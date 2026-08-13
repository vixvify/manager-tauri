use crate::error::{AppError, AppResult};
use crate::models::{
    BuildResult, DevDeckEvent, LogStream, PortStatus, ProjectRuntimeState, RuntimeMode, Service,
    ServiceLogEntry, ServiceLogEvent, ServiceRuntimeState, ServiceStatus, ServiceStatusEvent,
};
use crate::services::{docker_service, port_service, project_service};
use crate::state::{key, AppState, ManagedProcess};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub fn get_runtime(state: &AppState) -> AppResult<Vec<ProjectRuntimeState>> {
    let projects = project_service::get_projects(state)?;
    projects
        .iter()
        .map(|project| get_project_runtime(state, project.id.as_str()))
        .collect()
}

pub fn get_project_runtime(state: &AppState, project_id: &str) -> AppResult<ProjectRuntimeState> {
    let project = project_service::get_project(state, project_id)?;
    let mut services = std::collections::HashMap::new();
    for service in &project.services {
        let mut runtime = get_service_runtime(state, project_id, service);
        if docker_service::is_compose_up(&service.command) {
            if let Ok(cwd) = resolve_working_directory(&project.path, service.cwd.as_deref()) {
                match docker_service::is_running(&service.command, &cwd) {
                    Ok(true) => {
                        runtime =
                            runtime_state(service, ServiceStatus::Running, RuntimeMode::Docker);
                        runtime.port_status = port_status(service.port)?;
                    }
                    Ok(false) => {
                        runtime =
                            runtime_state(service, ServiceStatus::Stopped, RuntimeMode::Docker);
                        runtime.port_status = service.port.map(|_| PortStatus::Available);
                    }
                    Err(error) => {
                        runtime = runtime_state(service, ServiceStatus::Error, RuntimeMode::Docker);
                        runtime.error = Some(error.to_string());
                    }
                }
            }
        }
        if let Ok(mut guard) = state.inner.lock() {
            guard
                .runtime
                .insert(key(project_id, &service.id), runtime.clone());
        }
        services.insert(service.id.clone(), runtime);
    }
    let statuses = services
        .values()
        .map(|service| &service.status)
        .collect::<Vec<_>>();
    let status = if statuses
        .iter()
        .any(|value| matches!(value, ServiceStatus::Error))
    {
        ServiceStatus::Error
    } else if statuses
        .iter()
        .any(|value| matches!(value, ServiceStatus::Stopping))
    {
        ServiceStatus::Stopping
    } else if statuses
        .iter()
        .any(|value| matches!(value, ServiceStatus::Starting))
    {
        ServiceStatus::Starting
    } else if statuses
        .iter()
        .any(|value| matches!(value, ServiceStatus::Running))
    {
        ServiceStatus::Running
    } else {
        ServiceStatus::Stopped
    };
    Ok(ProjectRuntimeState {
        project_id: project.id,
        status,
        services,
    })
}

pub fn get_logs(
    state: &AppState,
    project_id: &str,
    service_id: &str,
) -> AppResult<Vec<ServiceLogEntry>> {
    project_service::get_project(state, project_id)?
        .services
        .iter()
        .find(|service| service.id == service_id)
        .ok_or_else(|| AppError::ServiceNotFound(service_id.into()))?;
    let guard = state
        .inner
        .lock()
        .map_err(|_| AppError::Storage("State lock poisoned.".into()))?;
    Ok(guard
        .logs
        .get(&key(project_id, service_id))
        .cloned()
        .unwrap_or_default())
}

pub fn start_project(
    app: &AppHandle,
    state: &AppState,
    project_id: &str,
) -> AppResult<ProjectRuntimeState> {
    let project = project_service::get_project(state, project_id)?;
    for service in project.services {
        start_service(app, state, project_id, &service.id)?;
    }
    get_project_runtime(state, project_id)
}

