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
pub fn get_project(project_id: String, state: State<'_, AppState>) -> AppResult<Project> {
    project_service::get_project(&state, &project_id)
}

#[tauri::command]
pub fn add_project(input: ProjectInput, state: State<'_, AppState>) -> AppResult<Project> {
    project_service::add_project(&state, input)
}

#[tauri::command]
pub fn update_project(
    project_id: String,
    input: ProjectInput,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Project> {
    let existing = project_service::get_project(&state, &project_id)?;
    if project_configuration_changed(&existing, &input) {
        process_service::stop_project(&app, &state, &project_id)?;
    }
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

fn project_configuration_changed(project: &Project, input: &ProjectInput) -> bool {
    if project.path != input.path.trim() {
        return true;
    }

    let services = input.services.as_deref().unwrap_or_default();
    project.services.len() != services.len()
        || project
            .services
            .iter()
            .zip(services.iter())
            .any(|(current, next)| {
                next.id.as_deref() != Some(current.id.as_str())
                    || current.command != next.command.trim()
                    || current.cwd.as_deref()
                        != next
                            .cwd
                            .as_deref()
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                    || current.port != next.port
            })
}
