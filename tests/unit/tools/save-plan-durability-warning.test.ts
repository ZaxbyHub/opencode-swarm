import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { executeSavePlan } from '../../../src/tools/save-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function planArgs(dir: string) {
	return {
		title: 'Durability Disclosure Plan',
		swarm_id: 'durability-disclosure-2531',
		working_directory: dir,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				tasks: [{ id: '1.1', description: 'Durability task' }],
			},
		],
	};
}

describe('save_plan surfaces the manager durability outcome (#2531 AC5)', () => {
	let dir: string;

	beforeEach(async () => {
		// Same gate-selection bypass the sibling save-plan suite uses.
		process.env.SWARM_SKIP_GATE_SELECTION = '1';
		dir = canonicalMkdtemp('save-plan-durability-');
		// executeSavePlan resolves the working directory as a project root,
		// requires an effective spec, and saves under .swarm/ — all must exist
		// before the save.
		mkdirSync(join(dir, '.git'));
		mkdirSync(join(dir, '.swarm'), { recursive: true });
		writeFileSync(join(dir, '.swarm', 'spec.md'), '# Test Spec\n', 'utf8');
	});

	afterEach(async () => {
		delete process.env.SWARM_SKIP_GATE_SELECTION;
		try {
			await rm(dir, { recursive: true, force: true, maxRetries: 5 });
		} catch {
			/* best-effort */
		}
	});

	test('a complete save carries no durability warning', async () => {
		const result = await executeSavePlan(planArgs(dir));
		expect(result.success).toBe(true);
		const durabilityWarning = (result.warnings ?? []).find((warning) =>
			warning.includes('incomplete durability'),
		);
		expect(durabilityWarning).toBeUndefined();
	});

	test('a failed plan.md advisory write is disclosed as an incomplete-durability warning', async () => {
		// Make the advisory plan.md surface unwritable: a directory at the
		// plan.md path makes the advisory write fail while the authoritative
		// pair (ledger + plan.json) still persists, so savePlan returns
		// durability 'incomplete' and the tool must surface it in warnings.
		mkdirSync(join(dir, '.swarm'), { recursive: true });
		mkdirSync(join(dir, '.swarm', 'plan.md'));
		expect(existsSync(join(dir, '.swarm', 'plan.md'))).toBe(true);

		const result = await executeSavePlan(planArgs(dir));

		expect(result.success).toBe(true);
		const durabilityWarning = (result.warnings ?? []).find((warning) =>
			warning.includes('incomplete durability'),
		);
		expect(durabilityWarning).toBeDefined();
		expect(durabilityWarning).toContain('plan.md');
		expect(existsSync(join(dir, '.swarm', 'plan.json'))).toBe(true);
	});
});
