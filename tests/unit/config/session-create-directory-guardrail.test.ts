/**
 * Phase 4.2 class guardrail — foreign-directory `session.create` call sites.
 *
 * ## The defect class
 *
 * OpenCode partitions permission state per directory: `Permission.state`,
 * `Agent.state`, `Plugin.state` and `ToolRegistry.state` are all built through
 * the same directory-keyed `InstanceState` cache. A session created against a
 * directory therefore lands in that directory's permission universe.
 *
 * The class is NOT "a session created in a directory other than the project
 * root". A plugin tool's `ctx.directory` is the *invoking instance's*
 * directory (host `ToolRegistry.state`, ~offset 100775000:
 * `vi = { ...Ro, ask: ..., directory: W.directory, worktree: W.worktree }`
 * where `W` is the InstanceState context). So threading `ctx.directory` through
 * to `session.create` keeps the child in the SAME instance and the SAME
 * permission universe — that is safe, even when the directory is a worktree.
 *
 * The actual defect is:
 *
 *   **`query.directory` differs from the `ctx.directory` threaded into that
 *   call site, without the resulting fresh permission partition being handled.**
 *
 * A site like that gets an empty `approved` list (every prior "Allow always" is
 * forgotten) and a private pending map. If no TUI is attached to that instance,
 * `Permission.ask` parks on a deferred with no timeout and the work hangs
 * forever.
 *
 * ## What this test enforces
 *
 * It maintains an exhaustive inventory of every `session.create(` call site in
 * `src/` together with the directory expression each one passes. Any new call
 * site, or any change to an existing site's directory expression, fails until a
 * human classifies it here. Foreign sites additionally require an explicit
 * disposition.
 *
 * Modelled on `tests/unit/hooks/hook-composition.test.ts`, which uses the same
 * source-scanning approach to keep the fail-closed hook chain honest.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '..', '..', '..', 'src');

type Classification = 'same-instance' | 'foreign';

/**
 * Allowed dispositions for a FOREIGN site. A foreign site with no disposition
 * is an unreviewed instance of the defect class.
 */
type Disposition =
	/** The foreign directory is a swarm worktree lane, so the plugin `config`
	 *  hook running in that instance resolves its permissions up front
	 *  (`src/config/lane-permissions.ts`). */
	| 'lane-permission-handled'
	/** The foreign directory is NOT a swarm worktree lane, so lane policy must
	 *  not be applied to it (the approved policy requires non-lane sessions to
	 *  be completely unaffected). Known gap, documented in `note`. */
	| 'foreign-non-lane-documented';

interface DeclaredSite {
	file: string;
	/** Directory expression exactly as the scanner normalises it. */
	directoryExpr: string;
	classification: Classification;
	disposition?: Disposition;
	note: string;
}

/**
 * THE INVENTORY. Every `session.create(` in `src/` must appear here.
 *
 * To add a site: run this test, copy the reported `file|expr` pair, and add an
 * entry with an honest classification. If your new site passes a directory that
 * differs from the `ctx.directory` threaded into it, it is `foreign` and needs
 * a disposition — do not classify it `same-instance` to make the test pass.
 */
