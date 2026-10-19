//! Canvas client against mock servers. Two servers on different ports are two
//! different origins, which lets us prove the token never leaves the Canvas
//! origin.

use std::sync::{Arc, Mutex};
use studydesk_core::canvas::models::{Course, User};
use studydesk_core::canvas::upload::UploadKind;
use studydesk_core::canvas::Canvas;
use studydesk_core::CoreError;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

const TOKEN: &str = "7~test-token";

fn client(server: &MockServer) -> Canvas {
    Canvas::new(&server.uri(), TOKEN, true).unwrap()
}

fn auth_of(r: &Request) -> Option<String> {
    r.headers.get("authorization").map(|v| v.to_str().unwrap().to_string())
}

#[tokio::test]
async fn sends_bearer_token_and_parses() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/users/self"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": 7, "name": "John Whitbread"})))
        .mount(&s)
        .await;
    let u: User = client(&s).user_self().await.unwrap();
    assert_eq!(u.id, 7);
    assert_eq!(u.name, "John Whitbread");
}

#[tokio::test]
async fn follows_same_origin_pagination() {
    let s = MockServer::start().await;
    let next = format!("{}/api/v1/courses?page=2&per_page=100", s.uri());
    Mock::given(method("GET"))
        .and(path("/api/v1/courses"))
        .and(query_param("page", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{"id": 2, "name": "B", "course_code": "B"}])))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/courses"))
        .and(query_param("enrollment_state", "active"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("Link", format!("<{next}>; rel=\"next\"").as_str())
                .set_body_json(serde_json::json!([
                    {"id": 1, "name": "A", "course_code": "A"},
                    {"id": 9, "access_restricted_by_date": true}
                ])),
        )
        .mount(&s)
        .await;
    let courses: Vec<Course> = client(&s).courses().await.unwrap();
    assert_eq!(courses.iter().map(|c| c.id).collect::<Vec<_>>(), vec![1, 2], "restricted course dropped, page 2 included");
    for r in s.received_requests().await.unwrap() {
        assert_eq!(auth_of(&r).as_deref(), Some(format!("Bearer {TOKEN}").as_str()));
    }
}

#[tokio::test]
async fn refuses_foreign_pagination_link() {
    let s = MockServer::start().await;
    let evil = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/courses"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("Link", format!("<{}/api/v1/courses?page=2>; rel=\"next\"", evil.uri()).as_str())
                .set_body_json(serde_json::json!([{"id": 1, "name": "A", "course_code": "A"}])),
        )
        .mount(&s)
        .await;
    let courses = client(&s).courses().await.unwrap();
    assert_eq!(courses.len(), 1);
    assert!(evil.received_requests().await.unwrap().is_empty(), "token must never reach another origin");
}

#[tokio::test]
async fn does_not_follow_redirects() {
    let s = MockServer::start().await;
    let evil = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/users/self"))
        .respond_with(ResponseTemplate::new(302).insert_header("Location", format!("{}/steal", evil.uri()).as_str()))
        .mount(&s)
        .await;
    let err = client(&s).user_self().await.unwrap_err();
    assert!(matches!(err, CoreError::Api { status: 302, .. }), "{err:?}");
    assert!(evil.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn maps_auth_errors() {
    let s = MockServer::start().await;
    Mock::given(path("/api/v1/users/self"))
        .respond_with(ResponseTemplate::new(401).insert_header("WWW-Authenticate", "Bearer realm=\"canvas-lms\""))
        .mount(&s)
        .await;
    Mock::given(path("/api/v1/users/self/colors"))
        .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({"status":"unauthorized","errors":[{"message":"user not authorized to perform that action"}]})))
        .mount(&s)
        .await;
    let c = client(&s);
    assert!(matches!(c.user_self().await, Err(CoreError::Unauthorized)));
    match c.colors().await {
        Err(CoreError::Forbidden(m)) => assert_eq!(m, "user not authorized to perform that action"),
        other => panic!("{:?}", other.err()),
    }
}

#[tokio::test]
async fn retries_rate_limit_then_succeeds() {
    let s = MockServer::start().await;
    Mock::given(path("/api/v1/users/self"))
        .respond_with(ResponseTemplate::new(403).set_body_string("403 Forbidden (Rate Limit Exceeded)"))
        .up_to_n_times(1)
        .mount(&s)
        .await;
    Mock::given(path("/api/v1/users/self"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": 7, "name": "J"})))
        .mount(&s)
        .await;
    assert_eq!(client(&s).user_self().await.unwrap().id, 7);
    assert_eq!(s.received_requests().await.unwrap().len(), 2);
}

#[tokio::test]
async fn unread_count_accepts_string() {
    let s = MockServer::start().await;
    Mock::given(path("/api/v1/conversations/unread_count"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"unread_count": "3"})))
        .mount(&s)
        .await;
    assert_eq!(client(&s).unread_count().await.unwrap(), 3);
}

