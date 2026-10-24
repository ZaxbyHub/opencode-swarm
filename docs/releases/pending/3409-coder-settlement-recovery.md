# Preserve interrupted coder settlement work

Coder settlement recovery now retains surviving recorded source commits even
when a lane checkout and branch are missing. Merge recovery can resume on a
compatible advanced primary branch while retaining conflict, dirty-overlap and
source-identity checks. Pending settlements protect their artifacts from
cleanup through shared dispatch/deletion admission.

Mixed foreground/background completion now hands off settlement ownership
before removing the lane. Interrupted handoff and leftover cleanup can replay
from saved provenance without merging twice; changed lanes remain preserved
for manual recovery.

Recovery also detects the specific historical missing-worktree self-heal that
may already have marked a settlement aborted. It reports the exact recoverable
commit and retained backup ref without reviving an old task generation.
Committed recovery releases its backup; unstaged and historical work remains
retained for explicit operator review. See
[coder settlement recovery](../../coder-settlement-recovery.md) for discovery
and safe cleanup commands.

No settlement schema or configuration migration is required.
