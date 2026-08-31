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
});
