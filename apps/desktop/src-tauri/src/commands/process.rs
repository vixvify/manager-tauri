use crate::error::{AppError, AppResult};
use crate::models::{BuildResult, ProjectRuntimeState, ServiceLogEntry, ServiceRuntimeState};
use crate::services::process_service;
use crate::state::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn get_runtime(state: State<'_, AppState>) -> AppResult<Vec<ProjectRuntimeState>> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || process_service::get_runtime(&state))
        .await
        .map_err(|error| AppError::CommandFailed {
            command: "get runtime".into(),
            message: error.to_string(),
        })?
}

#[tauri::command]
pub async fn get_project_runtime(
    project_id: String,
    state: State<'_, AppState>,
) -> AppResult<ProjectRuntimeState> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        process_service::get_project_runtime(&state, &project_id)
    })
    .await
    .map_err(|error| AppError::CommandFailed {
        command: "get project runtime".into(),
        message: error.to_string(),
    })?
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
pub async fn start_project(
    project_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ProjectRuntimeState> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        process_service::start_project(&app, &state, &project_id)
    })
    .await
    .map_err(|error| AppError::CommandFailed {
        command: "start project".into(),
        message: error.to_string(),
    })?
}

#[tauri::command]
pub async fn stop_project(
    project_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ProjectRuntimeState> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        process_service::stop_project(&app, &state, &project_id)
    })
    .await
    .map_err(|error| AppError::CommandFailed {
        command: "stop project".into(),
        message: error.to_string(),
    })?
}

#[tauri::command]
pub async fn start_service(
    project_id: String,
    service_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ServiceRuntimeState> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        process_service::start_service(&app, &state, &project_id, &service_id)
    })
    .await
    .map_err(|error| AppError::CommandFailed {
        command: "start service".into(),
        message: error.to_string(),
    })?
}

#[tauri::command]
pub async fn stop_service(
    project_id: String,
    service_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ServiceRuntimeState> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        process_service::stop_service(&app, &state, &project_id, &service_id)
    })
    .await
    .map_err(|error| AppError::CommandFailed {
        command: "stop service".into(),
        message: error.to_string(),
    })?
}

#[tauri::command]
pub async fn restart_service(
    project_id: String,
    service_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<ServiceRuntimeState> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        process_service::restart_service(&app, &state, &project_id, &service_id)
    })
    .await
    .map_err(|error| AppError::CommandFailed {
        command: "restart service".into(),
        message: error.to_string(),
    })?
}

#[tauri::command]
pub async fn build_service(
    project_id: String,
    service_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<BuildResult> {
    let state = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        process_service::build_service(&app, &state, &project_id, &service_id)
    })
    .await
    .map_err(|error| AppError::CommandFailed {
        command: "build service".into(),
        message: error.to_string(),
    })?
}
