import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/services/preflight-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Regression tests for issue #1662 (hardened per issue #2242, superseding
 * PR #2188): the req_coverage preflight gate used to pass on the mere
 * existence of `.swarm/evidence/req-coverage-phase-{N}.json` and never
 * validated the report's content. The gate must now fail on an empty,
 * unparseable, wrong-shape, oversized, or incomplete
 * (missingCount > 0 / totalRequirements === 0 / count-inconsistent /
 * phase-mismatched / success:false) report, and only pass on a genuinely
 * complete report produced by the req_coverage tool.
 *
 * #2242 hardens #2188's proposed gate further: the runtime previously
 * destructured only 3 of 6 schema fields, so `success: false` (F-1),
 * count-inconsistent (F-2), requirements-length-inconsistent (F-5), and
 * phase-mismatched (F-15) reports slipped through as passes. The JSON.parse
 * failure branch also discarded the underlying parse error (F-7).
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

	function validReport(overrides: Record<string, unknown> = {}) {
		return {
			success: true,
			phase: 1,
			totalRequirements: 2,
			coveredCount: 2,
			missingCount: 0,
			requirements: [
				{ id: 'FR-001', status: 'covered' },
				{ id: 'FR-002', status: 'covered' },
			],
			...overrides,
		};
	}

	// --- Ported from PR #2188's 11-scenario suite ---

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
			JSON.stringify(
				validReport({
					coveredCount: 0,
					missingCount: 2,
					requirements: [
						{ id: 'FR-001', status: 'missing' },
						{ id: 'FR-002', status: 'missing' },
					],
				}),
			),
		);

		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.status).toBe('fail');
		expect(result.message).toContain('uncovered requirement');
		expect(result.message).toContain('2');
		expect(result.details?.missingCount).toBe(2);
	});

	test('fails on a report with totalRequirements === 0 while a spec exists', async () => {
		writeReport(
			JSON.stringify(
				validReport({
					totalRequirements: 0,
					coveredCount: 0,
					missingCount: 0,
					requirements: [],
				}),
			),
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
		writeReport(JSON.stringify(validReport()));

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
		writeReport(JSON.stringify(validReport({ phase: 2 })));
		fs.renameSync(
			reportPath,
			path.join(evidenceDir, 'req-coverage-phase-2.json'),
		);

		const result = await _internals.runRequirementCoverageCheck(testDir, 1);

		expect(result.status).toBe('fail');
		expect(result.message).toContain('missing but effective spec exists');
	});

	// --- #2242 hardening regressions (finding-ID-labeled) ---

	describe('req_coverage gate — regression: success:false slipped through as a pass (F-1)', () => {
		test('fails when the report declares success:false even though counts look complete', async () => {
			// Previous code destructured only totalRequirements/coveredCount/
			// missingCount from the parsed report and never checked `success`,
			// so a writer-declared failure (success: false) with otherwise
			// consistent counts still reached the unconditional pass branch.
			writeReport(JSON.stringify(validReport({ success: false })));

			const result = await _internals.runRequirementCoverageCheck(testDir, 1);

			expect(result.status).toBe('fail');
			expect(result.message.toLowerCase()).toContain('success');
		});
	});

	describe('req_coverage gate — regression: coveredCount + missingCount !== totalRequirements slipped through (F-2)', () => {
		test('fails when covered+missing counts do not sum to totalRequirements', async () => {
			// Previous code never cross-checked coveredCount + missingCount
			// against totalRequirements, so an internally inconsistent report
			// (e.g. counts that don't add up) still passed the gate.
			writeReport(
				JSON.stringify(
					validReport({
						totalRequirements: 3,
						coveredCount: 2,
						missingCount: 0,
					}),
				),
			);

			const result = await _internals.runRequirementCoverageCheck(testDir, 1);

			expect(result.status).toBe('fail');
			expect(result.message.toLowerCase()).toContain('count');
		});
	});

	describe('req_coverage gate — regression: requirements.length !== totalRequirements slipped through (F-5)', () => {
		test('fails when the requirements array length does not match totalRequirements', async () => {
			// Previous code never checked requirements.length against
			// totalRequirements, so a report claiming N total requirements
			// while shipping a requirements array of a different length still
			// passed the gate (includes the empty-requirements-with-positive-
			// total case, F-13, a duplicate of this finding).
			writeReport(
				JSON.stringify(
					validReport({
						totalRequirements: 2,
						coveredCount: 2,
						missingCount: 0,
						requirements: [{ id: 'FR-001', status: 'covered' }],
					}),
				),
			);

			const result = await _internals.runRequirementCoverageCheck(testDir, 1);

			expect(result.status).toBe('fail');
			expect(result.message.toLowerCase()).toContain('requirements');
		});
	});

	describe('req_coverage gate — regression: phase !== currentPhase slipped through (F-15)', () => {
		test('fails when the report content phase differs from the requested phase', async () => {
			// Previous code never verified the report's own `phase` field
			// against the phase the gate was invoked for, so a stale report
			// (e.g. left over from phase 2, then copied/renamed to the
			// phase-1 filename) still passed as if it were current.
			writeReport(JSON.stringify(validReport({ phase: 2 })));

			const result = await _internals.runRequirementCoverageCheck(testDir, 1);

			expect(result.status).toBe('fail');
			expect(result.message.toLowerCase()).toContain('phase');
		});
	});

	describe('req_coverage gate — regression: JSON.parse error message discarded (F-7)', () => {
		test('fails with a message that includes the underlying parse error text', async () => {
			// Previous code caught the JSON.parse exception and discarded its
			// message entirely, always emitting the generic
			// 'Requirement coverage report is not valid JSON' with no detail
			// about why parsing failed.
			writeReport('{ not valid json !!!');

			const result = await _internals.runRequirementCoverageCheck(testDir, 1);

			let expectedParseErrorMessage = '';
			try {
				JSON.parse('{ not valid json !!!');
			} catch (err) {
				expectedParseErrorMessage =
					err instanceof Error ? err.message : String(err);
			}

			expect(result.status).toBe('fail');
			expect(expectedParseErrorMessage.length).toBeGreaterThan(0);
			expect(result.message).toContain(expectedParseErrorMessage);
		});
	});

	describe('req_coverage gate — regression: non-integer/negative count fields accepted by shape validation', () => {
		test('fails when a count field is a negative number', async () => {
			writeReport(
				JSON.stringify(validReport({ coveredCount: -1, missingCount: 3 })),
			);

			const result = await _internals.runRequirementCoverageCheck(testDir, 1);

			expect(result.status).toBe('fail');
			expect(result.message).toContain('expected report shape');
		});

		test('fails when a count field is a non-integer float', async () => {
			writeReport(
				JSON.stringify(validReport({ coveredCount: 1.5, missingCount: 0.5 })),
			);

			const result = await _internals.runRequirementCoverageCheck(testDir, 1);

			expect(result.status).toBe('fail');
			expect(result.message).toContain('expected report shape');
		});

		test('fails when phase is a negative number', async () => {
			writeReport(JSON.stringify(validReport({ phase: -1 })));

			const result = await _internals.runRequirementCoverageCheck(testDir, 1);

			expect(result.status).toBe('fail');
			expect(result.message).toContain('expected report shape');
		});
	});

	describe('req_coverage gate — multi-defect precedence: success:false wins over phase-mismatch and count-inconsistency', () => {
		test('reports the success:false failure message, not the phase or count failure, on a simultaneously-multi-defect report', async () => {
			// Pins the documented fail-branch precedence: success===false (F-1)
			// is checked before phase!==currentPhase (F-15), before
			// totalRequirements===0, before coveredCount+missingCount!==total
			// (F-2), before requirements.length!==total (F-5), before
			// missingCount>0. A report that is simultaneously success:false,
			// phase-mismatched, AND count-inconsistent must fail with the
			// success:false message.
			writeReport(
				JSON.stringify({
					success: false,
					phase: 2, // mismatched vs requested phase 1
					totalRequirements: 5,
					coveredCount: 1, // 1 + 1 !== 5 → count-inconsistent
					missingCount: 1,
					requirements: [], // also length-inconsistent vs totalRequirements
				}),
			);

			const result = await _internals.runRequirementCoverageCheck(testDir, 1);

			expect(result.status).toBe('fail');
			expect(result.message.toLowerCase()).toContain('success');
			expect(result.message.toLowerCase()).not.toContain('phase');
			expect(result.message.toLowerCase()).not.toContain('count');
		});
	});

	describe('req_coverage gate — regression: unreadable report file (EISDIR/fs.promises.readFile error)', () => {
		test('fails when report path exists as a directory and readFile throws EISDIR', async () => {
			// fs.access may report exists:true, but when the report path is a
			// directory instead of a file, fs.promises.readFile() throws EISDIR
			// (or equivalent platform error). The gate must catch this in the
			// readError branch (src/services/preflight-service.ts:806-816) and
			// fail with an unreadable message. Regression test for the branch
			// coverage gap that left this error unhandled.
			fs.mkdirSync(reportPath);

			const result = await _internals.runRequirementCoverageCheck(testDir, 1);

			expect(result.status).toBe('fail');
			expect(result.message.toLowerCase()).toContain('unreadable');
		});
	});
});
