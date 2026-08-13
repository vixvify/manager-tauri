use crate::error::AppResult;
use crate::models::{ProjectRuntimeState, ServiceLogEntry, ServiceRuntimeState};
use crate::services::process_service;
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn get_runtime(state: State<'_, AppState>) -> AppResult<Vec<ProjectRuntimeState>> {
    process_service::get_runtime(&state)
}

#[tauri::command]
pub fn get_project_runtime(
    project_id: String,
    state: State<'_, AppState>,
) -> AppResult<ProjectRuntimeState> {
    process_service::get_project_runtime(&state, &project_id)
}

#[tauri::command]
pub fn get_service_logs(
    project_id: String,
    service_id: String,
    state: State<'_, AppState>,
) -> AppResult<Vec<ServiceLogEntry>> {
    process_service::get_logs(&state, &project_id, &service_id)
}

#[tauri::command]
pub fn start_project(
    project_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ProjectRuntimeState> {
    process_service::start_project(&app, &state, &project_id)
}

#[tauri::command]
pub fn stop_project(
    project_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ProjectRuntimeState> {
    process_service::stop_project(&app, &state, &project_id)
}

#[tauri::command]
pub fn start_service(
    project_id: String,
    service_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ServiceRuntimeState> {
    process_service::start_service(&app, &state, &project_id, &service_id)
}

#[tauri::command]
pub fn stop_service(
    project_id: String,
    service_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ServiceRuntimeState> {
    process_service::stop_service(&app, &state, &project_id, &service_id)
}

#[tauri::command]
pub fn restart_service(
    project_id: String,
    service_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ServiceRuntimeState> {
    process_service::restart_service(&app, &state, &project_id, &service_id)
}
