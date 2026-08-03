/**
 * Lane `external_directory` allowlist CONSTRUCTION.
 *
 * What goes into the allowlist, how each entry's pattern is built, and the
 * operator-facing advisory text. Rule PRECEDENCE (emission order, user-config
 * override, host base-allow preservation, config-knob modes) lives in
 * `lane-permissions-precedence.test.ts`.
 *
 * Behavioural assertions run the emitted rules through
 * `tests/helpers/opencode-permission-model.ts`, a verbatim transcription of the
 * host's own `Wildcard.match` / `fromConfig` / `merge` / `evaluate`.
 */
import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { getHostDataDir } from '../../../src/config/cache-paths';
import { _test_exports } from '../../../src/config/lane-permissions';
import {
	asPermission,
	build,
	buildLaneAllowlist,
	buildLaneExternalDirectoryRules,
	lane,
} from '../../helpers/lane-permissions-fixture';
import {
	evaluateExternalDirectory,
	hostFromConfig,
} from '../../helpers/opencode-permission-model';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { laneDirectoryPattern, renderLanePermissionAdvisory } = _test_exports;

describe('buildLaneAllowlist — justified entries only', () => {
	const allowlist = buildLaneAllowlist(lane);
	const dirs = allowlist.map((e) => e.dir);

	test('includes the parent project the lane is a worktree of', () => {
		expect(dirs).toContain(lane.parentProjectPath);
	});

	test('includes the lane itself', () => {
		expect(dirs).toContain(lane.lanePath);
	});

	test('grants NARROW temp subtrees, never all of os.tmpdir()', () => {
		// external_directory has no read/write split, so every entry is also a
		// WRITE grant. Granting the whole shared temp tree would let a lane write
		// into any other process's temp state.
		//
		// NOTE: the `swwt` subtree is deliberately NOT asserted here — it is
		// win32-only. Asserting it unconditionally passed on a Windows dev box and
		// failed on the ubuntu CI runner. Its platform-conditional assertion lives
		// in 'the Windows shortened-lane root is granted only on win32' below.
		expect(dirs).toContain(path.resolve(path.join(os.tmpdir(), 'opencode')));
		expect(dirs).not.toContain(path.resolve(os.tmpdir()));
	});

	test('does NOT grant the plugin cache/install locations (write-grant surface)', () => {
		// A lane writing its own installed plugin would be executed in-process by
		// the host on the next load, outside lane teardown.
		for (const dir of dirs) {
			expect(
				dir.includes(`${path.sep}node_modules${path.sep}opencode-swarm`),
			).toBe(false);
			expect(dir.includes('opencode-swarm@latest')).toBe(false);
		}
	});

	test('includes the user-level .claude/skills root that the field log hung on', () => {
		expect(dirs).toContain(path.resolve(os.homedir(), '.claude/skills'));
	});

	test('includes project-relative skill roots for BOTH trees', () => {
		expect(dirs).toContain(
			path.resolve(lane.parentProjectPath, '.opencode/skills'),
		);
		expect(dirs).toContain(path.resolve(lane.lanePath, '.opencode/skills'));
	});

	test('re-grants OpenCode plan storage (the host plan agent has a native allow)', () => {
		// Host Agent.state gives `plan`:
		//   external_directory: { join(Path.data,'plans','*'): 'allow' }
		// merged BEFORE the top-level block, so our catch-all would outrank it
		// and a lane running `plan` would lose its own plan storage.
		expect(dirs).toContain(path.join(getHostDataDir(), 'plans'));
	});

	test('does NOT grant the OpenCode data dir itself (auth.json, session storage)', () => {
		expect(dirs).not.toContain(path.resolve(getHostDataDir()));
	});

	test('the Windows shortened-lane root is granted only on win32', () => {
		// shortenWorktreePath fires solely on the Windows path-budget check, so on
		// POSIX this directory is never created and granting it would be a write
		// grant into a sticky-bit, world-writable tree for nothing.
		const swwt = path.join(os.tmpdir(), 'swwt');
		expect(dirs.includes(swwt)).toBe(process.platform === 'win32');
	});

	test('every entry carries a non-empty justification', () => {
		expect(allowlist.length).toBeGreaterThan(0);
		for (const entry of allowlist) {
			expect(entry.reason.trim().length).toBeGreaterThan(0);
			expect(path.isAbsolute(entry.dir)).toBe(true);
		}
	});

	test('entries are deduplicated', () => {
		const key = (d: string) =>
			process.platform === 'win32' ? d.toLowerCase() : d;
		expect(new Set(dirs.map(key)).size).toBe(dirs.length);
	});
});

