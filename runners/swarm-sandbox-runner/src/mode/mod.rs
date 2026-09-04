pub mod app_container;
pub mod restricted_token;

use crate::error::RunnerError;
use crate::policy::Policy;
use std::collections::HashMap;

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

/// Build the child-process environment for a sandboxed run.
///
/// Ordering is security-critical and must stay exactly:
///   1. copy allowlisted keys from the parent environment
///   2. remove `env_unsets` keys (a nulled key never reaches the child verbatim)
///   3. apply `env_overrides`
///   4. force the runner-managed rewrites: PATH is composed from the PARENT PATH
///      (not the filtered map) so a nulled PATH still yields a functional
///      sandboxed PATH — stub dir first (network-egress kill), then parent
///      entries; TEMP/TMP always point at the policy temp root.
///
/// Every key is normalized to UPPERCASE before it enters the map. Windows
/// environment lookup is case-insensitive (`std::env::var("Path")` matches
/// the `PATH` entry), but this HashMap is case-sensitive — without
/// normalization an allowlist entry `Path` plus an unset `PATH` would leave
/// the parent value live under its original case and the unset would
/// silently no-op (PR review PRR-001/002).
///
/// `parent_lookup` is injectable so unit tests can drive the ordering without
/// touching the process environment; production callers pass
/// `|k| std::env::var(k).ok()`.
pub fn build_child_env<F>(
    policy: &Policy,
    stub_dir: &std::path::Path,
    parent_lookup: F,
) -> HashMap<String, String>
where
    F: Fn(&str) -> Option<String>,
{
    let mut env: HashMap<String, String> = HashMap::new();

    for key in &policy.env_allowlist {
        if let Some(val) = parent_lookup(key) {
            env.insert(key.to_uppercase(), val);
        }
    }

    for key in &policy.env_unsets {
        env.remove(&key.to_uppercase());
    }

    for (key, val) in &policy.env_overrides {
        env.insert(key.to_uppercase(), val.clone());
    }

    let original_path = parent_lookup("PATH").unwrap_or_default();
    env.insert(
        "PATH".to_string(),
        crate::path_stubs::build_sandboxed_path(stub_dir, &original_path),
    );
    env.insert("TEMP".to_string(), policy.temp_root.clone());
    env.insert("TMP".to_string(), policy.temp_root.clone());

    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_policy() -> Policy {
        serde_json::from_str(
            r#"{
            "schema_version": 1,
            "run_id": "test",
            "workspace_roots": ["C:\\ws"],
            "writable_roots": ["C:\\ws"],
            "temp_root": "C:\\temp-root",
            "env_allowlist": ["PATH", "TEMP", "TMP", "SYSTEMROOT", "LD_PRELOAD"]
        }"#,
        )
        .unwrap()
    }

    fn parent_env() -> impl Fn(&str) -> Option<String> {
        |key: &str| match key {
            "PATH" => Some("C:\\Windows\\System32;C:\\tools".to_string()),
            "TEMP" => Some("C:\\Users\\user\\AppData\\Local\\Temp".to_string()),
            "TMP" => Some("C:\\Users\\user\\AppData\\Local\\Temp".to_string()),
            "SYSTEMROOT" => Some("C:\\Windows".to_string()),
            "LD_PRELOAD" => Some("evil.so".to_string()),
            _ => None,
        }
    }

    #[test]
    fn path_null_keeps_functional_sandboxed_path() {
        // Issue #2259 acceptance: PATH:null under strong mode must not break
        // ordinary command execution. The forced rewrite composes stub-dir +
        // PARENT entries (parent PATH read directly, not the filtered map), so
        // tools still resolve while the stubs shadow the network exes.
        let mut policy = test_policy();
        policy.env_unsets = vec!["PATH".to_string()];
        let env = build_child_env(&policy, std::path::Path::new("C:\\stubs"), parent_env());
        let path = env.get("PATH").unwrap();
        assert!(path.starts_with("C:\\stubs;"), "stub dir must shadow: {path}");
        assert!(path.contains("C:\\Windows\\System32"), "parent entries retained: {path}");
        assert_ne!(path, "C:\\Windows\\System32;C:\\tools");
    }

    #[test]
    fn env_unsets_genuinely_remove_non_managed_keys() {
        let mut policy = test_policy();
        policy.env_unsets = vec!["LD_PRELOAD".to_string(), "DYLD_INSERT_LIBRARIES".to_string()];
        let env = build_child_env(&policy, std::path::Path::new("C:\\stubs"), parent_env());
        assert!(!env.contains_key("LD_PRELOAD"));
        assert!(!env.contains_key("DYLD_INSERT_LIBRARIES"));
    }

    #[test]
    fn unsets_do_not_break_managed_temp_rewrites() {
        let mut policy = test_policy();
        policy.env_unsets = vec!["TEMP".to_string(), "TMP".to_string()];
        let env = build_child_env(&policy, std::path::Path::new("C:\\stubs"), parent_env());
        assert_eq!(env.get("TEMP").unwrap(), "C:\\temp-root");
        assert_eq!(env.get("TMP").unwrap(), "C:\\temp-root");
    }

    #[test]
    fn overrides_win_over_unsets() {
        let mut policy = test_policy();
        policy.env_unsets = vec!["FOO".to_string()];
        policy
            .env_overrides
            .insert("FOO".to_string(), "bar".to_string());
        let env = build_child_env(&policy, std::path::Path::new("C:\\stubs"), parent_env());
        assert_eq!(env.get("FOO").unwrap(), "bar");
    }

    #[test]
    fn allowlisted_parent_values_pass_through_when_not_nulled() {
        let policy = test_policy();
        let env = build_child_env(&policy, std::path::Path::new("C:\\stubs"), parent_env());
        assert_eq!(env.get("SYSTEMROOT").unwrap(), "C:\\Windows");
    }

    #[test]
    fn mixed_case_unsets_remove_allowlisted_keys() {
        // PR review PRR-001: Windows env lookup is case-insensitive, so an
        // allowlist entry "Path" must be removable by an unset "PATH" (and
        // vice versa). The map is case-sensitive; normalization makes the
        // removal hit.
        let mut policy = test_policy();
        policy.env_allowlist = vec!["Path".to_string()];
        policy.env_unsets = vec!["PATH".to_string()];
        let env = build_child_env(&policy, std::path::Path::new("C:\\stubs"), parent_env());
        assert!(
            !env.contains_key("PATH") && !env.contains_key("Path"),
            "case-variant unset must remove the allowlisted entry: {:?}",
            env.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn case_variant_keys_collapse_to_one_entry() {
        // PR review PRR-002: `Path` (allowlist) and `PATH` (override) are the
        // same variable on Windows. The forced rewrite wins, and exactly one
        // uppercase entry exists — never two case-variant copies.
        let mut policy = test_policy();
        policy.env_allowlist = vec!["Path".to_string()];
        policy
            .env_overrides
            .insert("PATH".to_string(), "C:\\override".to_string());
        let env = build_child_env(&policy, std::path::Path::new("C:\\stubs"), parent_env());
        let path_entries = env
            .keys()
            .filter(|k| k.eq_ignore_ascii_case("path"))
            .count();
        assert_eq!(path_entries, 1, "case variants must collapse: {:?}", env);
        assert!(env.contains_key("PATH"));
    }
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
