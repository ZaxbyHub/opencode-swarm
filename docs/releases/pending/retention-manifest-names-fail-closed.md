# Retention manifests: a misnamed `.json` file no longer disables its claim silently

## What

`.swarm/retention.d/` previously skipped any `.json` file whose name fell outside
the manifest name grammar (for example `_reviewer.json`, `my reviewer.json`), with
no error: its claimed directory was then pruned at the default 30-day horizon, and
a malformed body in such a file did not refuse the unclaimed-directory catch-all as
documented.

A non-dot `.json` file in `retention.d` whose name is not a valid manifest name now
makes the unclaimed-directory catch-all refuse to run, with the file and the reason
in the sweep result, like any other malformed manifest. This includes a `.json`
name followed by trailing dots or whitespace (`reviewer.json `, `reviewer.json.`),
and the check is case-insensitive (`_x.JSON` is refused). Dotfiles and names that do
not end in `.json` (editor scratch files, `x.json.bak`) are still ignored.

## Behavior change: only the catch-all is refused

A malformed or misnamed manifest now skips only the tier-3 unclaimed-directory
catch-all (its `retention.dry_run` listing included). Every directory-family pass
and the other retention passes still run, because they never read the claims. This
narrows the v7.204.10 behavior, where an unusable manifest refused the whole sweep
and stopped family prunes as well. The catch-all stays fail-closed: nothing under
`.swarm/` that is unclaimed is deleted while a claim cannot be verified.

The reason is visible only in the debug log (`OPENCODE_SWARM_DEBUG=1`), because
neither production caller reads the sweep result. A grammar-valid stray `.json`
(for example `notes.json` or `owner-copy.json`) already refused this way before
this change; the change widens the set of names that do. OS file-manager duplicates
such as `owner (1).json` or `Copy of owner.json` used to be skipped harmlessly and
now stop the catch-all until renamed or removed.

## Migration

If a project has a hand-made `retention.d/_x.json` (or a name with a space or
non-ASCII letter, or a file-manager duplicate), rename it to start with a letter or
digit and use only letters, digits, `.`, `_` and `-`, or delete it if it is not a
claim. Until then the catch-all is skipped, the file is named in the debug log
(`OPENCODE_SWARM_DEBUG=1`), and no unclaimed directory is deleted.

Doc corrections to the v7.204.10 release notes (#3727), which stay as published:
the tier-3 rule is "no future-dated file" (age is measured from regular files),
not "no future-dated entries", and the retention result is surfaced only in the
debug log because neither production caller reads it.
