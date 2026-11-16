/**
 * Bun test preload (PR #3328 closeout; #3355 hardening): neutralize BOTH
 * ambient SDD-selection inputs before ANY test file loads.
 *
 * Registered in bunfig.toml under [test] preload, alongside
 * `executable-resolver-pin.ts`. Why this exists: `readEffectiveSpecSync` now
 * honors `SWARM_SDD_SOURCE` (declarative SDD provider selection) and the
 * user-level config (`sdd.source` in
 * `$XDG_CONFIG_HOME/opencode/opencode-swarm.json`), so a developer shell or
 * host that carries either one silently changes the outcome of every suite
 * that resolves an effective spec WITHOUT passing `opts.source`
 * (src/sdd/effective-spec.test.ts, tests/unit/commands/sdd*.test.ts,
 * issue-2501 multi-feature, diagnose-buffered-warning, ...). Several of those
 * files are grandfathered over the FR-006 500-line cap and may only shrink, so
 * a per-file `beforeEach` env pin is not possible there; a single preload fixes
 * all of them at once (the same reasoning as executable-resolver-pin.ts).
 *
 * Issue #3355: the user-level-config half is neutralized UNCONDITIONALLY —
 * overwriting `XDG_CONFIG_HOME` even when the host explicitly exports it
 * (an exported-but-real config dir leaked through the earlier unset-only
 * guard). The original value, when present, is stashed in
 * `SWARM_TEST_NEUTRALIZED_XDG_CONFIG_HOME` for inspection. The replacement is
 * a per-process empty directory (`canonicalMkdtemp`: realpath-canonicalized
 * temp root, never deleted — one bounded empty dir per test process).
 *
 * Tests that exercise either variable set their own values and restore them
 * in `afterEach`; this preload only removes the AMBIENT influence. Suites
 * that intentionally pin `XDG_CONFIG_HOME` (the config-reading ones) do so in
 * their own `beforeEach`, which runs after this preload and wins.
 */
import { canonicalMkdtemp } from '../helpers/tmpdir';

delete process.env.SWARM_SDD_SOURCE;
if (process.env.XDG_CONFIG_HOME !== undefined) {
	process.env.SWARM_TEST_NEUTRALIZED_XDG_CONFIG_HOME =
		process.env.XDG_CONFIG_HOME;
}
process.env.XDG_CONFIG_HOME = canonicalMkdtemp('swarm-xdg-neutral-');
