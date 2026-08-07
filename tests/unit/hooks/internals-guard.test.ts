/**
 * Plugin-internals read guard (issue #2063 B4).
 *
 * Denies read/glob/grep/bash calls whose RESOLVED target lies inside the
 * INSTALLED opencode-swarm package. The guard is explicitly best-effort: it
 * must FAIL OPEN on every kind of resolution uncertainty, because a false
 * denial of a legitimate read is far worse than a missed evasion. The evasion
 * coverage lives in B5 + the A4 prompt rule, not here.
 *
 * The fixture stands up a REAL fake install (a directory whose package.json is
 * named `opencode-swarm`) under `os.tmpdir()` and points the module's
 * `moduleUrl` seam at a file inside it, so package-root derivation is exercised
 * for real rather than stubbed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	_internals,
	enforceInternalsGuard,
	extractGuardedPathCandidates,
	isInsidePackageRoot,
	SWARM_INTERNALS_DENIAL_MESSAGE,
} from '../../../src/hooks/guardrails/internals-guard';

let root: string;
/** The fake INSTALLED plugin package (`<root>/user-project/node_modules/opencode-swarm`). */
let installRoot: string;
/** A user workspace that is NOT the plugin repo. */
let userProject: string;
/** A workspace that IS an opencode-swarm checkout. */
let selfDevProject: string;

const realModuleUrl = _internals.moduleUrl;
const realHomedir = _internals.homedir;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'internals-guard-'));
	userProject = path.join(root, 'user-project');
	installRoot = path.join(userProject, 'node_modules', 'opencode-swarm');
	selfDevProject = path.join(root, 'swarm-checkout');

	fs.mkdirSync(path.join(installRoot, 'dist'), { recursive: true });
	fs.writeFileSync(
		path.join(installRoot, 'package.json'),
		JSON.stringify({ name: 'opencode-swarm', version: '9.9.9' }),
	);
	fs.writeFileSync(path.join(installRoot, 'dist', 'index.js'), '// bundle');

	fs.mkdirSync(path.join(userProject, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(userProject, 'package.json'),
		JSON.stringify({ name: 'my-app' }),
	);

	fs.mkdirSync(path.join(selfDevProject, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(selfDevProject, 'package.json'),
		JSON.stringify({ name: 'opencode-swarm' }),
	);

	// The guard derives its root from ITS OWN location, so point the seam at a
	// module inside the fake install.
	_internals.moduleUrl = () =>
		pathToFileURL(path.join(installRoot, 'dist', 'index.js')).href;
	_internals.homedir = () => root;
	_internals.resetCaches();
});

afterEach(() => {
	_internals.moduleUrl = realModuleUrl;
	_internals.homedir = realHomedir;
	_internals.resetCaches();
	const resolved = path.resolve(root);
	if (resolved.startsWith(path.resolve(os.tmpdir())) && resolved.length > 8) {
		fs.rmSync(resolved, { recursive: true, force: true });
	}
});

function guard(tool: string, args: unknown, directory = userProject): void {
	enforceInternalsGuard({
		sessionID: 'guard-session',
		tool,
		args,
		directory,
	});
}

