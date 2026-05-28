use crate::error::RunnerError;
use std::fs;
use std::path::{Path, PathBuf};

pub fn create_stub_dir(temp_root: &str, run_id: &str) -> Result<PathBuf, RunnerError> {
    let stub_dir = Path::new(temp_root).join(format!("stubs-{run_id}"));
    fs::create_dir_all(&stub_dir)?;
    Ok(stub_dir)
}

pub fn create_stubs(
    stub_dir: &Path,
    binaries: &[String],
) -> Result<(), RunnerError> {
    for bin_name in binaries {
        create_single_stub(stub_dir, bin_name)?;
    }
    Ok(())
}

fn create_single_stub(stub_dir: &Path, name: &str) -> Result<(), RunnerError> {
    let cmd_name = if name.ends_with(".exe") || name.ends_with(".cmd") || name.ends_with(".bat") {
        name.to_string()
    } else {
        format!("{name}.cmd")
    };

    let stub_path = stub_dir.join(&cmd_name);

    let content = format!(
        "@echo off\r\n\
         echo [swarm-sandbox] {name} is blocked by sandbox policy >&2\r\n\
         exit /b 126\r\n"
    );

    fs::write(&stub_path, content)?;

    if cfg!(windows) && !name.contains('.') {
        let exe_stub = stub_dir.join(format!("{name}.exe"));
        let exe_content = format!(
            "@echo off\r\n\
             echo [swarm-sandbox] {name} is blocked by sandbox policy >&2\r\n\
             exit /b 126\r\n"
        );
        fs::write(&exe_stub, exe_content)?;
    }

    Ok(())
}

pub fn build_sandboxed_path(stub_dir: &Path, original_path: &str) -> String {
    let stub_str = stub_dir.to_string_lossy();
    if original_path.is_empty() {
        stub_str.to_string()
    } else {
        format!("{stub_str};{original_path}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn creates_cmd_stubs() {
        let dir = std::env::temp_dir().join("stub-test-cmd");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        create_stubs(&dir, &["ssh.exe".to_string(), "curl".to_string()]).unwrap();

        assert!(dir.join("ssh.exe.cmd").exists() || dir.join("ssh.exe").exists());
        assert!(dir.join("curl.cmd").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_prepend() {
        let stub_dir = Path::new("C:\\stubs");
        let result = build_sandboxed_path(stub_dir, "C:\\Windows\\System32");
        assert!(result.starts_with("C:\\stubs"));
        assert!(result.contains("C:\\Windows\\System32"));
    }
}
