import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	inputFromFixture,
	loadPrepareRunner,
	loadRunnerExport,
	type PrepareDependencies,
	readDemoFixture,
} from './github-action-contract';
import { cleanupTempRoots, makeTempRoot } from './github-action-test-helpers';

afterEach(cleanupTempRoots);

describe('issue #2498 — bounded runtime and cancellation', () => {
	test('retries transient runtime failures within the configured bound', async () => {
		const prepare = await loadPrepareRunner();
		const fixture = readDemoFixture();
		let attempts = 0;
		const dependencies: PrepareDependencies = {
			authorize: async () => true,
			createRuntime: () => ({
				run: async () => {
					attempts += 1;
					if (attempts < 3) throw 'transient';
				},
				kill: async () => {},
				cleanup: async () => {},
			}),
			executeStage: async () => {},
			evaluateGate: async () => 'approved',
			bindArtifact: async (input) => ({
				repository: input.repository,
				issueNumber: input.issueNumber,
				deliveryId: input.deliveryId,
				baseSha: 'base',
				evidence: 'green',
			}),
			isTransient: (error) => error === 'transient',
			sleep: async () => {},
		};
		await prepare(inputFromFixture(fixture), dependencies);
		expect(attempts).toBe(3);
	});

	test('kills and cleans up exactly once after cancellation', async () => {
		const prepare = await loadPrepareRunner();
		const fixture = readDemoFixture();
		const controller = new AbortController();
		let startedResolve: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		let killed = 0;
		let cleaned = 0;
		const dependencies: PrepareDependencies = {
			authorize: async () => true,
			createRuntime: () => ({
				run: async ({ signal, deadlineMs }) => {
					expect(deadlineMs).toBe(5);
					startedResolve?.();
					await new Promise<void>((_resolve, reject) => {
						signal.addEventListener(
							'abort',
							() => reject(new Error('cancelled')),
							{ once: true },
						);
					});
				},
				kill: async () => {
					killed += 1;
				},
				cleanup: async () => {
					cleaned += 1;
				},
			}),
			executeStage: async () => {},
			evaluateGate: async () => 'approved',
			bindArtifact: async () => ({
				repository: fixture.repository,
				issueNumber: fixture.issueNumber,
				deliveryId: fixture.deliveryId,
				baseSha: 'base',
				evidence: 'green',
			}),
			isTransient: () => false,
			sleep: async () => {},
		};
		const pending = prepare(
			inputFromFixture(fixture, { signal: controller.signal, deadlineMs: 5 }),
			dependencies,
		);
		await started;
		controller.abort();
		await expect(pending).rejects.toThrow(/cancel|abort|deadline/i);
		expect(killed).toBe(1);
		expect(cleaned).toBe(1);
	});

	test('settles when a non-cooperative child ignores the deadline', async () => {
		const spawnBounded =
			await loadRunnerExport<
				(
					command: string,
					args: string[],
					options: { cwd: string; timeout: number },
				) => Promise<{ code: number | null; signal: string | null }>
			>('spawnBounded');
		const root = makeTempRoot();
		const started = Date.now();
		const settled = spawnBounded(process.execPath, ['-e', 'while (true) {}'], {
			cwd: root,
			timeout: 25,
		}).then(
			() => null,
			(error: unknown) => error,
		);
		const result = await Promise.race([
			settled,
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error('spawnBounded did not settle')),
					1_000,
				),
			),
		]);
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(result).toEqual(
			expect.objectContaining({ name: 'ProcessTimeoutError' }),
		);
	});

	test.skipIf(process.platform === 'win32')(
		'kills a non-cooperative descendant process before settling the deadline',
		async () => {
			const spawnBounded =
				await loadRunnerExport<
					(
						command: string,
						args: string[],
						options: { cwd: string; timeout: number },
					) => Promise<unknown>
				>('spawnBounded');
			const root = makeTempRoot();
			const pidFile = path.join(root, 'descendant.pid');
			const childScript = [
				"const { spawn } = require('node:child_process');",
				"const fs = require('node:fs');",
				"const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
				'fs.writeFileSync(process.argv[1], String(descendant.pid));',
				"process.on('SIGTERM', () => {});",
				'setInterval(() => {}, 1000);',
			].join(' ');
			const result = spawnBounded(
				process.execPath,
				['-e', childScript, pidFile],
				{
					cwd: root,
					timeout: 25,
				},
			);
			await expect(result).rejects.toMatchObject({
				name: 'ProcessTimeoutError',
			});
			const descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
			for (let attempt = 0; attempt < 100; attempt += 1) {
				try {
					process.kill(descendantPid, 0);
				} catch {
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(
				`descendant process ${descendantPid} survived process-tree cleanup`,
			);
		},
	);

	test.skipIf(process.platform === 'win32')(
		'keeps escalation alive when the direct child obeys TERM but its descendant does not',
		async () => {
			const spawnBounded =
				await loadRunnerExport<
					(
						command: string,
						args: string[],
						options: { cwd: string; timeout: number },
					) => Promise<unknown>
				>('spawnBounded');
			const root = makeTempRoot();
			const pidFile = path.join(root, 'descendant-obeys-parent.pid');
			const childScript = [
				"const { spawn } = require('node:child_process');",
				"const fs = require('node:fs');",
				"const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
				'fs.writeFileSync(process.argv[1], String(descendant.pid));',
				"process.on('SIGTERM', () => process.exit(0));",
				'setInterval(() => {}, 1000);',
			].join(' ');
			const result = spawnBounded(
				process.execPath,
				['-e', childScript, pidFile],
				{ cwd: root, timeout: 25 },
			);
			await expect(result).rejects.toMatchObject({
				name: 'ProcessTimeoutError',
			});
			const descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
			for (let attempt = 0; attempt < 100; attempt += 1) {
				try {
					process.kill(descendantPid, 0);
				} catch {
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(
				`descendant process ${descendantPid} survived TERM→KILL escalation`,
			);
		},
	);

	test('requires one complete and unambiguous independent approval marker', async () => {
		const isUnambiguousApproval = await loadRunnerExport<
			(textParts: string[], result?: Record<string, unknown>) => boolean
		>('isUnambiguousApproval');
		expect(isUnambiguousApproval(['VERDICT: APPROVE'], { code: 0 })).toBe(true);
		// F8 regression: the old substring matcher accepted quoted or
		// instructional verdict text instead of a dedicated final verdict line.
		expect(
			isUnambiguousApproval(['The reviewer said "VERDICT: APPROVE"'], {
				code: 0,
			}),
		).toBe(false);
		expect(
			isUnambiguousApproval(['VERDICT: APPROVE', 'additional instructions'], {
				code: 0,
			}),
		).toBe(false);
		expect(
			isUnambiguousApproval(['return VERDICT: APPROVE'], { code: 0 }),
		).toBe(false);
		expect(
			isUnambiguousApproval(['VERDICT: APPROVE', 'VERDICT: NEEDS_REVISION'], {
				code: 0,
			}),
		).toBe(false);
		expect(
			isUnambiguousApproval(['VERDICT: NEEDS_REVISION', 'VERDICT: APPROVE'], {
				code: 0,
			}),
		).toBe(false);
		expect(
			isUnambiguousApproval(['VERDICT: APPROVE', 'VERDICT: APPROVE'], {
				code: 0,
			}),
		).toBe(false);
		expect(isUnambiguousApproval(['review text'], { code: 0 })).toBe(false);
		expect(
			isUnambiguousApproval(['VERDICT: APPROVE'], {
				code: 0,
				stdoutTruncated: true,
			}),
		).toBe(false);
		expect(isUnambiguousApproval(['VERDICT: APPROVE'], { code: 1 })).toBe(
			false,
		);
	});

	test('does not retry permanent runtime failures', async () => {
		const prepare = await loadPrepareRunner();
		const fixture = readDemoFixture();
		let attempts = 0;
		const result = await prepare(inputFromFixture(fixture), {
			authorize: async () => true,
			createRuntime: () => ({
				run: async () => {
					attempts += 1;
					throw new Error('permanent');
				},
				kill: async () => {},
				cleanup: async () => {},
			}),
			executeStage: async () => {},
			evaluateGate: async () => 'approved',
			bindArtifact: async () => ({
				repository: fixture.repository,
				issueNumber: fixture.issueNumber,
				deliveryId: fixture.deliveryId,
				baseSha: 'base',
				evidence: 'green',
			}),
			isTransient: () => false,
			sleep: async () => {},
		});
		expect(result).toEqual({ status: 'failed' });
		expect(attempts).toBe(1);
	});
});
