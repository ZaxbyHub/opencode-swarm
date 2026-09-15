import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { check_gate_status } from '../../../src/tools/check-gate-status.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

describe('check_gate_status — receiptless recovery (FB-001)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir(
			'check-gate-status-2525-',
		));
	});

	afterEach(() => {
		cleanup();
	});

	test('reports incomplete when receiptless repair leaves no required gates', async () => {
		// An empty required_gates array without trusted no-mutation settlement proof
		// still has the ordinary Stage-A pre_check obligation.
		const evidenceDir = path.join(directory, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, '1.1.json'),
			JSON.stringify({ taskId: '1.1', required_gates: [], gates: {} }),
		);

		const parsed = JSON.parse(
			await check_gate_status.execute({ task_id: '1.1' }, { directory }),
		) as {
			status: string;
			required_gates: string[];
			passed_gates: string[];
			missing_gates: string[];
			message: string;
		};

		expect(parsed.status).toBe('incomplete');
		expect(parsed.required_gates).toEqual(['pre_check']);
		expect(parsed.passed_gates).toEqual([]);
		expect(parsed.missing_gates).toEqual(['pre_check']);
		expect(parsed.message).toBe(
			'Task "1.1" is incomplete. Missing gates: pre_check.',
		);
	});
});
