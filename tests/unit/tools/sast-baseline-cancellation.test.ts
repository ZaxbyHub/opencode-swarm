import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureOrMergeBaseline } from '../../../src/tools/sast-baseline';
import type { SastScanFinding } from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('SAST baseline capture cancellation', () => {
	test('F-004 aborts lock retry without writing a late baseline', async () => {
		const directory = canonicalMkdtemp('sast-baseline-direct-cancel-');
		tempDirectories.push(directory);
		const file = path.join(directory, 'cancelled.js');
		fs.writeFileSync(file, 'eval(x);');
		const evidenceDirectory = path.join(directory, '.swarm', 'evidence', '1');
		fs.mkdirSync(evidenceDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDirectory, 'sast-baseline.json.lock'),
			'busy',
		);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);
		const finding: SastScanFinding = {
			rule_id: 'sast/js-eval',
			severity: 'high',
			message: 'Test finding',
			location: { file, line: 1 },
		};

		const result = await captureOrMergeBaseline(
			directory,
			1,
			[finding],
			'tier_a',
			[file],
			{ abortSignal: controller.signal },
		);

		expect(result).toEqual({
			status: 'error',
			message: 'SAST baseline capture cancelled',
		});
		expect(
			fs.existsSync(path.join(evidenceDirectory, 'sast-baseline.json')),
		).toBe(false);
	});
});
