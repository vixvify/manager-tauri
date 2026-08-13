use crate::error::{AppError, AppResult};
use crate::services::process_service::tokenize_command;
use std::path::Path;
use std::process::{Command, Output};

pub fn is_detached_compose(command: &str) -> bool {
    let Ok(tokens) = tokenize_command(command) else {
        return false;
    };
    tokens
        .first()
        .map(|token| {
            token.eq_ignore_ascii_case("docker") || token.eq_ignore_ascii_case("docker.exe")
        })
        .unwrap_or(false)
        && tokens
            .get(1)
            .map(|token| token.eq_ignore_ascii_case("compose"))
            .unwrap_or(false)
        && tokens.iter().any(|token| token == "up")
        && tokens
            .iter()
            .any(|token| token == "-d" || token == "--detach")
}

pub fn is_running(command: &str, cwd: &Path) -> AppResult<bool> {
    let output = run_compose(command, cwd, ComposeAction::Status)?;
    Ok(output.status.success() && !String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

pub fn start(command: &str, cwd: &Path) -> AppResult<Output> {
    let output = run_compose(command, cwd, ComposeAction::Start)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(command_error(command, &output))
    }
}

pub fn stop(command: &str, cwd: &Path) -> AppResult<()> {
    let output = run_compose(command, cwd, ComposeAction::Stop)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(command, &output))
    }
}

fn run_compose(command: &str, cwd: &Path, action: ComposeAction) -> AppResult<Output> {
    let tokens = tokenize_command(command)?;
    if tokens.len() < 3
        || !tokens[0].eq_ignore_ascii_case("docker")
        || !tokens[1].eq_ignore_ascii_case("compose")
    {
        return Err(AppError::InvalidCommand(command.into()));
    }
    let up_index = tokens
        .iter()
        .position(|token| token.eq_ignore_ascii_case("up"))
        .ok_or_else(|| AppError::InvalidCommand(command.into()))?;
    let mut args = tokens[2..up_index].to_vec();
    match action {
        ComposeAction::Start => args.extend(tokens[up_index..].iter().cloned()),
        ComposeAction::Status => {
            args.extend([
                "ps".into(),
                "--services".into(),
                "--filter".into(),
                "status=running".into(),
            ]);
            args.extend(service_names(&tokens[up_index + 1..]));
        }
        ComposeAction::Stop => {
            args.push("stop".into());
            args.extend(service_names(&tokens[up_index + 1..]));
        }
    }
    if !matches!(action, ComposeAction::Start) {
        args.retain(|argument| argument != "-d" && argument != "--detach");
    }

    let mut process = Command::new(command_program());
    process.args(compose_args(&args)).current_dir(cwd);
    configure_hidden(&mut process);
    process.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::DockerNotAvailable(error.to_string())
        } else {
            error.into()
        }
    })
}

fn service_names(tokens: &[String]) -> Vec<String> {
    tokens
        .iter()
        .filter(|token| !token.starts_with('-'))
        .cloned()
        .collect()
}

fn compose_args(args: &[String]) -> Vec<String> {
    let mut result = vec!["compose".to_string()];
    result.extend(args.iter().cloned());
    result
}

fn command_program() -> &'static str {
    if cfg!(windows) {
        "docker.exe"
    } else {
        "docker"
    }
}

fn configure_hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

fn command_error(command: &str, output: &Output) -> AppError {
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if message.to_ascii_lowercase().contains("not recognized")
        || message.to_ascii_lowercase().contains("cannot find")
    {
        AppError::DockerNotAvailable(message)
    } else {
        AppError::CommandFailed {
            command: command.into(),
            message,
        }
    }
}

#[derive(Clone, Copy)]
enum ComposeAction {
    Start,
    Status,
    Stop,
}
