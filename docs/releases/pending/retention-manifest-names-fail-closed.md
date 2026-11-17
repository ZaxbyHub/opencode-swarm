# Retention manifests: a misnamed `.json` file no longer disables its claim silently

## What

`.swarm/retention.d/` previously skipped any `.json` file whose name fell outside
the manifest name grammar (for example `_reviewer.json`, `my reviewer.json`), with
no error: its claimed directory was then pruned at the default 30-day horizon, and
a malformed body in such a file did not refuse the sweep as documented.

A non-dot `.json` file in `retention.d` whose name is not a valid manifest name now
refuses the whole sweep, naming the file and the reason, like any other malformed
manifest. Dotfiles and names that do not end in `.json` (editor scratch files,
`x.json` plus a temp suffix) are still ignored.

## Migration

If a project has a hand-made `retention.d/_x.json` (or a name with a space or
non-ASCII letter), rename it to start with a letter or digit and use only letters,
digits, `.`, `_` and `-`. Until renamed the sweep refuses, names the file, and
deletes nothing.

Doc corrections in the same change: the tier-3 rule is "no future-dated file" (age
is measured from regular files), and the retention result is surfaced only in the
debug log (`OPENCODE_SWARM_DEBUG=1`) because neither production caller reads it.
