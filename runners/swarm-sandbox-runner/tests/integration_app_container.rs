use swarm_sandbox_runner::mode::app_container;

#[cfg(windows)]
#[test]
fn app_container_availability_check() {
    // AppContainer may or may not be available depending on OS version and policy.
    // This test just verifies the probe doesn't crash.
    let available = app_container::is_available();
    println!("AppContainer available: {available}");
}

#[cfg(not(windows))]
#[test]
fn app_container_not_available_off_windows() {
    assert!(!app_container::is_available());
}
