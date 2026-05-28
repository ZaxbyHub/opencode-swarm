pub mod acl;
pub mod desktop;
pub mod error;
pub mod events;
pub mod job_object;
pub mod mode;
pub mod path_stubs;
pub mod policy;
pub mod policy_enforce;
pub mod probe;
pub mod temp_watcher;

use error::RunnerError;
use policy::Policy;

pub fn run_windows_sandbox_capture(
    policy_json: &str,
    mode_str: &str,
    command: &[String],
) -> Result<i32, RunnerError> {
    let policy: Policy = serde_json::from_str(policy_json)?;
    policy.validate()?;

    let sandbox_mode = mode::select_mode(mode_str, &policy)?;
    let result = mode::execute(sandbox_mode, &policy, command)?;
    Ok(result.exit_code)
}
