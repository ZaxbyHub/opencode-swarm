use crate::error::RunnerError;

#[cfg(windows)]
use windows::Win32::Foundation::HANDLE;

#[cfg(windows)]
pub struct JobObject {
    handle: HANDLE,
}

#[cfg(windows)]
impl JobObject {
    pub fn create(
        memory_cap: u64,
        active_process_cap: u32,
    ) -> Result<Self, RunnerError> {
        use windows::Win32::System::JobObjects::*;
        use windows::core::HSTRING;

        unsafe {
            let name = HSTRING::from(format!(
                "swarm_sandbox_job_{}",
                std::process::id()
            ));
            let handle = CreateJobObjectW(None, &name)
                .map_err(|e| RunnerError::OsApiFailure(format!("CreateJobObjectW: {e}")))?;

            let mut ext_info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();

            ext_info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                    | JOB_OBJECT_LIMIT_JOB_MEMORY;

            ext_info.BasicLimitInformation.ActiveProcessLimit = active_process_cap;
            ext_info.JobMemoryLimit = memory_cap as usize;

            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &ext_info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|e| {
                let _ = windows::Win32::Foundation::CloseHandle(handle);
                RunnerError::OsApiFailure(format!("SetInformationJobObject: {e}"))
            })?;

            Ok(JobObject { handle })
        }
    }

    pub fn assign_process(&self, process: HANDLE) -> Result<(), RunnerError> {
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        unsafe {
            AssignProcessToJobObject(self.handle, process).map_err(|e| {
                RunnerError::OsApiFailure(format!("AssignProcessToJobObject: {e}"))
            })
        }
    }

    pub fn terminate(&self, exit_code: u32) -> Result<(), RunnerError> {
        use windows::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            TerminateJobObject(self.handle, exit_code)
                .map_err(|e| RunnerError::OsApiFailure(format!("TerminateJobObject: {e}")))
        }
    }

    pub fn handle(&self) -> HANDLE {
        self.handle
    }
}

#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(not(windows))]
pub struct JobObject;

#[cfg(not(windows))]
impl JobObject {
    pub fn create(_memory_cap: u64, _active_process_cap: u32) -> Result<Self, RunnerError> {
        Err(RunnerError::OsApiFailure("Job Objects require Windows".into()))
    }

    pub fn terminate(&self, _exit_code: u32) -> Result<(), RunnerError> {
        Err(RunnerError::OsApiFailure("Job Objects require Windows".into()))
    }
}