const DECLARED_SITES: DeclaredSite[] = [
	{
		file: 'src/evaluation/ephemeral-agent-dispatcher.ts',
		directoryExpr: 'request.directory',
		classification: 'foreign',
		disposition: 'foreign-non-lane-documented',
		note:
			'Two production chains, both under os.tmpdir() and neither a swarm worktree lane: ' +
			'src/evaluation/runner.ts:750 passes args.isolatedRoot (a subpath of a disposable ' +
			'worktree created at path.join(os.tmpdir(), WORKTREE_PARENT) by ' +
			'src/evaluation/disposable-worktree.ts), and src/evaluation/gate-audit.ts:480 passes ' +
			'a mkdtempSync root under os.tmpdir(). Both get a fresh permission partition and can ' +
			'hang the same way. NOT covered by lane-permission handling: resolveLaneContext ' +
			'requires a swarm-OWNED linked git worktree (a `swarm/`/`swarm-lane/` branch, or the ' +
			'.swarm-worktrees path fallback) and neither temp root is one, and the approved ' +
			'policy explicitly forbids applying lane policy to non-lane sessions. Known gap.',
	},
	{
		file: 'src/full-auto/oversight.ts',
		directoryExpr: 'input.directory',
		classification: 'same-instance',
		note: 'Closes over ctx.directory captured at plugin init (src/index.ts:1202-1204).',
	},
	{
		file: 'src/hooks/curator-llm-factory.ts',
		directoryExpr: 'directory',
		classification: 'same-instance',
		note: 'The `directory` parameter is the caller tool/hook ctx.directory, passed through unchanged.',
	},
	{
		file: 'src/hooks/delegation-gate/worktree-isolation.ts',
		directoryExpr: 'provisionResult.worktreePath',
		classification: 'foreign',
		disposition: 'lane-permission-handled',
		note:
			'PRIMARY FIX SITE. Creates the worktree-lane session that started this defect. ' +
			'provisionWorktree builds the path under resolveWorktreeBaseDir (.swarm-worktrees), ' +
			'so the lane instance is recognised by src/config/lane-context.ts and its ' +
			'permissions are pre-resolved by the plugin config hook.',
	},
	{
		file: 'src/hooks/full-auto-intercept.ts',
		directoryExpr: 'directory',
		classification: 'same-instance',
		note: 'Closes over ctx.directory captured at plugin init (src/index.ts:1184-1186).',
	},
	{
		file: 'src/hooks/skill-improver-llm-factory.ts',
		directoryExpr: 'directory',
		classification: 'same-instance',
		note: 'The `directory` parameter is the caller tool/command ctx.directory.',
	},
	{
		file: 'src/mutation/generator.ts',
		directoryExpr: 'directory',
		classification: 'same-instance',
		note: 'Resolves from the generate_mutants tool ctx (ctx.directory ?? process.cwd()).',
	},
	{
		file: 'src/tools/dispatch-lanes.ts',
		directoryExpr: 'HELPER buildLaneSessionCreateArgs(args.directory)',
		classification: 'same-instance',
		note:
			'dispatch_lanes_async tool ctx.directory. buildLaneSessionCreateArgs ' +
			'(src/tools/dispatch-lanes.ts:2510) returns query.directory unchanged.',
	},
	{
		file: 'src/tools/dispatch-lanes.ts',
		directoryExpr: 'HELPER buildLaneSessionCreateArgs(directory)',
		classification: 'same-instance',
		note: 'dispatch_lanes tool ctx.directory, passed through buildLaneSessionCreateArgs unchanged.',
	},
	{
		file: 'src/turbo/lean/integration.ts',
		directoryExpr: 'directory',
		classification: 'same-instance',
		note:
			'dispatchPhaseCritic parameter — same-instance when reached. NOTE it currently has ' +
			'zero production callers, so the site is unreachable rather than unsafe. It is NOT ' +
			'dead code to delete: writeCriticEvidence (integration.ts:411, reachable only via ' +
			'dispatchPhaseCritic) is the ONLY writer of .swarm/evidence/{phase}/lean-turbo-critic.json, ' +
			'which src/turbo/lean/phase-ready.ts:675 reads to satisfy the phase_critic gate — a ' +
			'flag that defaults to true (src/config/schema.ts) and is documented in ' +
			'docs/configuration.md and docs/modes.md. This is an UNWIRED FEATURE (the missing ' +
			'lean_turbo_critic tool registration, mirroring lean_turbo_review) and needs wiring ' +
			'or an explicit product decision to remove the flag and docs too — not a silent delete.',
	},
	{
		file: 'src/turbo/lean/runner.ts',
		directoryExpr: 'effectiveDirectory',
		classification: 'foreign',
		disposition: 'lane-permission-handled',
		note:
			'PRIMARY FIX SITE. effectiveDirectory = worktreeDirectory ?? this._directory; ' +
			'worktreeDirectory is set at src/turbo/lean/runner.ts:1087/1124 from ' +
			'provisionWorktree(...).worktreePath. The lane is NOT necessarily under ' +
			'.swarm-worktrees (a worktree_dir override or the Windows path-budget fallback ' +
			'place it elsewhere), so recognisability rests on the BRANCH grammar, which the ' +
			'executable assertions below verify rather than assert by annotation. The ' +
			'fallback branch is same-instance.',
	},
];

