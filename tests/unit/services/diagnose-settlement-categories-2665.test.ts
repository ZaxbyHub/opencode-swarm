/**
 * Issue #2665 — diagnose settlement categories through the real surface.
 *
 * Fixture-driven per-class rendering via getDiagnoseData: corrupt / stale /
 * ambiguous-foreign get distinct category lines with per-class suggested
 * commands and identity; the wedged Stage A class and a plan task with no
 * receipt are visible; a healthy terminal task never receives a per-task
 * category line.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saveEvidence } from '../../../src/evidence/manager';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import { getDiagnoseData } from '../../../src/services/diagnose-service';
import { resetSwarmState } from '../../../src/state';
import { _internals as settlementInternals } from '../../../src/workflow/coder-settlement';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { freezeClock } from '../../helpers/test-clock';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0)
		throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
}

function walPath(directory: string, taskId: string): string {
	return path.join(directory, '.swarm', 'coder-settlements', `${taskId}.json`);
}

/** Schema-valid WAL template (see workflow-wal-schema.ts requirements). */
function writeWal(
	directory: string,
	taskId: string,
	overrides: Record<string, unknown>,
): void {
	fs.mkdirSync(path.dirname(walPath(directory, taskId)), { recursive: true });
	fs.writeFileSync(
		walPath(directory, taskId),
		JSON.stringify({
			version: 1,
			state: 'DISPATCHED',
			taskId,
			transitionId: `coder:cat-${taskId}`,
			actor: 'architect',
			processId: process.pid,
			runtimeId: `runtime-cat-${taskId}`,
			expectedGeneration: 1,
			context: {
				declaredFiles: [],
				baseline: {
					directory,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
			},
			recordedAt: '2026-09-09T00:00:00.000Z',
			...overrides,
		}),
	);
}

async function writeGreenBundles(directory: string): Promise<void> {
	await saveEvidence(directory, 'secretscan', {
		task_id: 'secretscan',
		type: 'secretscan',
		timestamp: new Date().toISOString(),
		agent: 'pre_check_batch',
		verdict: 'pass',
		summary: 'no secrets found',
		findings_count: 0,
		files_scanned: 10,
		skipped_files: 0,
		incomplete_files: 0,
		incomplete_paths: [],
	});
	await saveEvidence(directory, 'sast_scan', {
		task_id: 'sast_scan',
		type: 'sast',
		timestamp: new Date().toISOString(),
		agent: 'pre_check_batch',
		verdict: 'pass',
		summary: 'no findings',
		findings: [],
		engine: 'tier_a',
		files_scanned: 5,
		findings_count: 0,
		findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
	});
}

describe('diagnose settlement categories (issue #2665)', () => {
	// Deterministic fixture instant (explicit-arg Date constructor where possible;
	// freezeClock pins the Date.now-derived fixture timestamps below so the
	// recency math in scanStageATask is reproducible under coverage runs).
	const FIXED_NOW_ISO = '2026-09-09T12:00:00.000Z';
	let restoreClock: (() => void) | null = null;
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(async () => {
		restoreClock = freezeClock({ isoNow: FIXED_NOW_ISO });
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		({ dir: directory, cleanup } = createSafeTestDir('diagnose-cat-2665-'));
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'src', 'feature.ts'),
			'export const feature = 1;\n',
		);
		git(directory, ['add', '.']);
		git(directory, ['commit', '-m', 'seed']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
	}, 30_000);

	afterEach(() => {
		restoreClock?.();
		restoreClock = null;
		resetSwarmState();
		settlementInternals.liveDispatches.clear();
		cleanup();
	});

	async function settlementDetail(): Promise<{
		status: string;
		detail: string;
	}> {
		const data = await getDiagnoseData(directory);
		const check = data.checks.find(
			(entry) => entry.name === 'Coder Settlements',
		);
		if (!check) throw new Error('Coder Settlements row missing');
		return { status: check.status, detail: check.detail };
	}

	test('corrupt, stale, and ambiguous-foreign tasks render distinct category lines', async () => {
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/feature.ts'] },
			{ id: '1.2', files: ['src/feature.ts'] },
			{ id: '1.3', files: ['src/feature.ts'] },
		]);
		// 1.1 stale: dead owner pid, no in-process registration.
		const dead = spawnSync(process.execPath, ['--version'], {
			stdin: 'ignore',
			encoding: 'utf8',
			timeout: 15_000,
			windowsHide: true,
		});
		writeWal(directory, '1.1', {
			processId: dead.pid,
			transitionId: 'coder:cat-stale',
			expectedGeneration: 2,
		});
		// 1.2 corrupt: unparseable bytes.
		fs.mkdirSync(path.dirname(walPath(directory, '1.2')), {
			recursive: true,
		});
		fs.writeFileSync(
			walPath(directory, '1.2'),
			'{ "version": 1, "state": "DIS',
		);
		// 1.3 ambiguous: live foreign pid (this test process's parent).
		writeWal(directory, '1.3', { processId: process.ppid });

		const { status, detail } = await settlementDetail();
		expect(status).toBe('⚠️');
		expect(detail).toContain('task 1.1 [stale]');
		expect(detail).toContain('coder:cat-stale');
		expect(detail).toMatch(/generation \d/);
		expect(detail).toContain('/swarm recover 1.1');
		expect(detail).toContain('task 1.2 [corrupt]');
		// The corrupt task's own segment must not suggest /swarm recover
		// (segments mirror how the row renders: '; '-separated per task).
		const corruptSegment = detail
			.split('; ')
			.find((segment) => segment.includes('task 1.2'));
		expect(corruptSegment).toBeDefined();
		expect(corruptSegment).not.toMatch(/\/swarm\s+recover/);
		expect(detail).toContain('task 1.3 [ambiguous]');
		expect(detail).toContain('live foreign process');
	}, 60_000);

	test('wedged Stage A task and missing-receipt plan task are visible; healthy stays counted', async () => {
		await writeApprovedPlan(directory, [
			{ id: '2.1', files: ['src/feature.ts'] },
			{ id: '3.1', files: ['src/feature.ts'] },
			{ id: '9.9', files: ['src/feature.ts'] },
		]);
		// 2.1: live-shaped wedge (accepted_mutation, no pre_check proof,
		// green post-settlement bundles, COMMITTED receipt before now).
		await transitionTaskWorkflowEvidence(directory, '2.1', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder:setup-2.1',
		});
		writeWal(directory, '2.1', {
			state: 'COMMITTED',
			transitionId: 'coder:setup-2.1',
			accepted: true,
			recordedAt: new Date(Date.now() - 60_000).toISOString(),
		});
		await writeGreenBundles(directory);
		// 3.1: healthy terminal receipt.
		writeWal(directory, '3.1', {
			state: 'COMMITTED',
			transitionId: 'coder:cat-3.1',
			accepted: true,
		});
		// 9.9: nothing — the missing class.

		const { detail } = await settlementDetail();
		expect(detail).toContain('task 2.1 [live_wedge]');
		expect(detail).toContain('/swarm recover 2.1');
		expect(detail).toContain('task 9.9 [missing]');
		expect(detail).toContain('no settlement WAL');
		// Healthy task: count only — no per-task category line for 3.1.
		expect(detail).not.toContain('task 3.1 [');
		expect(detail).toContain('2 healthy settlement(s)');
	}, 60_000);
});
