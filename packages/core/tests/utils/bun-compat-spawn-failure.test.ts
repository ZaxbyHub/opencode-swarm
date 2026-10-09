/**
 * Issue #2236 F0-CORE (ported from 7.x for the 8.x monorepo, issue #3151) —
 * process-creation failures are values, never throws.
 *
 * `packages/core/src/utils/bun-compat.ts` documents the cross-runtime
 * contract in its own comment: "process-creation failures have no exit code
 * and are described by `spawnError`". The Node path honoured it (`error`
 * event -> `spawnError`, `exited` resolves 1). The Bun path did NOT:
 * `Bun.spawn` throws synchronously, that throw escaped `runGit`, and its raw
 * `ENOENT: ... posix_spawn 'git'` reached the user looking like a missing git
 * binary. This file pins the normalisation.
 *
 * Two INDEPENDENT triggers are exercised deliberately. Both reach the real
 * spawn and both land in the same guard; what discriminates them is the TYPE
 * of the resulting `spawnError`:
 *   1. a missing executable with a LIVE cwd — the caught runtime error is
 *      surfaced unchanged, proving the guard itself is live;
 *   2. a missing cwd — the caught error is retyped to `SpawnCwdMissingError`,
 *      proving the classification path.
 * Asserting the two types DIFFER is what stops either half from silently
 * covering for the other.
 *
 * The final describe block drives the classification helpers through the
 * `_internals.statSync` seam so the stat-failure branches (`unreadable`,
 * `unknown`) are exercised on every host, not only on filesystems where an
 * unreadable directory can be created.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	bunSpawn,
	bunSpawnSync,
	classifySpawnFailure,
	describeSpawnCwdFailure,
	inspectSpawnCwd,
	isBun,
	SpawnCwdMissingError,
	_internals,
} from '../../src/utils/bun-compat';

const roots: string[] = [];

/** mkdtemp resolved through realpath (canonical) — safe for later stat/compare. */
function canonicalMkdtemp(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function tempRoot(label: string): string {
	const dir = canonicalMkdtemp(`bun-compat-spawn-${label}-`);
	roots.push(dir);
	return dir;
}

const SPAWN_OPTS = {
	stdin: 'ignore' as const,
	stdout: 'pipe' as const,
	stderr: 'pipe' as const,
	timeout: 10_000,
};

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('bunSpawn process-creation failure normalisation', () => {
	test('this run exercises the Bun branch', () => {
		// Not an assertion about the fix — it records which branch of bunSpawn
		// the two tests below actually took, so a future Node-only runner cannot
		// silently turn them into Node-path-only coverage.
		expect(isBun()).toBe(true);
	});

	test('a missing executable with a LIVE cwd returns spawnError instead of throwing', async () => {
		const root = tempRoot('missing-binary');
		let proc: ReturnType<typeof bunSpawn> | undefined;
		expect(() => {
			proc = bunSpawn(['definitely-not-a-real-binary-2236'], {
				cwd: root,
				...SPAWN_OPTS,
			});
		}).not.toThrow();
		expect(proc?.spawnError).toBeInstanceOf(Error);
		// The cwd is live, so classification leaves this alone: it is the raw
		// runtime throw, caught and surfaced as a value rather than retyped.
		expect(proc?.spawnError).not.toBeInstanceOf(SpawnCwdMissingError);
		expect(proc?.exitCode).toBeNull();
		expect(await proc?.exited).not.toBe(0);
		// stdout of a process that never existed stays empty, but stderr
		// replays the reason: a caller that reads only stderr for its failure
		// explanation must not be handed an empty string, or a loud failure
		// becomes a silent "ran fine, found nothing".
		expect(await proc?.stdout.text()).toBe('');
		expect(await proc?.stderr.text()).toContain(
			'definitely-not-a-real-binary-2236',
		);
	});

	test('a missing cwd returns a typed SpawnCwdMissingError instead of throwing', async () => {
		const root = tempRoot('missing-cwd');
		const gone = path.join(root, 'gone');
		let proc: ReturnType<typeof bunSpawn> | undefined;
		expect(() => {
			proc = bunSpawn(['git', 'rev-parse', 'HEAD'], {
				cwd: gone,
				...SPAWN_OPTS,
			});
		}).not.toThrow();
		expect(proc?.spawnError).toBeInstanceOf(SpawnCwdMissingError);
		expect((proc?.spawnError as SpawnCwdMissingError).cwd).toBe(gone);
		expect((proc?.spawnError as SpawnCwdMissingError).reason).toBe('missing');
		expect(proc?.spawnError?.message).toContain(gone);
		expect(proc?.exitCode).toBeNull();
		expect(await proc?.exited).not.toBe(0);
		expect(await proc?.stderr.text()).toContain(gone);
		expect(await proc?.stdout.text()).toBe('');
	});

	test('a cwd that is a FILE is rejected as a cwd problem, not a binary problem', async () => {
		const root = tempRoot('file-cwd');
		const file = path.join(root, 'a-file');
		fs.writeFileSync(file, 'x');
		const proc = bunSpawn(['git', 'rev-parse', 'HEAD'], {
			cwd: file,
			...SPAWN_OPTS,
		});
		expect(proc.spawnError).toBeInstanceOf(SpawnCwdMissingError);
		expect((proc.spawnError as SpawnCwdMissingError).reason).toBe(
			'not-directory',
		);
		expect(await proc.exited).not.toBe(0);
	});

	test('kill() on a process that never started is a no-op, not a throw', async () => {
		const root = tempRoot('kill-noop');
		const proc = bunSpawn(['git', 'status'], {
			cwd: path.join(root, 'gone'),
			...SPAWN_OPTS,
		});
		expect(() => proc.kill()).not.toThrow();
		await expect(proc.killTree?.()).resolves.toBeUndefined();
	});

	test('a live cwd and a real binary still spawn normally', async () => {
		const root = tempRoot('happy');
		const proc = bunSpawn(['git', '--version'], { cwd: root, ...SPAWN_OPTS });
		expect(proc.spawnError ?? null).toBeNull();
		expect(await proc.exited).toBe(0);
		expect(await proc.stdout.text()).toContain('git version');
	});
});

describe('bunSpawnSync process-creation failure normalisation', () => {
	test('a missing cwd reports the reason through stderr rather than an empty result', () => {
		const root = tempRoot('sync-missing-cwd');
		const gone = path.join(root, 'gone');
		let result: ReturnType<typeof bunSpawnSync> | undefined;
		expect(() => {
			result = bunSpawnSync(['git', 'rev-parse', 'HEAD'], {
				cwd: gone,
				timeout: 10_000,
			});
		}).not.toThrow();
		expect(result?.success).toBe(false);
		expect(result?.exitCode).not.toBe(0);
		// `BunCompatSyncResult` has no spawnError channel, so stderr — the only
		// field sync consumers read for a reason — must carry it. An empty
		// stderr here would read as "the command ran and printed nothing".
		expect(new TextDecoder().decode(result?.stderr)).toContain(gone);
		expect(result?.stdout.byteLength).toBe(0);
	});

	test('the object command form validates its own cwd too', () => {
		const root = tempRoot('sync-object-form');
		const gone = path.join(root, 'gone');
		const result = bunSpawnSync({
			cmd: ['git', 'rev-parse', 'HEAD'],
			cwd: gone,
			timeout: 10_000,
		});
		expect(result.success).toBe(false);
		expect(new TextDecoder().decode(result.stderr)).toContain(gone);
	});

	test('a live cwd still runs normally', () => {
		const root = tempRoot('sync-happy');
		const result = bunSpawnSync(['git', '--version'], {
			cwd: root,
			timeout: 10_000,
		});
		expect(result.success).toBe(true);
		expect(new TextDecoder().decode(result.stdout)).toContain('git version');
	});
});

describe('spawn-cwd classification (Node-fallback branches via _internals seam)', () => {
	const realStatSync = _internals.statSync;

	afterEach(() => {
		_internals.statSync = realStatSync;
	});

	test('inspectSpawnCwd reports directory / not-directory against a real tree', () => {
		const root = tempRoot('inspect');
		const file = path.join(root, 'f');
		fs.writeFileSync(file, 'x');
		expect(inspectSpawnCwd(root)).toBe('directory');
		expect(inspectSpawnCwd(file)).toBe('not-directory');
		expect(inspectSpawnCwd(path.join(root, 'gone'))).toBe('missing');
	});

	test('inspectSpawnCwd maps EACCES to unreadable and other stat errors to unknown (seam-driven)', () => {
		_internals.statSync = ((_target: string) => {
			const err = new Error('stat: permission denied') as NodeJS.ErrnoException;
			err.code = 'EACCES';
			throw err;
		}) as typeof _internals.statSync;
		expect(inspectSpawnCwd('/wherever')).toBe('unreadable');

		_internals.statSync = ((_target: string) => {
			throw new Error('stat: bizarre failure');
		}) as typeof _internals.statSync;
		expect(inspectSpawnCwd('/wherever')).toBe('unknown');
	});

	test('classifySpawnFailure keeps the three-way split honest', () => {
		const root = tempRoot('classify');
		const gone = path.join(root, 'gone');

		// A SpawnCwdMissingError always classifies as cwd-missing.
		const typed = describeSpawnCwdFailure(gone, 'git');
		expect(typed).toBeInstanceOf(SpawnCwdMissingError);
		expect(classifySpawnFailure(typed, gone)).toBe('cwd-missing');

		// ENOENT with no cwd preserves historical binary-missing semantics.
		const enoent = new Error('enoent') as NodeJS.ErrnoException;
		enoent.code = 'ENOENT';
		expect(classifySpawnFailure(enoent, undefined)).toBe('binary-missing');

		// ENOENT WITH a missing cwd retargets to the cwd.
		expect(classifySpawnFailure(enoent, gone)).toBe('cwd-missing');

		// EACCES over an unreadable cwd fails closed as cwd-unreadable.
		const eacces = new Error('eacces') as NodeJS.ErrnoException;
		eacces.code = 'EACCES';
		_internals.statSync = ((_target: string) => {
			const err = new Error('stat: permission denied') as NodeJS.ErrnoException;
			err.code = 'EACCES';
			throw err;
		}) as typeof _internals.statSync;
		expect(classifySpawnFailure(eacces, root)).toBe('cwd-unreadable');

		// Non-ambiguous codes are never retyped.
		const eio = new Error('io') as NodeJS.ErrnoException;
		eio.code = 'EIO';
		expect(classifySpawnFailure(eio, gone)).toBe('other');
	});
});
