use crate::error::{AppError, AppResult};
use std::net::TcpListener;

pub fn is_listening(port: u16) -> AppResult<bool> {
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            Ok(false)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Ok(true),
        Err(error) => Err(AppError::Io(error.to_string())),
    }
}

pub fn ensure_available(port: u16) -> AppResult<()> {
    if is_listening(port)? {
        return Err(AppError::PortInUse(port));
    }
    Ok(())
}

pub fn wait_for_listening(port: u16, attempts: usize) -> AppResult<bool> {
    for _ in 0..attempts {
        if is_listening(port)? {
            return Ok(true);
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Ok(false)
}
