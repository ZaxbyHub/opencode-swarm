/**
 * Stage A wedge repair (TASK_WORKFLOW_STAGE_A_REQUIRED post-reset wedge).
 *
 * Covers repairWedgedStageA: tasks whose durable workflow store sits at
 * coder_delegated with no pre_check gate proof and a green post-settlement
 * pre-check bundle get the missing stage_a_passed transition written
 * directly; everything else is skipped with a reason or errors per-task.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saveEvidence } from '../../../src/evidence/manager';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { repairWedgedStageA } from '../../../src/workflow/stage-a-repair';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let cleanup: () => void;
let directory: string;

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir('stage-a-repair'));
});

afterEach(() => {
	cleanup();
});

function walPath(taskId: string): string {
	return path.join(directory, '.swarm', 'coder-settlements', `${taskId}.json`);
}

/** Minimal valid v1 COMMITTED settlement WAL accepted by the schema parser. */
function writeCommittedWal(
	taskId: string,
	options?: { accepted?: boolean; recordedAt?: string },
): void {
	fs.mkdirSync(path.dirname(walPath(taskId)), { recursive: true });
	fs.writeFileSync(
		walPath(taskId),
		JSON.stringify({
			version: 1,
			state: 'COMMITTED',
			taskId,
			transitionId: `coder:test-${taskId}`,
			actor: 'test',
			processId: process.pid,
			runtimeId: '00000000-0000-4000-8000-000000000000',
			expectedGeneration: 1,
			context: {
				baseline: {
					directory,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
				declaredFiles: [],
			},
			accepted: options?.accepted ?? true,
			recordedAt: options?.recordedAt ?? new Date().toISOString(),
		}),
	);
}

async function settleTaskAtCoderDelegated(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:setup-${taskId}`,
	});
}

async function writeGreenSecretscan(timestamp?: string): Promise<void> {
	await saveEvidence(directory, 'secretscan', {
		task_id: 'secretscan',
		type: 'secretscan',
		timestamp: timestamp ?? new Date().toISOString(),
		agent: 'pre_check_batch',
		verdict: 'pass',
		summary: 'no secrets found',
		findings_count: 0,
		files_scanned: 10,
		skipped_files: 0,
		incomplete_files: 0,
		incomplete_paths: [],
	});
}

describe('repairWedgedStageA', () => {
	test('repairs a wedged coder_delegated task with green pre-check evidence', async () => {
		await settleTaskAtCoderDelegated('1.1');
		writeCommittedWal('1.1');
		await writeGreenSecretscan();

		const { results, truncated } = await repairWedgedStageA(directory);

		expect(truncated).toBe(false);
		expect(results).toEqual([
			{
				taskId: '1.1',
				outcome: 'repaired',
				generation: 1,
				transitionId: 'stage-a-repair:1.1:1',
			},
		]);
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		);
		expect(workflow.state).toBe('pre_check_passed');
		expect(workflow.generation).toBe(1);
	});

	test('appends a stage_a_repair audit event for each repair', async () => {
		await settleTaskAtCoderDelegated('2.3');
		writeCommittedWal('2.3');
		await writeGreenSecretscan();

		await repairWedgedStageA(directory);

		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		expect(fs.existsSync(eventsPath)).toBe(true);
		const events = fs
			.readFileSync(eventsPath, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const repairEvents = events.filter(
			(event) => event.type === 'stage_a_repair',
		);
		expect(repairEvents).toHaveLength(1);
		expect(repairEvents[0]).toMatchObject({
			action: 'repaired',
			taskId: '2.3',
			transitionId: 'stage-a-repair:2.3:1',
		});
	});

	test('skips tasks whose store is not wedged at coder_delegated', async () => {
		// Never dispatched: stays at the default (idle-ish) snapshot.
		const { results } = await repairWedgedStageA(directory);
		expect(results).toEqual([]);

		await settleTaskAtCoderDelegated('1.2');
		writeCommittedWal('1.2');
		await writeGreenSecretscan();
		await repairWedgedStageA(directory); // first run repairs
		const second = await repairWedgedStageA(directory); // already advanced
		expect(second.results).toHaveLength(1);
		expect(second.results[0]).toMatchObject({
			taskId: '1.2',
			outcome: 'skipped_not_wedged',
		});
	});

	test('skips when no pre-check bundles exist (nothing proves Stage A ran)', async () => {
		await settleTaskAtCoderDelegated('1.4');
		writeCommittedWal('1.4');

		const { results } = await repairWedgedStageA(directory);
		expect(results).toEqual([
			{
				taskId: '1.4',
				outcome: 'skipped_not_green',
				reason: 'no_pre_check_bundles',
			},
		]);
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.4'),
		);
		expect(workflow.state).toBe('coder_delegated');
	});

	test('skips when latest secretscan failed', async () => {
		await settleTaskAtCoderDelegated('1.5');
		writeCommittedWal('1.5');
		await saveEvidence(directory, 'secretscan', {
			task_id: 'secretscan',
			type: 'secretscan',
			timestamp: new Date().toISOString(),
			agent: 'pre_check_batch',
			verdict: 'fail',
			summary: 'secrets detected',
			findings_count: 2,
			files_scanned: 10,
			skipped_files: 0,
			incomplete_files: 0,
			incomplete_paths: [],
		});

		const { results } = await repairWedgedStageA(directory);
		expect(results).toEqual([
			{
				taskId: '1.5',
				outcome: 'skipped_not_green',
				reason: 'pre_check_failed_or_stale',
			},
		]);
	});

	test('skips when only a sast bundle exists (secretscan is the required proof)', async () => {
		await settleTaskAtCoderDelegated('1.7');
		writeCommittedWal('1.7');
		await saveEvidence(directory, 'sast', {
			task_id: 'sast',
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

		const { results } = await repairWedgedStageA(directory);
		expect(results).toEqual([
			{
				taskId: '1.7',
				outcome: 'skipped_not_green',
				reason: 'no_pre_check_bundles',
			},
		]);
	});

	test('skips when pre-check evidence predates the settlement commit', async () => {
		await settleTaskAtCoderDelegated('1.6');
		// Bundle written BEFORE the settlement commit — it cannot vouch for the
		// mutation this settlement accepted.
		const staleTimestamp = new Date(Date.now() - 60_000).toISOString();
		writeCommittedWal('1.6', { recordedAt: new Date().toISOString() });
		await writeGreenSecretscan(staleTimestamp);

		const { results } = await repairWedgedStageA(directory);
		expect(results).toEqual([
			{
				taskId: '1.6',
				outcome: 'skipped_not_green',
				reason: 'pre_check_failed_or_stale',
			},
		]);
	});

	test('taskIds filter scopes the scan to the requested task', async () => {
		await settleTaskAtCoderDelegated('3.1');
		await settleTaskAtCoderDelegated('3.2');
		writeCommittedWal('3.1');
		writeCommittedWal('3.2');
		await writeGreenSecretscan();

		const { results } = await repairWedgedStageA(directory, {
			taskIds: ['3.2'],
		});
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ taskId: '3.2', outcome: 'repaired' });
		const workflow = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '3.1'),
		);
		expect(workflow.state).toBe('coder_delegated');
	});

	test('live DISPATCHED settlement blocks the repair loudly as a per-task error', async () => {
		await settleTaskAtCoderDelegated('4.1');
		// DISPATCHED WAL owns the evidence lane; the reducer fence must refuse.
		fs.mkdirSync(path.dirname(walPath('4.1')), { recursive: true });
		fs.writeFileSync(
			walPath('4.1'),
			JSON.stringify({
				version: 1,
				state: 'DISPATCHED',
				taskId: '4.1',
				transitionId: 'coder:live-4-1',
				actor: 'test',
				processId: 999_999_999,
				runtimeId: '00000000-0000-4000-8000-000000000001',
				expectedGeneration: 1,
				context: {
					baseline: {
						directory,
						gitHead: null,
						dirtyHash: null,
						prHeadSha: null,
						scope: null,
						changedFiles: [],
					},
					declaredFiles: [],
				},
				accepted: true,
				recordedAt: new Date().toISOString(),
			}),
		);
		await writeGreenSecretscan();

		const { results } = await repairWedgedStageA(directory);
		expect(results).toHaveLength(1);
		expect(results[0].outcome).toBe('error');
		if (results[0].outcome === 'error') {
			expect(results[0].message).toContain('CODER_SETTLEMENT_IN_PROGRESS');
		}
	});

	test('missing .swarm/evidence directory is a clean no-op', async () => {
		const { results, truncated } = await repairWedgedStageA(directory);
		expect(results).toEqual([]);
		expect(truncated).toBe(false);
	});
});
