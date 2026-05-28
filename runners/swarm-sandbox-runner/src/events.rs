use serde::Serialize;
use std::io::Write;
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Start {
        run_id: String,
        mode: String,
        pid: u32,
        ts: String,
    },
    Denial {
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        ts: String,
    },
    QuotaExceeded {
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        used_bytes: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cap_bytes: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        elapsed_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cap_ms: Option<u64>,
        ts: String,
    },
    Exit {
        exit_code: i32,
        signal: Option<String>,
        ts: String,
    },
}

fn now_iso() -> String {
    let dur = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    format!("{secs}.{millis:03}")
}

pub fn emit(event: &Event) {
    let json = serde_json::to_string(event).unwrap_or_default();
    let stderr = std::io::stderr();
    let mut handle = stderr.lock();
    let _ = writeln!(handle, "{json}");
}

pub fn start_event(run_id: &str, mode: &str, pid: u32) -> Event {
    Event::Start {
        run_id: run_id.to_string(),
        mode: mode.to_string(),
        pid,
        ts: now_iso(),
    }
}

pub fn denial_event(reason: &str, path: Option<&str>) -> Event {
    Event::Denial {
        reason: reason.to_string(),
        path: path.map(|p| p.to_string()),
        ts: now_iso(),
    }
}

pub fn quota_exceeded_temp(used: u64, cap: u64) -> Event {
    Event::QuotaExceeded {
        kind: "temp_size".to_string(),
        used_bytes: Some(used),
        cap_bytes: Some(cap),
        elapsed_ms: None,
        cap_ms: None,
        ts: now_iso(),
    }
}

pub fn quota_exceeded_wall_clock(elapsed: u64, cap: u64) -> Event {
    Event::QuotaExceeded {
        kind: "wall_clock".to_string(),
        used_bytes: None,
        cap_bytes: None,
        elapsed_ms: Some(elapsed),
        cap_ms: Some(cap),
        ts: now_iso(),
    }
}

pub fn exit_event(code: i32, signal: Option<&str>) -> Event {
    Event::Exit {
        exit_code: code,
        signal: signal.map(|s| s.to_string()),
        ts: now_iso(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_event_serializes_as_ndjson() {
        let ev = start_event("swarm-test", "restricted-token", 1234);
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"type\":\"start\""));
        assert!(json.contains("\"run_id\":\"swarm-test\""));
        assert!(json.contains("\"mode\":\"restricted-token\""));
        assert!(json.contains("\"pid\":1234"));
        assert!(json.contains("\"ts\":"));
    }

    #[test]
    fn denial_event_includes_path() {
        let ev = denial_event("write_outside_workspace", Some("C:\\Windows\\System32"));
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"type\":\"denial\""));
        assert!(json.contains("write_outside_workspace"));
        assert!(json.contains("C:\\\\Windows\\\\System32"));
    }

    #[test]
    fn quota_exceeded_temp_shape() {
        let ev = quota_exceeded_temp(536_870_912, 524_288_000);
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"type\":\"quota_exceeded\""));
        assert!(json.contains("\"kind\":\"temp_size\""));
        assert!(json.contains("\"used_bytes\":536870912"));
        assert!(json.contains("\"cap_bytes\":524288000"));
        assert!(!json.contains("elapsed_ms"));
    }

    #[test]
    fn exit_event_shape() {
        let ev = exit_event(0, None);
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"type\":\"exit\""));
        assert!(json.contains("\"exit_code\":0"));
        assert!(json.contains("\"signal\":null"));
    }

    #[test]
    fn wall_clock_quota_shape() {
        let ev = quota_exceeded_wall_clock(600_123, 600_000);
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"kind\":\"wall_clock\""));
        assert!(json.contains("\"elapsed_ms\":600123"));
        assert!(json.contains("\"cap_ms\":600000"));
        assert!(!json.contains("used_bytes"));
    }
}
