use crate::error::RunnerError;
use crate::events;
use crate::policy::{NetworkMode, Policy};

pub fn enforce_deny_rules(policy: &Policy, command: &[String]) -> Result<(), RunnerError> {
    for arg in command {
        if policy.deny_unc_paths && is_unc_path(arg) {
            events::emit(&events::denial_event("deny_unc_path", Some(arg)));
            return Err(RunnerError::PolicyViolation {
                reason: format!("UNC paths blocked by policy: {arg}"),
            });
        }
        if policy.deny_device_paths && is_device_path(arg) {
            events::emit(&events::denial_event("deny_device_path", Some(arg)));
            return Err(RunnerError::PolicyViolation {
                reason: format!("device paths blocked by policy: {arg}"),
            });
        }
        if policy.deny_alternate_data_streams && has_ads(arg) {
            events::emit(&events::denial_event(
                "deny_alternate_data_stream",
                Some(arg),
            ));
            return Err(RunnerError::PolicyViolation {
                reason: format!("alternate data streams blocked by policy: {arg}"),
            });
        }
    }
    Ok(())
}

pub fn enforce_network_mode(policy: &Policy, mode_name: &str) -> Result<(), RunnerError> {
    if policy.network_mode == NetworkMode::Off {
        // AppContainer: implicit deny (zero capabilities granted)
        // Restricted token: dead-loopback proxy via env_overrides + path stubs for curl/wget/ssh
        // Both approaches are wired in the mode-specific execution paths.
        return Ok(());
    }
    if mode_name == "restricted-token" && policy.network_mode == NetworkMode::On {
        // Restricted token mode cannot grant selective network access — it's all or nothing
        // via the OS token. network_mode: "on" is a no-op (network remains available).
    }
    Ok(())
}

fn is_unc_path(s: &str) -> bool {
    s.starts_with("\\\\") || s.starts_with("//")
}

fn is_device_path(s: &str) -> bool {
    let lower = s.to_lowercase();
    lower.starts_with("\\\\.\\")
        || lower.starts_with("\\\\?\\")
        || lower.starts_with("//./")
        || lower.starts_with("//?/")
}

fn has_ads(s: &str) -> bool {
    // Detect NTFS Alternate Data Streams in ANY path component.
    // ADS syntax: component:streamname
    // Must skip the drive letter colon (e.g. C:\) at position 1.
    let skip = if s.len() >= 2 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic() {
        2 // skip "C:" drive prefix
    } else {
        0
    };
    let rest = &s[skip..];
    for component in rest.split(['\\', '/']) {
        if component.len() < 3 {
            continue;
        }
        if let Some(colon_idx) = component.find(':') {
            if colon_idx > 0 && colon_idx < component.len() - 1 {
                return true;
            }
        }
    }
    false
}

#[cfg(windows)]
pub fn enforce_symlink_egress(policy: &Policy, cwd: &str) -> Result<(), RunnerError> {
    if !policy.deny_symlink_egress {
        return Ok(());
    }
    let canonical = std::fs::canonicalize(cwd).map_err(|e| RunnerError::PolicyViolation {
        reason: format!("cannot canonicalize cwd for symlink egress check: {e}"),
    })?;
    let canonical_str = canonical.to_string_lossy().to_lowercase();

    let in_allowed = policy
        .workspace_roots
        .iter()
        .chain(std::iter::once(&policy.temp_root))
        .any(|root| {
            let root_lower = root.to_lowercase();
            canonical_str.starts_with(&root_lower)
        });

    if !in_allowed {
        events::emit(&events::denial_event(
            "deny_symlink_egress",
            Some(&canonical_str),
        ));
        return Err(RunnerError::PolicyViolation {
            reason: format!("cwd resolves outside allowed roots (symlink egress): {canonical_str}"),
        });
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn enforce_symlink_egress(_policy: &Policy, _cwd: &str) -> Result<(), RunnerError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_unc_paths() {
        assert!(is_unc_path("\\\\server\\share"));
        assert!(is_unc_path("//server/share"));
        assert!(!is_unc_path("C:\\normal\\path"));
    }

    #[test]
    fn detects_device_paths() {
        assert!(is_device_path("\\\\.\\PhysicalDrive0"));
        assert!(is_device_path("\\\\?\\C:\\long\\path"));
        assert!(!is_device_path("C:\\normal"));
    }

    #[test]
    fn detects_ads() {
        assert!(has_ads("file.txt:hidden"));
        assert!(has_ads("C:\\dir\\file.txt:stream"));
        assert!(has_ads("C:\\dir:hidden\\file.txt"));
        assert!(!has_ads("C:\\normal\\file.txt"));
        assert!(!has_ads("short"));
        assert!(!has_ads("C:\\"));
    }
}
