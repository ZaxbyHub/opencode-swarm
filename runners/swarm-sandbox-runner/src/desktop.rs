use crate::error::RunnerError;

#[cfg(windows)]
pub struct PrivateDesktop {
    handle: windows::Win32::System::StationsAndDesktops::HDESK,
    name: String,
}

#[cfg(windows)]
impl PrivateDesktop {
    pub fn create(run_id: &str) -> Result<Self, RunnerError> {
        use windows::core::HSTRING;
        use windows::Win32::System::StationsAndDesktops::{CreateDesktopW, DESKTOP_CONTROL_FLAGS};

        let name = format!("swarm_sandbox_{run_id}");
        let hname = HSTRING::from(&name);

        unsafe {
            let handle = CreateDesktopW(
                &hname,
                None,
                None,
                DESKTOP_CONTROL_FLAGS(0),
                0x000F_01FF, // DESKTOP_ALL_ACCESS
                None,
            )
            .map_err(|e| RunnerError::OsApiFailure(format!("CreateDesktopW: {e}")))?;

            Ok(PrivateDesktop { handle, name })
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn desktop_string(&self) -> String {
        format!("WinSta0\\{}", self.name)
    }
}

#[cfg(windows)]
impl Drop for PrivateDesktop {
    fn drop(&mut self) {
        use windows::Win32::System::StationsAndDesktops::CloseDesktop;
        unsafe {
            let _ = CloseDesktop(self.handle);
        }
    }
}

#[cfg(not(windows))]
pub struct PrivateDesktop {
    name: String,
}

#[cfg(not(windows))]
impl PrivateDesktop {
    pub fn create(run_id: &str) -> Result<Self, RunnerError> {
        Ok(PrivateDesktop {
            name: format!("swarm_sandbox_{run_id}"),
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn desktop_string(&self) -> String {
        format!("WinSta0\\{}", self.name)
    }
}
