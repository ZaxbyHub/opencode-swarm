/**
 * Lane `external_directory` rule PRECEDENCE.
 *
 * Emission order (which IS evaluation order — the host uses `findLast`),
 * explicit-user-config override, host base-allow preservation, and the three
 * config-knob modes. Allowlist CONSTRUCTION lives in
 * `lane-permissions.test.ts`.
 *
 * Every behavioural assertion runs the emitted rules through
 * `tests/helpers/opencode-permission-model.ts`, a verbatim transcription of the
 * host's own `Wildcard.match` / `fromConfig` / `merge` / `evaluate`. That is
 * deliberate: the ordering contract (catch-all deny FIRST, allows after) is the
 * single thing most likely to be got backwards, and asserting on our own object
 * shape would not catch it.
 */
import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { getHostDataDir } from '../../../src/config/cache-paths';
import {
	asPermission,
	build,
	buildLaneExternalDirectoryRules,
	lane,
} from '../../helpers/lane-permissions-fixture';
import {
	evaluateExternalDirectory,
	hostFromConfig,
} from '../../helpers/opencode-permission-model';

describe('rule ordering — verified against the host evaluator', () => {
	const rules = build('scoped_allow');

	test('the catch-all deny is emitted FIRST (findLast means later wins)', () => {
		const keys = Object.keys(rules ?? {});
		expect(keys[0]).toBe('*');
		expect(rules?.['*']).toBe('deny');
		expect(keys.length).toBeGreaterThan(1);
	});

	test('allowlisted directories evaluate to allow', () => {
		const permission = asPermission(rules);
		expect(evaluateExternalDirectory(permission, lane.parentProjectPath)).toBe(
			'allow',
		);
		expect(evaluateExternalDirectory(permission, lane.lanePath)).toBe('allow');
		expect(
			evaluateExternalDirectory(permission, path.join(os.tmpdir(), 'opencode')),
		).toBe('allow');
	});

	test('the broad OS temp root is DENIED', () => {
		expect(evaluateExternalDirectory(asPermission(rules), os.tmpdir())).toBe(
			'deny',
		);
	});

	test('nested paths under an allowlisted directory also allow (dotAll `*`)', () => {
		const permission = asPermission(rules);
		expect(
			evaluateExternalDirectory(
				permission,
				path.join(lane.parentProjectPath, 'src', 'deep', 'nested'),
			),
		).toBe('allow');
	});

	test('a path outside the allowlist DENIES — it is never left at "ask"', () => {
		const permission = asPermission(rules);
		const outside = path.resolve(
			path.join(os.tmpdir(), '..', 'not-allowed-xyz'),
		);
		const action = evaluateExternalDirectory(permission, outside);
		expect(action).toBe('deny');
		// The whole point of the fix: nothing may remain answerable-only.
		expect(action).not.toBe('ask');
	});

	test('FALSIFIABILITY: emitting the catch-all deny LAST would deny everything', () => {
		// Reproduce the ordering mistake this module exists to prevent.
		const { '*': catchAll, ...allows } = rules ?? {};
		const reversed = { ...allows, '*': catchAll } as Record<string, string>;
		expect(
			evaluateExternalDirectory(asPermission(reversed), lane.parentProjectPath),
		).toBe('deny');
		// ...whereas the real ordering allows it. If both branches ever agree,
		// this test has stopped proving anything.
		expect(
			evaluateExternalDirectory(asPermission(rules), lane.parentProjectPath),
		).toBe('allow');
	});

	test('BASELINE: without our rules the host default leaves the request at "ask"', () => {
		// This is the hang. Confirms the fixture reproduces the real defect.
		expect(evaluateExternalDirectory({}, lane.parentProjectPath)).toBe('ask');
	});
});

