# Bounded, read-only GitHub fetches for Bash 3.2 and newer.
bounded_gh_api() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${seconds}s" gh api "$@"
    return
  fi

  # macOS does not ship GNU timeout. Node is also used by checkpoint generation.
  node -e '
    const { spawnSync } = require("node:child_process");
    const [seconds, ...args] = process.argv.slice(1);
    const result = spawnSync("gh", ["api", ...args], {
      timeout: Number(seconds) * 1000,
      killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) console.error(result.error.message);
    if (result.error || result.status !== 0) process.exitCode = 1;
    else process.stdout.write(result.stdout);
  ' -- "$seconds" "$@"
}
