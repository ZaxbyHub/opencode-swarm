/**
 * Issue #2679 — static source guardrail: the bootstrap root binding.
 *
 * The fix resolves the project root ONCE per boot
 * (`resolveProjectRootDecision(ctx.directory)` → `bootstrapRoot`) and threads
 * it through EVERY project-surface consumer in `src/index.ts`: `.swarm`
 * state, project config, telemetry, observability, agent configs, plan/
 * session state. Before the fix these call sites consumed raw
 * `ctx.directory`, so an ordinary child boot created a SECOND runtime-state
 * tree under the child. This test FAILS on the pre-fix tree — that is the
 * guardrail property. Its runtime counterparts are the frozen acceptance
 * checks C1 (ordinary-child redirect) and C6 (late writer) in
 * .agents/issue-traces/2679-project-root-ownership-bootstrap/repro/ and the
 * boot tests in tests/unit/index-bootstrap-root-ownership-2679.test.ts.
 *
 * Scan approach (robust to formatting): for each symbol, find EVERY
 * `\bsymbol\(` occurrence and require that within the next 200 characters
 * (enough for a multi-line argument list) the binding appears:
 *   - PROJECT-surface symbols: `bootstrapRoot`, never `ctx.directory`;
 *   - WORKSPACE-surface symbols (git diffs, file authority, lane
 *     permissions): `ctx.directory`, never `bootstrapRoot`.
 *
 * Known deviation from the fix brief: the host session-API lookup
 * `query: { directory: ... }` is threaded at `bootstrapRoot` in the actual
 * implementation (src/index.ts, lookupParentSessionIDForTaskRoute) so the
 * host resolves child sessions against the root that owns the state — this
 * test pins the implemented shape, not the brief's `ctx.directory` spelling.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE_PATH = path.join(import.meta.dir, '..', '..', 'src', 'index.ts');
const SOURCE = readFileSync(SOURCE_PATH, 'utf-8');

/** Argument-window length after `symbol(` — long enough for multi-line calls, short enough to stay in the call. */
const ARG_WINDOW_CHARS = 200;

interface CallSite {
	line: number;
	window: string;
}

function callSites(symbol: string): CallSite[] {
	const pattern = new RegExp(`\\b${symbol}\\(`, 'g');
	const sites: CallSite[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(SOURCE)) !== null) {
		const start = match.index + match[0].length;
		sites.push({
			line: SOURCE.slice(0, match.index).split('\n').length,
			window: SOURCE.slice(start, start + ARG_WINDOW_CHARS),
		});
	}
	return sites;
}

/**
 * PROJECT-surface symbols (#2679): every call site must bind `bootstrapRoot`
 * and none may fall back to the opened workspace's `ctx.directory`.
 */
const PROJECT_SURFACE_SYMBOLS = [
	'loadPluginConfigWithMetaAsyncForInit',
	'loadSnapshotForInit',
	'hasSwarmState',
	'ensureSwarmGitExcludedForInit',
	'hasGitMarkerAncestor',
	'initObservability',
	'registerObservabilityEventSink',
	'initTelemetry',
	'repoGraphHookFactory',
	'startSnapshotCoordinationInitialization',
	'runInitOrphanRecovery',
	'cleanupOldTrajectoryFiles',
	'runRetentionSweep',
	'maintainBackgroundDelegations',
	'writeSwarmConfigExampleIfNew',
	'syncBundledProjectSkillsIfMissingAsync',
	'getAgentConfigs',
	'regenerateMemoryReflectionForInit',
	'createSnapshotWriterHook',
	'loadPlan',
	'ensureAgentSession',
	'cacheCohortIdAtMessage',
] as const;

/**
 * WORKSPACE-surface symbols: these intentionally keep `ctx.directory` (git
 * diffs, file authority, and lane permission scoping operate on the OPENED
 * workspace, which for a lane instance IS ctx.directory).
 */
const WORKSPACE_SURFACE_SYMBOLS = [
	'hasManifestAncestor',
	'buildProjectContext',
	'applyLanePermissions',
	'beginApprovedReviewerScopeLifecycle',
	'completeReviewerScopeLifecycle',
] as const;

describe('src/index.ts bootstrap-root sources (#2679)', () => {
	test('every project-surface call site binds bootstrapRoot and never ctx.directory', () => {
		const violations: string[] = [];
		for (const symbol of PROJECT_SURFACE_SYMBOLS) {
			const sites = callSites(symbol);
			if (sites.length === 0) {
				violations.push(`${symbol}: no call site found (renamed or removed?)`);
				continue;
			}
			for (const site of sites) {
				if (!site.window.includes('bootstrapRoot')) {
					violations.push(
						`${symbol} (line ${site.line}): no bootstrapRoot within ${ARG_WINDOW_CHARS} chars of the call`,
					);
				}
				if (site.window.includes('ctx.directory')) {
					violations.push(
						`${symbol} (line ${site.line}): still consumes ctx.directory — pre-fix shape`,
					);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	test('workspace-surface call sites keep ctx.directory and never bootstrapRoot', () => {
		const violations: string[] = [];
		for (const symbol of WORKSPACE_SURFACE_SYMBOLS) {
			const sites = callSites(symbol);
			if (sites.length === 0) {
				violations.push(`${symbol}: no call site found (renamed or removed?)`);
				continue;
			}
			for (const site of sites) {
				if (!site.window.includes('ctx.directory')) {
					violations.push(
						`${symbol} (line ${site.line}): expected ctx.directory within ${ARG_WINDOW_CHARS} chars of the call`,
					);
				}
				if (site.window.includes('bootstrapRoot')) {
					violations.push(
						`${symbol} (line ${site.line}): unexpectedly rebound to bootstrapRoot (workspace surface)`,
					);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	test('the resolver is invoked with ctx.directory and derives the bootstrap root', () => {
		// The decision input is the OPENED workspace; ownership is derived from it.
		expect(/resolveProjectRootDecision\(ctx\.directory\)/.test(SOURCE)).toBe(
			true,
		);
		// bootstrapRoot is the redirect-or-workspace derivation, not a bare alias.
		expect(/const bootstrapRoot =/.test(SOURCE)).toBe(true);
		expect(SOURCE).toContain(
			"rootDecision.kind === 'redirect' ? rootDecision.owningRoot : ctx.directory",
		);
	});

	test('the host session-API lookup is threaded at the owning bootstrap root', () => {
		// Deviation note (header): the implementation resolves child-session
		// parentage against the root that owns the state, so the query binds
		// bootstrapRoot rather than ctx.directory.
		expect(/query:\s*\{\s*directory:\s*bootstrapRoot/.test(SOURCE)).toBe(true);
	});
});
