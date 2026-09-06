## Disabled compaction no longer throws through the registered host hook

Setting the documented opt-out `hooks.compaction=false` used to break every
session compaction instead of disabling the plugin's compaction enrichment:
the registered `experimental.session.compacting` wrapper awaited a handler
that `createCompactionCustomizerHook` omits when the flag is false, so each
compaction (including the automatic one at context overflow) rejected with
`TypeError: compactionHook["experimental.session.compacting"] is not a
function`, which the host does not catch — wedging the session at the context
limit exactly when compaction was needed most (issue #2533, audit HOOKS-1).

**What changed.** The wrapper now calls the compaction customizer only when
the factory actually provided it. The wrapper stays registered in every flag
state because it also carries a flag-independent obligation: the per-turn
injection-ledger reset (`advanceTurnGeneration`, #2107 §4) that must fire on
every host compaction — the host still compacts when the plugin's
customization is disabled. Behavior with `hooks.compaction=true` or absent is
unchanged: the registered hook still appends exactly one bounded
`<swarm_compaction_facts>` block to the compaction context.

**Why it matters.** `hooks.compaction` is a documented opt-out
(`docs/installation.md`); taking it now yields "no plugin enrichment" rather
than "broken compaction". A census of every other conditionally-registered
hook confirmed this was the only unguarded site of its class, and a new
guardrail test boots the real plugin with each gated-hook flag disabled to
keep it that way. The compaction tests drive the REAL plugin through
`server()` (the registered host hook), via a new shared
`tests/helpers/plugin-host.ts` boot helper that the upcoming interrupt/resume
compaction scenarios (#2585) reuse.
