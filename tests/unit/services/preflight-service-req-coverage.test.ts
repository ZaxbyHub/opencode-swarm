import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/services/preflight-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Regression tests for issue #1662: the req_coverage preflight gate used to
 * pass on the mere existence of `.swarm/evidence/req-coverage-phase-{N}.json`
 * and never validated the report's content. The gate must now fail on an
 * empty, unparseable, wrong-shape, oversized, or incomplete
 * (missingCount > 0 / totalRequirements === 0) report, and only pass on a
 * genuinely complete report produced by the req_coverage tool.
 */
describe('Preflight Service req_coverage content validation', () => {
	let testDir: string;
	let evidenceDir: string;
	let reportPath: string;

	beforeEach(() => {
		testDir = canonicalMkdtemp('preflight-req-coverage-');
		fs.mkdirSync(path.join(testDir, '.swarm', 'evidence'), {
			recursive: true,
		});
		// Effective spec present → the req_coverage gate is required.
		fs.writeFileSync(
			path.join(testDir, '.swarm', 'spec.md'),
			'# Test Spec\n\nFR-001 MUST be covered by implementation evidence.\nFR-002 SHOULD be covered by documentation.\n',
		);
		evidenceDir = path.join(testDir, '.swarm', 'evidence');
		reportPath = path.join(evidenceDir, 'req-coverage-phase-1.json');
	});

	afterEach(() => {
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	function writeReport(content: string): void {
		fs.writeFileSync(reportPath, content);
	}

	test('fails on an empty report file (existence alone is not enough)', async () => {
		writeReport('');

		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.type).toBe('req_coverage');
		expect(result.status).toBe('fail');
		expect(result.message).toContain('empty');
	});

	test('fails on whitespace-only report file', async () => {
		writeReport('   \n\t\n');

		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.status).toBe('fail');
		expect(result.message).toContain('empty');
	});

	test('fails on unparseable (malformed JSON) report', async () => {
		writeReport('{ not valid json !!!');

		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.status).toBe('fail');
		expect(result.message).toContain('not valid JSON');
	});

	test('fails on a report that does not match the report shape', async () => {
		writeReport(JSON.stringify({ unrelated: 'payload' }));

		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.status).toBe('fail');
		expect(result.message).toContain('expected report shape');
	});

	test('fails on a report with missingCount > 0', async () => {
		writeReport(
			JSON.stringify({
				success: true,
				phase: 1,
				totalRequirements: 2,
				coveredCount: 0,
				missingCount: 2,
				requirements: [],
			}),
		);

		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.status).toBe('fail');
		expect(result.message).toContain('uncovered requirement');
		expect(result.message).toContain('2');
		expect(result.details?.missingCount).toBe(2);
	});

	test('fails on a report with totalRequirements === 0 while a spec exists', async () => {
		writeReport(
			JSON.stringify({
				success: true,
				phase: 1,
				totalRequirements: 0,
				coveredCount: 0,
				missingCount: 0,
				requirements: [],
			}),
		);

		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.status).toBe('fail');
		expect(result.message).toContain('totalRequirements is 0');
	});

	test('fails on a report exceeding the read cap', async () => {
		writeReport(`${'a'.repeat(500 * 1024 + 1)}`);

		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.status).toBe('fail');
		expect(result.message).toContain('cannot be validated');
	});

	test('passes on a genuinely complete, valid report', async () => {
		writeReport(
			JSON.stringify({
				success: true,
				phase: 1,
				totalRequirements: 2,
				coveredCount: 2,
				missingCount: 0,
				requirements: [
					{
						id: 'FR-001',
						obligation: 'MUST',
						text: 'be covered by implementation evidence.',
						status: 'covered',
						filesSearched: [],
					},
					{
						id: 'FR-002',
						obligation: 'SHOULD',
						text: 'be covered by documentation.',
						status: 'covered',
						filesSearched: [],
					},
				],
			}),
		);

		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.type).toBe('req_coverage');
		expect(result.status).toBe('pass');
		expect(result.message).toContain('2/2');
		expect(result.details?.totalRequirements).toBe(2);
		expect(result.details?.coveredCount).toBe(2);
		expect(result.details?.missingCount).toBe(0);
	});

	test('still skips when no effective spec exists', async () => {
		fs.rmSync(path.join(testDir, '.swarm', 'spec.md'));

		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.status).toBe('skip');
		expect(result.message).toContain('No effective spec found');
	});

	test('still fails when the report is missing but a spec exists', async () => {
		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.status).toBe('fail');
		expect(result.message).toContain('missing but effective spec exists');
	});

	test('fails when only a different phase report exists', async () => {
		writeReport(
			JSON.stringify({
				success: true,
				phase: 2,
				totalRequirements: 2,
				coveredCount: 2,
				missingCount: 0,
				requirements: [],
			}),
		);
		fs.renameSync(
			reportPath,
			path.join(evidenceDir, 'req-coverage-phase-2.json'),
		);

		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.status).toBe('fail');
		expect(result.message).toContain('missing but effective spec exists');
	});
});
