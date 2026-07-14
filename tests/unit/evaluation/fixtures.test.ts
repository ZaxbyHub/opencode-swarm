import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	listTier1FixtureManifests,
	loadTier1EvaluationTasks,
	TIER1_FIXTURE_IDS,
} from '../../../src/evaluation/fixtures.js';

const packageRoot = path.resolve(import.meta.dir, '../../..');

describe('Tier-1 evaluation fixtures', () => {
	test('ships six mutation-class and six curated content-addressed tasks', async () => {
		const tasks = await loadTier1EvaluationTasks(packageRoot);
		expect(tasks).toHaveLength(12);
		expect(tasks.map((task) => task.id).sort()).toEqual(
			[...TIER1_FIXTURE_IDS].sort(),
		);
		expect(
			tasks.filter(
				(task) =>
					task.id.startsWith('mutation-') ||
					[
						'null-substitution',
						'operator-swap',
						'guard-removal',
						'branch-swap',
						'side-effect-deletion',
					].includes(task.id),
			),
		).toHaveLength(6);
		expect(tasks.every((task) => task.split === 'train')).toBe(true);
		expect(new Set(tasks.map((task) => task.contentHash)).size).toBe(12);
	});

	test('rejects an incomplete packed fixture root', () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'eval-fixtures-')),
		);
		try {
			fs.mkdirSync(path.join(root, 'evaluation-fixtures', 'tier1'), {
				recursive: true,
			});
			expect(() => listTier1FixtureManifests(root)).toThrow('incomplete');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
