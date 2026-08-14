import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeRmRecursive } from '../../tests/helpers/safe-test-dir';
import { closeProjectDb } from '../db/project-db';
import { executeSavePlan } from './save-plan';

let tmpDir: string;

const minimalPlan = {
	title: 'Regression Test Plan',
	swarm_id: 'test-swarm',
	phases: [
		{
			id: 1,
			name: 'Phase 1',
			tasks: [
				{
					id: '1.1',
					description: 'Test task',
				},
			],
		},
	],
};

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'save-plan-anchor-test-'));
});

afterEach(() => {
	closeProjectDb(tmpDir);
	safeRmRecursive(tmpDir);
});

describe('save_plan subdirectory rejection (issue #577 regression)', () => {
	// ── 1. Subdirectory of project root is rejected ──

	it('rejects working_directory that is a subdirectory of the project root', async () => {
		const subDir = path.join(tmpDir, 'src');
		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: subDir },
			tmpDir,
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain('project root');
	});

	// ── 2. An unrelated nonexistent absolute path fails closed ──

	it('rejects an unrelated nonexistent working_directory without creating state', async () => {
		const wrongDir = `${tmpDir}-unrelated-missing-root`;
		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: wrongDir },
			tmpDir,
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain('project root');
		expect(existsSync(wrongDir)).toBe(false);
	});

	// ── 3. working_directory matching fallbackDir exactly is NOT rejected by anchor check ──

	it('does not fail with project root error when working_directory matches fallbackDir exactly', async () => {
		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: tmpDir },
			tmpDir,
		);

		// May fail later (e.g. missing spec.md), but NOT due to the anchor check
		expect(result.message).not.toContain('project root');
		expect(
			result.errors?.some((e) => e.includes('not the project root')),
		).not.toBe(true);
	});

	// ── 4. Omitting working_directory entirely is NOT rejected by anchor check ──

	it('does not fail with project root error when working_directory is omitted', async () => {
		const result = await executeSavePlan({ ...minimalPlan }, tmpDir);

		// May fail later (e.g. missing spec.md), but NOT due to the anchor check
		expect(result.message).not.toContain('project root');
		expect(
			result.errors?.some((e) => e.includes('not the project root')),
		).not.toBe(true);
	});

	// ── 5. working_directory as the same absolute project root is NOT rejected by anchor check ──

	it('does not fail with project root error when working_directory is the project root', async () => {
		const resolvedRoot = path.resolve(tmpDir);
		const result = await executeSavePlan(
			{ ...minimalPlan, working_directory: resolvedRoot },
			tmpDir,
		);

		// May fail later (e.g. missing spec.md), but NOT due to the anchor check
		expect(result.message).not.toContain('project root');
		expect(
			result.errors?.some((e) => e.includes('not the project root')),
		).not.toBe(true);
	});
});
