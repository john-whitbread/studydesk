//! Canvas data: dashboard sync, assignment details, announcements, links.

use crate::state::{now_ms, AppState};
use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use studydesk_core::canvas::models::{Announcement, Assignment, Course, Submission};
use studydesk_core::url_guard::{external_link, same_origin};
use studydesk_core::{CoreError, Result};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
pub struct CourseOut {
    #[serde(flatten)]
    course: Course,
    /// Canvas's own name; `course.name` / `course_code` are tidied (courses::tidy).
    full_name: String,
    color: Option<String>,
    folder: Option<String>,
    hidden: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    user_id: u64,
    user_name: String,
    base_url: String,
    courses: Vec<CourseOut>,
    assignments: Vec<Assignment>,
    announcements: Vec<Announcement>,
    unread_count: Option<u64>,
    /// Non-fatal problems, e.g. one course hides its assignments.
    notices: Vec<String>,
    synced_at: u64,
}

fn label(c: &Course) -> String {
    if c.course_code.is_empty() || c.course_code == c.name {
        c.name.clone()
    } else {
        format!("{} – {}", c.course_code, c.name)
    }
}

#[tauri::command]
pub async fn sync_all(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Dashboard> {
    let canvas = state.canvas().await?;
    let (user_id, user_name, links, hidden) = {
        let g = state.session.read().await;
        let s = g.as_ref().ok_or(CoreError::Locked)?;
        (s.data.user_id, s.data.user_name.clone(), s.data.folder_links.clone(), s.data.prefs.hidden_courses.clone())
    };

    let (courses, colors, unread) = tokio::join!(canvas.courses(), canvas.colors(), canvas.unread_count());
    let mut courses = courses?; // without courses there is nothing to show
    // "202609 - Statics - MECE-2230U-002" -> code "MECE 2230U", name "Statics".
    let full_names: std::collections::HashMap<u64, String> = courses.iter().map(|c| (c.id, c.name.clone())).collect();
    for c in &mut courses {
        let (code, title) = studydesk_core::courses::tidy(&c.course_code, &c.name);
        c.course_code = code;
        c.name = title;
    }
    let mut notices = Vec::new();
    let colors = colors.map(|c| c.custom_colors).unwrap_or_default();
    let unread_count = match unread {
        Ok(n) => Some(n),
        Err(CoreError::Unauthorized) => return Err(CoreError::Unauthorized),
        Err(_) => None,
    };

    let ids: Vec<u64> = courses.iter().filter(|c| !hidden.contains(&c.id)).map(|c| c.id).collect();
    let futures: Vec<_> = ids
        .iter()
        .map(|&id| {
            let canvas = canvas.clone();
            async move { (id, canvas.assignments(id).await) }
        })
        .collect();
    let results: Vec<(u64, Result<Vec<Assignment>>)> = stream::iter(futures).buffer_unordered(4).collect().await;

    let mut assignments = Vec::new();
    for (id, r) in results {
        match r {
            Ok(mut list) => {
                for a in &mut list {
                    a.course_id = id;
                }
                assignments.append(&mut list);
            }
            Err(CoreError::Unauthorized) => return Err(CoreError::Unauthorized),
            Err(e) => {
                let name = courses.iter().find(|c| c.id == id).map(label).unwrap_or_default();
                notices.push(match e {
                    CoreError::Forbidden(_) | CoreError::NotFound => format!("{name}: this course doesn't share its assignment list."),
                    other => format!("{name}: {other}"),
                });
            }
        }
    }

    let today = chrono::Local::now().date_naive();
    let start = (today - chrono::Duration::days(21)).format("%Y-%m-%d").to_string();
    let end = (today + chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    let mut announcements = match canvas.announcements(&ids, &start, &end).await {
        Ok(a) => a,
        Err(CoreError::Unauthorized) => return Err(CoreError::Unauthorized),
        Err(e) => {
            notices.push(format!("Announcements: {e}"));
            vec![]
        }
    };
    announcements.sort_by(|a, b| b.posted_at.cmp(&a.posted_at));

    {
        let mut g = state.session.write().await;
        if let Some(s) = g.as_mut() {
            s.course_labels = courses.iter().map(|c| (c.id, label(c))).collect();
            // Every assignment, for reminders and the date scanner's duplicate check.
            s.upcoming = assignments
                .iter()
                .map(|a| (courses.iter().find(|c| c.id == a.course_id).map(|c| c.course_code.clone()).unwrap_or_default(), a.clone()))
                .collect();
        }
    }

    let courses = courses
        .into_iter()
        .map(|c| CourseOut {
            full_name: full_names.get(&c.id).cloned().unwrap_or_default(),
            color: colors.get(&format!("course_{}", c.id)).cloned(),
            folder: links.get(&c.id).cloned(),
            hidden: hidden.contains(&c.id),
            course: c,
        })
        .collect();

    // Keep the Studydesk calendar in iCloud up to date (no-op if not set up).
    crate::cmd_calendar::spawn_push(app);
    Ok(Dashboard {
        user_id,
        user_name,
        base_url: canvas.base_str(),
        courses,
        assignments,
        announcements,
        unread_count,
        notices,
        synced_at: now_ms(),
    })
}

#[derive(Serialize)]
pub struct AssignmentDetail {
    assignment: Assignment,
    submission: Option<Submission>,
}

#[tauri::command]
pub async fn assignment_detail(state: State<'_, AppState>, course_id: u64, assignment_id: u64) -> Result<AssignmentDetail> {
    let canvas = state.canvas().await?;
    let (a, s) = tokio::join!(canvas.assignment(course_id, assignment_id), canvas.my_submission(course_id, assignment_id));
    let mut assignment = a?;
    assignment.course_id = course_id;
    let submission = match s {
        Ok(s) => Some(s),
        Err(CoreError::Unauthorized) => return Err(CoreError::Unauthorized),
        Err(_) => assignment.submission.clone(),
    };
    Ok(AssignmentDetail { assignment, submission })
}

#[tauri::command]
pub async fn mark_announcement_read(state: State<'_, AppState>, course_id: u64, topic_id: u64) -> Result<()> {
    state.canvas().await?.mark_announcement_read(course_id, topic_id).await
}

/// Opens a link in the default browser. Canvas links are re-checked to be on
/// your Canvas origin so a crafted page link can't pose as one.
#[tauri::command]
pub async fn open_external(app: AppHandle, state: State<'_, AppState>, url: String) -> Result<()> {
    state.touch();
    let u = external_link(&url)?;
    app.opener().open_url(u.as_str(), None::<&str>).map_err(|e| CoreError::Io(format!("Couldn't open the browser: {e}")))
}

#[tauri::command]
pub async fn open_in_canvas(app: AppHandle, state: State<'_, AppState>, url: String) -> Result<()> {
    let canvas = state.canvas().await?;
    let u = url::Url::parse(&url).map_err(|_| CoreError::Invalid("Bad Canvas link.".into()))?;
    if !same_origin(&u, canvas.base()) {
        return Err(CoreError::Invalid("That link is not on your Canvas site.".into()));
    }
    app.opener().open_url(u.as_str(), None::<&str>).map_err(|e| CoreError::Io(format!("Couldn't open the browser: {e}")))
}
