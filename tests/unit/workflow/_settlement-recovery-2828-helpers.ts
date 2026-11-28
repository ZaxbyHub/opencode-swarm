/**
 * Shared fixtures for the issue #2828 settlement-recovery suites
 * (underscore-prefixed so bun does not treat this as a test file).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saveEvidence } from '../../../src/evidence/manager';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';

export const FIXED_NOW_MS = new Date('2026-01-01T00:00:00.000Z').getTime();
export const SETTLED_AT_ISO = new Date(FIXED_NOW_MS - 60_000).toISOString();
export const STALE_AT_ISO = new Date(FIXED_NOW_MS - 120_000).toISOString();

export function writeCommittedWal(
	directory: string,
	taskId: string,
	accepted = true,
): void {
	const walPath = path.join(
		directory,
		'.swarm',
		'coder-settlements',
		`${taskId}.json`,
	);
	fs.mkdirSync(path.dirname(walPath), { recursive: true });
	fs.writeFileSync(
		walPath,
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
				declaredFiles: ['src/changed.ts'],
			},
			accepted,
			recordedAt: SETTLED_AT_ISO,
		}),
	);
}

export async function writeGreenBundles(
	directory: string,
	stale = false,
): Promise<void> {
	const stamp = stale ? STALE_AT_ISO : SETTLED_AT_ISO;
	await saveEvidence(directory, 'secretscan', {
		task_id: 'secretscan',
		type: 'secretscan',
		timestamp: stamp,
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
		timestamp: stamp,
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

/** accepted_mutation → stage_a_passed → task_blocked (→ repair_idle). */
export async function settleAt(
	directory: string,
	taskId: string,
	target: 'blocked' | 'idle',
): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:setup-${taskId}`,
	});
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `pre-check:setup-${taskId}`,
	});
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'task_blocked',
		expectedGeneration: 1,
		transitionId: `terminal:setup-${taskId}`,
	});
	if (target === 'idle') {
		await transitionTaskWorkflowEvidence(directory, taskId, {
			type: 'repair_idle',
			expectedGeneration: 1,
			transitionId: `repair:setup-${taskId}`,
		});
	}
}

export function readRepairEvents(directory: string): Record<string, unknown>[] {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((event) => event.type === 'stage_a_repair');
}

/**
 * Remove the task-gate-requirements receipt ledger for a task so the fixture
 * carries NO durable settlement receipt at all (settleAt's accepted_mutation
 * transition writes one). Used by the "nothing justifies repair" pins: since
 * the requirements-receipt fallback, a chain-verified accepted_mutation
 * receipt alone justifies the settlement-wedge recovery, so those pins must
 * strip the ledger to stay receipt-less.
 */
export function stripRequirementsLedger(
	directory: string,
	taskId: string,
): void {
	const ledgerPath = path.join(
		directory,
		'.swarm',
		'evidence',
		'task-gate-requirements',
		`${taskId}.jsonl`,
	);
	fs.rmSync(ledgerPath, { force: true });
}