pub fn stop_project(
    app: &AppHandle,
    state: &AppState,
    project_id: &str,
) -> AppResult<ProjectRuntimeState> {
    let project = project_service::get_project(state, project_id)?;
    let docker_projects = project
        .services
        .iter()
        .filter(|service| docker_service::is_compose_up(&service.command))
        .map(|service| {
            resolve_working_directory(&project.path, service.cwd.as_deref())
                .map(|cwd| (service.command.clone(), cwd))
        })
        .collect::<AppResult<Vec<_>>>()?;

    for service in &project.services {
        stop_service(app, state, project_id, &service.id)?;
    }

    for (command, cwd) in docker_projects {
        docker_service::down(&command, &cwd)?;
    }

    get_project_runtime(state, project_id)
}

pub fn stop_all(app: &AppHandle, state: &AppState) -> AppResult<()> {
    let projects = project_service::get_projects(state)?;
    for project in projects {
        stop_project(app, state, &project.id)?;
    }
    Ok(())
}

pub fn start_service(
    app: &AppHandle,
    state: &AppState,
    project_id: &str,
    service_id: &str,
) -> AppResult<ServiceRuntimeState> {
    let project = project_service::get_project(state, project_id)?;
    let service = project
        .services
        .iter()
        .find(|service| service.id == service_id)
        .cloned()
        .ok_or_else(|| AppError::ServiceNotFound(service_id.into()))?;
    let service_key = key(project_id, service_id);
    let current = get_project_runtime(state, project_id)?
        .services
        .get(service_id)
        .cloned()
        .unwrap_or_else(|| get_service_runtime(state, project_id, &service));
    if matches!(
        current.status,
        ServiceStatus::Running | ServiceStatus::Starting
    ) {
        return Err(AppError::ProcessAlreadyRunning);
    }
    if matches!(current.status, ServiceStatus::Stopping) {
        return Err(AppError::ProcessStillStopping);
    }

    let cwd = resolve_working_directory(&project.path, service.cwd.as_deref())?;
    let is_docker = docker_service::is_compose_up(&service.command);
    if is_docker {
        match docker_service::is_running(&service.command, &cwd) {
            Ok(true) => {
                let mut running =
                    runtime_state(&service, ServiceStatus::Running, RuntimeMode::Docker);
                running.port_status = port_status(service.port)?;
                set_runtime_state(app, state, project_id, running.clone());
                return Ok(running);
            }
            Ok(false) => {}
            Err(error) => {
                let failed = error.to_string();
                let mut error_state =
                    runtime_state(&service, ServiceStatus::Error, RuntimeMode::Docker);
                error_state.error = Some(failed.clone());
                set_runtime_state(app, state, project_id, error_state);
                return Err(error);
            }
        }
    }

    if let Some(port) = service.port {
        if let Err(error) = port_service::ensure_available(port) {
            let mut failed = runtime_state(&service, ServiceStatus::Error, RuntimeMode::Process);
            failed.port_status = Some(PortStatus::Occupied);
            failed.error = Some(error.to_string());
            set_runtime_state(app, state, project_id, failed);
            return Err(error);
        }
    }

    if is_docker {
        let starting = runtime_state(&service, ServiceStatus::Starting, RuntimeMode::Docker);
        set_runtime_state(app, state, project_id, starting);
        append_log(
            app,
            state,
            project_id,
            service_id,
            LogStream::Stdout,
            format!("> {}\n", service.command),
        );
        let output = match docker_service::start(&service.command, &cwd) {
            Ok(output) => output,
            Err(error) => {
                let mut failed = runtime_state(&service, ServiceStatus::Error, RuntimeMode::Docker);
                failed.error = Some(error.to_string());
                set_runtime_state(app, state, project_id, failed);
                return Err(error);
            }
        };
        append_command_output(app, state, project_id, service_id, &output);
        if !docker_service::is_running(&service.command, &cwd)? {
            let message =
                "Docker Compose completed, but no requested container is running.".to_string();
            let mut failed = runtime_state(&service, ServiceStatus::Error, RuntimeMode::Docker);
            failed.error = Some(message.clone());
            set_runtime_state(app, state, project_id, failed);
            return Err(AppError::CommandFailed {
                command: service.command,
                message,
            });
        }
        let mut running = runtime_state(&service, ServiceStatus::Running, RuntimeMode::Docker);
        running.port_status = port_status(service.port)?;
        set_runtime_state(app, state, project_id, running.clone());
        return Ok(running);
    }

    let mut child = match spawn_process(&service.command, &cwd) {
        Ok(child) => child,
        Err(error) => {
            let mut failed = runtime_state(&service, ServiceStatus::Error, RuntimeMode::Process);
            failed.error = Some(error.to_string());
            set_runtime_state(app, state, project_id, failed);
            return Err(error);
        }
    };
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| AppError::Storage("State lock poisoned.".into()))?;
        guard.processes.insert(
            service_key.clone(),
            ManagedProcess {
                pid,
                child: child.clone(),
            },
        );
    }
    let mut starting = runtime_state(&service, ServiceStatus::Starting, RuntimeMode::Process);
    starting.pid = Some(pid);
    set_runtime_state(app, state, project_id, starting);
    append_log(
        app,
        state,
        project_id,
        service_id,
        LogStream::Stdout,
        format!("> {}\n", service.command),
    );

    if let Some(reader) = stdout {
        spawn_log_reader(
            reader,
            app.clone(),
            state.clone(),
            project_id.to_string(),
            service_id.to_string(),
            LogStream::Stdout,
        );
    }
    if let Some(reader) = stderr {
        spawn_log_reader(
            reader,
            app.clone(),
            state.clone(),
            project_id.to_string(),
            service_id.to_string(),
            LogStream::Stderr,
        );
    }
    let mut running = runtime_state(&service, ServiceStatus::Running, RuntimeMode::Process);
    running.pid = Some(pid);
    running.port_status = port_status(service.port)?;
    set_runtime_state(app, state, project_id, running.clone());
    spawn_process_monitor(
        app.clone(),
        state.clone(),
        project_id.to_string(),
        service.clone(),
        child,
    );
    Ok(running)
}

