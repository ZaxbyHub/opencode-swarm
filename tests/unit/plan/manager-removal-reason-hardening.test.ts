/**
 * Manager-layer hardening test (PR #855 follow-up).
 *
 * The save_plan tool already rejects whitespace-only removal_reason at the
 * tool layer, but the underlying savePlan() function must also reject it
 * when called directly (e.g. by other internal call sites or future
 * callers). The acknowledged_removals contract documents
 * `reason: string`; the manager now enforces non-empty trimmed values to
 * keep the ledger audit trail meaningful.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { savePlan } from '../../../src/plan/manager';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-ack-reason-'));
	await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
	await fs.writeFile(path.join(tmpDir, '.swarm', 'spec.md'), '# Test Spec\n');
});

afterEach(async () => {
	try {
		await fs.rm(tmpDir, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

function planWith(taskIds: string[]): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Manager Ack Reason',
		swarm: 'regression',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: taskIds.map((id) => ({
					id,
					phase: 1,
					description: `Task ${id}`,
					status: 'pending' as const,
					size: 'small' as const,
					depends: [],
					files_touched: [],
				})),
			},
		],
	} as Plan;
}

describe('savePlan acknowledged_removals reason hardening', () => {
	test('rejects empty-string reason at the manager layer', async () => {
		await savePlan(tmpDir, planWith(['1.1', '1.2']));

		await expect(
			savePlan(tmpDir, planWith(['1.1']), {
				acknowledged_removals: {
					ids: ['1.2'],
					reason: '',
					source: 'test_direct_manager_call',
				},
			}),
		).rejects.toThrow(/non-empty string/);
	});

	test('rejects whitespace-only reason at the manager layer', async () => {
		await savePlan(tmpDir, planWith(['1.1', '1.2']));

		await expect(
			savePlan(tmpDir, planWith(['1.1']), {
				acknowledged_removals: {
					ids: ['1.2'],
					reason: '   \t\n',
					source: 'test_direct_manager_call',
				},
			}),
		).rejects.toThrow(/non-empty string/);
	});

	test('rejects empty-string source at the manager layer', async () => {
		await savePlan(tmpDir, planWith(['1.1', '1.2']));

		await expect(
			savePlan(tmpDir, planWith(['1.1']), {
				acknowledged_removals: {
					ids: ['1.2'],
					reason: 'legitimate removal',
					source: '',
				},
			}),
		).rejects.toThrow(/non-empty string/);
	});

	test('accepts non-empty reason and source', async () => {
		await savePlan(tmpDir, planWith(['1.1', '1.2']));

		await expect(
			savePlan(tmpDir, planWith(['1.1']), {
				acknowledged_removals: {
					ids: ['1.2'],
					reason: 'redundant task',
					source: 'test_direct_manager_call',
				},
			}),
		).resolves.toBeUndefined();
	});
});
