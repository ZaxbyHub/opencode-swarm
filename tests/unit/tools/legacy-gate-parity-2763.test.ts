import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { check_gate_status } from '../../../src/tools/check-gate-status';
import { checkReviewerGate } from '../../../src/tools/update-task-status';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('legacy gate diagnostics parity (#2763)', () => {
	let directory = '';
	let cleanup = (): void => {};

	afterEach(() => cleanup());

	test('legacy reviewer gate includes the same derived pre_check obligation', async () => {
		({ dir: directory, cleanup } = createSafeTestDir('legacy-gate-2763-'));
		const evidenceDir = path.join(directory, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['reviewer'],
				gates: {
					reviewer: {
						sessionId: 'reviewer-session',
						timestamp: '2026-09-14T00:00:00.000Z',
						agent: 'reviewer',
					},
				},
			}),
		);

		const reviewer = checkReviewerGate(
			'1.1',
			directory,
			false,
			'parent-session',
			directory,
		);
		const status = JSON.parse(
			await check_gate_status.execute({ task_id: '1.1' }, { directory }),
		) as {
			required_gates: string[];
			passed_gates: string[];
			missing_gates: string[];
		};

		expect(reviewer.blocked).toBe(true);
		expect(reviewer.requiredGates).toEqual(status.required_gates);
		expect(reviewer.satisfiedGates).toEqual(status.passed_gates);
		expect(reviewer.missingGates).toEqual(status.missing_gates);
		expect(reviewer.requiredGates).toEqual(['pre_check', 'reviewer']);
		expect(reviewer.satisfiedGates).toEqual(['reviewer']);
		expect(reviewer.missingGates).toEqual(['pre_check']);
	});
});
