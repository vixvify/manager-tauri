use crate::error::AppResult;
use crate::models::{Project, ProjectInput, ProjectReorderInput};
use crate::services::{process_service, project_service};
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn get_projects(state: State<'_, AppState>) -> AppResult<Vec<Project>> {
    project_service::get_projects(&state)
}

#[tauri::command]
pub fn add_project(input: ProjectInput, state: State<'_, AppState>) -> AppResult<Project> {
    project_service::add_project(&state, input)
}

#[tauri::command]
pub fn update_project(
    project_id: String,
    input: ProjectInput,
    state: State<'_, AppState>,
) -> AppResult<Project> {
    project_service::update_project(&state, &project_id, input)
}

#[tauri::command]
pub fn remove_project(
    project_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    process_service::stop_project(&app, &state, &project_id)?;
    project_service::remove_project(&state, &project_id)
}

#[tauri::command]
pub fn reorder_projects(
    input: ProjectReorderInput,
    state: State<'_, AppState>,
) -> AppResult<Vec<Project>> {
    project_service::reorder_projects(&state, input)
}
