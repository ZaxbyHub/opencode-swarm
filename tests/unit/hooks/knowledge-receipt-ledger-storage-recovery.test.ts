import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	resolveReceiptLedgerPaths,
	withReceiptLedgerLock,
} from '../../../src/hooks/knowledge-receipt-ledger-storage.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const cleanups: Array<() => void> = [];
const original = {
	platform: _internals.platform,
	killProcess: _internals.killProcess,
	readLinuxProcStat: _internals.readLinuxProcStat,
	procStateReadTimeoutMs: _internals.procStateReadTimeoutMs,
	isProcessAlive: _internals.isProcessAlive,
	afterRecoveryRename: _internals.afterRecoveryRename,
};

afterEach(() => {
	_internals.platform = original.platform;
	_internals.killProcess = original.killProcess;
	_internals.readLinuxProcStat = original.readLinuxProcStat;
	_internals.procStateReadTimeoutMs = original.procStateReadTimeoutMs;
	_internals.isProcessAlive = original.isProcessAlive;
	_internals.afterRecoveryRename = original.afterRecoveryRename;
	while (cleanups.length > 0) cleanups.pop()?.();
});

function project(prefix: string): string {
	const fixture = createSafeTestDir(prefix);
	cleanups.push(fixture.cleanup);
	fs.mkdirSync(path.join(fixture.dir, '.git'));
	return fixture.dir;
}

function writeOwner(
	filePath: string,
	ownerToken: string,
	pid: number,
	root: string,
): void {
	fs.writeFileSync(
		filePath,
		`${JSON.stringify({
			owner_token: ownerToken,
			pid,
			created_at_ms: 1_700_000_000_000,
			root_identity: root,
		})}\n`,
	);
}

describe('knowledge receipt storage stale-lock recovery', () => {
	test('an atomic recovery claim cannot delete a concurrently created successor lock', async () => {
		const directory = project('receipt-storage-successor-');
		const paths = resolveReceiptLedgerPaths(directory);
		fs.mkdirSync(paths.swarmDir);
		writeOwner(paths.lockTarget, 'stale-owner', 999_999, paths.root);
		_internals.isProcessAlive = async () => false;

		let competingRecovery: Promise<void> | undefined;
		_internals.afterRecoveryRename = async () => {
			// Previous path-based recovery re-read the stale token and then rm()'d
			// lockTarget, deleting this successor. The claimed stale inode now has a
			// distinct path, and a second recovery worker loses the atomic rename.
			writeOwner(paths.lockTarget, 'successor-owner', process.pid, paths.root);
			_internals.isProcessAlive = async (pid) => pid === process.pid;
			competingRecovery = _internals.recoverLockIfSafe(paths);
			await competingRecovery;
		};

		await _internals.recoverLockIfSafe(paths);
		await competingRecovery;
		const successor = JSON.parse(fs.readFileSync(paths.lockTarget, 'utf8')) as {
			owner_token: string;
			pid: number;
		};
		expect(successor).toMatchObject({
			owner_token: 'successor-owner',
			pid: process.pid,
		});
		expect(
			fs
				.readdirSync(paths.swarmDir)
				.some((name) => name.endsWith('.recovering')),
		).toBe(false);
	});

	test('classifies a Linux zombie as dead after bounded proc inspection', async () => {
		_internals.platform = () => 'linux';
		_internals.killProcess = () => {};
		_internals.readLinuxProcStat = async () =>
			'4242 (worker with ) parens) Z 1 2 3 4';

		expect(await original.isProcessAlive(4242)).toBe(false);
	});

	test('retains conservative liveness on non-Linux and on proc timeout', async () => {
		let procReads = 0;
		_internals.platform = () => 'win32';
		_internals.killProcess = () => {};
		_internals.readLinuxProcStat = async () => {
			procReads++;
			return '7 (ignored) Z 1';
		};
		expect(await original.isProcessAlive(7)).toBe(true);
		expect(procReads).toBe(0);

		_internals.platform = () => 'linux';
		_internals.procStateReadTimeoutMs = 5;
		_internals.readLinuxProcStat = async () =>
			await new Promise<string>(() => undefined);
		const started = performance.now();
		expect(await original.isProcessAlive(8)).toBe(true);
		expect(performance.now() - started).toBeLessThan(200);
	});

	test('shares one elapsed budget across zombie probes and retry waits', async () => {
		const directory = project('receipt-storage-budget-');
		const paths = resolveReceiptLedgerPaths(directory);
		fs.mkdirSync(paths.swarmDir);
		writeOwner(paths.lockTarget, 'live-owner', 4242, paths.root);
		_internals.isProcessAlive = async () => {
			await new Promise((resolve) => setTimeout(resolve, 25));
			return true;
		};

		const started = performance.now();
		await expect(
			withReceiptLedgerLock(directory, async () => undefined),
		).rejects.toMatchObject({ code: 'lock_timeout' });
		expect(performance.now() - started).toBeLessThan(750);
	});
});
