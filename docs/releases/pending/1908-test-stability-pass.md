---
category: Fixed
---

# Retire the tracked merge-group stability backlog

## What changed

- Removed every tracked global, macOS-only, and integration quarantine after
  repairing the underlying privilege-dependent path fixtures, incomplete Pester
  capability detection, transient Windows cleanup, host-invalid message
  fixtures, and phase-completion test isolation.
- Replaced leaking test-runner module mocks with restored dependency seams and
  added a diff-scoped guard that blocks repository-local test temp roots from
  reintroducing shared `.swarm/` state.
- Made shell-script fixtures resolve Git Bash explicitly on Windows and model
  directory-link escapes with junctions, avoiding WSL and Developer Mode
  assumptions. The trace initializer also normalizes native Git paths before
  handing them to MSYS coreutils.
- Removed remaining Windows-only integration failures by using host-native path
  assertions, the current TypeScript profile label, and the packaged native
  Biome executable instead of a Unix-style package shim.
- Redirected XDG data storage in the shared test isolation helper so
  skill-generation fixtures cannot acquire locks in a user's real hive store.
- Closed a checkpoint-config prototype-pollution parsing gap discovered by the
  restored adversarial tier, and replaced its remaining privileged Windows
  symlink fixtures with junctions.

## Why

The quarantined tests repeatedly destabilized merge-group validation across
Ubuntu, macOS, and Windows. These repairs make the tests exercise the intended
runtime contracts without relying on host privileges, optional binaries, or
state shared through the repository checkout.

## Migration and compatibility

No user migration or configuration change is required. Checkpoint config now
fails closed for forbidden prototype keys and non-plain input objects; ordinary
JSON configuration is unchanged.
