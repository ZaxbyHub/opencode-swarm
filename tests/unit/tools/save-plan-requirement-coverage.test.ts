import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SavePlanArgs } from '../../../src/tools/save-plan';
import { executeSavePlan } from '../../../src/tools/save-plan';

function baseArgs(overrides?: Partial<SavePlanArgs>): SavePlanArgs {
	return {
		title: 'Requirement Coverage Test',
		swarm_id: 'mega',
		phases: [
			{
				id: 1,
				name: 'Implementation',
				tasks: [
					{
						id: '1.1',
						description: 'Implement the runtime execution gate',
					},
				],
			},
		],
		...overrides,
	};
}

describe('save_plan requirement coverage gate', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'save-plan-coverage-'));
		await mkdir(join(dir, '.swarm'), { recursive: true });
		await writeFile(
			join(dir, '.swarm', 'spec.md'),
			[
				'# Spec',
				'FR-001: MUST enforce plan critic approval before coder execution.',
				'FR-002: SHOULD include an operator-facing warning.',
			].join('\n'),
			'utf8',
		);
		await writeFile(
			join(dir, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
			'utf8',
		);
	});

	afterEach(async () => {
		if (dir && existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('rejects and reports unmapped MUST requirements before writing plan.json', async () => {
		const result = await executeSavePlan(baseArgs(), dir);

		expect(result.success).toBe(false);
		expect(result.message).toContain('REQUIREMENT_COVERAGE_GAPS');
		expect(result.requirement_coverage?.status).toBe('failed');
		expect(result.requirement_coverage?.missing_count).toBe(2);
		expect(result.requirement_coverage?.blocking_missing_count).toBe(1);
		expect(result.requirement_coverage?.missing.map((r) => r.id)).toContain(
			'FR-001',
		);
		expect(existsSync(join(dir, '.swarm', 'plan.json'))).toBe(false);
	});

	test('saves plan when required FR IDs are mapped in task text', async () => {
		const result = await executeSavePlan(
			baseArgs({
				phases: [
					{
						id: 1,
						name: 'Implementation',
						tasks: [
							{
								id: '1.1',
								description: 'Implement FR-001 plan critic approval gate',
								acceptance: 'FR-002 warning is surfaced when useful',
							},
						],
					},
				],
			}),
			dir,
		);

		expect(result.success).toBe(true);
		expect(result.requirement_coverage?.status).toBe('passed');
		expect(result.requirement_coverage?.missing_count).toBe(0);
		const saved = JSON.parse(
			await readFile(join(dir, '.swarm', 'plan.json'), 'utf8'),
		);
		expect(saved.phases[0].tasks[0].description).toContain('FR-001');
	});

	test('allows explicit override while returning structured missing coverage', async () => {
		const result = await executeSavePlan(
			baseArgs({ confirm_requirement_coverage_gaps: true }),
			dir,
		);

		expect(result.success).toBe(true);
		expect(result.requirement_coverage?.status).toBe('override');
		expect(result.requirement_coverage?.blocking_missing_count).toBe(1);
		expect(result.warnings?.some((warning) => warning.includes('FR-001'))).toBe(
			true,
		);
		expect(existsSync(join(dir, '.swarm', 'plan.json'))).toBe(true);
	});
});
