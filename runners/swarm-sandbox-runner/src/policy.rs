use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    pub schema_version: u32,
    pub run_id: String,
    pub workspace_roots: Vec<String>,
    pub writable_roots: Vec<String>,
    #[serde(default)]
    pub read_only_subpaths: Vec<String>,
    pub temp_root: String,
    #[serde(default = "default_temp_cap")]
    pub temp_cap_bytes: u64,
    #[serde(default = "default_memory_cap")]
    pub memory_cap_bytes: u64,
    #[serde(default = "default_child_process_cap")]
    pub child_process_cap: u32,
    #[serde(default = "default_wall_clock_timeout")]
    pub wall_clock_timeout_ms: u64,
    #[serde(default = "default_network_mode")]
    pub network_mode: NetworkMode,
    #[serde(default)]
    pub env_allowlist: Vec<String>,
    #[serde(default)]
    pub env_overrides: HashMap<String, String>,
    #[serde(default)]
    pub path_stubs: Vec<String>,
    #[serde(default)]
    pub private_desktop: bool,
    #[serde(default = "default_true")]
    pub deny_alternate_data_streams: bool,
    #[serde(default = "default_true")]
    pub deny_unc_paths: bool,
    #[serde(default = "default_true")]
    pub deny_device_paths: bool,
    #[serde(default = "default_true")]
    pub deny_symlink_egress: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    Off,
    On,
}

fn default_temp_cap() -> u64 {
    524_288_000 // 500 MB
}
fn default_memory_cap() -> u64 {
    2_147_483_648 // 2 GB
}
fn default_child_process_cap() -> u32 {
    16
}
fn default_wall_clock_timeout() -> u64 {
    600_000 // 10 minutes
}
fn default_network_mode() -> NetworkMode {
    NetworkMode::Off
}
fn default_true() -> bool {
    true
}

impl Policy {
    pub fn validate(&self) -> Result<(), crate::error::RunnerError> {
        if self.schema_version != 1 {
            return Err(crate::error::RunnerError::PolicyParse(format!(
                "unsupported schema_version: {} (expected 1)",
                self.schema_version
            )));
        }
        if self.workspace_roots.is_empty() {
            return Err(crate::error::RunnerError::PolicyParse(
                "workspace_roots must not be empty".into(),
            ));
        }
        if self.writable_roots.is_empty() {
            return Err(crate::error::RunnerError::PolicyParse(
                "writable_roots must not be empty".into(),
            ));
        }
        if self.temp_root.is_empty() {
            return Err(crate::error::RunnerError::PolicyParse(
                "temp_root must not be empty".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_policy_json() {
        let json = r#"{
            "schema_version": 1,
            "run_id": "swarm-test-001",
            "workspace_roots": ["C:\\Users\\test\\project"],
            "writable_roots": ["C:\\Users\\test\\project"],
            "read_only_subpaths": [".git", ".swarm"],
            "temp_root": "C:\\Users\\test\\AppData\\Local\\Temp\\sandbox",
            "temp_cap_bytes": 524288000,
            "memory_cap_bytes": 2147483648,
            "child_process_cap": 16,
            "wall_clock_timeout_ms": 600000,
            "network_mode": "off",
            "env_allowlist": ["PATH", "TEMP"],
            "env_overrides": {"HTTP_PROXY": "http://127.0.0.1:1"},
            "path_stubs": ["ssh.exe", "curl.exe"],
            "private_desktop": true,
            "deny_alternate_data_streams": true,
            "deny_unc_paths": true,
            "deny_device_paths": true,
            "deny_symlink_egress": true
        }"#;

        let policy: Policy = serde_json::from_str(json).unwrap();
        assert_eq!(policy.schema_version, 1);
        assert_eq!(policy.run_id, "swarm-test-001");
        assert_eq!(policy.workspace_roots.len(), 1);
        assert_eq!(policy.network_mode, NetworkMode::Off);
        assert!(policy.private_desktop);
        assert!(policy.deny_alternate_data_streams);

        policy.validate().unwrap();

        let re_serialized = serde_json::to_string(&policy).unwrap();
        let re_parsed: Policy = serde_json::from_str(&re_serialized).unwrap();
        assert_eq!(re_parsed.run_id, policy.run_id);
    }

    #[test]
    fn validates_schema_version() {
        let json = r#"{
            "schema_version": 99,
            "run_id": "test",
            "workspace_roots": ["C:\\test"],
            "writable_roots": ["C:\\test"],
            "temp_root": "C:\\temp"
        }"#;
        let policy: Policy = serde_json::from_str(json).unwrap();
        assert!(policy.validate().is_err());
    }

    #[test]
    fn defaults_applied() {
        let json = r#"{
            "schema_version": 1,
            "run_id": "test",
            "workspace_roots": ["C:\\test"],
            "writable_roots": ["C:\\test"],
            "temp_root": "C:\\temp"
        }"#;
        let policy: Policy = serde_json::from_str(json).unwrap();
        assert_eq!(policy.temp_cap_bytes, 524_288_000);
        assert_eq!(policy.memory_cap_bytes, 2_147_483_648);
        assert_eq!(policy.child_process_cap, 16);
        assert_eq!(policy.wall_clock_timeout_ms, 600_000);
        assert_eq!(policy.network_mode, NetworkMode::Off);
        assert!(policy.deny_unc_paths);
    }
}
