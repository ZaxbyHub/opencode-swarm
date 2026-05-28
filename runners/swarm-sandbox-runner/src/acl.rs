use crate::error::RunnerError;

#[cfg(windows)]
pub fn grant_access(path: &str, sid_string: &str) -> Result<(), RunnerError> {
    use std::process::Command;

    let output = Command::new("icacls")
        .args([path, "/grant", &format!("{sid_string}:(OI)(CI)F"), "/T", "/Q"])
        .output()
        .map_err(|e| RunnerError::OsApiFailure(format!("icacls grant: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(RunnerError::OsApiFailure(format!(
            "icacls grant failed: {stderr}"
        )));
    }
    Ok(())
}

#[cfg(windows)]
pub fn deny_write(path: &str, sid_string: &str) -> Result<(), RunnerError> {
    use std::process::Command;

    let output = Command::new("icacls")
        .args([path, "/deny", &format!("{sid_string}:(OI)(CI)(W,D,DC)"), "/T", "/Q"])
        .output()
        .map_err(|e| RunnerError::OsApiFailure(format!("icacls deny: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(RunnerError::OsApiFailure(format!(
            "icacls deny-write failed: {stderr}"
        )));
    }
    Ok(())
}

#[cfg(windows)]
pub fn setup_workspace_acls(
    workspace_roots: &[String],
    writable_roots: &[String],
    read_only_subpaths: &[String],
    temp_root: &str,
    sid_string: &str,
) -> Result<(), RunnerError> {
    use std::path::Path;

    for root in writable_roots {
        if Path::new(root).exists() {
            grant_access(root, sid_string)?;
        }
    }

    for root in workspace_roots {
        for subpath in read_only_subpaths {
            let full = Path::new(root).join(subpath);
            if full.exists() {
                deny_write(full.to_str().unwrap_or(root), sid_string)?;
            }
        }
    }

    std::fs::create_dir_all(temp_root)
        .map_err(|e| RunnerError::Io(e))?;
    grant_access(temp_root, sid_string)?;

    Ok(())
}

#[cfg(not(windows))]
pub fn setup_workspace_acls(
    _workspace_roots: &[String],
    _writable_roots: &[String],
    _read_only_subpaths: &[String],
    _temp_root: &str,
    _sid_string: &str,
) -> Result<(), RunnerError> {
    Err(RunnerError::OsApiFailure("ACL setup requires Windows".into()))
}
