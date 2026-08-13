use crate::error::{AppError, AppResult};
use crate::models::{GitBranch, GitPullResult};
use crate::services::git_service;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn get_git_branches(
    project_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<GitBranch>> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || git_service::get_branches(&state, &project_id))
        .await
        .map_err(|error| AppError::CommandFailed {
            command: "git branch".into(),
            message: error.to_string(),
        })?
}

#[tauri::command]
pub async fn pull_project(
    project_id: String,
    branch: String,
    state: State<'_, AppState>,
) -> AppResult<GitPullResult> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || git_service::pull(&state, &project_id, &branch))
        .await
        .map_err(|error| AppError::CommandFailed {
            command: "git pull".into(),
            message: error.to_string(),
        })?
}
