//! Canvas endpoints Studydesk uses. Each is a small wrapper over the client
//! so the exact parameters sent are easy to audit.

use super::models::*;
use super::{Canvas, Page};
use crate::{CoreError, Result};
use reqwest::Method;

fn q(k: &'static str, v: impl Into<String>) -> (&'static str, String) {
    (k, v.into())
}

impl Canvas {
    pub async fn user_self(&self) -> Result<User> {
        self.get("/api/v1/users/self", &[]).await
    }

    pub async fn colors(&self) -> Result<Colors> {
        self.get("/api/v1/users/self/colors", &[]).await
    }

    /// Current courses, including the Canvas-computed current score.
    pub async fn courses(&self) -> Result<Vec<Course>> {
        let all: Vec<Course> = self
            .get_all(
                "/api/v1/courses",
                &[q("enrollment_state", "active"), q("include[]", "total_scores"), q("include[]", "term"), q("per_page", "100")],
            )
            .await?;
        Ok(all.into_iter().filter(|c| c.access_restricted_by_date != Some(true) && !c.name.is_empty()).collect())
    }

    /// All assignments in a course with your submission attached. Due dates
    /// are your effective dates (section and individual overrides applied).
    pub async fn assignments(&self, course_id: u64) -> Result<Vec<Assignment>> {
        self.get_all(
            &format!("/api/v1/courses/{course_id}/assignments"),
            &[q("include[]", "submission"), q("order_by", "due_at"), q("per_page", "100")],
        )
        .await
    }

    pub async fn assignment(&self, course_id: u64, assignment_id: u64) -> Result<Assignment> {
        self.get(&format!("/api/v1/courses/{course_id}/assignments/{assignment_id}"), &[q("include[]", "submission")]).await
    }

    /// Your submission with instructor comments and rubric marks.
    pub async fn my_submission(&self, course_id: u64, assignment_id: u64) -> Result<Submission> {
        self.get(
            &format!("/api/v1/courses/{course_id}/assignments/{assignment_id}/submissions/self"),
            &[q("include[]", "submission_comments"), q("include[]", "rubric_assessment")],
        )
        .await
    }

    pub async fn announcements(&self, course_ids: &[u64], start_date: &str, end_date: &str) -> Result<Vec<Announcement>> {
        if course_ids.is_empty() {
            return Ok(vec![]);
        }
        let mut query: Vec<(&str, String)> = course_ids.iter().map(|id| q("context_codes[]", format!("course_{id}"))).collect();
        query.push(q("start_date", start_date));
        query.push(q("end_date", end_date));
        query.push(q("active_only", "true"));
        query.push(q("per_page", "50"));
        self.get_all("/api/v1/announcements", &query).await
    }

    pub async fn mark_announcement_read(&self, course_id: u64, topic_id: u64) -> Result<()> {
        let _: serde_json::Value =
            self.send_form(Method::PUT, &format!("/api/v1/courses/{course_id}/discussion_topics/{topic_id}/read"), &[]).await.or_else(empty_ok)?;
        Ok(())
    }

    // ---------------------------------------------------------------- inbox

    /// `scope`: inbox | unread | starred | sent | archived.
    pub async fn conversations(&self, scope: &str, course_id: Option<u64>, cursor: Option<&str>) -> Result<Page<Conversation>> {
        let scope = match scope {
            "inbox" | "unread" | "starred" | "sent" | "archived" => scope,
            _ => return Err(CoreError::Invalid("Unknown inbox folder.".into())),
        };
        let mut query = vec![q("per_page", "40")];
        if scope != "inbox" {
            query.push(q("scope", scope));
        }
        if let Some(c) = course_id {
            query.push(q("filter[]", format!("course_{c}")));
        }
        self.get_page("/api/v1/conversations", &query, cursor).await
    }

    /// Fetching a conversation marks it read in Canvas.
    pub async fn conversation(&self, id: u64) -> Result<Conversation> {
        self.get(&format!("/api/v1/conversations/{id}"), &[]).await
    }

    pub async fn unread_count(&self) -> Result<u64> {
        let c: UnreadCount = self.get("/api/v1/conversations/unread_count", &[]).await?;
        Ok(c.unread_count)
    }

    pub async fn update_conversation(&self, id: u64, workflow_state: Option<&str>, starred: Option<bool>) -> Result<Conversation> {
        let mut form = Vec::new();
        if let Some(s) = workflow_state {
            if !matches!(s, "read" | "unread" | "archived") {
                return Err(CoreError::Invalid("Unknown conversation state.".into()));
            }
            form.push(("conversation[workflow_state]".to_string(), s.to_string()));
        }
        if let Some(s) = starred {
            form.push(("conversation[starred]".to_string(), s.to_string()));
        }
        self.send_form(Method::PUT, &format!("/api/v1/conversations/{id}"), &form).await
    }