pub fn stop_service(
    app: &AppHandle,
    state: &AppState,
    project_id: &str,
    service_id: &str,
) -> AppResult<ServiceRuntimeState> {
    let project = project_service::get_project(state, project_id)?;
    let service = project
        .services
        .iter()
        .find(|service| service.id == service_id)
        .cloned()
        .ok_or_else(|| AppError::ServiceNotFound(service_id.into()))?;
    let service_key = key(project_id, service_id);
    let current = get_project_runtime(state, project_id)?
        .services
        .get(service_id)
        .cloned()
        .unwrap_or_else(|| get_service_runtime(state, project_id, &service));
    let managed = state
        .inner
        .lock()
        .map_err(|_| AppError::Storage("State lock poisoned.".into()))?
        .processes
        .get(&service_key)
        .map(|process| (process.pid, process.child.clone()));

    if let Some((pid, child)) = managed {
        if matches!(current.status, ServiceStatus::Stopping) {
            return Ok(current);
        }
        let mut stopping = current.clone();
        stopping.status = ServiceStatus::Stopping;
        stopping.error = None;
        set_runtime_state(app, state, project_id, stopping);
        terminate_process(pid, &child)?;
        wait_until_stopped(state, &service_key);
        let mut stopped = runtime_state(&service, ServiceStatus::Stopped, RuntimeMode::Process);
        stopped.port_status = service.port.map(|_| PortStatus::Available);
        set_runtime_state(app, state, project_id, stopped.clone());
        return Ok(stopped);
    }

    if matches!(current.mode, Some(RuntimeMode::Docker))
        && !matches!(current.status, ServiceStatus::Stopped)
    {
        let mut stopping = current.clone();
        stopping.status = ServiceStatus::Stopping;
        stopping.error = None;
        set_runtime_state(app, state, project_id, stopping);
        match docker_service::stop(
            &service.command,
            &resolve_working_directory(&project.path, service.cwd.as_deref())?,
        ) {
            Ok(()) => {
                let mut stopped =
                    runtime_state(&service, ServiceStatus::Stopped, RuntimeMode::Docker);
                stopped.port_status = Some(PortStatus::Available);
                set_runtime_state(app, state, project_id, stopped.clone());
                return Ok(stopped);
            }
            Err(error) => {
                let mut failed = current;
                failed.status = ServiceStatus::Error;
                failed.error = Some(error.to_string());
                set_runtime_state(app, state, project_id, failed);
                return Err(error);
            }
        }
    }

    Ok(current)
}

