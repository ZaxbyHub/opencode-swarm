use std::process;

#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
    #[error("child exited with code {0}")]
    ChildNonZero(i32),

    #[error("policy violation: {reason}")]
    PolicyViolation { reason: String },

    #[error("quota exceeded: {kind}")]
    QuotaExceeded { kind: String },

    #[error("wall-clock timeout after {elapsed_ms} ms")]
    WallClockTimeout { elapsed_ms: u64 },

    #[error("launcher misconfiguration: {0}")]
    LauncherMisconfig(String),

    #[error("OS API failure: {0}")]
    OsApiFailure(String),

    #[error("probe failed: {0}")]
    ProbeFailed(String),

    #[error("policy parse error: {0}")]
    PolicyParse(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl RunnerError {
    pub fn exit_code(&self) -> i32 {
        match self {
            RunnerError::ChildNonZero(code) => {
                if *code == 0 {
                    1
                } else {
                    *code
                }
            }
            RunnerError::PolicyViolation { .. } => 64,
            RunnerError::QuotaExceeded { .. } => 65,
            RunnerError::WallClockTimeout { .. } => 66,
            RunnerError::LauncherMisconfig(_) | RunnerError::PolicyParse(_) => 67,
            RunnerError::OsApiFailure(_) => 68,
            RunnerError::ProbeFailed(_) => 69,
            RunnerError::Io(_) | RunnerError::Json(_) => 68,
        }
    }

    pub fn exit(&self) -> ! {
        eprintln!("{self}");
        process::exit(self.exit_code());
    }
}
