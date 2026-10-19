use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use studydesk_core::google::gmail::{Endpoints, Gmail};
use studydesk_core::CoreError;
use url::Url;
use wiremock::matchers::{body_string_contains, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn client(oauth: &MockServer, api: &MockServer) -> Gmail {
    let ep = Endpoints {
        token_url: format!("{}/token", oauth.uri()),
        revoke_url: format!("{}/revoke", oauth.uri()),
        api_base: Url::parse(&format!("{}/", api.uri())).unwrap(),
        allow_loopback_http: true,
    };
    Gmail::new(ep, "id.apps.googleusercontent.com", "secret", "REFRESH-1", "me@school.net").unwrap()
}

async fn mount_token(oauth: &MockServer, tok: &str) {
    Mock::given(method("POST"))
        .and(path("/token"))
        .and(body_string_contains("grant_type=refresh_token"))
        .and(body_string_contains("refresh_token=REFRESH-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"access_token": tok, "expires_in": 3599})))
        .mount(oauth)
        .await;
}

#[tokio::test]
async fn lists_threads_with_metadata_and_keeps_tokens_apart() {
    let oauth = MockServer::start().await;
    let api = MockServer::start().await;
    mount_token(&oauth, "ACCESS-1").await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/threads"))
        .and(query_param("labelIds", "INBOX"))
        .and(query_param("q", "from:prof"))
        .and(header("authorization", "Bearer ACCESS-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "threads": [{"id": "t1", "snippet": "See you at 3 &amp; bring it"}],
            "nextPageToken": "p2", "resultSizeEstimate": 31
        })))
        .mount(&api)
        .await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/threads/t1"))
        .and(query_param("format", "metadata"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "t1",
            "messages": [
                {"id": "m1", "labelIds": ["INBOX"], "internalDate": "1792360000000", "payload": {"mimeType": "multipart/mixed", "headers": [{"name":"From","value":"Prof X <x@school.ca>"},{"name":"Subject","value":"Lab 3"}]}},
                {"id": "m2", "labelIds": ["INBOX","UNREAD"], "internalDate": "1792365000000", "payload": {"mimeType": "text/plain", "headers": [{"name":"From","value":"TA Y <y@school.ca>"}]}}
            ]
        })))
        .mount(&api)
        .await;

    let g = client(&oauth, &api);
    let page = g.threads("inbox", "from:prof", None).await.unwrap();
    assert_eq!(page.next.as_deref(), Some("p2"));
    let t = &page.items[0];
    assert_eq!(t.subject, "Lab 3");
    assert_eq!(t.senders, vec!["Prof X".to_string(), "TA Y".into()]);
    assert_eq!(t.snippet, "See you at 3 & bring it");
    assert!(t.unread && t.in_inbox && t.has_attachments && !t.starred);
    assert_eq!(t.last_ms, 1792365000000);
    assert_eq!(t.message_count, 2);

    // Refresh token only went to the token endpoint; API calls carried only the access token.
    for r in api.received_requests().await.unwrap() {
        assert!(!String::from_utf8_lossy(&r.body).contains("REFRESH-1"));
        assert_eq!(r.headers.get("authorization").unwrap(), "Bearer ACCESS-1");
    }
    assert_eq!(oauth.received_requests().await.unwrap().len(), 1, "access token is cached");
}

#[tokio::test]
async fn refreshes_once_on_401() {
    let oauth = MockServer::start().await;
    let api = MockServer::start().await;
    mount_token(&oauth, "ACCESS-X").await;
    Mock::given(path("/gmail/v1/users/me/profile"))
        .respond_with(ResponseTemplate::new(401))
        .up_to_n_times(1)
        .mount(&api)
        .await;
    Mock::given(path("/gmail/v1/users/me/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"emailAddress": "me@school.net"})))
        .mount(&api)
        .await;
    let g = client(&oauth, &api);
    assert_eq!(g.profile().await.unwrap().email_address, "me@school.net");
    assert_eq!(oauth.received_requests().await.unwrap().len(), 2);
}

#[tokio::test]
async fn expired_refresh_token_explains_itself() {
    let oauth = MockServer::start().await;
    let api = MockServer::start().await;
    Mock::given(path("/token"))
        .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({"error": "invalid_grant", "error_description": "Token has been expired or revoked."})))
        .mount(&oauth)
        .await;
    let err = client(&oauth, &api).profile().await.unwrap_err();
    assert!(err.to_string().contains("Reconnect Gmail"), "{err}");
    assert!(api.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn full_thread_send_and_attachment() {
    let oauth = MockServer::start().await;
    let api = MockServer::start().await;
    mount_token(&oauth, "A").await;
    let text = URL_SAFE_NO_PAD.encode("Hello John");
    Mock::given(path("/gmail/v1/users/me/threads/t9"))
        .and(query_param("format", "full"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "t9",
            "messages": [{"id": "m9", "labelIds": ["INBOX","STARRED"], "internalDate": "5", "payload": {
                "mimeType": "multipart/mixed",
                "headers": [{"name":"From","value":"Prof <p@s.ca>"},{"name":"To","value":"me@school.net, \"B, C\" <bc@s.ca>"},{"name":"Subject","value":"Hi"},{"name":"Message-ID","value":"<id9@mail>"}],
                "parts": [{"mimeType":"text/plain","body":{"data": text}}, {"mimeType":"application/pdf","filename":"a.pdf","body":{"size":4,"attachmentId":"att1"}}]
            }}]
        })))
        .mount(&api)
        .await;
    Mock::given(method("POST"))
        .and(path("/upload/gmail/v1/users/me/messages/send"))
        .and(query_param("uploadType", "multipart"))
        .and(body_string_contains("\"threadId\":\"t9\""))
        .and(body_string_contains("Content-Type: message/rfc822"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "sent1", "threadId": "t9"})))
        .mount(&api)
        .await;
    Mock::given(path("/gmail/v1/users/me/messages/m9/attachments/att1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": URL_SAFE_NO_PAD.encode(b"%PDF"), "size": 4})))
        .mount(&api)
        .await;
    Mock::given(method("POST"))
        .and(path("/gmail/v1/users/me/threads/t9/modify"))
        .and(body_string_contains("\"removeLabelIds\":[\"INBOX\"]"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "t9"})))
        .mount(&api)
        .await;

    let g = client(&oauth, &api);
    let t = g.thread("t9").await.unwrap();
    let m = &t.messages[0];
    assert_eq!(m.text.as_deref(), Some("Hello John"));
    assert_eq!(m.to, vec!["me@school.net".to_string(), "\"B, C\" <bc@s.ca>".into()]);
    assert_eq!(m.message_id_header.as_deref(), Some("<id9@mail>"));
    assert!(t.starred && t.in_inbox);
    assert_eq!(g.attachment("m9", "att1").await.unwrap(), b"%PDF");
    assert_eq!(g.send_raw(b"From: me@school.net\r\n\r\nhi".to_vec(), Some("t9")).await.unwrap(), "sent1");
    g.modify("t9", &[], &["INBOX"]).await.unwrap();
    assert!(matches!(g.modify("t9", &["TRASH"], &[]).await, Err(CoreError::Invalid(_))));
    assert!(matches!(g.thread("../../profile").await, Err(CoreError::Invalid(_))));
}

