use crate::error::{AppError, AppResult};
use crate::models::{Project, ServiceLogEntry, ServiceRuntimeState};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Child;
use std::sync::{Arc, Mutex};

pub struct ManagedProcess {
    pub pid: u32,
    pub child: Arc<Mutex<Child>>,
}

pub struct AppStateData {
    pub project_file: PathBuf,
    pub projects: Vec<Project>,
    pub processes: HashMap<String, ManagedProcess>,
    pub runtime: HashMap<String, ServiceRuntimeState>,
    pub logs: HashMap<String, Vec<ServiceLogEntry>>,
}

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<Mutex<AppStateData>>,
}

impl AppState {
    pub fn load(project_file: PathBuf) -> AppResult<Self> {
        let projects = if project_file.exists() {
            let contents = std::fs::read_to_string(&project_file)?;
            serde_json::from_str(&contents)?
        } else {
            Vec::new()
        };

        if let Some(parent) = project_file.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let state = Self {
            inner: Arc::new(Mutex::new(AppStateData {
                project_file,
                projects,
                processes: HashMap::new(),
                runtime: HashMap::new(),
                logs: HashMap::new(),
            })),
        };
        state.persist()?;
        Ok(state)
    }

    pub fn persist(&self) -> AppResult<()> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AppError::Storage("State lock poisoned.".into()))?;
        let contents = serde_json::to_string_pretty(&guard.projects)?;
        std::fs::write(&guard.project_file, format!("{contents}\n"))?;
        Ok(())
    }
}

pub fn key(project_id: &str, service_id: &str) -> String {
    format!("{project_id}:{service_id}")
}
