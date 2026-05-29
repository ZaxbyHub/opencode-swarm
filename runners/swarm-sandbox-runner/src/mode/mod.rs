pub mod app_container;
pub mod restricted_token;

use crate::error::RunnerError;
use crate::policy::Policy;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxMode {
    AppContainer,
    RestrictedToken,
}

impl std::fmt::Display for SandboxMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SandboxMode::AppContainer => write!(f, "app-container"),
            SandboxMode::RestrictedToken => write!(f, "restricted-token"),
        }
    }
}

pub struct SandboxResult {
    pub exit_code: i32,
    pub mode: SandboxMode,
}

pub fn select_mode(requested: &str, _policy: &Policy) -> Result<SandboxMode, RunnerError> {
    match requested {
        "auto" => {
            if app_container::is_available() {
                Ok(SandboxMode::AppContainer)
            } else if restricted_token::is_available() {
                Ok(SandboxMode::RestrictedToken)
            } else {
                Err(RunnerError::OsApiFailure(
                    "neither AppContainer nor restricted-token mode is available".into(),
                ))
            }
        }
        "app-container" => {
            if app_container::is_available() {
                Ok(SandboxMode::AppContainer)
            } else {
                Err(RunnerError::LauncherMisconfig(
                    "app-container mode requested but not available on this system".into(),
                ))
            }
        }
        "restricted-token" => {
            if restricted_token::is_available() {
                Ok(SandboxMode::RestrictedToken)
            } else {
                Err(RunnerError::OsApiFailure(
                    "restricted-token mode unavailable".into(),
                ))
            }
        }
        other => Err(RunnerError::LauncherMisconfig(format!(
            "unknown mode: {other}"
        ))),
    }
}

#[cfg(windows)]
pub fn execute(
    mode: SandboxMode,
    policy: &Policy,
    command: &[String],
) -> Result<SandboxResult, RunnerError> {
    match mode {
        SandboxMode::AppContainer => app_container::execute(policy, command),
        SandboxMode::RestrictedToken => restricted_token::execute(policy, command),
    }
}

#[cfg(not(windows))]
pub fn execute(
    _mode: SandboxMode,
    _policy: &Policy,
    _command: &[String],
) -> Result<SandboxResult, RunnerError> {
    Err(RunnerError::OsApiFailure(
        "sandbox execution requires Windows".into(),
    ))
}
