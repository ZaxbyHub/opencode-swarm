/**
 * Adversarial tests for gate-evidence write locking — concurrent gate record.
 *
 * Proves that no gate records are lost when concurrent callers race on the
 * same gate-evidence file.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

mock.module('../../src/telemetry.js', () => ({
	emit: () => {},
	telemetry: {
		gatePassed: () => {},
		sessionStarted: () => {},
	},
}));

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ev-adv-'));
	fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
	mock.restore();
});

describe('gate-evidence lock — concurrent recordGateEvidence', () => {
	test('all 8 concurrent gate records land without corruption', async () => {
		// Dynamic import after mocks are in place
		const {
			getTaskWorkflowSnapshot,
			recordAgentDispatch,
			recordGateEvidence,
			readTaskEvidence,
			transitionTaskWorkflowEvidence,
		} = await import('../../src/gate-evidence.js');

		const taskId = '1.1';
		await recordAgentDispatch(tempDir, taskId, 'coder');
		const generation = getTaskWorkflowSnapshot(
			await readTaskEvidence(tempDir, taskId),
		).generation;
		await transitionTaskWorkflowEvidence(tempDir, taskId, {
			type: 'stage_a_passed',
			expectedGeneration: generation,
		});
		const gates = [
			'reviewer',
			'test_engineer',
			'sme',
			'critic',
			'docs',
			'designer',
			'explorer',
			'reviewer', // duplicate: should overwrite, not corrupt
		];

		const writers = gates.map((gate, i) =>
			recordGateEvidence(tempDir, taskId, gate, `session-${i}`, false, {
				expectedGeneration: generation,
				transitionId: `concurrent-gate-${i}`,
			}),
		);

		const results = await Promise.allSettled(writers);
		const failures = results.filter((r) => r.status === 'rejected');
		expect(failures.length).toBe(0);

		// Read evidence file and verify it is valid JSON
		const evPath = path.join(tempDir, '.swarm', 'evidence', `${taskId}.json`);
		expect(fs.existsSync(evPath)).toBe(true);
		const raw = fs.readFileSync(evPath, 'utf-8');
		const ev = JSON.parse(raw);

		// taskId must be preserved
		expect(ev.taskId).toBe(taskId);
		// gates must be an object
		expect(typeof ev.gates).toBe('object');
		// At least one unique gate must be recorded
		const uniqueGates = new Set(gates);
		for (const gate of uniqueGates) {
			expect(ev.gates[gate]).toBeDefined();
		}
	});
});
