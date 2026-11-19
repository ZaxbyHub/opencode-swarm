# Retention manifests: a misnamed `.json` file no longer disables its claim silently

## What

`.swarm/retention.d/` previously skipped any `.json` file whose name fell outside
the manifest name grammar (for example `_reviewer.json`, `my reviewer.json`), with
no error: its claimed directory was then pruned at the default 30-day horizon, and
a malformed body in such a file did not refuse the sweep as documented.

A non-dot `.json` file in `retention.d` whose name is not a valid manifest name now
refuses the whole sweep, naming the file and the reason, like any other malformed
manifest. This includes a `.json` name followed by trailing dots or whitespace
(`reviewer.json `, `reviewer.json.`), and the check is case-insensitive
(`_x.JSON` is refused). Dotfiles and names that do not end in `.json` (editor
scratch files, `x.json.bak`) are still ignored.

The refusal covers the whole sweep: every family pass and the unclaimed-directory
catch-all stop, `retention.dry_run` is refused as well, and nothing is deleted. The
reason is visible only in the debug log (`OPENCODE_SWARM_DEBUG=1`), because neither
production caller reads the sweep result. Before this change a stray `.json` with a
grammar-valid name (for example `notes.json` or `owner-copy.json`) already refused
the sweep the same way; this change widens the set of names that do. OS
file-manager duplicates such as `owner (1).json` or `Copy of owner.json` used to be
skipped harmlessly and now refuse until renamed or removed.

## Migration

If a project has a hand-made `retention.d/_x.json` (or a name with a space or
non-ASCII letter, or a file-manager duplicate), rename it to start with a letter or
digit and use only letters, digits, `.`, `_` and `-`, or delete it if it is not a
claim. Until then the sweep refuses, names the file in the debug log
(`OPENCODE_SWARM_DEBUG=1`), and deletes nothing.

Doc corrections to the v7.204.10 release notes (#3727), which stay as published:
the tier-3 rule is "no future-dated file" (age is measured from regular files),
not "no future-dated entries", and the retention result is surfaced only in the
debug log because neither production caller reads it.