import {
	buildSwarmBranchName,
	matchSwarmLaneBranch,
} from '../../../src/config/swarm-branch';
import {
	discoverSites,
	stripCommentsWithState,
	tokenizerFailures,
} from '../../helpers/session-create-scanner';

const identity = (s: { file: string; directoryExpr: string }): string =>
	`${s.file}|${s.directoryExpr}`;

const HOWTO = [
	'',
	'A `session.create(` call site in src/ is not declared in DECLARED_SITES,',
	'or its directory expression changed.',
	'',
	'WHY THIS MATTERS: OpenCode partitions permission state per directory.',
	'Creating a session against a directory that differs from the ctx.directory',
	'threaded into the call site gives that session an EMPTY `approved` list and',
	'a private pending map. If no TUI is attached to that instance, an',
	'`external_directory` prompt raised there can never be answered and the work',
	'hangs forever (Permission.ask awaits its deferred with no timeout).',
	'',
	'WHAT TO DO:',
	' 1. Trace the directory expression to its origin.',
	' 2. If it is the same ctx.directory threaded into this call site, declare it',
	"    `classification: 'same-instance'` with a note naming the origin.",
	" 3. If it differs, it is `classification: 'foreign'` and needs a disposition:",
	"      'lane-permission-handled'        - it is a .swarm-worktrees lane, so",
	'                                         src/config/lane-permissions.ts',
	'                                         pre-resolves its permissions.',
	"      'foreign-non-lane-documented'    - it is not a lane; record the gap.",
	' 4. Do NOT classify a foreign site as same-instance to silence this test.',
	'',
].join('\n');

