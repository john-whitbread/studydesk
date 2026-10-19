use studydesk_core::calendar::{caldav::{CalDav, PutCond}, ics};
use studydesk_core::CoreError;
use url::Url;
use wiremock::matchers::{body_string_contains, header, header_exists, method, path, path_regex};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

const AUTH: &str = "Basic bWVAaWNsb3VkLmNvbTphYmNkZWZnaGlqa2xtbm9w"; // me@icloud.com:abcdefghijklmnop

fn ms(xml: &str) -> ResponseTemplate {
    ResponseTemplate::new(207).insert_header("content-type", "application/xml").set_body_string(xml.to_string())
}

#[tokio::test]
async fn icloud_flow_end_to_end() {
    let s = MockServer::start().await;
    let base = Url::parse(&format!("{}/", s.uri())).unwrap();
    let home = format!("{}/123/calendars/", s.uri());

    // Discovery: / -> principal -> calendar home (absolute URL, like iCloud's pXX host).
    Mock::given(method("PROPFIND")).and(path("/")).and(header("authorization", AUTH)).and(header("depth", "0"))
        .respond_with(ms(r#"<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><href>/123/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#))
        .mount(&s).await;
    Mock::given(method("PROPFIND")).and(path("/123/principal/"))
        .respond_with(ms(&format!(r#"<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/123/principal/</href><propstat><prop><C:calendar-home-set><href>{home}</href></C:calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#)))
        .mount(&s).await;
    Mock::given(method("PROPFIND")).and(path("/123/calendars/")).and(header("depth", "1"))
        .respond_with(ms(r##"<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
          <response><href>/123/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
          <response><href>/123/calendars/work/</href><propstat><prop><resourcetype><collection/><C:calendar/></resourcetype><displayname>Work</displayname><A:calendar-color>#1BADF8FF</A:calendar-color><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>
          <response><href>/123/calendars/home/</href><propstat><prop><resourcetype><collection/><C:calendar/></resourcetype><displayname>Home</displayname><A:calendar-color>#FF2968FF</A:calendar-color></prop><status>HTTP/1.1 200 OK</status></propstat></response>
          <response><href>/123/calendars/reminders/</href><propstat><prop><resourcetype><collection/><C:calendar/></resourcetype><displayname>Reminders</displayname><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>
        </multistatus>"##))
        .mount(&s).await;
    Mock::given(method("REPORT")).and(path("/123/calendars/home/"))
        .respond_with(ms(r#"<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/123/calendars/home/ev1.ics</href><propstat><prop><getetag>"e1"</getetag><C:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:ev1
SUMMARY:Gym &amp; run
DTSTART;TZID=America/Toronto:20261020T070000
DURATION:PT1H
RRULE:FREQ=DAILY;COUNT=3
END:VEVENT
END:VCALENDAR
</C:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#))
        .mount(&s).await;
    // Like iCloud: the first, full request is refused; the name-only retry works.
    Mock::given(method("MKCALENDAR")).and(path_regex(r"^/123/calendars/[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}/$")).and(body_string_contains("calendar-color"))
        .respond_with(ResponseTemplate::new(403)).mount(&s).await;
    Mock::given(method("MKCALENDAR")).and(path_regex(r"^/123/calendars/[0-9A-F-]{36}/$")).respond_with(ResponseTemplate::new(201)).mount(&s).await;
    Mock::given(method("PUT")).and(path_regex(r"^/123/calendars/[0-9A-F-]{36}/a1\.ics$")).and(header("if-none-match", "*")).and(header("content-type", "text/calendar; charset=utf-8"))
        .respond_with(ResponseTemplate::new(201).insert_header("etag", "\"v1\"")).mount(&s).await;
    Mock::given(method("PUT")).and(path_regex(r"^/123/calendars/[0-9A-F-]{36}/a1\.ics$")).and(header("if-match", "\"v1\""))
        .respond_with(ResponseTemplate::new(204).insert_header("etag", "\"v2\"")).mount(&s).await;
    Mock::given(method("DELETE")).and(path_regex(r"^/123/calendars/[0-9A-F-]{36}/a1\.ics$")).respond_with(ResponseTemplate::new(204)).mount(&s).await;

    let c = CalDav::with_base(base, "me@icloud.com", "abcd-efgh-ijkl-mnop", true).unwrap();
    let home_url = c.discover().await.unwrap();
    assert_eq!(home_url.as_str(), home);
    let cals = c.calendars(&home_url).await.unwrap();
    let names: Vec<_> = cals.iter().map(|x| (x.name.as_str(), x.color.as_str())).collect();
    assert_eq!(names, vec![("Home", "#ff2968"), ("Work", "#1badf8")], "reminders skipped, sorted, colours normalised");

    let evs = c.events(&Url::parse(&cals[0].href).unwrap(), 1_792_000_000_000, 1_793_000_000_000).await.unwrap();
    assert_eq!(evs.len(), 1);
    let occ = ics::occurrences(&evs[0].data, 1_792_000_000_000, 1_793_000_000_000);
    assert_eq!(occ.len(), 3);
    assert_eq!(occ[0].title, "Gym & run");

    let cal = c.create_calendar(&home_url, "Studydesk", "#1d4ed8").await.unwrap();
    let mk: Vec<_> = s.received_requests().await.unwrap().into_iter().filter(|r| r.method.as_str() == "MKCALENDAR").collect();
    assert_eq!(mk.len(), 2, "refused once, then retried with the name only");
    assert!(!String::from_utf8_lossy(&mk[1].body).contains("calendar-color"));
    assert_ne!(mk[0].url.path(), mk[1].url.path(), "fresh random id each try");
    let ev = cal.join("a1.ics").unwrap();
    let e1 = c.put(&ev, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n".into(), PutCond::Create).await.unwrap();
    assert_eq!(e1, "\"v1\"");
    let e2 = c.put(&ev, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n".into(), PutCond::Replace(&e1)).await.unwrap();
    assert_eq!(e2, "\"v2\"");
    c.delete(&ev).await.unwrap();

    // Every request carried the credentials, and only to this server.
    for r in s.received_requests().await.unwrap() {
        assert_eq!(r.headers.get("authorization").unwrap(), AUTH);
    }
}

#[tokio::test]
async fn bad_password_and_foreign_redirects() {
    let s = MockServer::start().await;
    Mock::given(method("PROPFIND")).and(path("/")).respond_with(ResponseTemplate::new(401)).mount(&s).await;
    Mock::given(method("PROPFIND")).and(path("/moved/")).respond_with(ResponseTemplate::new(301).insert_header("location", "https://evil.example.com/steal")).mount(&s).await;
    let base = Url::parse(&format!("{}/", s.uri())).unwrap();
    let c = CalDav::with_base(base.clone(), "me@icloud.com", "abcdefghijklmnop", true).unwrap();
    match c.discover().await {
        Err(CoreError::Invalid(m)) => assert!(m.contains("app-specific password")),
        other => panic!("{:?}", other.err()),
    }
    let c = CalDav::with_base(base.join("moved/").unwrap(), "me@icloud.com", "abcdefghijklmnop", true).unwrap();
    assert!(matches!(c.discover().await, Err(CoreError::Refused(_))));
    let _ = (header_exists("x"), |_: &Request| true);
}
