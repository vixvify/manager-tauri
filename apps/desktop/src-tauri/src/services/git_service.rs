use crate::error::{AppError, AppResult};
use crate::models::{GitBranch, GitPullResult};
use crate::services::project_service;
use crate::state::AppState;
use std::collections::HashSet;
use std::process::{Command, Output};

pub fn get_branches(state: &AppState, project_id: &str) -> AppResult<Vec<GitBranch>> {
    let project = project_service::get_project(state, project_id)?;
    let current_output = run_git(&project.path, &["branch", "--show-current"])?;
    if !current_output.status.success() {
        return Err(command_error("git branch --show-current", &current_output));
    }
    let current = output_text(&current_output).trim().to_string();

    let branches_output = run_git(
        &project.path,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes/origin",
        ],
    )?;
    if !branches_output.status.success() {
        return Err(command_error(
            "git for-each-ref --format=%(refname:short) refs/heads refs/remotes/origin",
            &branches_output,
        ));
    }

    let mut seen = HashSet::new();
    let mut branches = output_text(&branches_output)
        .lines()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .filter_map(|branch| {
            let name = branch.strip_prefix("origin/").unwrap_or(branch);
            if name == "HEAD" {
                return None;
            }
            (!name.is_empty() && seen.insert(name.to_string())).then(|| GitBranch {
                current: name == current,
                name: name.to_string(),
            })
        })
        .collect::<Vec<_>>();
    branches.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(branches)
}

pub fn pull(
    state: &AppState,
    project_id: &str,
    requested_branch: &str,
) -> AppResult<GitPullResult> {
    let project = project_service::get_project(state, project_id)?;
    let branch = requested_branch.trim();
    if branch.is_empty() {
        return Err(AppError::CommandFailed {
            command: "git pull".into(),
            message: "Choose a branch to pull.".into(),
        });
    }
    if branch.starts_with('-') || branch.chars().any(char::is_whitespace) {
        return Err(AppError::InvalidCommand(
            "The selected Git branch is invalid.".into(),
        ));
    }

    let output = run_git(&project.path, &["pull", "--no-edit", "origin", branch])?;
    let command = format!("git pull --no-edit origin {branch}");
    let text = output_text(&output);
    if !output.status.success() {
        return Err(AppError::CommandFailed {
            command,
            message: if text.trim().is_empty() {
                "Git pull failed.".into()
            } else {
                text.trim().to_string()
            },
        });
    }
    Ok(GitPullResult {
        branch: branch.to_string(),
        output: text,
    })
}

fn run_git(cwd: &str, args: &[&str]) -> AppResult<Output> {
    let mut command = Command::new(git_program());
    command.args(args).current_dir(cwd);
    configure_hidden(&mut command);
    command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::CommandFailed {
                command: format!("git {}", args.join(" ")),
                message: "Git was not found on PATH. Install Git and try again.".into(),
            }
        } else {
            error.into()
        }
    })
}

fn output_text(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.trim().is_empty() {
        stdout.into_owned()
    } else if stdout.trim().is_empty() {
        stderr.into_owned()
    } else {
        format!("{stdout}{stderr}")
    }
}

fn command_error(command: &str, output: &Output) -> AppError {
    let message = output_text(output).trim().to_string();
    AppError::CommandFailed {
        command: command.into(),
        message: if message.is_empty() {
            "Git command failed.".into()
        } else {
            message
        },
    }
}

fn git_program() -> &'static str {
    if cfg!(windows) {
        "git.exe"
    } else {
        "git"
    }
}

fn configure_hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}