describe('regression: skill roots mirror the host glob, not half of it', () => {
	// Host skill discovery (binary offset 102990880), verbatim:
	//   bA = ".claude"   xA = ".agents"
	//   GA = "skills/**/SKILL.md"          <- PLURAL only
	//   SA = "{skill,skills}/**/SKILL.md"  <- SINGULAR or plural
	// `.claude`/`.agents` (home + project) use GA; every Config.directories()
	// entry uses SA. Granting only `skills` for a config root silently denied the
	// supported singular `skill/` layout — a capability loss introduced when the
	// whole-tree `~/.opencode` grant was removed.
	const home = os.homedir();
	const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
	const permission = asPermission(build('scoped_allow'));
	const act = (dir: string) => evaluateExternalDirectory(permission, dir);

	test.each([
		['~/.claude/skills/<s>', path.join(home, '.claude', 'skills', 's')],
		['~/.agents/skills/<s>', path.join(home, '.agents', 'skills', 's')],
		['~/.opencode/skills/<s>', path.join(home, '.opencode', 'skills', 's')],
		['~/.opencode/skill/<s>', path.join(home, '.opencode', 'skill', 's')],
		[
			'<xdgcfg>/opencode/skill/<s>',
			path.join(xdgConfig, 'opencode', 'skill', 's'),
		],
		[
			'<proj>/.claude/skills/<s>',
			path.join(lane.parentProjectPath, '.claude', 'skills', 's'),
		],
		[
			'<proj>/.agents/skills/<s>',
			path.join(lane.parentProjectPath, '.agents', 'skills', 's'),
		],
	])('%s is reachable from a lane', (_label, dir) => {
		expect(act(dir)).toBe('allow');
	});

	test('the singular/plural pair is granted for project .opencode too', () => {
		for (const name of ['skill', 'skills']) {
			expect(
				act(path.join(lane.parentProjectPath, '.opencode', name, 's')),
			).toBe('allow');
			expect(act(path.join(lane.lanePath, '.opencode', name, 's'))).toBe(
				'allow',
			);
		}
	});

	test('granting the skill roots does NOT re-admit the ~/.opencode tree', () => {
		// The narrowing that caused the regression must stay in force: the tree
		// holds the GitLab OAuth auth.json when XDG_DATA_HOME is unset.
		expect(act(path.join(home, '.opencode'))).toBe('deny');
	});

	test('configured skills.paths are granted, with host-identical resolution', () => {
		// Host resolution (offset 102994011): `~/` expands to $HOME, a relative
		// path anchors to the instance directory, absolute is used as-is.
		const withPaths = asPermission(
			buildLaneExternalDirectoryRules(
				'scoped_allow',
				lane,
				undefined,
				buildLaneAllowlist(lane, ['~/my-skills', './relative-skills']),
			)?.rules ?? null,
		);
		expect(
			evaluateExternalDirectory(withPaths, path.join(home, 'my-skills')),
		).toBe('allow');
		expect(
			evaluateExternalDirectory(
				withPaths,
				path.join(lane.lanePath, 'relative-skills'),
			),
		).toBe('allow');
	});

	test('a malformed skills config cannot break allowlist construction', () => {
		for (const bogus of [null, 42, 'nope', [1, 2], [null], ['', '   ']]) {
			expect(() =>
				buildLaneAllowlist(lane, bogus as unknown as string[]),
			).not.toThrow();
		}
	});
});

describe('pattern construction', () => {
	test('laneDirectoryPattern covers the subtree', () => {
		// A REAL directory. A synthetic '/a/b' collides with the host's
		// windowsPath single-letter drive rewrite under POSIX ('/a/b' -> 'A:/b'),
		// which path.resolve then re-anchors under cwd — see
		// tests/unit/config/host-path.test.ts for the pinned behaviour.
		const { dir, cleanup } = createSafeTestDir('lane-pattern-');
		try {
			const resolved = path.resolve(dir);
			expect(laneDirectoryPattern(resolved)).toBe(path.join(resolved, '*'));
		} finally {
			cleanup();
		}
	});

	test('emitted patterns survive host fromConfig unchanged (no ~ expansion surprises)', () => {
		const rules = build('scoped_allow');
		const parsed = hostFromConfig({ external_directory: rules ?? {} });
		for (const rule of parsed) {
			expect(rule.permission).toBe('external_directory');
			// Absolute paths must not have been rewritten by the host's `~`
			// expansion; only our literal catch-all is non-absolute.
			if (rule.pattern !== '*') {
				expect(rule.pattern.startsWith('~')).toBe(false);
			}
		}
	});
});

describe('operator-facing advisory text', () => {
	test('names the lane, the parent, the policy and the exact remedy', () => {
		const text = renderLanePermissionAdvisory(
			'scoped_allow',
			lane,
			buildLaneAllowlist(lane),
		);
		expect(text).toContain(lane.lanePath);
		expect(text).toContain(lane.parentProjectPath);
		expect(text).toContain('worktree.lane_permissions');
		expect(text).toContain('external_directory');
		expect(text).toContain('"off"');
	});

	test('deny mode says so explicitly', () => {
		expect(renderLanePermissionAdvisory('deny', lane, [])).toContain(
			'ALL external directory access is denied',
		);
	});
});
