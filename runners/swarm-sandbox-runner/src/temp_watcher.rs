use crate::error::RunnerError;
use crate::events;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub struct TempWatcher {
    stop_flag: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl TempWatcher {
    pub fn start(
        temp_root: String,
        cap_bytes: u64,
        kill_callback: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let flag = stop_flag.clone();

        let handle = std::thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(250));

                if flag.load(Ordering::Relaxed) {
                    break;
                }

                match dir_size(Path::new(&temp_root)) {
                    Ok(size) if size > cap_bytes => {
                        events::emit(&events::quota_exceeded_temp(size, cap_bytes));
                        kill_callback();
                        break;
                    }
                    _ => {}
                }
            }
        });

        TempWatcher {
            stop_flag,
            handle: Some(handle),
        }
    }

    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for TempWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

fn dir_size(path: &Path) -> Result<u64, RunnerError> {
    let mut total = 0u64;
    if !path.exists() {
        return Ok(0);
    }

    let entries = std::fs::read_dir(path)?;
    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_file() {
            total += meta.len();
        } else if meta.is_dir() {
            total += dir_size(&entry.path())?;
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn dir_size_empty() {
        let dir = std::env::temp_dir().join("tw-empty-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let size = dir_size(&dir).unwrap();
        assert_eq!(size, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dir_size_with_files() {
        let dir = std::env::temp_dir().join("tw-files-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "hello").unwrap();
        fs::write(dir.join("b.txt"), "world!").unwrap();
        let size = dir_size(&dir).unwrap();
        assert_eq!(size, 11); // "hello" (5) + "world!" (6)
        let _ = fs::remove_dir_all(&dir);
    }
}
