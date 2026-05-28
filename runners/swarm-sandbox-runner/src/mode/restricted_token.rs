use crate::acl;
use crate::desktop::PrivateDesktop;
use crate::error::RunnerError;
use crate::events;
use crate::job_object::JobObject;
use crate::mode::{SandboxMode, SandboxResult};
use crate::path_stubs;
use crate::policy::Policy;
use crate::policy_enforce;
use crate::temp_watcher::TempWatcher;

#[cfg(windows)]
pub fn is_available() -> bool {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Security::{
        CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, TOKEN_ALL_ACCESS,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &mut token).is_err() {
            return false;
        }
        let mut restricted = HANDLE::default();
        let ok = CreateRestrictedToken(
            token,
            DISABLE_MAX_PRIVILEGE,
            None,
            None,
            None,
            &mut restricted,
        );
        let _ = windows::Win32::Foundation::CloseHandle(token);
        if ok.is_ok() {
            let _ = windows::Win32::Foundation::CloseHandle(restricted);
            true
        } else {
            false
        }
    }
}

#[cfg(not(windows))]
pub fn is_available() -> bool {
    false
}

#[cfg(windows)]
pub fn execute(policy: &Policy, command: &[String]) -> Result<SandboxResult, RunnerError> {
    use std::sync::Arc;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT};
    use windows::Win32::Security::{
        CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, TOKEN_ALL_ACCESS,
    };
    use windows::Win32::System::Threading::*;

    if command.is_empty() {
        return Err(RunnerError::LauncherMisconfig("empty command".into()));
    }

    // 0. Enforce policy rules on command arguments
    policy_enforce::enforce_deny_rules(policy, command)?;
    let cwd = policy.workspace_roots.first().cloned().unwrap_or_default();
    policy_enforce::enforce_symlink_egress(policy, &cwd)?;
    policy_enforce::enforce_network_mode(policy, "restricted-token")?;

    // 1. Open current process token
    let mut process_token = HANDLE::default();
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &mut process_token)
            .map_err(|e| RunnerError::OsApiFailure(format!("OpenProcessToken: {e}")))?;
    }

    // 2. Create restricted token (disable max privileges)
    let mut restricted_token = HANDLE::default();
    unsafe {
        let result = CreateRestrictedToken(
            process_token,
            DISABLE_MAX_PRIVILEGE,
            None,
            None,
            None,
            &mut restricted_token,
        );
        let _ = CloseHandle(process_token);
        result.map_err(|e| RunnerError::OsApiFailure(format!("CreateRestrictedToken: {e}")))?;
    }

    // 3. Create Job Object
    let job = JobObject::create(policy.memory_cap_bytes, policy.child_process_cap)?;

    // 4. Create private desktop if requested
    let _desktop = if policy.private_desktop {
        Some(PrivateDesktop::create(&policy.run_id)?)
    } else {
        None
    };

    // 5. Set up path stubs
    let stub_dir = path_stubs::create_stub_dir(&policy.temp_root, &policy.run_id)?;
    path_stubs::create_stubs(&stub_dir, &policy.path_stubs)?;

    // 6. Build environment
    let mut env: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for key in &policy.env_allowlist {
        if let Ok(val) = std::env::var(key) {
            env.insert(key.clone(), val);
        }
    }
    for (key, val) in &policy.env_overrides {
        env.insert(key.clone(), val.clone());
    }

    let original_path = env.get("PATH").cloned().unwrap_or_default();
    env.insert(
        "PATH".to_string(),
        path_stubs::build_sandboxed_path(&stub_dir, &original_path),
    );
    env.insert("TEMP".to_string(), policy.temp_root.clone());
    env.insert("TMP".to_string(), policy.temp_root.clone());

    // 7. Build command line
    let cmd_line = build_command_line(command);
    let mut cmd_wide: Vec<u16> = cmd_line.encode_utf16().chain(std::iter::once(0)).collect();

    // 8. Build environment block
    let env_block = build_env_block(&env);

    // 9. Set up startup info — desktop HSTRING must outlive CreateProcess call
    let desktop_hstr = _desktop.as_ref().map(|d| HSTRING::from(d.desktop_string()));
    let mut si = STARTUPINFOW::default();
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    if let Some(ref hstr) = desktop_hstr {
        si.lpDesktop = windows::core::PWSTR(hstr.as_ptr() as *mut u16);
    }

    let mut pi = PROCESS_INFORMATION::default();

    // 10. Ensure temp root exists
    std::fs::create_dir_all(&policy.temp_root)?;

    // 11. Set up workspace ACLs
    // Restricted token mode uses Everyone SID for ACLs because the token itself
    // restricts access via removed privileges/SIDs, not via per-identity deny ACEs.
    acl::setup_workspace_acls(
        &policy.workspace_roots,
        &policy.writable_roots,
        &policy.read_only_subpaths,
        &policy.temp_root,
        "S-1-1-0",
    )?;

    // 12. Create process with restricted token (suspended)

    unsafe {
        CreateProcessAsUserW(
            restricted_token,
            None,
            Some(cmd_wide.as_mut_slice()),
            None,
            None,
            false,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP,
            Some(env_block.as_ptr() as *const _),
            &HSTRING::from(&cwd),
            &si,
            &mut pi,
        )
        .map_err(|e| {
            let _ = CloseHandle(restricted_token);
            RunnerError::OsApiFailure(format!("CreateProcessAsUserW: {e}"))
        })?;

        let _ = CloseHandle(restricted_token);
    }

    // 13. Assign process to job before resuming
    job.assign_process(pi.hProcess)?;

    // 14. Emit start event
    let pid = unsafe { GetProcessId(pi.hProcess) };
    events::emit(&events::start_event(
        &policy.run_id,
        "restricted-token",
        pid,
    ));

    // 15. Start temp watcher
    let kill_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let kf = kill_flag.clone();
    let pi_handle = pi.hProcess;
    let kill_cb = Arc::new(move || {
        kf.store(true, std::sync::atomic::Ordering::Relaxed);
        unsafe {
            let _ = TerminateProcess(pi_handle, 65);
        }
    });
    let mut watcher = TempWatcher::start(
        policy.temp_root.clone(),
        policy.temp_cap_bytes,
        kill_cb.clone(),
    );

    // 16. Resume the child
    unsafe {
        ResumeThread(pi.hThread);
    }

    // 17. Wait for child with wall-clock timeout
    // u32::MAX (0xFFFFFFFF) means INFINITE for WaitForSingleObject — cap at MAX-1
    let timeout_ms = u32::try_from(policy.wall_clock_timeout_ms).unwrap_or(u32::MAX - 1);
    let wait_result = unsafe { WaitForSingleObject(pi.hProcess, timeout_ms) };

    watcher.stop();

    let exit_code;
    if wait_result == WAIT_TIMEOUT {
        events::emit(&events::quota_exceeded_wall_clock(
            policy.wall_clock_timeout_ms,
            policy.wall_clock_timeout_ms,
        ));
        let _ = job.terminate(66);
        unsafe {
            let _ = CloseHandle(pi.hProcess);
            let _ = CloseHandle(pi.hThread);
        }
        return Err(RunnerError::WallClockTimeout {
            elapsed_ms: policy.wall_clock_timeout_ms,
        });
    } else if kill_flag.load(std::sync::atomic::Ordering::Relaxed) {
        unsafe {
            let _ = CloseHandle(pi.hProcess);
            let _ = CloseHandle(pi.hThread);
        }
        return Err(RunnerError::QuotaExceeded {
            kind: "temp_size".to_string(),
        });
    } else {
        let mut code = 0u32;
        unsafe {
            GetExitCodeProcess(pi.hProcess, &mut code)
                .map_err(|e| RunnerError::OsApiFailure(format!("GetExitCodeProcess: {e}")))?;
        }
        exit_code = code as i32;
    }

    events::emit(&events::exit_event(exit_code, None));

    unsafe {
        let _ = CloseHandle(pi.hProcess);
        let _ = CloseHandle(pi.hThread);
    }

    Ok(SandboxResult {
        exit_code,
        mode: SandboxMode::RestrictedToken,
    })
}

#[cfg(not(windows))]
pub fn execute(_policy: &Policy, _command: &[String]) -> Result<SandboxResult, RunnerError> {
    Err(RunnerError::OsApiFailure(
        "restricted-token mode requires Windows".into(),
    ))
}

fn build_command_line(args: &[String]) -> String {
    if args.len() == 1 {
        return args[0].clone();
    }
    args.iter()
        .map(|arg| {
            if arg.contains(' ') || arg.contains('"') {
                format!("\"{}\"", arg.replace('"', "\\\""))
            } else {
                arg.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(windows)]
fn build_env_block(env: &std::collections::HashMap<String, String>) -> Vec<u16> {
    let mut block = Vec::new();
    let mut pairs: Vec<_> = env.iter().collect();
    pairs.sort_by_key(|(k, _)| k.to_uppercase());

    for (key, val) in pairs {
        let entry = format!("{key}={val}");
        block.extend(entry.encode_utf16());
        block.push(0);
    }
    block.push(0); // double null terminator
    block
}
