import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type SecretscanEvidence,
	SecretscanEvidenceSchema,
} from '../../../src/config/evidence-schema';
import {
	_internals,
	runPreCheckBatch,
	type ToolResult,
} from '../../../src/tools/pre-check-batch';
import type {
	SecretscanErrorResult,
	SecretscanResult,
} from '../../../src/tools/secretscan';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originals = { ..._internals };
let tempDir: string;
let savedEvidence: SecretscanEvidence[];
let savedSignals: Array<AbortSignal | undefined>;

function wrapped<T>(result: T): ToolResult<T> {
	return { ran: true, result, duration_ms: 0 };
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('precheck-secret-evidence-');
	fs.writeFileSync(path.join(tempDir, 'changed.txt'), 'clean\n');
	savedEvidence = [];
	savedSignals = [];

	_internals.runLintWrapped = (async () =>
		wrapped({ success: true })) as typeof _internals.runLintWrapped;
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
	_internals.saveEvidence = (async (
		_directory: string,
		_taskId: string,
		evidence: SecretscanEvidence,
		abortSignal?: AbortSignal,
	) => {
		savedSignals.push(abortSignal);
		abortSignal?.throwIfAborted();
		savedEvidence.push(evidence);
		return {};
	}) as typeof _internals.saveEvidence;
});

afterEach(() => {
	Object.assign(_internals, originals);
	fs.rmSync(tempDir, { recursive: true, force: true });
});

async function executeWith(
	result: ToolResult<SecretscanResult | SecretscanErrorResult>,
	abortSignal?: AbortSignal,
) {
	_internals.runSecretscanWrapped = (async () =>
		result) as typeof _internals.runSecretscanWrapped;
	return runPreCheckBatch(
		{ directory: tempDir, files: ['changed.txt'] },
		undefined,
		undefined,
		abortSignal,
	);
}

describe('secretscan hard-gate evidence parity', () => {
	test('does not persist secretscan evidence after host cancellation', async () => {
		const controller = new AbortController();
		controller.abort();

		await executeWith(
			wrapped({
				scan_dir: tempDir,
				findings: [],
				count: 0,
				files_scanned: 1,
				skipped_files: 0,
				incomplete_files: 0,
				incomplete_paths: [],
			}),
			controller.signal,
		);

		expect(savedSignals).toEqual([controller.signal]);
		expect(savedEvidence).toHaveLength(0);
	});

	test('persists a failed verdict for a structured scanner error', async () => {
		const result = await executeWith(
			wrapped({
				error: 'read failure',
				scan_dir: tempDir,
				findings: [],
				count: 0,
				files_scanned: 0,
				skipped_files: 0,
			}),
		);

		expect(result.gates_passed).toBe(false);
		expect(savedEvidence).toHaveLength(1);
		expect(savedEvidence[0].verdict).toBe('fail');
		expect(savedEvidence[0].summary).toContain('read failure');
	});

	test('persists a failed verdict for a wrapper timeout', async () => {
		const result = await executeWith({
			ran: true,
			error: 'timed out',
			duration_ms: 60_000,
		});

		expect(result.gates_passed).toBe(false);
		expect(savedEvidence).toHaveLength(1);
		expect(savedEvidence[0].verdict).toBe('fail');
		expect(savedEvidence[0].summary).toContain('timed out');
	});

	test('persists a failed verdict for incomplete coverage', async () => {
		const result = await executeWith(
			wrapped({
				scan_dir: tempDir,
				findings: [],
				count: 0,
				files_scanned: 1,
				skipped_files: 1,
				incomplete_files: 1,
				incomplete_paths: [
					{
						path: path.join(tempDir, 'oversized.txt'),
						reason: 'oversized',
					},
				],
			}),
		);

		expect(result.gates_passed).toBe(false);
		expect(savedEvidence).toHaveLength(1);
		expect(savedEvidence[0].verdict).toBe('fail');
		expect(savedEvidence[0].summary).toContain('incomplete');
		expect(savedEvidence[0].incomplete_files).toBe(1);
		expect(savedEvidence[0].incomplete_paths).toEqual([
			{
				path: path.join(tempDir, 'oversized.txt'),
				reason: 'oversized',
			},
		]);
		expect(
			SecretscanEvidenceSchema.parse(savedEvidence[0]).incomplete_files,
		).toBe(1);
	});

	test('persists a failed verdict for zero requested-file coverage', async () => {
		const result = await executeWith(
			wrapped({
				scan_dir: tempDir,
				findings: [],
				count: 0,
				files_scanned: 0,
				skipped_files: 1,
				incomplete_files: 0,
				incomplete_paths: [],
			}),
		);

		expect(result.gates_passed).toBe(false);
		expect(savedEvidence).toHaveLength(1);
		expect(savedEvidence[0].verdict).toBe('fail');
		expect(savedEvidence[0].summary).toContain('zero requested files scanned');
	});

	test('fails closed when findings and count disagree', async () => {
		const result = await executeWith(
			wrapped({
				scan_dir: tempDir,
				findings: [
					{
						path: path.join(tempDir, 'changed.txt'),
						line: 1,
						type: 'stripe_key',
						confidence: 'high',
						severity: 'critical',
						redacted: '[REDACTED]',
						context: '[REDACTED]',
					},
				],
				count: 0,
				files_scanned: 1,
				skipped_files: 0,
				incomplete_files: 0,
				incomplete_paths: [],
			}),
		);

		expect(result.gates_passed).toBe(false);
		expect(savedEvidence[0].verdict).toBe('fail');
		expect(savedEvidence[0].findings_count).toBe(1);
		expect(savedEvidence[0].summary).toContain('mismatch');
	});
});
