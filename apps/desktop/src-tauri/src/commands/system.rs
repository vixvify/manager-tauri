use std::process::Command;

use crate::error::{AppError, AppResult};

#[tauri::command]
pub fn open_service_url(port: u16) -> AppResult<()> {
    if port == 0 {
        return Err(AppError::InvalidCommand("A service URL needs a valid port.".into()));
    }

    let url = format!("http://localhost:{port}");
    let mut command = if cfg!(windows) {
        let mut browser = Command::new("rundll32.exe");
        browser.args(["url.dll,FileProtocolHandler", &url]);
        browser
    } else if cfg!(target_os = "macos") {
        let mut browser = Command::new("open");
        browser.arg(&url);
        browser
    } else {
        let mut browser = Command::new("xdg-open");
        browser.arg(&url);
        browser
    };

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    command.spawn().map(|_| ()).map_err(|error| AppError::CommandFailed {
        command: format!("open {url}"),
        message: error.to_string(),
    })
}
