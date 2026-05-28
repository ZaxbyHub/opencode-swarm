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
    use windows::core::HSTRING;
    use windows::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeleteAppContainerProfile,
    };
    use windows::Win32::Security::{FreeSid, PSID};

    let probe_name = HSTRING::from("swarm.sandbox.ac-probe");
    unsafe {
        let _ = DeleteAppContainerProfile(&probe_name);

        let mut sid = PSID::default();
        let ok = CreateAppContainerProfile(
            &probe_name,
            &HSTRING::from("Probe"),
            &HSTRING::from("Probe"),
            None,
            &mut sid,
        );
        if ok.is_ok() {
            let _ = DeleteAppContainerProfile(&probe_name);
            if !sid.is_invalid() {
                FreeSid(sid);
            }
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
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeleteAppContainerProfile,
    };
    use windows::Win32::Security::*;
    use windows::Win32::System::Threading::*;

    if command.is_empty() {
        return Err(RunnerError::LauncherMisconfig("empty command".into()));
    }

    policy_enforce::enforce_deny_rules(policy, command)?;
    let cwd = policy.workspace_roots.first().cloned().unwrap_or_default();
    policy_enforce::enforce_symlink_egress(policy, &cwd)?;
    policy_enforce::enforce_network_mode(policy, "app-container")?;

    let profile_name = format!("swarm.sandbox.{}", policy.run_id);
    let hprofile_name = HSTRING::from(&profile_name);

    // Clean up any stale profile
    unsafe {
        let _ = DeleteAppContainerProfile(&hprofile_name);
    }

    // Create AppContainer profile
    let mut container_sid = PSID::default();
    unsafe {
        CreateAppContainerProfile(
            &hprofile_name,
            &HSTRING::from("opencode-swarm sandbox"),
            &HSTRING::from(&format!("Sandbox for run {}", policy.run_id)),
            None,
            &mut container_sid,
        )
        .map_err(|e| RunnerError::OsApiFailure(format!("CreateAppContainerProfile: {e}")))?;
    }

    // Ensure cleanup on all exit paths
    struct ProfileGuard {
        name: HSTRING,
        sid: PSID,
    }
    impl Drop for ProfileGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = windows::Win32::Security::Isolation::DeleteAppContainerProfile(&self.name);
                if !self.sid.is_invalid() {
                    windows::Win32::Security::FreeSid(self.sid);
                }
            }
        }
    }
    let _guard = ProfileGuard {
        name: hprofile_name.clone(),
        sid: container_sid,
    };

    // Convert SID to string for ACL operations
    let sid_string = unsafe {
        let mut string_sid = windows::core::PWSTR::null();
        ConvertSidToStringSidW(container_sid, &mut string_sid)
            .map_err(|e| RunnerError::OsApiFailure(format!("ConvertSidToStringSidW: {e}")))?;
        let s = string_sid
            .to_string()
            .map_err(|e| RunnerError::OsApiFailure(format!("SID string conversion: {e}")))?;
        windows::Win32::Foundation::LocalFree(windows::Win32::Foundation::HLOCAL(
            string_sid.0 as *mut _,
        ));
        s
    };

    // Set up workspace ACLs for the container SID
    acl::setup_workspace_acls(
        &policy.workspace_roots,
        &policy.writable_roots,
        &policy.read_only_subpaths,
        &policy.temp_root,
        &sid_string,
    )?;

    // Create Job Object
    let job = JobObject::create(policy.memory_cap_bytes, policy.child_process_cap)?;

    // Create private desktop if requested
    let _desktop = if policy.private_desktop {
        Some(PrivateDesktop::create(&policy.run_id)?)
    } else {
        None
    };

    // Set up path stubs
    let stub_dir = path_stubs::create_stub_dir(&policy.temp_root, &policy.run_id)?;
    path_stubs::create_stubs(&stub_dir, &policy.path_stubs)?;

    // Build environment
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

    // Build command line
    let cmd_line = if command.len() == 1 {
        command[0].clone()
    } else {
        command
            .iter()
            .map(|a| {
                if a.contains(' ') || a.contains('"') {
                    format!("\"{}\"", a.replace('"', "\\\""))
                } else {
                    a.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut cmd_wide: Vec<u16> = cmd_line.encode_utf16().chain(std::iter::once(0)).collect();

    // Build env block
    let mut env_block = Vec::new();
    let mut pairs: Vec<_> = env.iter().collect();
    pairs.sort_by_key(|(k, _)| k.to_uppercase());
    for (key, val) in pairs {
        let entry = format!("{key}={val}");
        env_block.extend(entry.encode_utf16());
        env_block.push(0);
    }
    env_block.push(0);

    // Build SECURITY_CAPABILITIES
    let capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: container_sid,
        Capabilities: std::ptr::null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };

    // Build attribute list with SECURITY_CAPABILITIES
    let mut attr_list_size: usize = 0;
    unsafe {
        let _ = InitializeProcThreadAttributeList(
            LPPROC_THREAD_ATTRIBUTE_LIST(std::ptr::null_mut()),
            1,
            0,
            &mut attr_list_size,
        );
    }

    let mut attr_list_buf = vec![0u8; attr_list_size];
    let attr_list = LPPROC_THREAD_ATTRIBUTE_LIST(attr_list_buf.as_mut_ptr() as *mut _);

    unsafe {
        InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_list_size).map_err(|e| {
            RunnerError::OsApiFailure(format!("InitializeProcThreadAttributeList: {e}"))
        })?;

        UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            Some(&capabilities as *const _ as *const _),
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            None,
            None,
        )
        .map_err(|e| RunnerError::OsApiFailure(format!("UpdateProcThreadAttribute: {e}")))?;
    }

    // Set up startup info — desktop HSTRING must outlive CreateProcess call
    let desktop_hstr = _desktop.as_ref().map(|d| HSTRING::from(d.desktop_string()));
    let mut si = STARTUPINFOEXW::default();
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.lpAttributeList = attr_list;

    if let Some(ref hstr) = desktop_hstr {
        si.StartupInfo.lpDesktop = windows::core::PWSTR(hstr.as_ptr() as *mut u16);
    }

    let mut pi = PROCESS_INFORMATION::default();

    // Ensure temp root exists
    std::fs::create_dir_all(&policy.temp_root)?;

    // Create process
    unsafe {
        CreateProcessW(
            None,
            Some(PWSTR(cmd_wide.as_mut_ptr())),
            None,
            None,
            false,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NEW_PROCESS_GROUP,
            Some(env_block.as_ptr() as *const _),
            &HSTRING::from(&cwd),
            &si.StartupInfo,
            &mut pi,
        )
        .map_err(|e| RunnerError::OsApiFailure(format!("CreateProcessW (AppContainer): {e}")))?;
    }

    // Assign to job before resuming
    job.assign_process(pi.hProcess)?;

    let pid = unsafe { GetProcessId(pi.hProcess) };
    events::emit(&events::start_event(&policy.run_id, "app-container", pid));

    // Start temp watcher
    let kill_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let kf = kill_flag.clone();
    let pi_handle = pi.hProcess;
    let kill_cb = Arc::new(move || {
        kf.store(true, std::sync::atomic::Ordering::Relaxed);
        unsafe {
            let _ = TerminateProcess(pi_handle, 65);
        }
    });
    let mut watcher = TempWatcher::start(policy.temp_root.clone(), policy.temp_cap_bytes, kill_cb);

    // Resume
    unsafe {
        ResumeThread(pi.hThread);
    }

    // Wait
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

    // Cleanup is handled by ProfileGuard drop

    Ok(SandboxResult {
        exit_code,
        mode: SandboxMode::AppContainer,
    })
}

#[cfg(not(windows))]
pub fn execute(_policy: &Policy, _command: &[String]) -> Result<SandboxResult, RunnerError> {
    Err(RunnerError::OsApiFailure(
        "AppContainer mode requires Windows".into(),
    ))
}