describe('#2063 B4 — denies reads of the installed package', () => {
	test('denies a Read of a file under the installed package root', () => {
		expect(() =>
			guard('read', { filePath: path.join(installRoot, 'dist', 'index.js') }),
		).toThrow(SWARM_INTERNALS_DENIAL_MESSAGE);
	});

	test('the denial message is the exact contracted text', () => {
		let message = '';
		try {
			guard('read', { filePath: path.join(installRoot, 'package.json') });
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toBe(
			"SWARM_INTERNALS_OFF_LIMITS: the swarm plugin's installed files are never the fix for a gate error. Fix the dispatch/state the error names, or report the blocker to the user.",
		);
	});

	test('the leading token is the code B1 keys its denial streak on', async () => {
		const { deriveGateDenialCode } = await import(
			'../../../src/hooks/gate-denial-tracker'
		);
		expect(deriveGateDenialCode(SWARM_INTERNALS_DENIAL_MESSAGE)).toBe(
			'SWARM_INTERNALS_OFF_LIMITS',
		);
	});

	test('denies glob and grep targeting the package root', () => {
		expect(() => guard('glob', { path: installRoot })).toThrow(
			SWARM_INTERNALS_DENIAL_MESSAGE,
		);
		expect(() =>
			guard('grep', { path: path.join(installRoot, 'dist') }),
		).toThrow(SWARM_INTERNALS_DENIAL_MESSAGE);
	});

	test('denies namespaced tool names', () => {
		expect(() =>
			guard('opencode:read', {
				filePath: path.join(installRoot, 'dist', 'index.js'),
			}),
		).toThrow(SWARM_INTERNALS_DENIAL_MESSAGE);
	});

	test('accepts every scalar path arg key the hosts use', () => {
		const target = path.join(installRoot, 'dist', 'index.js');
		for (const key of ['filePath', 'file_path', 'path', 'file', 'target']) {
			expect(() => guard('read', { [key]: target })).toThrow(
				SWARM_INTERNALS_DENIAL_MESSAGE,
			);
		}
	});
});

describe('#2063 B4 — bash path extraction', () => {
	test('denies an absolute path inside the package root', () => {
		expect(() =>
			guard('bash', {
				command: `cat ${path.join(installRoot, 'dist', 'index.js')}`,
			}),
		).toThrow(SWARM_INTERNALS_DENIAL_MESSAGE);
	});

	test('denies a ~-prefixed path that expands into the package root', () => {
		// installRoot lives under the (redirected) home directory in this fixture.
		const relFromHome = path.relative(root, installRoot).replace(/\\/g, '/');
		expect(() =>
			guard('bash', { command: `ls ~/${relFromHome}/dist` }),
		).toThrow(SWARM_INTERNALS_DENIAL_MESSAGE);
	});

	test('denies a quoted absolute path', () => {
		expect(() =>
			guard('bash', {
				command: `grep -n foo "${path.join(installRoot, 'dist', 'index.js')}"`,
			}),
		).toThrow(SWARM_INTERNALS_DENIAL_MESSAGE);
	});

	test('FAILS OPEN on a relative path', () => {
		expect(() =>
			guard('bash', { command: 'grep -rn foo node_modules/opencode-swarm' }),
		).not.toThrow();
	});

	test('FAILS OPEN on a cd-chain (documented residual)', () => {
		expect(() =>
			guard('bash', {
				command: `cd node_modules/opencode-swarm && cat dist/index.js`,
			}),
		).not.toThrow();
	});

	test('FAILS OPEN on a shell-variable indirection (documented residual)', () => {
		expect(() =>
			guard('bash', { command: 'cat "$PLUGIN_DIR/dist/index.js"' }),
		).not.toThrow();
	});

	test('allows an absolute path OUTSIDE the package root', () => {
		expect(() =>
			guard('bash', {
				command: `cat ${path.join(userProject, 'src', 'app.ts')}`,
			}),
		).not.toThrow();
	});

	test('a relative segment does not get mistaken for an absolute path', () => {
		// Regression guard on the extractor's leading-boundary requirement:
		// without it, `src/hooks` yields the candidate `/hooks`.
		const candidates = extractGuardedPathCandidates('bash', {
			command: 'grep -rn foo src/hooks tests/unit',
		});
		expect(candidates).toHaveLength(0);
	});
});

describe('#2063 B4 — exemptions and fail-open paths', () => {
	test('is fully inert when the WORKSPACE is an opencode-swarm checkout', () => {
		expect(() =>
			guard(
				'read',
				{ filePath: path.join(installRoot, 'dist', 'index.js') },
				selfDevProject,
			),
		).not.toThrow();
	});

	test('is inert when the WORKSPACE ROOT itself resolves inside the package root', () => {
		// Catastrophic failure mode if this clause is missing: a `directory` that
		// is a SUBDIRECTORY of a checkout (or anywhere under an install) carries
		// no package.json, so the self-dev check cannot see it — and then EVERY
		// path in that workspace is inside the package root, denying read, glob,
		// grep and bash outright for the whole session.
		const nested = path.join(installRoot, 'dist');
		expect(() =>
			guard('read', { filePath: path.join(nested, 'index.js') }, nested),
		).not.toThrow();
		expect(() =>
			guard(
				'bash',
				{ command: `cat ${path.join(nested, 'index.js')}` },
				nested,
			),
		).not.toThrow();
	});

	test('is inert when guardrails are disabled', () => {
		expect(() =>
			enforceInternalsGuard({
				sessionID: 's',
				tool: 'read',
				args: { filePath: path.join(installRoot, 'dist', 'index.js') },
				directory: userProject,
				options: { enabled: false },
			}),
		).not.toThrow();
	});

	test('fails open when the package root cannot be derived', () => {
		_internals.resetCaches();
		_internals.moduleUrl = () =>
			pathToFileURL(path.join(root, 'nowhere', 'mod.js')).href;
		expect(() =>
			guard('read', { filePath: path.join(installRoot, 'dist', 'index.js') }),
		).not.toThrow();
	});

	test('fails open for tools outside the guarded set', () => {
		const target = path.join(installRoot, 'dist', 'index.js');
		for (const tool of ['write', 'edit', 'Task', 'list', 'webfetch']) {
			expect(() => guard(tool, { filePath: target })).not.toThrow();
		}
	});

	test('fails open on missing, empty, or non-string args', () => {
		expect(() => guard('read', undefined)).not.toThrow();
		expect(() => guard('read', {})).not.toThrow();
		expect(() => guard('read', { filePath: 42 })).not.toThrow();
		expect(() => guard('bash', { command: '' })).not.toThrow();
		expect(() => guard('bash', {})).not.toThrow();
	});

	test('a path that merely SHARES A PREFIX with the package root is allowed', () => {
		// `…/opencode-swarm-notes` must not be treated as inside `…/opencode-swarm`.
		const sibling = `${installRoot}-notes`;
		fs.mkdirSync(sibling, { recursive: true });
		expect(() =>
			guard('read', { filePath: path.join(sibling, 'file.ts') }),
		).not.toThrow();
	});
});

describe('#2063 B4 — isInsidePackageRoot', () => {
	const rootPath = path.resolve(path.join(os.tmpdir(), 'pkg-root'));

	test('the root itself is inside', () => {
		expect(isInsidePackageRoot(rootPath, rootPath)).toBe(true);
	});

	test('a descendant is inside', () => {
		expect(
			isInsidePackageRoot(rootPath, path.join(rootPath, 'dist', 'index.js')),
		).toBe(true);
	});

	test('a parent is not inside', () => {
		expect(isInsidePackageRoot(rootPath, path.dirname(rootPath))).toBe(false);
	});

	test('a prefix-sharing sibling is not inside', () => {
		expect(isInsidePackageRoot(rootPath, `${rootPath}-notes`)).toBe(false);
	});
});
