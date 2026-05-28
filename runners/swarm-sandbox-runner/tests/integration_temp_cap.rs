use std::fs;
use std::path::Path;

#[test]
fn temp_watcher_detects_size() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use swarm_sandbox_runner::temp_watcher::TempWatcher;

    let dir = std::env::temp_dir().join("tw-cap-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();

    // Write 2KB to exceed a 1KB cap
    fs::write(dir.join("large.bin"), vec![0u8; 2048]).unwrap();

    let killed = Arc::new(AtomicBool::new(false));
    let k = killed.clone();

    let mut watcher = TempWatcher::start(
        dir.to_string_lossy().to_string(),
        1024, // 1 KB cap
        Arc::new(move || {
            k.store(true, Ordering::Relaxed);
        }),
    );

    // Give the watcher time to poll
    std::thread::sleep(std::time::Duration::from_millis(600));

    watcher.stop();

    assert!(
        killed.load(Ordering::Relaxed),
        "temp watcher should have detected size exceeded"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn temp_watcher_does_not_fire_under_cap() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use swarm_sandbox_runner::temp_watcher::TempWatcher;

    let dir = std::env::temp_dir().join("tw-under-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();

    // Write 100 bytes, well under a 1MB cap
    fs::write(dir.join("small.bin"), vec![0u8; 100]).unwrap();

    let killed = Arc::new(AtomicBool::new(false));
    let k = killed.clone();

    let mut watcher = TempWatcher::start(
        dir.to_string_lossy().to_string(),
        1_048_576, // 1 MB cap
        Arc::new(move || {
            k.store(true, Ordering::Relaxed);
        }),
    );

    std::thread::sleep(std::time::Duration::from_millis(600));

    watcher.stop();

    assert!(
        !killed.load(Ordering::Relaxed),
        "temp watcher should NOT fire when under cap"
    );

    let _ = fs::remove_dir_all(&dir);
}
