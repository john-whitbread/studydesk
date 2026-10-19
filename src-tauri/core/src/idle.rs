//! System-wide idle time. On Windows this is time since the last keyboard or
//! mouse input anywhere in the session, so the app also locks when you walk
//! away or lock Windows. Elsewhere it returns None and the app falls back to
//! in-app activity.

use std::time::Duration;

#[cfg(windows)]
pub fn system_idle() -> Option<Duration> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    // SAFETY: `info` is a valid, correctly sized LASTINPUTINFO.
    let ok = unsafe { GetLastInputInfo(&mut info) };
    if ok == 0 {
        return None;
    }
    // Both are 32-bit millisecond tick counts; wrapping_sub handles the
    // 49.7-day rollover.
    let now = unsafe { GetTickCount() };
    Some(Duration::from_millis(now.wrapping_sub(info.dwTime) as u64))
}

#[cfg(not(windows))]
pub fn system_idle() -> Option<Duration> {
    None
}
