import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runBuildCheck } from '../../../src/tools/build-check';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('build_check environment diagnostics (#2303)', () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	});

	test('returns structured non-failing evidence for an unsupported runtime', async () => {
		tempDir = canonicalMkdtemp('build-check-2303-');
		await fs.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'unsupported-runtime-fixture',
				packageManager: 'unsupported-pm@1.0.0',
				scripts: { build: 'echo build' },
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'both',
		});

		expect(result.verdict).toBe('skip');
		expect(result.runs).toEqual([]);
		expect(result.summary.environment_unavailable).toEqual([
			{
				ecosystem: 'node',
				code: 'environment_unavailable',
				required_commands: ['unsupported-pm'],
				reason: 'Unsupported packageManager: unsupported-pm@1.0.0',
			},
		]);
	});

	test('reports a truthful skip reason when no supported build files are present', async () => {
		tempDir = canonicalMkdtemp('build-check-empty-');

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'both',
		});

		expect(result.verdict).toBe('info');
		expect(result.runs).toEqual([]);
		expect(result.summary.skipped_reason).toBe(
			'No build commands discovered (no supported build files found)',
		);
		expect(result.summary.environment_unavailable).toBeUndefined();
	});

	test('sanitizes and bounds packageManager text before exposing environment diagnostics', async () => {
		tempDir = canonicalMkdtemp('build-check-sanitize-');
		const noisySuffix = 'x'.repeat(200);
		await fs.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'unsupported-runtime-fixture',
				packageManager: `unsupported-pm@\n${noisySuffix}\twith-control`,
				scripts: { build: 'echo build' },
			}),
		);

		const result = await runBuildCheck(tempDir, {
			scope: 'all',
			mode: 'both',
		});

		const reason = result.summary.environment_unavailable?.[0]?.reason;
		expect(
			result.summary.environment_unavailable?.[0]?.required_commands,
		).toEqual(['unsupported-pm']);
		expect(reason).toBeDefined();
		expect(reason).toStartWith('Unsupported packageManager: unsupported-pm@ ');
		expect(reason).not.toContain('\n');
		expect(reason).not.toContain('\t');
		expect(reason?.endsWith('...')).toBe(true);
		expect(reason!.length).toBeLessThanOrEqual(
			'Unsupported packageManager: '.length + 120,
		);
		expect(result.summary.skipped_reason).toBe(`node: ${reason}`);
	});
});
