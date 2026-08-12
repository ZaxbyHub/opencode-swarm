/**
 * Adversarial tests for exact plan identity when readable identifiers collide.
 * Attack vectors: Unicode normalization and swarm-ID sanitization collisions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	executeSavePlan,
	type SavePlanArgs,
} from '../../../src/tools/save-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('save_plan exact identity — normalized-identifier collisions (FR-001)', () => {
	let tmpDir: string;

	const baseArgs: SavePlanArgs = {
		title: 'Alpha Project',
		swarm_id: 'mega',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				tasks: [{ id: '1.1', description: 'Do the thing' }],
			},
		],
	};

	beforeEach(async () => {
		process.env.SWARM_SKIP_GATE_SELECTION = '1';
		tmpDir = canonicalMkdtemp('identity-collision-');
		await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
		await fs.writeFile(path.join(tmpDir, '.swarm', 'spec.md'), '# Test Spec\n');
		await fs.writeFile(
			path.join(tmpDir, '.swarm', 'context.md'),
			'## Pending QA Gate Selection\n',
		);
	});

	afterEach(async () => {
		delete process.env.SWARM_SKIP_GATE_SELECTION;
		try {
			await fs.rm(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('Unicode title normalization', () => {
		it('rejects a title that differs only by non-breaking space (U+00A0)', async () => {
			const first = await executeSavePlan({
				...baseArgs,
				title: 'Mega Project',
				working_directory: tmpDir,
			});
			expect(first.success).toBe(true);

			const second = await executeSavePlan({
				...baseArgs,
				title: 'Mega\u00A0Project',
				working_directory: tmpDir,
			});

			// Human-readable plan IDs may normalize alike, but the durable identity
			// boundary is the exact raw swarm/title pair.
			expect(second.success).toBe(false);
			expect(second.message).toContain('PLAN_IDENTITY_MISMATCH');
		});

		it('rejects a title that differs only by U+2002 EN SPACE', async () => {
			const first = await executeSavePlan({
				...baseArgs,
				title: 'Alpha\u2002Beta',
				working_directory: tmpDir,
			});
			expect(first.success).toBe(true);

			const second = await executeSavePlan({
				...baseArgs,
				title: 'Alpha Beta',
				working_directory: tmpDir,
			});
			expect(second.success).toBe(false);
			expect(second.message).toContain('PLAN_IDENTITY_MISMATCH');
		});

		it('rejects a title when zero-width-space removal changes identity', async () => {
			const first = await executeSavePlan({
				...baseArgs,
				title: 'Alpha\u200BProject',
				working_directory: tmpDir,
			});
			expect(first.success).toBe(true);

			const second = await executeSavePlan({
				...baseArgs,
				title: 'AlphaProject',
				working_directory: tmpDir,
			});
			expect(second.success).toBe(false);
			expect(second.message).toContain('PLAN_IDENTITY_MISMATCH');
		});

		it('rejects truly different titles containing Unicode whitespace', async () => {
			const first = await executeSavePlan({
				...baseArgs,
				title: 'Project Alpha',
				working_directory: tmpDir,
			});
			expect(first.success).toBe(true);

			const second = await executeSavePlan({
				...baseArgs,
				title: 'Project\u00A0Beta',
				working_directory: tmpDir,
			});
			expect(second.success).toBe(false);
			expect(second.message).toContain('PLAN_IDENTITY_MISMATCH');
		});
	});

	describe('swarm-ID sanitization', () => {
		it('rejects a swarm_id that only differs by sanitized special characters', async () => {
			const first = await executeSavePlan({
				...baseArgs,
				swarm_id: 'mega@test',
				working_directory: tmpDir,
			});
			expect(first.success).toBe(true);

			const second = await executeSavePlan({
				...baseArgs,
				swarm_id: 'mega_test',
				working_directory: tmpDir,
			});
			expect(second.success).toBe(false);
			expect(second.message).toContain('PLAN_IDENTITY_MISMATCH');
		});

		it('rejects a swarm_id that remains different after normalization', async () => {
			const first = await executeSavePlan({
				...baseArgs,
				swarm_id: 'mega@test',
				working_directory: tmpDir,
			});
			expect(first.success).toBe(true);

			const second = await executeSavePlan({
				...baseArgs,
				swarm_id: 'other@test',
				working_directory: tmpDir,
			});
			expect(second.success).toBe(false);
			expect(second.message).toContain('PLAN_IDENTITY_MISMATCH');
		});
	});
});
