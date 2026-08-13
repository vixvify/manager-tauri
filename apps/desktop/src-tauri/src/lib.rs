use tauri::{Manager, RunEvent};

mod commands;
mod error;
mod models;
mod services;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = state::AppState::load(data_dir.join("projects.json"))
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error>)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::project::get_projects,
            commands::project::get_project,
            commands::project::add_project,
            commands::project::update_project,
            commands::project::remove_project,
            commands::project::reorder_projects,
            commands::git::get_git_branches,
            commands::git::pull_project,
            commands::process::get_runtime,
            commands::process::get_project_runtime,
            commands::process::get_service_logs,
            commands::process::start_project,
            commands::process::stop_project,
            commands::process::start_service,
            commands::process::stop_service,
            commands::process::restart_service,
            commands::process::build_service,
        ])
        .build(tauri::generate_context!())
        .expect("error while running DevDeck")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::Exit) {
                if let Some(state) = app_handle.try_state::<state::AppState>() {
                    let _ = services::process_service::stop_all(app_handle, &state);
                }
            }
        });
}
