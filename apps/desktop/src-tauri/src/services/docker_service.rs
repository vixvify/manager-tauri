use crate::error::{AppError, AppResult};
use crate::services::process_service::tokenize_command;
use std::path::Path;
use std::process::{Command, Output};

pub fn is_compose_up(command: &str) -> bool {
    let Ok(tokens) = tokenize_command(command) else {
        return false;
    };
    compose_command_start(&tokens).is_some()
        && tokens.iter().any(|token| token.eq_ignore_ascii_case("up"))
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

pub fn build(command: &str, cwd: &Path) -> AppResult<Output> {
    let output = run_compose(command, cwd, ComposeAction::Build)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(command_error(command, &output))
    }
}

pub fn build_description(command: &str) -> AppResult<String> {
    let tokens = tokenize_command(command)?;
    let up_index = tokens
        .iter()
        .position(|token| token.eq_ignore_ascii_case("up"))
        .ok_or_else(|| AppError::InvalidCommand(command.into()))?;
    let mut build_tokens = tokens[..up_index].to_vec();
    build_tokens.push("build".into());
    build_tokens.extend(service_names(&tokens[up_index + 1..]));
    Ok(build_tokens.join(" "))
}

pub fn stop(command: &str, cwd: &Path) -> AppResult<()> {
    let output = run_compose(command, cwd, ComposeAction::Down)?;
    if !output.status.success() {
        return Err(command_error(command, &output));
    }

    for _ in 0..10 {
        if !is_running(command, cwd)? {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }

    let kill_output = run_compose(command, cwd, ComposeAction::Kill)?;
    if !kill_output.status.success() {
        return Err(command_error(command, &kill_output));
    }

    for _ in 0..10 {
        if !is_running(command, cwd)? {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }

    Err(AppError::CommandFailed {
        command: command.into(),
        message: "Docker Compose reported success, but the requested container is still running."
            .into(),
    })
}

fn run_compose(command: &str, cwd: &Path, action: ComposeAction) -> AppResult<Output> {
    let tokens = tokenize_command(command)?;
    let command_start =
        compose_command_start(&tokens).ok_or_else(|| AppError::InvalidCommand(command.into()))?;
    let up_index = tokens
        .iter()
        .position(|token| token.eq_ignore_ascii_case("up"))
        .ok_or_else(|| AppError::InvalidCommand(command.into()))?;
    let mut args = tokens[command_start..up_index].to_vec();
    match action {
        ComposeAction::Start => {
            args.push("up".into());
            if !tokens[up_index + 1..]
                .iter()
                .any(|token| token == "-d" || token == "--detach")
            {
                args.push("-d".into());
            }
            args.extend(tokens[up_index + 1..].iter().cloned());
        }
        ComposeAction::Status => {
            args.extend([
                "ps".into(),
                "--services".into(),
                "--filter".into(),
                "status=running".into(),
            ]);
            args.extend(service_names(&tokens[up_index + 1..]));
        }
        ComposeAction::Down => {
            args.push("down".into());
            args.push("--remove-orphans".into());
        }
        ComposeAction::Kill => {
            args.push("kill".into());
        }
        ComposeAction::Build => {
            args.push("build".into());
            args.extend(service_names(&tokens[up_index + 1..]));
        }
    }
    if !matches!(action, ComposeAction::Start) {
        args.retain(|argument| argument != "-d" && argument != "--detach");
    }

    let mut process = Command::new(command_program(&tokens));
    process
        .args(compose_args(&args, command_start == 2))
        .current_dir(cwd);
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
    let mut names = Vec::new();
    let mut skip_next = false;
    for token in tokens {
        if skip_next {
            skip_next = false;
            continue;
        }
        if matches!(token.as_str(), "--scale" | "--pull" | "--timeout") {
            skip_next = true;
            continue;
        }
        if token.starts_with('-') {
            continue;
        }
        names.push(token.clone());
    }
    names
}

fn compose_command_start(tokens: &[String]) -> Option<usize> {
    if tokens.len() >= 2
        && (tokens[0].eq_ignore_ascii_case("docker")
            || tokens[0].eq_ignore_ascii_case("docker.exe"))
        && tokens[1].eq_ignore_ascii_case("compose")
    {
        Some(2)
    } else if tokens
        .first()
        .map(|token| {
            token.eq_ignore_ascii_case("docker-compose")
                || token.eq_ignore_ascii_case("docker-compose.exe")
        })
        .unwrap_or(false)
    {
        Some(1)
    } else {
        None
    }
}

fn compose_args(args: &[String], docker_compose_subcommand: bool) -> Vec<String> {
    let mut result = if docker_compose_subcommand {
        vec!["compose".to_string()]
    } else {
        Vec::new()
    };
    result.extend(args.iter().cloned());
    result
}

fn command_program(tokens: &[String]) -> &'static str {
    if tokens
        .first()
        .map(|token| {
            token.eq_ignore_ascii_case("docker-compose")
                || token.eq_ignore_ascii_case("docker-compose.exe")
        })
        .unwrap_or(false)
    {
        if cfg!(windows) {
            "docker-compose.exe"
        } else {
            "docker-compose"
        }
    } else if cfg!(windows) {
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
    Down,
    Kill,
    Build,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_compose_up_with_or_without_detached_mode() {
        assert!(is_compose_up("docker compose up database"));
        assert!(is_compose_up("docker compose up -d database"));
    }

    #[test]
    fn uses_down_for_a_whole_compose_project() {
        let tokens = tokenize_command("docker compose up -d").expect("parse compose command");
        assert_eq!(compose_command_start(&tokens), Some(2));
    }

    #[test]
    fn recognizes_legacy_docker_compose() {
        let tokens = tokenize_command("docker-compose up -d").expect("parse compose command");
        assert_eq!(compose_command_start(&tokens), Some(1));
    }

    #[test]
    fn derives_build_command_from_compose_start_command() {
        assert_eq!(
            build_description("docker compose --env-file local.env up -d backend proxy")
                .expect("derive build command"),
            "docker compose --env-file local.env build backend proxy"
        );
    }
}
