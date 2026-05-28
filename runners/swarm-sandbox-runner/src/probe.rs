use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ProbeResult {
    pub app_container_available: bool,
    pub lpac_available: bool,
    pub restricted_token_available: bool,
    pub private_desktop_creatable: bool,
    pub integrity_level: String,
    pub is_admin: bool,
    pub os_version: String,
    pub arch: String,
}

#[cfg(windows)]
pub fn run_probe() -> ProbeResult {
    let is_admin = check_admin();
    let integrity = get_integrity_level();
    let os_ver = get_os_version();
    let arch = std::env::consts::ARCH.to_string();

    let app_container = probe_app_container();
    let lpac = probe_lpac();
    let restricted_token = probe_restricted_token();
    let private_desktop = probe_private_desktop();

    ProbeResult {
        app_container_available: app_container,
        lpac_available: lpac,
        restricted_token_available: restricted_token,
        private_desktop_creatable: private_desktop,
        integrity_level: integrity,
        is_admin,
        os_version: os_ver,
        arch,
    }
}

#[cfg(not(windows))]
pub fn run_probe() -> ProbeResult {
    ProbeResult {
        app_container_available: false,
        lpac_available: false,
        restricted_token_available: false,
        private_desktop_creatable: false,
        integrity_level: "unsupported-platform".to_string(),
        is_admin: false,
        os_version: "non-windows".to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[cfg(windows)]
fn check_admin() -> bool {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }

        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        );
        let _ = windows::Win32::Foundation::CloseHandle(token);
        ok.is_ok() && elevation.TokenIsElevated != 0
    }
}

#[cfg(windows)]
fn get_integrity_level() -> String {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Security::{
        GetSidSubAuthority, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL,
        TOKEN_QUERY,
    };
    use windows::Win32::System::SystemServices::{
        SECURITY_MANDATORY_HIGH_RID, SECURITY_MANDATORY_LOW_RID, SECURITY_MANDATORY_MEDIUM_RID,
        SECURITY_MANDATORY_SYSTEM_RID,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return "unknown".to_string();
        }

        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len);

        let mut buffer = vec![0u8; len as usize];
        let ok = GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(buffer.as_mut_ptr() as *mut _),
            len,
            &mut len,
        );
        let _ = windows::Win32::Foundation::CloseHandle(token);

        if ok.is_err() {
            return "unknown".to_string();
        }

        let label = &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        let sub_count = *windows::Win32::Security::GetSidSubAuthorityCount(sid);
        if sub_count == 0 {
            return "unknown".to_string();
        }
        let rid = *GetSidSubAuthority(sid, (sub_count - 1) as u32);

        match rid {
            x if x == SECURITY_MANDATORY_LOW_RID as u32 => "low".to_string(),
            x if x == SECURITY_MANDATORY_MEDIUM_RID as u32 => "medium".to_string(),
            x if x == SECURITY_MANDATORY_HIGH_RID as u32 => "high".to_string(),
            x if x == SECURITY_MANDATORY_SYSTEM_RID as u32 => "system".to_string(),
            other => format!("rid-{other}"),
        }
    }
}

#[cfg(not(windows))]
fn get_integrity_level() -> String {
    "unsupported-platform".to_string()
}

#[cfg(windows)]
fn get_os_version() -> String {
    use windows::Win32::System::SystemInformation::{GetVersionExW, OSVERSIONINFOW};
    unsafe {
        let mut info = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        if GetVersionExW(&mut info).is_ok() {
            format!(
                "{}.{}.{}",
                info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
            )
        } else {
            "unknown".to_string()
        }
    }
}

#[cfg(not(windows))]
fn get_os_version() -> String {
    "non-windows".to_string()
}

#[cfg(windows)]
fn probe_app_container() -> bool {
    use windows::core::HSTRING;
    use windows::Win32::Security::FreeSid;
    use windows::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeleteAppContainerProfile,
    };

    let probe_name = HSTRING::from("swarm.sandbox.probe-test");
    let display_name = HSTRING::from("Probe Test");
    let description = HSTRING::from("Temporary probe for capability detection");

    unsafe {
        let _ = DeleteAppContainerProfile(&probe_name);

        match CreateAppContainerProfile(&probe_name, &display_name, &description, None) {
            Ok(sid) => {
                let _ = DeleteAppContainerProfile(&probe_name);
                if !sid.is_invalid() {
                    FreeSid(sid);
                }
                true
            }
            Err(_) => false,
        }
    }
}

#[cfg(not(windows))]
fn probe_app_container() -> bool {
    false
}

#[cfg(windows)]
fn probe_lpac() -> bool {
    let build = get_build_number();
    build >= 15063 && probe_app_container()
}

#[cfg(not(windows))]
fn probe_lpac() -> bool {
    false
}

#[cfg(windows)]
fn get_build_number() -> u32 {
    use windows::Win32::System::SystemInformation::{GetVersionExW, OSVERSIONINFOW};
    unsafe {
        let mut info = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        if GetVersionExW(&mut info).is_ok() {
            info.dwBuildNumber
        } else {
            0
        }
    }
}

#[cfg(windows)]
fn probe_restricted_token() -> bool {
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
fn probe_restricted_token() -> bool {
    false
}

#[cfg(windows)]
fn probe_private_desktop() -> bool {
    use windows::core::HSTRING;
    use windows::Win32::System::StationsAndDesktops::{
        CloseDesktop, CreateDesktopW, DESKTOP_CONTROL_FLAGS,
    };

    unsafe {
        let name = HSTRING::from("swarm_probe_desktop");
        let result = CreateDesktopW(
            &name,
            None,
            None,
            DESKTOP_CONTROL_FLAGS(0),
            windows::Win32::Security::GENERIC_MAPPING {
                GenericRead: 0x0002_0000,
                GenericWrite: 0x0002_0000,
                GenericExecute: 0x0002_0000,
                GenericAll: 0x000F_01FF,
            }
            .GenericAll,
            None,
        );
        match result {
            Ok(desktop) => {
                let _ = CloseDesktop(desktop);
                true
            }
            Err(_) => false,
        }
    }
}

#[cfg(not(windows))]
fn probe_private_desktop() -> bool {
    false
}
