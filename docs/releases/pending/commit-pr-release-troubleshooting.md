# Release workflow troubleshooting in commit-pr skill

## What changed

- Added "Troubleshooting — Release workflow automation gaps" section to the commit-pr skill
- Documents the root cause: `update-pr-notes` job is skipped when `releases_created=true`
- Provides safe PowerShell recovery procedure using `--body-file` / `--notes-file` patterns
- Clarifies gh CLI jq `$` expansion issues in PowerShell

## Why

During the v7.21.4/v7.21.5 release cycle, the automation gap left pending release-note fragments unaggregated into the next release PR body. Agents need documented recovery procedures for this scenario.

## Migration steps

None.

## Known caveats

None.
