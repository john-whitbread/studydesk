//! Typed subsets of Canvas API objects. Only the fields Studydesk uses are
//! declared; everything is optional or defaulted so an absent field on some
//! Canvas instance never breaks parsing. Dates stay as ISO-8601 strings and
//! are formatted in the UI using the computer's time zone.

use serde::{Deserialize, Deserializer, Serialize};

/// Canvas returns some ids as numbers and some (search results) as strings.
pub fn de_string_or_number<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum V {
        S(String),
        N(i64),
        U(u64),
    }
    Ok(match V::deserialize(d)? {
        V::S(s) => s,
        V::N(n) => n.to_string(),
        V::U(n) => n.to_string(),
    })
}

fn de_u64_lenient<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let s = de_string_or_number(d)?;
    s.parse().map_err(serde::de::Error::custom)
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct User {
    pub id: u64,
    pub name: String,
    pub short_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Term {
    pub name: Option<String>,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Enrollment {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub computed_current_score: Option<f64>,
    pub computed_current_grade: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Course {
    pub id: u64,
    /// The user's nickname for the course when one is set.
    pub name: String,
    pub original_name: Option<String>,
    pub course_code: String,
    pub term: Option<Term>,
    pub enrollments: Vec<Enrollment>,
    pub access_restricted_by_date: Option<bool>,
    pub hide_final_grades: Option<bool>,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    /// Assignment-group weights decide the grade (else total points).
    pub apply_assignment_group_weights: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct GroupRules {
    pub drop_lowest: Option<u32>,
    pub drop_highest: Option<u32>,
    pub never_drop: Vec<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct AssignmentGroup {
    pub id: u64,
    pub name: String,
    pub position: Option<i64>,
    /// Percent of the final grade when the course uses weights.
    pub group_weight: Option<f64>,
    pub rules: Option<GroupRules>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct CompletionRequirement {
    /// must_view | must_mark_done | must_submit | must_contribute | min_score
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub completed: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ContentDetails {
    pub due_at: Option<String>,
    pub points_possible: Option<f64>,
    pub locked_for_user: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ModuleItem {
    pub id: u64,
    pub module_id: u64,
    pub position: Option<i64>,
    pub title: String,
    /// File | Page | Discussion | Assignment | Quiz | SubHeader | ExternalUrl | ExternalTool
    #[serde(rename = "type")]
    pub kind: String,
    pub content_id: Option<u64>,
    pub html_url: Option<String>,
    pub indent: Option<i64>,
    pub completion_requirement: Option<CompletionRequirement>,
    pub content_details: Option<ContentDetails>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Module {
    pub id: u64,
    pub name: String,
    pub position: Option<i64>,
    pub unlock_at: Option<String>,
    /// locked | unlocked | started | completed
    pub state: Option<String>,
    pub items: Vec<ModuleItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct RubricRating {
    pub id: Option<String>,
    pub description: Option<String>,
    pub points: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct RubricCriterion {
    #[serde(deserialize_with = "de_string_or_number")]
    pub id: String,
    pub description: Option<String>,
    pub long_description: Option<String>,
    pub points: Option<f64>,
    pub ratings: Vec<RubricRating>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Attachment {
    pub id: u64,
    pub display_name: Option<String>,
    pub filename: Option<String>,
    pub size: Option<u64>,
    #[serde(rename = "content-type", alias = "content_type")]
    pub content_type: Option<String>,
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct SubmissionComment {
    pub id: u64,
    pub author_id: Option<u64>,
    pub author_name: Option<String>,
    pub comment: Option<String>,
    pub created_at: Option<String>,
    pub attachments: Vec<Attachment>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Submission {
    pub id: Option<u64>,
    pub assignment_id: Option<u64>,
    /// Number of the latest submitted attempt; null when nothing submitted.
    pub attempt: Option<i64>,
    /// unsubmitted | submitted | graded | pending_review
    pub workflow_state: Option<String>,
    pub submitted_at: Option<String>,
    pub graded_at: Option<String>,
    pub posted_at: Option<String>,
    pub score: Option<f64>,
    pub grade: Option<String>,
    pub late: Option<bool>,
    pub missing: Option<bool>,
    pub excused: Option<bool>,
    pub submission_type: Option<String>,
    pub attachments: Vec<Attachment>,
    pub submission_comments: Vec<SubmissionComment>,
    /// criterion id -> { points, rating_id, comments }
    pub rubric_assessment: Option<serde_json::Value>,
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Assignment {
    pub id: u64,
    pub course_id: u64,
    pub name: String,
    pub description: Option<String>,
    pub due_at: Option<String>,
    pub lock_at: Option<String>,
    pub unlock_at: Option<String>,
    pub points_possible: Option<f64>,
    pub grading_type: Option<String>,
    pub submission_types: Vec<String>,
    pub allowed_extensions: Vec<String>,
    /// -1 or null means unlimited.
    pub allowed_attempts: Option<i64>,
    pub html_url: Option<String>,
    pub locked_for_user: Option<bool>,
    pub lock_explanation: Option<String>,
    pub is_quiz_assignment: Option<bool>,
    pub quiz_id: Option<u64>,
    pub rubric: Vec<RubricCriterion>,
    pub submission: Option<Submission>,
    pub omit_from_final_grade: Option<bool>,
    pub assignment_group_id: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Author {
    pub display_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Announcement {
    pub id: u64,
    pub title: String,
    pub message: Option<String>,
    pub posted_at: Option<String>,
    pub context_code: Option<String>,
    pub html_url: Option<String>,
    pub read_state: Option<String>,
    pub author: Option<Author>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Participant {
    pub id: u64,
    pub name: String,
    pub full_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Message {
    pub id: u64,
    pub created_at: Option<String>,
    pub body: String,
    pub author_id: u64,
    pub generated: Option<bool>,
    pub attachments: Vec<Attachment>,
    pub participating_user_ids: Vec<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Conversation {
    pub id: u64,
    pub subject: Option<String>,
    /// read | unread | archived
    pub workflow_state: String,
    pub last_message: Option<String>,
    pub last_message_at: Option<String>,
    pub last_authored_message_at: Option<String>,
    pub message_count: u64,
    pub starred: bool,
    pub properties: Vec<String>,
    pub audience: Vec<u64>,
    pub participants: Vec<Participant>,
    pub context_name: Option<String>,
    pub context_code: Option<String>,
    /// Present only when one conversation is fetched.
    pub messages: Vec<Message>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Recipient {
    #[serde(deserialize_with = "de_string_or_number")]
    pub id: String,
    pub name: String,
    pub full_name: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct UnreadCount {
    #[serde(deserialize_with = "de_u64_lenient")]
    pub unread_count: u64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Colors {
    pub custom_colors: std::collections::HashMap<String, String>,
}

#[derive(Deserialize, Debug)]
pub struct UploadTicket {
    pub upload_url: String,
    #[serde(default)]
    pub upload_params: serde_json::Map<String, serde_json::Value>,
    pub file_param: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct UploadedFile {
    pub id: u64,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct CalendarEvent {
    pub id: u64,
    pub title: String,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub all_day: Option<bool>,
    pub location_name: Option<String>,
    pub description: Option<String>,
    pub html_url: Option<String>,
    pub context_code: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct CourseFile {
    pub id: u64,
    pub display_name: String,
    pub filename: Option<String>,
    pub size: Option<u64>,
    pub url: Option<String>,
    pub updated_at: Option<String>,
    pub locked_for_user: Option<bool>,
    pub hidden_for_user: Option<bool>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct CourseSyllabus {
    pub syllabus_body: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct WikiPage {
    pub title: Option<String>,
    pub body: Option<String>,
    pub html_url: Option<String>,
}
