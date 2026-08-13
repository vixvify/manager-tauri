use crate::error::{AppError, AppResult};
use crate::models::{Project, ProjectInput, ProjectReorderInput, Service, ServiceInput};
use crate::state::AppState;
use std::path::Path;
use uuid::Uuid;

pub fn get_projects(state: &AppState) -> AppResult<Vec<Project>> {
    let guard = state
        .inner
        .lock()
        .map_err(|_| AppError::Storage("State lock poisoned.".into()))?;
    Ok(guard.projects.clone())
}

pub fn get_project(state: &AppState, project_id: &str) -> AppResult<Project> {
    let guard = state
        .inner
        .lock()
        .map_err(|_| AppError::Storage("State lock poisoned.".into()))?;
    guard
        .projects
        .iter()
        .find(|project| project.id == project_id)
        .cloned()
        .ok_or_else(|| AppError::ProjectNotFound(project_id.into()))
}

pub fn add_project(state: &AppState, input: ProjectInput) -> AppResult<Project> {
    let project = normalize_project(input, None)?;
    {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| AppError::Storage("State lock poisoned.".into()))?;
        guard.projects.push(project.clone());
    }
    state.persist()?;
    Ok(project)
}

pub fn update_project(
    state: &AppState,
    project_id: &str,
    input: ProjectInput,
) -> AppResult<Project> {
    let existing = get_project(state, project_id)?;
    let project = normalize_project(input, Some(&existing))?;
    {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| AppError::Storage("State lock poisoned.".into()))?;
        let index = guard
            .projects
            .iter()
            .position(|candidate| candidate.id == project_id)
            .ok_or_else(|| AppError::ProjectNotFound(project_id.into()))?;
        guard.projects[index] = project.clone();
    }
    state.persist()?;
    Ok(project)
}

pub fn remove_project(state: &AppState, project_id: &str) -> AppResult<()> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| AppError::Storage("State lock poisoned.".into()))?;
    let index = guard
        .projects
        .iter()
        .position(|project| project.id == project_id)
        .ok_or_else(|| AppError::ProjectNotFound(project_id.into()))?;
    guard.projects.remove(index);
    drop(guard);
    state.persist()
}

pub fn reorder_projects(state: &AppState, input: ProjectReorderInput) -> AppResult<Vec<Project>> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| AppError::Storage("State lock poisoned.".into()))?;
    if input.project_ids.len() != guard.projects.len() {
        return Err(AppError::Storage(
            "Project reorder must include every project exactly once.".into(),
        ));
    }

    let mut reordered = Vec::with_capacity(guard.projects.len());
    for project_id in input.project_ids {
        let project = guard
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
            .ok_or_else(|| AppError::ProjectNotFound(project_id.clone()))?;
        if reordered
            .iter()
            .any(|candidate: &Project| candidate.id == project.id)
        {
            return Err(AppError::Storage(
                "Project reorder contains a duplicate project.".into(),
            ));
        }
        reordered.push(project);
    }

    guard.projects = reordered.clone();
    drop(guard);
    state.persist()?;
    Ok(reordered)
}

fn normalize_project(input: ProjectInput, existing: Option<&Project>) -> AppResult<Project> {
    let name = input.name.trim().to_string();
    let path = input.path.trim().to_string();
    if name.is_empty() {
        return Err(AppError::InvalidProjectName);
    }
    if path.is_empty() {
        return Err(AppError::InvalidProjectPath(
            "A project path is required.".into(),
        ));
    }
    if !Path::new(&path).is_dir() {
        return Err(AppError::InvalidProjectPath(format!(
            "Project directory does not exist: {path}"
        )));
    }

    let existing_services = existing.map(|project| &project.services);
    let services = input
        .services
        .unwrap_or_default()
        .into_iter()
        .map(|service| normalize_service(service, existing_services))
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Project {
        id: existing
            .map(|project| project.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        name,
        path,
        services,
    })
}

fn normalize_service(input: ServiceInput, existing: Option<&Vec<Service>>) -> AppResult<Service> {
    let name = input.name.trim().to_string();
    let command = input.command.trim().to_string();
    if name.is_empty() || command.is_empty() {
        return Err(AppError::InvalidService);
    }
    let id = input
        .id
        .filter(|id| {
            existing
                .map(|services| services.iter().any(|service| service.id == *id))
                .unwrap_or(false)
        })
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    Ok(Service {
        id,
        name,
        command,
        cwd: input
            .cwd
            .and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string())),
        port: input.port,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::fs;

    #[test]
    fn project_crud_and_order_are_persisted() {
        let test_dir = std::env::temp_dir().join(format!("devdeck-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&test_dir).expect("create test directory");
        let state = AppState::load(test_dir.join("projects.json")).expect("load state");

        let first = add_project(
            &state,
            ProjectInput {
                name: "First".into(),
                path: test_dir.to_string_lossy().into_owned(),
                services: None,
            },
        )
        .expect("add first project");
        let second = add_project(
            &state,
            ProjectInput {
                name: "Second".into(),
                path: test_dir.to_string_lossy().into_owned(),
                services: None,
            },
        )
        .expect("add second project");

        let reordered = reorder_projects(
            &state,
            ProjectReorderInput {
                project_ids: vec![second.id.clone(), first.id.clone()],
            },
        )
        .expect("reorder projects");
        assert_eq!(reordered[0].id, second.id);

        let loaded = AppState::load(test_dir.join("projects.json")).expect("reload state");
        assert_eq!(
            get_projects(&loaded).expect("read projects")[0].id,
            second.id
        );

        remove_project(&loaded, &first.id).expect("remove first project");
        remove_project(&loaded, &second.id).expect("remove second project");
        fs::remove_dir_all(test_dir).expect("remove test directory");
    }

    #[test]
    fn rejects_missing_project_directory() {
        let state_file = std::env::temp_dir().join(format!("devdeck-test-{}.json", Uuid::new_v4()));
        let state = AppState::load(state_file.clone()).expect("load state");
        let result = add_project(
            &state,
            ProjectInput {
                name: "Missing".into(),
                path: state_file
                    .with_extension("missing")
                    .to_string_lossy()
                    .into_owned(),
                services: None,
            },
        );
        assert!(matches!(result, Err(AppError::InvalidProjectPath(_))));
        let _ = fs::remove_file(state_file);
    }
}
