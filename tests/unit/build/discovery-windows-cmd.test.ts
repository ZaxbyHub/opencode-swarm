import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals, isCommandAvailable } from '../../../src/build/discovery';

/**
 * Issue #1691 regression: on Windows, `isCommandAvailable` must NOT append
 * `.exe` to the search name. Windows `where` uses PATHEXT to find `.cmd`,
 * `.bat`, `.exe`, `.ps1` automatically; appending `.exe` missed npm-distributed
 * `.cmd` shims (biome.cmd, eslint.cmd, tsc.cmd, etc.).
 *
 * These tests mock `_internals.spawnSyncImpl` (the DI seam in discovery.ts) and
 * force `process.platform === 'win32'` so the win32 branch executes on every CI
 * platform — not just windows-latest. They assert the EXACT argv passed to
 * spawnSync so the `.exe` suffix cannot silently return.
 */
describe('isCommandAvailable Windows extension resolution (#1691)', () => {
	const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
	// Capture the real spawnSyncImpl before any test overrides it, so afterEach
	// can restore the original binding (DI-seam restore pattern).
	const realSpawnSyncImpl = _internals.spawnSyncImpl;
	let spawnCalls: { cmd: string[] }[] = [];

	beforeEach(() => {
		// Force win32 so the `where` branch runs on Linux/macOS CI too.
		Object.defineProperty(process, 'platform', { value: 'win32' });
		spawnCalls = [];
		_internals.spawnSyncImpl = ((cmd: unknown) => {
			spawnCalls.push({ cmd: cmd as string[] });
			return {
				stdout: new Uint8Array(),
				stderr: new Uint8Array(),
				exitCode: 0,
				success: true,
			};
		}) as typeof _internals.spawnSyncImpl;
		_internals.clearToolchainCache();
	});

	afterEach(() => {
		// Restore the real spawnSyncImpl and platform.
		_internals.spawnSyncImpl = realSpawnSyncImpl;
		if (origPlatform) {
			Object.defineProperty(process, 'platform', origPlatform);
		}
		_internals.clearToolchainCache();
	});

	it('does not append .exe to the `where` search name on Windows (regression: F1691)', () => {
		// Previous code built `where eslint.exe`, which missed eslint.cmd.
		// The fix must invoke `where eslint` (bare name) so PATHEXT resolves.
		isCommandAvailable('eslint');
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]!.cmd).toEqual(['where', 'eslint']);
		// Explicitly assert NO .exe suffix leaked into the argv.
		expect(spawnCalls[0]!.cmd[1]).toBe('eslint');
		expect(spawnCalls[0]!.cmd[1]).not.toBe('eslint.exe');
	});

	it('returns true when `where` reports success (cmd shim found via PATHEXT)', () => {
		expect(isCommandAvailable('tsc')).toBe(true);
	});

	it('returns false and caches when `where` fails', () => {
		_internals.spawnSyncImpl = (() => ({
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
			exitCode: 1,
			success: false,
		})) as typeof _internals.spawnSyncImpl;
		expect(isCommandAvailable('missing-tool')).toBe(false);
		// Cached: second call must not spawn again.
		const before = spawnCalls.length;
		expect(isCommandAvailable('missing-tool')).toBe(false);
		expect(spawnCalls.length).toBe(before);
	});
});

/**
 * `findBinaryInPath` (#1691): on Windows it must check `.exe`, `.cmd`, `.bat`,
 * and the bare name. Uses the `_test_exports` Tier 0 seam — real behavior with a
 * fake PATH and temp files, no mock.module.
 */
describe('findBinaryInPath Windows candidate order (#1691)', () => {
	const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
	const origPath = process.env.PATH;
	let tempDir: string;

	beforeEach(() => {
		Object.defineProperty(process, 'platform', { value: 'win32' });
		tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fbip-')));
		process.env.PATH = tempDir;
	});

	afterEach(() => {
		if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
		process.env.PATH = origPath;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('finds a .cmd shim when no .exe is present (regression: F1691)', async () => {
		const { findBinaryInPath } = await import(
			'../../../src/services/directive-predicate-runner'
		).then((m) => m._test_exports);
		// Only a .cmd shim exists — pre-fix code (`.exe` only) returned null.
		fs.writeFileSync(path.join(tempDir, 'biome.cmd'), '@echo off\n');
		const resolved = findBinaryInPath('biome');
		expect(resolved).not.toBeNull();
		expect(resolved).toBe(path.join(tempDir, 'biome.cmd'));
	});

	it('finds a .bat shim', async () => {
		const { findBinaryInPath } = await import(
			'../../../src/services/directive-predicate-runner'
		).then((m) => m._test_exports);
		fs.writeFileSync(path.join(tempDir, 'ruff.bat'), '@echo off\n');
		expect(findBinaryInPath('ruff')).toBe(path.join(tempDir, 'ruff.bat'));
	});

	it('prefers .exe over .cmd when both exist (documented candidate order)', async () => {
		const { findBinaryInPath } = await import(
			'../../../src/services/directive-predicate-runner'
		).then((m) => m._test_exports);
		fs.writeFileSync(path.join(tempDir, 'eslint.exe'), '');
		fs.writeFileSync(path.join(tempDir, 'eslint.cmd'), '@echo off\n');
		// Candidate order is [.exe, .cmd, .bat, bare]; .exe wins.
		expect(findBinaryInPath('eslint')).toBe(path.join(tempDir, 'eslint.exe'));
	});

	it('returns null when no candidate exists in any PATH dir', async () => {
		const { findBinaryInPath } = await import(
			'../../../src/services/directive-predicate-runner'
		).then((m) => m._test_exports);
		expect(findBinaryInPath('no-such-binary')).toBeNull();
	});
});