pub fn restart_service(
    app: &AppHandle,
    state: &AppState,
    project_id: &str,
    service_id: &str,
) -> AppResult<ServiceRuntimeState> {
    let _ = stop_service(app, state, project_id, service_id)?;
    start_service(app, state, project_id, service_id)
}

pub fn build_service(
    app: &AppHandle,
    state: &AppState,
    project_id: &str,
    service_id: &str,
) -> AppResult<BuildResult> {
    let project = project_service::get_project(state, project_id)?;
    let service = project
        .services
        .iter()
        .find(|service| service.id == service_id)
        .cloned()
        .ok_or_else(|| AppError::ServiceNotFound(service_id.into()))?;
    let cwd = resolve_working_directory(&project.path, service.cwd.as_deref())?;
    let configured_command = service
        .build_command
        .as_deref()
        .filter(|command| !command.trim().is_empty());
    let is_docker = docker_service::is_compose_up(&service.command);
    let command = configured_command.unwrap_or("docker compose build");
    let display_command = if configured_command.is_none() && is_docker {
        docker_service::build_description(&service.command).unwrap_or_else(|_| command.into())
    } else {
        command.into()
    };
    append_log(
        app,
        state,
        project_id,
        service_id,
        LogStream::Stdout,
        format!("> {display_command}\n"),
    );

    let output = if configured_command.is_none() && is_docker {
        docker_service::build(&service.command, &cwd)?
    } else {
        let child = spawn_process(command, &cwd)?;
        child
            .wait_with_output()
            .map_err(|error| AppError::CommandFailed {
                command: command.into(),
                message: error.to_string(),
            })?
    };
    append_command_output(app, state, project_id, service_id, &output);
    let output_text = command_output_text(&output);
    if !output.status.success() {
        return Err(AppError::CommandFailed {
            command: command.into(),
            message: if output_text.trim().is_empty() {
                "Build command failed.".into()
            } else {
                output_text.trim().to_string()
            },
        });
    }
    Ok(BuildResult {
        success: true,
        output: output_text,
    })
}

fn runtime_state(
    service: &Service,
    status: ServiceStatus,
    mode: RuntimeMode,
) -> ServiceRuntimeState {
    ServiceRuntimeState {
        service_id: service.id.clone(),
        status: status.clone(),
        mode: Some(mode),
        pid: None,
        port: service.port,
        port_status: service.port.map(|_| {
            if matches!(status, ServiceStatus::Starting) {
                PortStatus::Checking
            } else {
                PortStatus::Unknown
            }
        }),
        error: None,
    }
}

fn get_service_runtime(
    state: &AppState,
    _project_id: &str,
    service: &Service,
) -> ServiceRuntimeState {
    let runtime = state
        .inner
        .lock()
        .ok()
        .and_then(|guard| guard.runtime.get(&key(_project_id, &service.id)).cloned());
    runtime.unwrap_or_else(|| ServiceRuntimeState {
        service_id: service.id.clone(),
        status: ServiceStatus::Stopped,
        mode: None,
        pid: None,
        port: service.port,
        port_status: service.port.map(|_| PortStatus::Unknown),
        error: None,
    })
}

fn set_runtime_state(
    app: &AppHandle,
    state: &AppState,
    project_id: &str,
    runtime: ServiceRuntimeState,
) {
    let event = ServiceStatusEvent {
        event_type: "service:status",
        project_id: project_id.to_string(),
        service_id: runtime.service_id.clone(),
        status: runtime.status.clone(),
        pid: runtime.pid,
        error: runtime.error.clone(),
    };
    if let Ok(mut guard) = state.inner.lock() {
        guard
            .runtime
            .insert(key(project_id, &runtime.service_id), runtime);
    }
    let _ = app.emit("service:status", DevDeckEvent::Status(event));
}

fn append_log(
    app: &AppHandle,
    state: &AppState,
    project_id: &str,
    service_id: &str,
    stream: LogStream,
    message: String,
) {
    if message.is_empty() {
        return;
    }
    let timestamp = chrono_like_timestamp();
    let entry = ServiceLogEntry {
        timestamp: timestamp.clone(),
        stream: stream.clone(),
        message: message.clone(),
    };
    if let Ok(mut guard) = state.inner.lock() {
        let entries = guard.logs.entry(key(project_id, service_id)).or_default();
        entries.push(entry);
        if entries.len() > 500 {
            let excess = entries.len() - 500;
            entries.drain(0..excess);
        }
    }
    let event = ServiceLogEvent {
        event_type: "service:log",
        project_id: project_id.to_string(),
        service_id: service_id.to_string(),
        timestamp,
        stream,
        message,
    };
    let _ = app.emit("service:log", DevDeckEvent::Log(event));
}

