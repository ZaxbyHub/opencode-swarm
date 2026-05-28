use swarm_sandbox_runner::job_object::JobObject;

#[cfg(windows)]
#[test]
fn job_object_creation() {
    let job = JobObject::create(2_147_483_648, 16);
    assert!(job.is_ok(), "job object creation should succeed on Windows");
}

#[cfg(windows)]
#[test]
fn job_object_terminate() {
    let job = JobObject::create(2_147_483_648, 16).unwrap();
    // Terminating an empty job object is valid
    let result = job.terminate(0);
    assert!(result.is_ok());
}

#[cfg(not(windows))]
#[test]
fn job_object_not_available_off_windows() {
    let result = JobObject::create(2_147_483_648, 16);
    assert!(result.is_err());
}
