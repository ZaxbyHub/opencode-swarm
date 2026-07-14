import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals, sastScan } from '../../../src/tools/sast-scan';

const originalIsSemgrepAvailable = _internals.isSemgrepAvailable;
const originalRunSemgrep = _internals.runSemgrep;

let directory: string;
let discoveryCalls: number;
let semgrepRunCalls: number;

beforeEach(() => {
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'sast-offline-')),
	);
	discoveryCalls = 0;
	semgrepRunCalls = 0;
	_internals.isSemgrepAvailable = () => {
		discoveryCalls++;
		return true;
	};
	_internals.runSemgrep = async () => {
		semgrepRunCalls++;
		return {
			available: true,
			engine: 'tier_a+tier_b',
			findings: [
				{
					rule_id: 'semgrep/should-not-run',
					severity: 'critical',
					message: 'offline mode reached Semgrep',
					location: { file: 'offline.js', line: 1 },
				},
			],
		};
	};
});

afterEach(() => {
	_internals.isSemgrepAvailable = originalIsSemgrepAvailable;
	_internals.runSemgrep = originalRunSemgrep;
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('sastScan offline_only', () => {
	test('runs Tier A without probing for or invoking Semgrep', async () => {
		const file = path.join(directory, 'offline.js');
		fs.writeFileSync(file, 'const code = userInput;\neval(code);');

		const result = await sastScan(
			{
				changed_files: [file],
				offline_only: true,
			},
			directory,
		);

		expect(discoveryCalls).toBe(0);
		expect(semgrepRunCalls).toBe(0);
		expect(result.summary.engine).toBe('tier_a');
		expect(result.summary.files_scanned).toBe(1);
		expect(
			result.findings.some((finding) => finding.rule_id === 'sast/js-eval'),
		).toBe(true);
		expect(
			result.findings.some(
				(finding) => finding.rule_id === 'semgrep/should-not-run',
			),
		).toBe(false);
	});

	test('keeps the existing Semgrep path enabled when offline_only is absent', async () => {
		const file = path.join(directory, 'online.js');
		fs.writeFileSync(file, 'const safe = true;');

		const result = await sastScan({ changed_files: [file] }, directory);

		expect(discoveryCalls).toBe(1);
		expect(semgrepRunCalls).toBe(1);
		expect(result.summary.engine).toBe('tier_a+tier_b');
		expect(
			result.findings.some(
				(finding) => finding.rule_id === 'semgrep/should-not-run',
			),
		).toBe(true);
	});
});