fn append_command_output(
    app: &AppHandle,
    state: &AppState,
    project_id: &str,
    service_id: &str,
    output: &std::process::Output,
) {
    append_log(
        app,
        state,
        project_id,
        service_id,
        LogStream::Stdout,
        String::from_utf8_lossy(&output.stdout).to_string(),
    );
    append_log(
        app,
        state,
        project_id,
        service_id,
        LogStream::Stderr,
        String::from_utf8_lossy(&output.stderr).to_string(),
    );
}

fn command_output_text(output: &std::process::Output) -> String {
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

fn spawn_log_reader<R: Read + Send + 'static>(
    reader: R,
    app: AppHandle,
    state: AppState,
    project_id: String,
    service_id: String,
    stream: LogStream,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            append_log(
                &app,
                &state,
                &project_id,
                &service_id,
                stream.clone(),
                format!("{line}\n"),
            );
        }
    });
}

fn spawn_process_monitor(
    app: AppHandle,
    state: AppState,
    project_id: String,
    service: Service,
    child: Arc<Mutex<Child>>,
) {
    let app_for_monitor = app.clone();
    let state_for_monitor = state.clone();
    let project_for_monitor = project_id.clone();
    let service_for_monitor = service.clone();
    thread::spawn(move || {
        let result = loop {
            let process_state = child
                .lock()
                .ok()
                .and_then(|mut process| process.try_wait().ok());
            match process_state {
                Some(Some(status)) => break Some(status),
                Some(None) => thread::sleep(Duration::from_millis(50)),
                None => break None,
            }
        };
        let service_key = key(&project_for_monitor, &service_for_monitor.id);
        let was_stopping = state_for_monitor
            .inner
            .lock()
            .ok()
            .and_then(|guard| {
                guard
                    .runtime
                    .get(&service_key)
                    .map(|runtime| matches!(runtime.status, ServiceStatus::Stopping))
            })
            .unwrap_or(false);
        let mut runtime = get_service_runtime(
            &state_for_monitor,
            &project_for_monitor,
            &service_for_monitor,
        );
        runtime.status = if was_stopping
            || result
                .as_ref()
                .map(|status| status.success())
                .unwrap_or(false)
        {
            ServiceStatus::Stopped
        } else {
            ServiceStatus::Error
        };
        runtime.pid = None;
        runtime.port_status = service_for_monitor.port.map(|_| PortStatus::Available);
        if matches!(runtime.status, ServiceStatus::Error) {
            runtime.error = Some("Process exited unexpectedly.".into());
        }
        if let Ok(mut guard) = state_for_monitor.inner.lock() {
            guard.processes.remove(&service_key);
        }
        set_runtime_state(
            &app_for_monitor,
            &state_for_monitor,
            &project_for_monitor,
            runtime,
        );
    });
    if let Some(port) = service.port {
        let app_for_port = app.clone();
        let state_for_port = state.clone();
        let project_for_port = project_id.clone();
        let service_for_port = service.clone();
        thread::spawn(move || {
            if let Ok(listening) = port_service::wait_for_listening(port, 12) {
                let mut runtime =
                    get_service_runtime(&state_for_port, &project_for_port, &service_for_port);
                if matches!(
                    runtime.status,
                    ServiceStatus::Running | ServiceStatus::Starting
                ) {
                    runtime.port_status = Some(if listening {
                        PortStatus::Listening
                    } else {
                        PortStatus::Available
                    });
                    set_runtime_state(&app_for_port, &state_for_port, &project_for_port, runtime);
                }
            }
        });
    }
}

