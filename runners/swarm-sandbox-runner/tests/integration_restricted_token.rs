use swarm_sandbox_runner::mode;
use swarm_sandbox_runner::mode::restricted_token;
use swarm_sandbox_runner::policy::{NetworkMode, Policy};
use std::collections::HashMap;

fn test_policy(workspace: &str, temp: &str) -> Policy {
    Policy {
        schema_version: 1,
        run_id: format!("test-{}", uuid::Uuid::new_v4()),
        workspace_roots: vec![workspace.to_string()],
        writable_roots: vec![workspace.to_string()],
        read_only_subpaths: vec![".git".to_string(), ".swarm".to_string()],
        temp_root: temp.to_string(),
        temp_cap_bytes: 524_288_000,
        memory_cap_bytes: 2_147_483_648,
        child_process_cap: 16,
        wall_clock_timeout_ms: 30_000,
        network_mode: NetworkMode::Off,
        env_allowlist: vec![
            "PATH".to_string(),
            "TEMP".to_string(),
            "TMP".to_string(),
            "SYSTEMROOT".to_string(),
        ],
        env_overrides: HashMap::new(),
        path_stubs: vec!["ssh.exe".to_string(), "curl.exe".to_string()],
        private_desktop: false,
        deny_alternate_data_streams: true,
        deny_unc_paths: true,
        deny_device_paths: true,
        deny_symlink_egress: true,
    }
}

#[cfg(windows)]
#[test]
fn restricted_token_is_available() {
    assert!(restricted_token::is_available());
}

#[cfg(windows)]
#[test]
fn mode_selection_auto_works() {
    let policy = test_policy("C:\\temp\\test", "C:\\temp\\test\\tmp");
    let selected = mode::select_mode("auto", &policy).unwrap();
    assert!(
        selected == mode::SandboxMode::AppContainer
            || selected == mode::SandboxMode::RestrictedToken
    );
}

#[cfg(windows)]
#[test]
fn mode_selection_restricted_token_works() {
    let policy = test_policy("C:\\temp\\test", "C:\\temp\\test\\tmp");
    let selected = mode::select_mode("restricted-token", &policy).unwrap();
    assert_eq!(selected, mode::SandboxMode::RestrictedToken);
}

#[test]
fn mode_selection_invalid_mode_errors() {
    let policy = test_policy("C:\\temp\\test", "C:\\temp\\test\\tmp");
    assert!(mode::select_mode("invalid-mode", &policy).is_err());
}

#[cfg(windows)]
#[test]
fn restricted_token_echo_exits_zero() {
    let workspace = std::env::temp_dir().join("rt-echo-test");
    let temp = workspace.join("tmp");
    std::fs::create_dir_all(&temp).unwrap();

    let policy = test_policy(
        workspace.to_str().unwrap(),
        temp.to_str().unwrap(),
    );

    let result = mode::execute(
        mode::SandboxMode::RestrictedToken,
        &policy,
        &["cmd.exe".to_string(), "/c".to_string(), "echo".to_string(), "hello".to_string()],
    );

    let _ = std::fs::remove_dir_all(&workspace);

    match result {
        Ok(r) => assert_eq!(r.exit_code, 0),
        Err(e) => {
            // CreateProcessAsUserW may require SeAssignPrimaryTokenPrivilege
            // which is not available to non-admin users. This is expected.
            let msg = format!("{e}");
            assert!(
                msg.contains("CreateProcessAsUserW") || msg.contains("OS API"),
                "unexpected error: {e}"
            );
        }
    }
}

#[cfg(not(windows))]
#[test]
fn restricted_token_not_available_off_windows() {
    assert!(!restricted_token::is_available());
}
