import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, sastScan } from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalCheckSemgrepAvailable = _internals.checkSemgrepAvailable;
const tempDirectories: string[] = [];

afterEach(() => {
	_internals.checkSemgrepAvailable = originalCheckSemgrepAvailable;
	for (const directory of tempDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('SAST baseline cancellation', () => {
	test('F-004 does not publish a baseline after cancellation during lock retry', async () => {
		const directory = canonicalMkdtemp('sast-baseline-cancel-');
		tempDirectories.push(directory);
		const sourceFile = path.join(directory, 'safe.ts');
		fs.writeFileSync(sourceFile, 'export const safe = true;\n');
		const evidenceDirectory = path.join(directory, '.swarm', 'evidence', '1');
		fs.mkdirSync(evidenceDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDirectory, 'sast-baseline.json.lock'),
			'busy',
		);
		_internals.checkSemgrepAvailable = async () => false;
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 25);

		const result = await sastScan(
			{
				changed_files: [sourceFile],
				capture_baseline: true,
				phase: 1,
				abort_signal: controller.signal,
			},
			directory,
		);

		expect(result.error).toBe('SAST scan cancelled');
		expect(
			fs.existsSync(path.join(evidenceDirectory, 'sast-baseline.json')),
		).toBe(false);
	});
});
