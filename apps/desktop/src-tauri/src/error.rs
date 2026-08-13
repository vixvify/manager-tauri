use serde::Serialize;
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Project not found: {0}")]
    ProjectNotFound(String),
    #[error("Service not found: {0}")]
    ServiceNotFound(String),
    #[error("A project name is required.")]
    InvalidProjectName,
    #[error("A project path is required.")]
    InvalidProjectPath(String),
    #[error("Every service needs a name and command.")]
    InvalidService,
    #[error("Port {0} is already being used.")]
    PortInUse(u16),
    #[error("Process is already running.")]
    ProcessAlreadyRunning,
    #[error("Process is still stopping.")]
    ProcessStillStopping,
    #[error("Docker Compose is not available: {0}")]
    DockerNotAvailable(String),
    #[error("Command failed: {command}. {message}")]
    CommandFailed { command: String, message: String },
    #[error("Invalid command: {0}")]
    InvalidCommand(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("Storage error: {0}")]
    Storage(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        struct ErrorPayload<'a> {
            code: &'a str,
            message: String,
        }

        let code = match self {
            Self::ProjectNotFound(_) => "project_not_found",
            Self::ServiceNotFound(_) => "service_not_found",
            Self::InvalidProjectName | Self::InvalidProjectPath(_) => "invalid_project",
            Self::InvalidService | Self::InvalidCommand(_) => "invalid_service",
            Self::PortInUse(_) => "port_in_use",
            Self::ProcessAlreadyRunning => "process_already_running",
            Self::ProcessStillStopping => "process_still_stopping",
            Self::DockerNotAvailable(_) => "docker_not_available",
            Self::CommandFailed { .. } => "command_failed",
            Self::Io(_) => "io_error",
            Self::Storage(_) => "storage_error",
        };

        ErrorPayload {
            code,
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        Self::Storage(value.to_string())
    }
}
