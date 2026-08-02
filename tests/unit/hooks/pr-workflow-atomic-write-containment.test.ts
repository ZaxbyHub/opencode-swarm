import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	writePrWorkflowAtomicJson,
} from '../../../src/hooks/pr-workflow-gate.js';

let directory = '';

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-atomic-containment-')),
	);
	_test_exports.resetTrackedStateCache();
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR workflow atomic write containment', () => {
	test.skipIf(process.platform === 'win32')(
		'does not write content after the destination parent is symlink-swapped',
		async () => {
			const receiptDirectory = path.join(
				directory,
				'.swarm',
				'pr-workflow-checkouts',
				'session',
			);
			const destination = path.join(receiptDirectory, 'receipt.json');
			const preserved = path.join(
				directory,
				'.swarm',
				'pr-workflow-checkouts',
				'session-preserved',
			);
			const outside = path.join(directory, 'outside-atomic-race');
			let swapInstalled = false;
			await fs.mkdir(outside, { recursive: true });
			_test_exports.beforeAtomicTempWrite = async () => {
				_test_exports.beforeAtomicTempWrite = undefined;
				await fs.rename(receiptDirectory, preserved);
				await fs.symlink(
					outside,
					receiptDirectory,
					process.platform === 'win32' ? 'junction' : 'dir',
				);
				expect((await fs.lstat(receiptDirectory)).isSymbolicLink()).toBe(true);
				swapInstalled = true;
			};

			await expect(
				writePrWorkflowAtomicJson(directory, destination, {
					secret: 'blocked',
				}),
			).rejects.toThrow(/changed|escaped|ENOENT|EPERM/i);
			expect(swapInstalled).toBe(true);
			expect(await fs.readdir(outside)).toEqual([]);
		},
	);

	test.skipIf(process.platform !== 'win32')(
		'Windows blocks the parent rename while the atomic temp handle is open',
		async () => {
			const receiptDirectory = path.join(
				directory,
				'.swarm',
				'pr-workflow-checkouts',
				'session',
			);
			const destination = path.join(receiptDirectory, 'receipt.json');
			const preserved = path.join(
				directory,
				'.swarm',
				'pr-workflow-checkouts',
				'session-preserved',
			);
			const outside = path.join(directory, 'outside-atomic-race');
			let hookReached = false;
			let renameBlocked = false;
			await fs.mkdir(outside, { recursive: true });
			_test_exports.beforeAtomicTempWrite = async () => {
				_test_exports.beforeAtomicTempWrite = undefined;
				hookReached = true;
				try {
					await fs.rename(receiptDirectory, preserved);
				} catch (error) {
					renameBlocked = (error as NodeJS.ErrnoException).code === 'EPERM';
					throw error;
				}
			};

			await expect(
				writePrWorkflowAtomicJson(directory, destination, {
					secret: 'blocked',
				}),
			).rejects.toThrow(/EPERM/i);
			expect(hookReached).toBe(true);
			expect(renameBlocked).toBe(true);
			expect(await fs.readdir(outside)).toEqual([]);
		},
	);
});