describe('Phase 4.2 guardrail: session.create foreign-directory inventory', () => {
	const discovered = discoverSites(SRC_ROOT);

	test('every discovered call site is declared (and nothing declared is stale)', () => {
		const discoveredIds = discovered.map(identity).sort();
		const declaredIds = DECLARED_SITES.map(identity).sort();
		const undeclared = discovered.filter(
			(s) => !declaredIds.includes(identity(s)),
		);
		const stale = DECLARED_SITES.filter(
			(s) => !discoveredIds.includes(identity(s)),
		);
		const detail = [
			HOWTO,
			undeclared.length
				? `UNDECLARED:\n${undeclared.map((s) => `  ${s.file}:${s.line} | ${s.directoryExpr}`).join('\n')}`
				: '',
			stale.length
				? `STALE (declared but no longer found — remove the entry):\n${stale.map((s) => `  ${identity(s)}`).join('\n')}`
				: '',
		]
			.filter(Boolean)
			.join('\n');
		expect({
			undeclared: undeclared.map(identity),
			stale: stale.map(identity),
			detail,
		}).toEqual({ undeclared: [], stale: [], detail });
	});

	test('the scanner actually finds call sites (it cannot pass by finding nothing)', () => {
		expect(discovered.length).toBeGreaterThanOrEqual(DECLARED_SITES.length);
		expect(discovered.length).toBeGreaterThan(5);
	});

	test('the tokenizer parses every source file to completion (no silent blindness)', () => {
		// A stripper that loses track (e.g. treats `/*` inside a string literal as
		// a block comment) blanks the rest of that file and silently stops
		// finding call sites in it. The count assertion above cannot detect
		// PARTIAL blindness, so assert the terminal state per file instead.
		expect(tokenizerFailures).toEqual([]);
	});

	test('regression: a `/*` inside a string literal does not blind the scanner', () => {
		// The exact construct that defeated the previous 3-state stripper. Seven
		// files in src/ contain one, including this feature's own
		// src/config/lane-permissions.ts.
		const sample = [
			"const glob = '**/*.ts';",
			'const other = "a /* not a comment";',
			'const t = `tpl /* still not */ ${x} end`;',
			'const re = /[/*]/g;',
			'await client.session.create({ query: { directory: laterDir } });',
		].join('\n');
		const stripped = stripCommentsWithState(sample);
		expect(stripped.state).toBe('code');
		expect(stripped.source).toContain('session.create(');
		expect(stripped.source).toContain('laterDir');
	});

	test('regression: real comments are still blanked', () => {
		const sample = [
			'/* await client.session.create({ query: { directory: ghost } }); */',
			'// await client.session.create({ query: { directory: ghost2 } });',
			'const real = 1;',
		].join('\n');
		const stripped = stripCommentsWithState(sample);
		expect(stripped.state).toBe('code');
		expect(stripped.source).not.toContain('session.create(');
		expect(stripped.source).toContain('const real = 1;');
		// Line numbering must survive blanking.
		expect(stripped.source.split('\n').length).toBe(3);
	});

	test('no call site has an unrecognised directory expression', () => {
		const bad = discovered.filter((s) => s.directoryExpr === 'UNRECOGNISED');
		expect(bad.map((s) => `${s.file}:${s.line}`)).toEqual([]);
	});

	test('every FOREIGN site carries an explicit disposition', () => {
		const missing = DECLARED_SITES.filter(
			(s) => s.classification === 'foreign' && !s.disposition,
		);
		expect(missing.map((s) => s.file)).toEqual([]);
	});

	test('every declared site carries a non-trivial note', () => {
		for (const site of DECLARED_SITES) {
			expect(site.note.trim().length).toBeGreaterThan(20);
		}
	});

	test('the two known worktree-lane sites are covered by lane-permission handling', () => {
		const covered = DECLARED_SITES.filter(
			(s) => s.disposition === 'lane-permission-handled',
		).map((s) => s.file);
		expect(covered).toContain(
			'src/hooks/delegation-gate/worktree-isolation.ts',
		);
		expect(covered).toContain('src/turbo/lean/runner.ts');
	});

	test('EXECUTABLE: every branch a lane site can provision IS recognisable', () => {
		// The disposition string is an annotation; annotations drift. This asserts
		// the PROPERTY the disposition claims — that a lane created through the
		// provisioning boundary is one lane detection can actually recognise —
		// across every naming style provisionWorktree can emit.
		//
		// This is the assertion that would have caught the unvalidated-sessionID
		// hole: `ses-run-1` passes the host's `isStartsWith("ses")` brand but
		// yields `swarm-lane/ses-run-1/lane-1`, which the recogniser rejects.
		const realSessionId = 'ses_0410b724cffeApmZIOs5VH9XsN';
		for (const purpose of ['lane', 'review', 'evaluation']) {
			for (const legacy of [false, true]) {
				const branch = buildSwarmBranchName(
					realSessionId,
					'1.1',
					purpose,
					legacy,
				);
				expect(matchSwarmLaneBranch(branch)).toBeDefined();
			}
		}
	});

	test('EXECUTABLE: provisioning refuses any sessionID it could not later recognise', () => {
		// The structural guard in provisionWorktree and the recogniser used by
		// lane detection must be the SAME rule, with no gap between them.
		for (const sessionId of ['ses-run-1', 'phase-3', 'session123', 'ses_']) {
			const branch = buildSwarmBranchName(sessionId, 'lane-1', 'lane', false);
			expect(matchSwarmLaneBranch(branch)).toBeUndefined();
		}
		const guardSource = fs.readFileSync(
			path.join(SRC_ROOT, 'worktree', 'core.ts'),
			'utf-8',
		);
		// provisionWorktree must hard-fail, not warn, on an unrecognisable branch.
		expect(guardSource).toMatch(/if \(!matchSwarmLaneBranch\(branchName\)\)/);
		expect(guardSource).toContain('Refusing to provision worktree');
	});

	test('lane-permission handling actually exists and is wired into the config hook', () => {
		// A disposition of 'lane-permission-handled' is only meaningful if the
		// handler is real and reachable from the plugin entry point.
		const indexSource = fs.readFileSync(
			path.join(SRC_ROOT, 'index.ts'),
			'utf-8',
		);
		expect(indexSource).toContain('applyLanePermissions');
		expect(indexSource).toMatch(
			/applyLanePermissions\(\s*opencodeConfig,\s*ctx\.directory,/,
		);
		expect(
			fs.existsSync(path.join(SRC_ROOT, 'config', 'lane-permissions.ts')),
		).toBe(true);
		expect(
			fs.existsSync(path.join(SRC_ROOT, 'config', 'lane-context.ts')),
		).toBe(true);
	});
});