describe('regression (MEDIUM-4): the lane ruleset must not revoke host base allows', () => {
	// The host base-allows four families for EVERY agent (Agent.state, offset
	// 100811506):
	//   q = [A.GLOB, join(Global.Path.tmp,'*'), ...Skill.dirs(),
	//        ...config-reference dirs]
	// NOTE the third family is SKILL directories, not config directories: the
	// Agent chunk imports `zr as _` from chunk-mdqr1haw.js and `zr` is the Skill
	// namespace (the one exposing `dirs`). An earlier version of this test said
	// `Config.directories()` and asserted the config dirs as "base allows
	// preserved" — a false model of the host, the same class of error as the
	// ancestor-`.opencode` claim corrected below.
	//
	// Our catch-all deny sits in front of these, so anything we do not re-grant
	// is silently REVOKED inside a lane. This test pins exactly which survive.
	const toolOutputGlob = path
		.join(os.homedir(), '.local', 'share', 'opencode', 'tool-output', '*')
		.split(path.sep)
		.join('/');

	const hostBaseAllowDirs = [
		// Global.Path.tmp — binary offset 107378900: join(os.tmpdir(),'opencode').
		path.join(os.tmpdir(), 'opencode'),
		// Skill.dirs() — every directory skill discovery found. The user-level
		// `.claude/skills` root is the one the field log hung on.
		path.resolve(os.homedir(), '.claude', 'skills'),
		path.resolve(lane.parentProjectPath, '.opencode', 'skills'),
	];

	test.each(
		hostBaseAllowDirs,
	)('host base allow %s is preserved inside a lane', (dir) => {
		const action = evaluateExternalDirectory(
			asPermission(build('scoped_allow')),
			dir,
			{ baseAllowDirs: hostBaseAllowDirs, toolOutputGlob },
		);
		expect(action).toBe('allow');
	});

	test('the tool-output glob survives via the host re-append, not via our rules', () => {
		// Our catch-all uses pattern '*', which does NOT satisfy the host's exact
		// `action==='deny' && pattern===A.GLOB` check, so the re-append still
		// fires and lands last.
		const action = evaluateExternalDirectory(
			asPermission(build('scoped_allow')),
			path.dirname(toolOutputGlob),
			{ baseAllowDirs: hostBaseAllowDirs, toolOutputGlob },
		);
		expect(action).toBe('allow');
	});

	test('the config dirs are a deliberate WIDENING, not a host base allow', () => {
		// They are granted (a lane reads global agent/command/skill definitions
		// from them) but the host does NOT base-allow them, so this is us
		// widening on purpose. Recorded so the distinction cannot quietly invert.
		const p = asPermission(build('scoped_allow'));
		expect(
			evaluateExternalDirectory(
				p,
				path.resolve(os.homedir(), '.config', 'opencode'),
			),
		).toBe('allow');
	});

	test('the ~/.opencode TREE is not granted, but its skill roots are', () => {
		// external_directory has no read/write split, and OpenCode's GitLab OAuth
		// helper stores credentials at ~/.opencode/auth.json when XDG_DATA_HOME is
		// unset (the default on Windows and macOS). Granting the tree would put a
		// credential file inside a lane's WRITE grant. The skill subpaths a lane
		// actually needs are granted individually.
		const p = asPermission(build('scoped_allow'));
		expect(
			evaluateExternalDirectory(p, path.join(os.homedir(), '.opencode')),
		).toBe('deny');
		expect(
			evaluateExternalDirectory(
				p,
				path.join(os.homedir(), '.opencode', 'skills'),
			),
		).toBe('allow');
	});

	test('no allowlist entry contains a known credential file', () => {
		// Belt-and-braces against a future widening re-admitting one.
		const p = asPermission(build('scoped_allow'));
		for (const dir of [
			path.resolve(getHostDataDir()), // primary Auth service auth.json
			path.join(os.homedir(), '.opencode'), // GitLab OAuth helper auth.json
		]) {
			expect(evaluateExternalDirectory(p, dir)).toBe('deny');
		}
	});

	test('DISPOSITIONED revocation: config.references dirs, and ONLY those', () => {
		// Exactly ONE host base-allow family is not re-granted:
		// `config.references` directories, which a host service resolves from
		// user config and which the plugin config hook cannot obtain without
		// reimplementing that resolution.
		//
		// An earlier version of this test also claimed `.opencode` directories in
		// ancestors ABOVE the parent project were revoked. That was a false model
		// of the host. `ConfigPaths.directories` (offset 103303216) is:
		//   up({ targets: ['.opencode'], start: directory, stop: worktree })
		// — bounded by the worktree, so it never walks past it and those
		// ancestors were never base-allowed in the first place. Nothing to
		// revoke, and nothing to re-grant.
		const referenceDir = path.resolve(path.join(os.tmpdir(), 'shared-refs'));
		expect(
			evaluateExternalDirectory(
				asPermission(build('scoped_allow')),
				referenceDir,
				{ baseAllowDirs: [...hostBaseAllowDirs, referenceDir] },
			),
		).toBe('deny');
	});
});