fn wait_until_stopped(state: &AppState, service_key: &str) {
    for _ in 0..80 {
        let stopped = state
            .inner
            .lock()
            .ok()
            .and_then(|guard| {
                guard.runtime.get(service_key).map(|runtime| {
                    matches!(
                        runtime.status,
                        ServiceStatus::Stopped | ServiceStatus::Error
                    )
                })
            })
            .unwrap_or(true);
        if stopped {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn terminate_process(pid: u32, child: &Arc<Mutex<Child>>) -> AppResult<()> {
    if cfg!(windows) {
        let mut taskkill = Command::new("taskkill.exe");
        configure_hidden(&mut taskkill);
        let output = taskkill
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()?;
        if output.status.success() {
            Ok(())
        } else {
            kill_child_fallback(child, format!("taskkill /PID {pid} /T /F"))
        }
    } else {
        let status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()?;
        if status.success() {
            Ok(())
        } else {
            kill_child_fallback(child, format!("kill -TERM {pid}"))
        }
    }
}

fn kill_child_fallback(child: &Arc<Mutex<Child>>, command: String) -> AppResult<()> {
    let mut process = child
        .lock()
        .map_err(|_| AppError::Storage("Process lock poisoned.".into()))?;
    match process.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => process.kill().map_err(|error| AppError::CommandFailed {
            command,
            message: error.to_string(),
        }),
        Err(error) => Err(AppError::CommandFailed {
            command,
            message: error.to_string(),
        }),
    }
}

fn configure_hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

fn resolve_working_directory(project_path: &str, cwd: Option<&str>) -> AppResult<PathBuf> {
    let path = cwd
        .map(|value| Path::new(value).to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let resolved = if path.is_absolute() {
        path
    } else {
        PathBuf::from(project_path).join(path)
    };
    if !resolved.is_dir() {
        return Err(AppError::InvalidProjectPath(format!(
            "Working directory does not exist: {}",
            resolved.display()
        )));
    }
    Ok(resolved)
}

fn port_status(port: Option<u16>) -> AppResult<Option<PortStatus>> {
    port.map(|value| {
        port_service::is_listening(value).map(|listening| {
            if listening {
                PortStatus::Listening
            } else {
                PortStatus::Available
            }
        })
    })
    .transpose()
}

fn spawn_process(command: &str, cwd: &Path) -> AppResult<Child> {
    let tokens = tokenize_command(command)?;
    let (program, args) = tokens
        .split_first()
        .ok_or_else(|| AppError::InvalidCommand(command.into()))?;
    let program = windows_program(program);
    let mut process = Command::new(program);
    process
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000);
    }
    process.spawn().map_err(|error| AppError::CommandFailed {
        command: command.into(),
        message: error.to_string(),
    })
}

pub(crate) fn tokenize_command(command: &str) -> AppResult<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for character in command.chars() {
        match (quote, character) {
            (Some(active), value) if value == active => quote = None,
            (Some(_), value) => current.push(value),
            (None, '\'' | '"') => quote = Some(character),
            (None, value) if value.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            (None, value) => current.push(value),
        }
    }
    if quote.is_some() {
        return Err(AppError::InvalidCommand(
            "Unclosed quote in command.".into(),
        ));
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Ok(tokens)
}

fn windows_program(program: &str) -> String {
    if !cfg!(windows) {
        return program.into();
    }
    match program.to_ascii_lowercase().as_str() {
        "npm" | "pnpm" | "yarn" => format!("{program}.cmd"),
        _ => program.into(),
    }
}

fn chrono_like_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_quoted_arguments() {
        let tokens = tokenize_command(r#"npm run "dev:local" -- --host "127.0.0.1""#)
            .expect("tokenize command");
        assert_eq!(
            tokens,
            ["npm", "run", "dev:local", "--", "--host", "127.0.0.1"]
        );
    }

    #[test]
    fn terminate_process_stops_the_managed_child() {
        let mut process = if cfg!(windows) {
            let mut command = Command::new("cmd.exe");
            command.args(["/C", "ping 127.0.0.1 -n 30 >NUL"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 30"]);
            command
        };
        process
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = Arc::new(Mutex::new(process.spawn().expect("spawn test process")));
        let pid = child.lock().expect("lock test child").id();

        terminate_process(pid, &child).expect("terminate test process");
        for _ in 0..40 {
            if child
                .lock()
                .expect("lock test child")
                .try_wait()
                .expect("poll test child")
                .is_some()
            {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("test process did not stop");
    }
}