    pub async fn add_message(&self, id: u64, body: &str, attachment_ids: &[u64]) -> Result<Conversation> {
        let mut form = vec![("body".to_string(), body.to_string())];
        form.extend(attachment_ids.iter().map(|a| ("attachment_ids[]".to_string(), a.to_string())));
        self.send_form(Method::POST, &format!("/api/v1/conversations/{id}/add_message"), &form).await
    }

    pub async fn create_conversation(
        &self,
        course_id: u64,
        recipient_ids: &[String],
        subject: &str,
        body: &str,
        group: bool,
        attachment_ids: &[u64],
    ) -> Result<Vec<Conversation>> {
        let mut form = vec![
            ("subject".to_string(), subject.to_string()),
            ("body".to_string(), body.to_string()),
            ("context_code".to_string(), format!("course_{course_id}")),
            ("group_conversation".to_string(), group.to_string()),
            ("force_new".to_string(), "true".to_string()),
            ("mode".to_string(), "sync".to_string()),
        ];
        form.extend(recipient_ids.iter().map(|r| ("recipients[]".to_string(), r.clone())));
        form.extend(attachment_ids.iter().map(|a| ("attachment_ids[]".to_string(), a.to_string())));
        self.send_form(Method::POST, "/api/v1/conversations", &form).await
    }

    /// `role`: None for anyone, or "teachers" / "tas".
    pub async fn search_recipients(&self, course_id: u64, search: &str, role: Option<&str>) -> Result<Vec<Recipient>> {
        let context = match role {
            None => format!("course_{course_id}"),
            Some("teachers") => format!("course_{course_id}_teachers"),
            Some("tas") => format!("course_{course_id}_tas"),
            Some(_) => return Err(CoreError::Invalid("Unknown recipient role.".into())),
        };
        let mut query = vec![q("context", context), q("type", "user"), q("per_page", "30")];
        if !search.trim().is_empty() {
            query.push(q("search", search.trim()));
        }
        self.get("/api/v1/search/recipients", &query).await
    }
}

/// Some Canvas PUTs answer 204 with an empty body.
fn empty_ok(e: CoreError) -> Result<serde_json::Value> {
    match e {
        CoreError::Api { status: 0, .. } => Ok(serde_json::Value::Null),
        other => Err(other),
    }
}

impl Canvas {
    /// Assignment groups with weights and drop rules (for the grade calculator).
    pub async fn assignment_groups(&self, course_id: u64) -> Result<Vec<AssignmentGroup>> {
        self.get_all(&format!("/api/v1/courses/{course_id}/assignment_groups"), &[q("per_page", "100")]).await
    }

    /// Modules with their items and your completion state.
    pub async fn modules(&self, course_id: u64) -> Result<Vec<Module>> {
        self.get_all(
            &format!("/api/v1/courses/{course_id}/modules"),
            &[q("include[]", "items"), q("include[]", "content_details"), q("per_page", "50")],
        )
        .await
    }

    /// Marks a module item done (must_mark_done) or viewed (must_view).
    pub async fn module_item_complete(&self, course_id: u64, module_id: u64, item_id: u64, view: bool) -> Result<()> {
        let path = if view {
            format!("/api/v1/courses/{course_id}/modules/{module_id}/items/{item_id}/mark_read")
        } else {
            format!("/api/v1/courses/{course_id}/modules/{module_id}/items/{item_id}/done")
        };
        let method = if view { Method::POST } else { Method::PUT };
        let _: serde_json::Value = self.send_form(method, &path, &[]).await.or_else(empty_ok)?;
        Ok(())
    }

    /// Instructor-posted calendar events (exams, labs, sessions) in a date range.
    pub async fn calendar_events(&self, course_id: u64, start: &str, end: &str) -> Result<Vec<CalendarEvent>> {
        self.get_all(
            "/api/v1/calendar_events",
            &[q("type", "event"), q("context_codes[]", format!("course_{course_id}")), q("start_date", start), q("end_date", end), q("per_page", "100")],
        )
        .await
    }

    pub async fn syllabus(&self, course_id: u64) -> Result<Option<String>> {
        let c: CourseSyllabus = self.get(&format!("/api/v1/courses/{course_id}"), &[q("include[]", "syllabus_body")]).await?;
        Ok(c.syllabus_body.filter(|b| !b.trim().is_empty()))
    }

    pub async fn front_page(&self, course_id: u64) -> Result<Option<WikiPage>> {
        match self.get::<WikiPage>(&format!("/api/v1/courses/{course_id}/front_page"), &[]).await {
            Ok(p) => Ok(Some(p)),
            Err(CoreError::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The 200 most recently updated files in a course.
    pub async fn course_files(&self, course_id: u64) -> Result<Vec<CourseFile>> {
        let path = format!("/api/v1/courses/{course_id}/files");
        let first: Page<CourseFile> = self.get_page(&path, &[q("sort", "updated_at"), q("order", "desc"), q("per_page", "100")], None).await?;
        let mut all = first.items;
        if let Some(next) = first.next {
            if let Ok(p) = self.get_page::<CourseFile>(&path, &[], Some(&next)).await {
                all.extend(p.items);
            }
        }
        Ok(all)
    }
}

