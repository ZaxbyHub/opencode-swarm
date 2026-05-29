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
    // Windows std::fs::canonicalize prepends the verbatim path prefix \\?\ and resolves
    // 8.3 short names (e.g. RUNNER~1 → runneradmin).  Strip the prefix and lowercase so
    // we can compare consistently against policy roots (which may use the regular DOS form
    // or 8.3 short names from %TEMP%).  Canonicalize the roots too for the same reasons.
    let canonical_lower = canonical.to_string_lossy().to_lowercase();
    let canonical_str = canonical_lower
        .strip_prefix("\\\\?\\")
        .unwrap_or(&canonical_lower);

    let in_allowed = policy
        .workspace_roots
        .iter()
        .chain(policy.writable_roots.iter())
        .chain(std::iter::once(&policy.temp_root))
        .any(|root| {
            // Canonicalize each root so 8.3 short names and symlinks resolve to the same
            // long-path form as the cwd.  Fall back to the raw value if the root doesn't
            // exist on disk yet.
            let root_resolved = std::fs::canonicalize(root)
                .map(|p| p.to_string_lossy().to_lowercase())
                .unwrap_or_else(|_| root.to_lowercase());
            let root_cmp = root_resolved
                .strip_prefix("\\\\?\\")
                .unwrap_or(&root_resolved)
                .to_owned();
            canonical_str.starts_with(&root_cmp)
        });

    if !in_allowed {
        events::emit(&events::denial_event(
            "deny_symlink_egress",
            Some(canonical_str),
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
