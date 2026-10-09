# Fix: CLI cache cleanup no longer refuses paths that are merely shorter than home

## What

`install` and `update` clear the OpenCode plugin cache and lock files, and
`uninstall --clean` removes the plugin's prompts, config and install backups.
Every one of these deletions first passes a safety floor. That floor refused
the filesystem root, the home directory, and any path whose string was not
longer than the home path.

The length rule also refused legitimate targets. With
`XDG_CACHE_HOME=/var/cache` and a long home path, the cache directory
`/var/cache/opencode/packages/opencode-swarm@latest` is shorter than home, so
it could never be evicted and `update` silently kept the stale plugin.

The floor now refuses exactly:
- the filesystem root;
- the home directory;
- any ancestor of home (for example `/home` or `C:\Users`), compared
  case-insensitively on Windows.

Every guard still applies its own depth, basename and parent-shape checks
after the floor, so only the tool-owned leaf shapes can be deleted.

## Why

A string-length comparison is not a path relationship: it refused safe
paths and was the only floor shared by all five guards. The new floor names
the paths that are actually catastrophic to delete.

## Migration

None.
