/**
 * pre_check_batch boundary-bypass fail-fast + secretscan evidence parity —
 * issue #2209.
 *
 * 1. Boundary bypass: when invoked with `directory === workspaceDir` (the
 *    CLI-from-a-subdirectory shape), `isAcceptedProjectRootForPlatform`'s
 *    equality branch skips the explicit-boundary check, so a boundary-less
 *    subdirectory of an existing Swarm project used to pass validation and
 *    surface the violation only at evidence-write time — inconsistently
 *    (secretscan swallowed the error; sast_scan/quality_budget failed).
 *    runPreCheckBatch now reuses assertProjectRoot (unmodified) to fail fast
 *    BEFORE any tool executes.
 * 2. Secretscan evidence-write failures now fail the gate identically to
 *    sast_scan instead of being swallowed by a warn().
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	runPreCheckBatch,
	type ToolResult,
} from '../../../src/tools/pre-check-batch';
import {
	createNestedBoundaryFixture,
	type NestedBoundaryFixture,
	removeNestedBoundaryFixture,
} from '../../helpers/nested-project-boundary';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originals = { ..._internals };

function wrapped<T>(result: T): ToolResult<T> {
	return { ran: true, result, duration_ms: 0 };
}

function mockPassingTools(): void {
	_internals.runLintWrapped = (async () =>
		wrapped({ success: true })) as typeof _internals.runLintWrapped;
	_internals.runSecretscanWrapped = (async () =>
		wrapped({
			scan_dir: '.',
			findings: [],
			count: 0,
			files_scanned: 1,
			skipped_files: 0,
			incomplete_files: 0,
			incomplete_paths: [],
		})) as typeof _internals.runSecretscanWrapped;
	_internals.runSastScanWrapped = (async () =>
		wrapped({
			verdict: 'pass',
			findings: [],
			summary: {
				engine: 'tier_a',
				files_scanned: 1,
				findings_count: 0,
				findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
			},
		})) as typeof _internals.runSastScanWrapped;
	_internals.runQualityBudgetWrapped = (async () =>
		wrapped({
			verdict: 'pass',
			violations: [],
		})) as typeof _internals.runQualityBudgetWrapped;
	_internals.saveEvidence =
		(async () => ({})) as typeof _internals.saveEvidence;
}

beforeEach(() => {
	mockPassingTools();
});

afterEach(() => {
	Object.assign(_internals, originals);
});

describe('pre_check_batch boundary fail-fast (#2209)', () => {
	let fixture: NestedBoundaryFixture;

	beforeEach(() => {
		fixture = createNestedBoundaryFixture('git-directory');
		fs.writeFileSync(path.join(fixture.ordinary, 'changed.txt'), 'clean\n');
		fs.writeFileSync(path.join(fixture.outer, 'changed.txt'), 'clean\n');
		fs.writeFileSync(path.join(fixture.nested, 'changed.txt'), 'clean\n');
	});

	afterEach(() => {
		removeNestedBoundaryFixture(fixture);
	});

	test('boundary-less subdirectory of a Swarm project (directory === workspaceDir) fails fast before tools run', async () => {
		// CLI-cwd simulation: workspaceDir falls back to input.directory, so the
		// equality branch of isAcceptedProjectRootForPlatform passes — exactly
		// the #2209 bypass. assertProjectRoot must reject it BEFORE tools run.
		const result = await runPreCheckBatch(
			{ directory: fixture.ordinary, files: ['changed.txt'] },
			fixture.ordinary,
		);
		expect(result.batch_status).toBe('invalid');
		expect(result.gates_passed).toBe(false);
		// All four tools failed with the SAME root-cause error — no mixed
		// secretscan-silent / sast-hard-fail results, and no tool executed.
		expect(result.lint.ran).toBe(false);
		expect(result.secretscan.ran).toBe(false);
		expect(result.sast_scan.ran).toBe(false);
		expect(result.quality_budget.ran).toBe(false);
		const expectedMsg = `Cannot write runtime state in "${path.resolve(fixture.ordinary)}" — parent directory "${path.resolve(fixture.outer)}" already contains a .swarm/ folder. Runtime state must be written to the project root.`;
		expect(result.lint.error).toContain('already contains a .swarm/ folder');
		expect(result.secretscan.error).toBe(expectedMsg);
		expect(result.sast_scan.error).toBe(expectedMsg);
		expect(result.quality_budget.error).toBe(expectedMsg);
	});

	test('the Swarm project root itself still passes (regression guard)', async () => {
		const result = await runPreCheckBatch(
			{ directory: fixture.outer, files: ['changed.txt'] },
			fixture.outer,
		);
		expect(result.batch_status).not.toBe('invalid');
		expect(result.gates_passed).toBe(true);
	});

	test('a nested independent root (own .git marker) still passes', async () => {
		const result = await runPreCheckBatch(
			{ directory: fixture.nested, files: ['changed.txt'] },
			fixture.nested,
		);
		expect(result.batch_status).not.toBe('invalid');
		expect(result.gates_passed).toBe(true);
	});

	test('a standalone boundary-less directory with no .swarm ancestor still passes (rootless standalone preserved)', async () => {
		const standalone = canonicalMkdtemp('pcb-standalone-');
		try {
			fs.writeFileSync(path.join(standalone, 'changed.txt'), 'clean\n');
			const result = await runPreCheckBatch(
				{ directory: standalone, files: ['changed.txt'] },
				standalone,
			);
			expect(result.batch_status).not.toBe('invalid');
			expect(result.gates_passed).toBe(true);
		} finally {
			fs.rmSync(standalone, { recursive: true, force: true });
		}
	});
});

describe('pre_check_batch secretscan evidence persistence failure (#2209)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('pcb-evidence-fail-');
		fs.writeFileSync(path.join(tempDir, 'changed.txt'), 'clean\n');
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('a secretscan evidence write failure fails the gate identically to sast_scan', async () => {
		_internals.saveEvidence = (async () => {
			throw new Error('evidence disk full');
		}) as typeof _internals.saveEvidence;

		const result = await runPreCheckBatch(
			{ directory: tempDir, files: ['changed.txt'] },
			tempDir,
		);
		// The scan itself ran and found nothing; the persistence failure must
		// still fail the gate and surface on the payload (pre-#2209 this was a
		// warn() only and gates_passed stayed true).
		expect(result.secretscan.ran).toBe(true);
		expect(result.secretscan.error).toContain(
			'Failed to persist secretscan evidence',
		);
		expect(result.secretscan.error).toContain('evidence disk full');
		expect(result.gates_passed).toBe(false);
	});

	test('a successful secretscan evidence write leaves the gate unaffected', async () => {
		const result = await runPreCheckBatch(
			{ directory: tempDir, files: ['changed.txt'] },
			tempDir,
		);
		expect(result.secretscan.error).toBeUndefined();
		expect(result.gates_passed).toBe(true);
	});
});

describe('pre_check_batch SAST zero-coverage failure reason (#2210)', () => {
	let tempDir: string;
	let warnSpy: { mock: { calls: string[][] }; restore: () => void };

	beforeEach(() => {
		tempDir = canonicalMkdtemp('pcb-sast-zero-');
		fs.writeFileSync(path.join(tempDir, 'changed.xyz'), 'content\n');
		// warn() is gated behind OPENCODE_SWARM_DEBUG — enable it and capture
		// console.warn so the gate's failure reason is assertable.
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const calls: string[][] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			calls.push(args.map((a) => String(a)));
		};
		warnSpy = {
			mock: { calls },
			restore: () => {
				console.warn = originalWarn;
			},
		};
	});

	afterEach(() => {
		warnSpy.restore();
		delete process.env.OPENCODE_SWARM_DEBUG;
		Object.assign(_internals, originals);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function joinedWarns(): string {
		return warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
	}

	test('baseline mode surfaces the zero-coverage error, not "found new findings"', async () => {
		// Zero-coverage shape produced by sastScan on an empty/all-skipped
		// file set (issue #2210 repro payload): verdict fail, 0 findings,
		// and the #2210 error reason.
		_internals.runSastScanWrapped = (async () =>
			wrapped({
				verdict: 'fail',
				error:
					'SAST requires at least one file to scan; zero files were scanned',
				findings: [],
				new_findings: [],
				pre_existing_findings: [],
				baseline_used: true,
				summary: {
					engine: 'tier_a',
					files_scanned: 0,
					findings_count: 0,
					findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
				},
			})) as typeof _internals.runSastScanWrapped;

		const result = await runPreCheckBatch(
			{ directory: tempDir, files: ['changed.xyz'] },
			tempDir,
		);
		expect(result.gates_passed).toBe(false);
		// The gate-reason log carries the actual zero-coverage error (via the
		// result-level error branch), and the misleading "found new findings
		// above threshold" message is NOT emitted.
		expect(joinedWarns()).toContain(
			'SAST requires at least one file to scan; zero files were scanned',
		);
		expect(joinedWarns()).not.toContain(
			'SAST scan found new findings above threshold',
		);
	});

	test('a verdict-fail with no error field keeps the threshold message', async () => {
		_internals.runSastScanWrapped = (async () =>
			wrapped({
				verdict: 'fail',
				findings: [],
				new_findings: [],
				pre_existing_findings: [],
				baseline_used: true,
				summary: {
					engine: 'tier_a',
					files_scanned: 1,
					findings_count: 0,
					findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
				},
			})) as typeof _internals.runSastScanWrapped;

		const result = await runPreCheckBatch(
			{ directory: tempDir, files: ['changed.xyz'] },
			tempDir,
		);
		expect(result.gates_passed).toBe(false);
		expect(joinedWarns()).toContain(
			'SAST scan found new findings above threshold - GATE FAILED',
		);
	});
});