/// Full four-step upload where storage is a different origin and confirms
/// with a redirect back to Canvas.
#[tokio::test]
async fn upload_flow_keeps_token_on_canvas_origin() {
    let canvas = MockServer::start().await;
    let storage = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/api/v1/courses/2/assignments/3/submissions/self/files"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "upload_url": format!("{}/upload", storage.uri()),
            "upload_params": {"key": "abc/report.pdf", "policy": "p0", "x-amz-signature": "sig"},
            "file_param": "file"
        })))
        .mount(&canvas)
        .await;
    Mock::given(method("POST"))
        .and(path("/upload"))
        .respond_with(ResponseTemplate::new(302).insert_header("Location", format!("{}/api/v1/files/55/create_success?uuid=u", canvas.uri()).as_str()))
        .mount(&storage)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/files/55/create_success"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": 55, "display_name": "report.pdf", "size": 11})))
        .mount(&canvas)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/courses/2/assignments/3/submissions"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({"id": 900, "attempt": 1, "workflow_state": "submitted", "submitted_at": "2026-10-18T12:00:00Z"})))
        .mount(&canvas)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("report.pdf");
    std::fs::write(&file, b"%PDF-1.7 hi").unwrap();

    let c = client(&canvas);
    let seen = Arc::new(Mutex::new(Vec::<(u64, u64)>::new()));
    let seen2 = seen.clone();
    let up = c
        .upload_file(&UploadKind::Submission { course_id: 2, assignment_id: 3 }, &file, Arc::new(move |a, b| seen2.lock().unwrap().push((a, b))))
        .await
        .unwrap();
    assert_eq!(up.id, 55);
    let sub = c.submit_files(2, 3, &[up.id], Some("  thanks  ")).await.unwrap();
    assert_eq!(sub.attempt, Some(1));

    // Storage got the file, last, and never the token.
    let st = storage.received_requests().await.unwrap();
    assert_eq!(st.len(), 1);
    assert_eq!(auth_of(&st[0]), None, "token must not go to the storage host");
    let body = String::from_utf8_lossy(&st[0].body).to_string();
    let key_at = body.find("name=\"key\"").unwrap();
    let file_at = body.find("name=\"file\"").unwrap();
    assert!(key_at < file_at, "upload params must precede the file part");
    assert!(body.contains("%PDF-1.7 hi"));

    // Canvas got the token on every call, and the right submission params.
    let cv = canvas.received_requests().await.unwrap();
    assert_eq!(cv.len(), 3);
    assert!(cv.iter().all(|r| auth_of(r).is_some()));
    let submit_body = String::from_utf8_lossy(&cv[2].body).to_string();
    assert!(submit_body.contains("submission%5Bsubmission_type%5D=online_upload"));
    assert!(submit_body.contains("submission%5Bfile_ids%5D%5B%5D=55"));
    assert!(submit_body.contains("comment%5Btext_comment%5D=thanks"));
    let init_body = String::from_utf8_lossy(&cv[0].body).to_string();
    assert!(init_body.contains("name=report.pdf") && init_body.contains("size=11") && init_body.contains("content_type=application%2Fpdf"));

    let p = seen.lock().unwrap();
    assert_eq!(p.last(), Some(&(11, 11)));
}

#[tokio::test]
async fn upload_redirect_to_foreign_origin_gets_no_token() {
    let canvas = MockServer::start().await;
    let storage = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/users/self/files"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "upload_url": format!("{}/upload", storage.uri()), "upload_params": {}
        })))
        .mount(&canvas)
        .await;
    Mock::given(method("POST"))
        .and(path("/upload"))
        .respond_with(ResponseTemplate::new(303).insert_header("Location", "/confirm/77"))
        .mount(&storage)
        .await;
    Mock::given(method("GET"))
        .and(path("/confirm/77"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": 77})))
        .mount(&storage)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.txt");
    std::fs::write(&file, b"x").unwrap();
    let up = client(&canvas).upload_file(&UploadKind::MessageAttachment, &file, Arc::new(|_, _| {})).await.unwrap();
    assert_eq!(up.id, 77);
    let st = storage.received_requests().await.unwrap();
    assert_eq!(st.len(), 2);
    assert!(st.iter().all(|r| auth_of(r).is_none()));
    let init = String::from_utf8_lossy(&canvas.received_requests().await.unwrap()[0].body).to_string();
    assert!(init.contains("parent_folder_path=conversation+attachments"));
}

#[tokio::test]
async fn page_cursor_must_stay_on_canvas() {
    let s = MockServer::start().await;
    let c = client(&s);
    let bad = c.conversations("inbox", None, Some("https://evil.example/api/v1/conversations?page=2")).await;
    assert!(matches!(bad, Err(CoreError::Invalid(_))));
    let wrong_path = c.conversations("inbox", None, Some(&format!("{}/api/v1/users/self", s.uri()))).await;
    assert!(matches!(wrong_path, Err(CoreError::Invalid(_))));
    assert!(s.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn file_download_follows_redirect_without_token() {
    let canvas = MockServer::start().await;
    let storage = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/files/9/download"))
        .respond_with(ResponseTemplate::new(302).insert_header("Location", format!("{}/blob/9?sig=x", storage.uri()).as_str()))
        .mount(&canvas)
        .await;
    Mock::given(method("GET")).and(path("/blob/9")).respond_with(ResponseTemplate::new(200).set_body_bytes(b"%PDF-data".to_vec())).mount(&storage).await;
    let c = client(&canvas);
    let bytes = c.download(&format!("{}/files/9/download?download_frd=1", canvas.uri()), 1000).await.unwrap();
    assert_eq!(bytes, b"%PDF-data");
    assert!(auth_of(&canvas.received_requests().await.unwrap()[0]).is_some());
    assert!(auth_of(&storage.received_requests().await.unwrap()[0]).is_none(), "token must not go to storage");
    // Off-site start URL is refused outright.
    assert!(c.download(&format!("{}/blob/9", storage.uri()), 1000).await.is_err());
    // Size cap.
    assert!(c.download(&format!("{}/files/9/download", canvas.uri()), 3).await.is_err());
}
