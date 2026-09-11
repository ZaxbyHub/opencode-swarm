import { describe, expect, test } from 'bun:test';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
	TERMINAL_STATUSES,
	type ValidationReport,
	writeValidationReport,
} from '../../../../scripts/ci/repository-validation';
import { withFrozenClock } from '../../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const FIXED_ISO_NOW = '2026-01-01T00:00:00.000Z';

function isoNow(): string {
	return withFrozenClock(() => new Date().toISOString(), {
		fixedNow: 1_767_225_600_000,
		isoNow: FIXED_ISO_NOW,
	});
}

function report(root: string, durationMs = 0): ValidationReport {
	return {
		schemaVersion: 1,
		status: 'passed',
		mode: 'full',
		root,
		diffBase: 'origin/main',
		runtime: {
			bunVersion: 'test',
			platform: process.platform,
			arch: process.arch,
		},
		inventory: ['unit'],
		bounds: {
			testTimeoutMs: 120,
			perItemTimeoutMs: 180,
			suiteTimeoutMs: 900,
			maxOutputBytes: 64,
		},
		terminalStatuses: [...TERMINAL_STATUSES],
		summary: {
			discovered: 0,
			started: 0,
			completed: 0,
			passed: 0,
			failed: 0,
			crashed: 0,
			timedOut: 0,
			missing: 0,
			skipped: 0,
		},
		results: [],
		startedAt: isoNow(),
		endedAt: isoNow(),
		durationMs,
	};
}

async function withTempRoot(
	run: (root: string, destination: string) => Promise<void>,
): Promise<void> {
	const root = canonicalMkdtemp('repository-validation-2675-');
	const destination = path.join(root, '.swarm', 'repository-validation.json');
	try {
		await run(root, destination);
	} finally {
		await fsp.rm(root, { recursive: true, force: true });
	}
}

describe('repository validation report lock — issue #2675', () => {
	test('rejects a .swarm symlink or junction before writing outside the root (F2)', async () => {
		// Before this guard, lexical containment allowed mkdir/rename to follow a
		// .swarm symlink and place the report outside the project root.
		const root = canonicalMkdtemp('repository-validation-root-');
		const outside = canonicalMkdtemp('repository-validation-outside-');
		const swarmPath = path.join(root, '.swarm');
		const destination = path.join(swarmPath, 'repository-validation.json');
		try {
			try {
				await fsp.symlink(
					outside,
					swarmPath,
					process.platform === 'win32' ? 'junction' : 'dir',
				);
			} catch (error) {
				if (process.platform === 'win32') return;
				throw error;
			}
			await expect(
				writeValidationReport(report(root), destination),
			).rejects.toThrow(/symlink|junction/i);
			expect(await fsp.readdir(outside)).toEqual([]);
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
			await fsp.rm(outside, { recursive: true, force: true });
		}
	});

	test('recovers a lock whose owner process is dead', async () => {
		await withTempRoot(async (root, destination) => {
			await fsp.mkdir(path.dirname(destination), { recursive: true });
			await fsp.writeFile(
				`${destination}.lock`,
				JSON.stringify({
					pid: 2_147_483_647,
					token: 'dead-owner',
					createdAt: withFrozenClock(() => Date.now(), {
						fixedNow: 1_767_225_600_000,
					}),
				}),
			);

			await writeValidationReport(report(root), destination);
			const saved = JSON.parse(
				await fsp.readFile(destination, 'utf8'),
			) as ValidationReport & { reportPath: string };
			expect(saved.reportPath).toBe(destination);
			expect(
				await fsp.stat(`${destination}.lock`).catch(() => null),
			).toBeNull();
		});
	});

	test('serializes concurrent writers and leaves one complete atomic report', async () => {
		await withTempRoot(async (root, destination) => {
			const paths = await Promise.all([
				writeValidationReport(report(root, 1), destination),
				writeValidationReport(report(root, 2), destination),
			]);
			expect(paths).toEqual([destination, destination]);
			const saved = JSON.parse(
				await fsp.readFile(destination, 'utf8'),
			) as ValidationReport & { reportPath: string };
			expect(saved.reportPath).toBe(destination);
			expect([1, 2]).toContain(saved.durationMs);
			expect(
				await fsp.stat(`${destination}.lock`).catch(() => null),
			).toBeNull();
		});
	});
});