describe('config-knob modes', () => {
	test('scoped_allow: allowlist allows, everything else denies', () => {
		const p = asPermission(build('scoped_allow'));
		expect(evaluateExternalDirectory(p, lane.parentProjectPath)).toBe('allow');
		expect(evaluateExternalDirectory(p, path.resolve('/somewhere/else'))).toBe(
			'deny',
		);
	});

	test('deny: everything denies, including the parent project', () => {
		const rules = build('deny');
		expect(rules).toEqual({ '*': 'deny' });
		const p = asPermission(rules);
		expect(evaluateExternalDirectory(p, lane.parentProjectPath)).toBe('deny');
		expect(evaluateExternalDirectory(p, os.tmpdir())).toBe('deny');
	});

	test('off: returns null so the caller changes nothing', () => {
		expect(build('off')).toBeNull();
	});
});

describe('explicit user configuration always wins', () => {
	test('a user deny for a subpath beats our allow', () => {
		const secret = path.join(lane.parentProjectPath, 'secrets');
		const rules = build('scoped_allow', { [`${secret}/*`]: 'deny' });
		const p = asPermission(rules);
		expect(evaluateExternalDirectory(p, secret)).toBe('deny');
		// ...but the rest of the project is still reachable.
		expect(
			evaluateExternalDirectory(p, path.join(lane.parentProjectPath, 'src')),
		).toBe('allow');
	});

	test('a user allow for an outside dir beats our catch-all deny', () => {
		const extra = path.resolve('/opt/shared-lib');
		const p = asPermission(build('scoped_allow', { [`${extra}/*`]: 'allow' }));
		expect(evaluateExternalDirectory(p, extra)).toBe('allow');
	});

	test('a user `external_directory: "allow"` shorthand still means allow-all', () => {
		const p = asPermission(build('scoped_allow', 'allow'));
		expect(evaluateExternalDirectory(p, path.resolve('/anywhere'))).toBe(
			'allow',
		);
	});

	// The previous version of this test asserted that a user `'*'` "replaces our
	// catch-all value IN PLACE" — pinning the exact mechanism that caused a
	// fail-open. In-place reassignment keeps the key at index 0, so under the
	// host's `findLast` the plugin allowlist outranked the operator's explicit
	// deny-all and silently re-granted WRITE access. Position IS precedence, so
	// these tests assert emitted KEY ORDER, not just evaluated outcomes.

	test('regression (HIGH-2): an explicit deny-all from the operator WINS', () => {
		for (const existing of ['deny', { '*': 'deny' }] as const) {
			const rules = build('scoped_allow', existing);
			const keys = Object.keys(rules ?? {});
			// The user's rule must land LAST, not keep our catch-all's slot.
			expect(keys[keys.length - 1]).toBe('*');
			expect(rules?.['*']).toBe('deny');
			const permission = asPermission(rules);
			expect(
				evaluateExternalDirectory(permission, lane.parentProjectPath),
			).toBe('deny');
			expect(
				evaluateExternalDirectory(
					permission,
					path.resolve(os.homedir(), '.claude/skills'),
				),
			).toBe('deny');
		}
	});

	test('a user `{"*": "allow"}` map lands last and means allow-all', () => {
		const rules = build('scoped_allow', { '*': 'allow' });
		const keys = Object.keys(rules ?? {});
		expect(keys[keys.length - 1]).toBe('*');
		expect(rules?.['*']).toBe('allow');
		expect(
			evaluateExternalDirectory(asPermission(rules), path.resolve('/anywhere')),
		).toBe('allow');
	});

	test('EMITTED KEY ORDER: catch-all first, allowlist next, user entries last', () => {
		const userPattern = path.join(path.resolve('/user/dir'), '*');
		const rules =
			build('scoped_allow', { [userPattern]: 'deny', '*': 'deny' }) ?? {};
		const keys = Object.keys(rules);
		// Our catch-all was emitted first but the user re-specified '*', so it
		// moves to the end. Both user keys must sit after every allowlist entry.
		const lastAllowlistIndex = Math.max(
			...keys
				.map((k, i) => (rules[k] === 'allow' ? i : -1))
				.filter((i) => i >= 0),
		);
		expect(keys.indexOf(userPattern)).toBeGreaterThan(lastAllowlistIndex);
		expect(keys.indexOf('*')).toBeGreaterThan(lastAllowlistIndex);
	});

	test('a coerced ask also lands last (the coercion branch uses the same helper)', () => {
		const rules = build('scoped_allow', { '*': 'ask' }) ?? {};
		const keys = Object.keys(rules);
		expect(keys[keys.length - 1]).toBe('*');
		expect(rules['*']).toBe('deny');
		expect(
			evaluateExternalDirectory(asPermission(rules), lane.parentProjectPath),
		).toBe('deny');
	});

	test('regression (HIGH-2): a user "ask" is coerced to deny — it would hang the lane', () => {
		// Prior behaviour honoured `ask` verbatim, silently reinstating the exact
		// indefinite hang this module exists to remove: a lane has no TUI, so the
		// resulting prompt could never be answered, yet the code reported
		// decision:"applied".
		const out = buildLaneExternalDirectoryRules('scoped_allow', lane, 'ask');
		expect(out?.rules['*']).toBe('deny');
		expect(out?.coercedAskPatterns).toEqual(['*']);
		// Multi-segment: a single-letter first segment ('/x') is rewritten by the
		// host's windowsPath under POSIX, so the assertion would hold for a
		// cwd-anchored path rather than the one named here.
		expect(
			evaluateExternalDirectory(
				asPermission(out?.rules ?? null),
				path.resolve('/definitely/not/allowlisted'),
			),
		).toBe('deny');
	});

	test('regression (HIGH-2): a per-pattern "ask" is coerced and reported', () => {
		const target = path.resolve('/opt/thing');
		const out = buildLaneExternalDirectoryRules('scoped_allow', lane, {
			[`${target}/*`]: 'ask',
		});
		expect(out?.coercedAskPatterns).toEqual([`${target}/*`]);
		expect(
			evaluateExternalDirectory(asPermission(out?.rules ?? null), target),
		).toBe('deny');
	});

	test('user allow/deny are NOT coerced — only "ask" is', () => {
		const out = buildLaneExternalDirectoryRules('scoped_allow', lane, {
			'/a/*': 'allow',
			'/b/*': 'deny',
		});
		expect(out?.coercedAskPatterns).toEqual([]);
		expect(out?.rules['/a/*']).toBe('allow');
		expect(out?.rules['/b/*']).toBe('deny');
	});

	test('no configuration means nothing is reported as coerced', () => {
		expect(
			buildLaneExternalDirectoryRules('scoped_allow', lane)?.coercedAskPatterns,
		).toEqual([]);
	});

	test('a non-object, non-string existing value is ignored safely', () => {
		for (const bogus of [42, [], true, null, undefined]) {
			const rules = build('scoped_allow', bogus);
			expect(rules?.['*']).toBe('deny');
		}
	});
});