const QUOTA: &str = r#"{"error":{"code":429,"message":"Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'","errors":[{"reason":"rateLimitExceeded"}]}}"#;

#[tokio::test]
async fn quota_errors_retry_then_name_gmail_not_canvas() {
    let oauth = MockServer::start().await;
    let api = MockServer::start().await;
    mount_token(&oauth, "A").await;
    // First call is rate limited, the retry succeeds.
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/labels/INBOX"))
        .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "1").set_body_string(QUOTA))
        .up_to_n_times(1)
        .mount(&api)
        .await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/labels/INBOX"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id":"INBOX","threadsUnread": 7})))
        .mount(&api)
        .await;
    let g = client(&oauth, &api);
    assert_eq!(g.inbox_unread().await.unwrap(), 7);

    // Persistent 403 quota: gives up after 3 retries with a Gmail message.
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/threads/t9"))
        .respond_with(ResponseTemplate::new(403).set_body_string(QUOTA))
        .mount(&api)
        .await;
    let started = std::time::Instant::now();
    match g.thread("t9").await {
        Err(e @ CoreError::Busy(_)) => {
            let m = e.to_string();
            assert!(m.contains("Gmail") && !m.contains("Canvas"), "{m}");
            assert_eq!(e.kind(), "rate_limited");
        }
        other => panic!("{:?}", other.err()),
    }
    assert!(started.elapsed() >= std::time::Duration::from_secs(7), "backed off 1+2+4s");
    let hits = api.received_requests().await.unwrap().iter().filter(|r| r.url.path().ends_with("/t9")).count();
    assert_eq!(hits, 4);

    // A plain 403 is a Gmail refusal, never worded as Canvas.
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/threads/t8"))
        .respond_with(ResponseTemplate::new(403).set_body_string(r#"{"error":{"message":"Access blocked by admin"}}"#))
        .mount(&api)
        .await;
    let e = g.thread("t8").await.unwrap_err();
    assert_eq!(e.to_string(), "Gmail refused this: Access blocked by admin");
}

#[tokio::test]
async fn unchanged_threads_come_from_cache() {
    let oauth = MockServer::start().await;
    let api = MockServer::start().await;
    mount_token(&oauth, "A").await;
    let list = |hist: &str| {
        serde_json::json!({"threads": [{"id": "t1", "historyId": hist, "snippet": "hi"}, {"id": "t2", "historyId": "50", "snippet": "yo"}]})
    };
    Mock::given(method("GET")).and(path("/gmail/v1/users/me/threads")).respond_with(ResponseTemplate::new(200).set_body_json(list("10"))).up_to_n_times(2).mount(&api).await;
    Mock::given(method("GET")).and(path("/gmail/v1/users/me/threads")).respond_with(ResponseTemplate::new(200).set_body_json(list("11"))).mount(&api).await;
    for id in ["t1", "t2"] {
        Mock::given(method("GET"))
            .and(path(format!("/gmail/v1/users/me/threads/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": id, "historyId": "x", "messages": [{"id":"m","labelIds":["INBOX"],"internalDate":"1","payload":{"mimeType":"text/plain","headers":[{"name":"Subject","value":id}]}}]})))
            .mount(&api)
            .await;
    }
    let g = client(&oauth, &api);
    let fetches = |reqs: &Vec<wiremock::Request>| reqs.iter().filter(|r| r.url.path().contains("/threads/")).count();
    g.threads("inbox", "", None).await.unwrap();
    assert_eq!(fetches(&api.received_requests().await.unwrap()), 2);
    let p = g.threads("inbox", "", None).await.unwrap();
    assert_eq!(fetches(&api.received_requests().await.unwrap()), 2, "nothing changed, nothing refetched");
    assert_eq!(p.items[0].subject, "t1");
    g.threads("inbox", "", None).await.unwrap();
    assert_eq!(fetches(&api.received_requests().await.unwrap()), 3, "only the changed thread refetched");
}
