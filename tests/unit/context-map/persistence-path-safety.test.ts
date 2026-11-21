/**
 * r17 audit (P1): `existsSync()` is not proof that the context map is
 * missing — the `missing`/`unreadable` distinction must be provable from the
 * filesystem object itself.
 *
 * Under Linux, `existsSync()` follows symlinks and returns `false` for a
 * PRESENT dangling symlink. The previous `readContextMapState` classified
 * that state as `missing` — the one state the r16/r17 repairs treat as
 * "rebuild is legitimate". A rebuild writes via atomic-rename, which REPLACES
 * the symlink itself: a filesystem object whose identity was never verified
 * (the dangling link, or a link retargeting the write) gets clobbered. A
 * symlink to a foreign VALID json file was likewise accepted as a normal
 * readable map (`ok`) — reading arbitrary foreign files without an explicit
 * contract.
 *
 * Expected classification after the repair (lstat-based, ENOENT is the ONLY
 * proof of absence):
 * - provable ENOENT                        → missing
 * - regular file, valid map                → ok
 * - regular file, corrupt/invalid JSON     → unreadable
 * - dangling symlink                       → unreadable (NOT missing)
 * - symlink to a valid foreign json file   → unreadable (never `ok`)
 * - directory at the path                  → unreadable
 * - EACCES on read                         → unreadable
 * - metadata (lstat) access error          → unreadable
 * - file vanishes between lstat and read   → unreadable (fail toward
 *   preservation — no unverified reconstruction overwrites foreign data)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	readContextMapState,
} from '../../../src/context-map/persistence';

let tempDir: string;
let origInternals: typeof _internals;

function mapPath(): string {
	return path.join(tempDir, '.swarm', 'context-map.json');
}

function validMapJson(): string {
	return JSON.stringify(
		{
			schema_version: 1,
			generated_at: '2026-11-21T00:00:00.000Z',
			repo_fingerprint: '',
			files: {},
			task_history: {},
			decisions: [],
		},
		null,
		2,
	);
}

/** Whether this host can create symlinks (privilege-gated on Windows). */
function trySymlink(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath);
		return true;
	} catch {
		return false;
	}
}

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxmap-state-test-'));
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	origInternals = { ..._internals };
});

afterEach(() => {
	Object.assign(_internals, origInternals);
	fs.rmSync(tempDir, { force: true, recursive: true });
});

describe('readContextMapState — provable missing vs unsafe path (r17 P1)', () => {
	test('a genuinely absent path is missing', () => {
		expect(readContextMapState(tempDir)).toEqual({ kind: 'missing' });
	});

	test('a regular file with a valid map is ok', () => {
		fs.writeFileSync(mapPath(), validMapJson(), 'utf-8');
		const state = readContextMapState(tempDir);
		expect(state.kind).toBe('ok');
	});

	test('a regular file with invalid JSON is unreadable', () => {
		fs.writeFileSync(mapPath(), '{"schema_version": 1, "trunc', 'utf-8');
		expect(readContextMapState(tempDir).kind).toBe('unreadable');
	});

	test('a dangling symlink is unreadable, NOT missing', () => {
		if (!trySymlink('/nonexistent-target-ctxmap', mapPath())) return;
		// The KEY reproduction: existsSync() returns false for a present
		// dangling symlink, so the pre-fix code classified it `missing` —
		// the rebuild-legitimate state. A filesystem object exists here.
		expect(fs.existsSync(mapPath())).toBe(false);
		expect(readContextMapState(tempDir).kind).toBe('unreadable');
	});

	test('a symlink to a valid foreign json file is never `ok`', () => {
		const foreign = path.join(tempDir, 'foreign.json');
		fs.writeFileSync(foreign, validMapJson(), 'utf-8');
		if (!trySymlink(foreign, mapPath())) return;
		// existsSync() follows the link and the pre-fix code READ the foreign
		// file as a normal map (`ok`). Without an explicit contract a symlink
		// is never accepted as the context map.
		expect(fs.existsSync(mapPath())).toBe(true);
		expect(readContextMapState(tempDir).kind).toBe('unreadable');
	});

	test('a directory at the context-map path is unreadable', () => {
		fs.mkdirSync(mapPath(), { recursive: true });
		expect(readContextMapState(tempDir).kind).toBe('unreadable');
	});

	test('an EACCES read failure is unreadable', () => {
		fs.writeFileSync(mapPath(), validMapJson(), 'utf-8');
		_internals.readFileSync = (() => {
			const err = new Error('EACCES: permission denied') as Error & {
				code: string;
			};
			err.code = 'EACCES';
			throw err;
		}) as typeof _internals.readFileSync;
		expect(readContextMapState(tempDir).kind).toBe('unreadable');
	});

	test('a metadata (lstat) access error is unreadable, not missing', () => {
		fs.writeFileSync(mapPath(), validMapJson(), 'utf-8');
		_internals.lstatSync = (() => {
			const err = new Error('EACCES: permission denied') as Error & {
				code: string;
			};
			err.code = 'EACCES';
			throw err;
		}) as typeof _internals.lstatSync;
		// Pre-fix behavior: existsSync (real fs) → true → the map read fine
		// and the state was `ok`. A metadata access failure must never be
		// interpreted as either `missing` (rebuild!) or `ok` (foreign read).
		expect(readContextMapState(tempDir).kind).toBe('unreadable');
	});

	test('a file that vanishes between metadata check and read is unreadable', () => {
		fs.writeFileSync(mapPath(), validMapJson(), 'utf-8');
		// lstat sees a regular file; the read then hits ENOENT (file removed
		// or raced away in between). Fail toward preservation: no unverified
		// reconstruction may overwrite whatever now lives at the path.
		const realLstat = fs.lstatSync;
		_internals.lstatSync = ((p: fs.PathLike) =>
			realLstat(mapPath())) as typeof _internals.lstatSync;
		_internals.readFileSync = (() => {
			const err = new Error('ENOENT: no such file') as Error & {
				code: string;
			};
			err.code = 'ENOENT';
			throw err;
		}) as typeof _internals.readFileSync;
		expect(readContextMapState(tempDir).kind).toBe('unreadable');
	});

	test('an lstat ENOENT is classified missing even when existsSync would mislead', () => {
		// Inverse control: the ONLY provable-absence signal is an exact
		// ENOENT from metadata access. existsSync false (e.g. dangling
		// symlink) must NOT reach this branch.
		_internals.existsSync = (() => false) as typeof _internals.existsSync;
		_internals.lstatSync = (() => {
			const err = new Error('ENOENT: no such file') as Error & {
				code: string;
			};
			err.code = 'ENOENT';
			throw err;
		}) as typeof _internals.lstatSync;
		expect(readContextMapState(tempDir)).toEqual({ kind: 'missing' });
	});
});
