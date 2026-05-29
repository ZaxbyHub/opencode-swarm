use swarm_sandbox_runner::probe::run_probe;

#[test]
fn probe_returns_valid_json() {
    let result = run_probe();
    let json = serde_json::to_string(&result).unwrap();
    assert!(!json.is_empty());

    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(parsed.get("app_container_available").is_some());
    assert!(parsed.get("restricted_token_available").is_some());
    assert!(parsed.get("integrity_level").is_some());
    assert!(parsed.get("is_admin").is_some());
    assert!(parsed.get("os_version").is_some());
    assert!(parsed.get("arch").is_some());
}

#[test]
fn probe_arch_is_known() {
    let result = run_probe();
    assert!(
        ["x86_64", "aarch64", "x86"].contains(&result.arch.as_str()),
        "unexpected arch: {}",
        result.arch
    );
}

#[cfg(windows)]
#[test]
fn probe_restricted_token_available_on_windows() {
    let result = run_probe();
    assert!(
        result.restricted_token_available,
        "restricted token should be available on Windows"
    );
}

#[cfg(windows)]
#[test]
fn probe_integrity_level_not_unknown() {
    let result = run_probe();
    assert_ne!(result.integrity_level, "unknown");
    assert_ne!(result.integrity_level, "unsupported-platform");
}

#[cfg(not(windows))]
#[test]
fn probe_nothing_available_off_windows() {
    let result = run_probe();
    assert!(!result.app_container_available);
    assert!(!result.restricted_token_available);
    assert!(!result.private_desktop_creatable);
}
