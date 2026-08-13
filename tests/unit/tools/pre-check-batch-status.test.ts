import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decodePreCheckResult } from '../../../src/hooks/guardrails/pre-check-result';
import {
	_internals,
	type PreCheckBatchResult,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function oversizedResult(
	gatesPassed: boolean,
	detail: string,
): PreCheckBatchResult {
	const toolResult = {
		ran: true,
		duration_ms: 1,
		result: { detail },
	};
	return {
		batch_status: 'completed',
		gates_passed: gatesPassed,
		lint: toolResult,
		secretscan: toolResult,
		sast_scan: toolResult,
		quality_budget: toolResult,
		total_duration_ms: 4,
	} as unknown as PreCheckBatchResult;
}

test('producer labels an intentionally non-running batch as skipped', async () => {
	const directory = canonicalMkdtemp('pre-check-batch-status-');
	fs.writeFileSync(
		path.join(directory, 'test.ts'),
		'export const value = 1;\n',
	);

	const originals = {
		runLintWrapped: _internals.runLintWrapped,
		runSecretscanWrapped: _internals.runSecretscanWrapped,
		runSastScanWrapped: _internals.runSastScanWrapped,
		runQualityBudgetWrapped: _internals.runQualityBudgetWrapped,
		saveEvidence: _internals.saveEvidence,
	};
	const skipped = async () => ({
		ran: false as const,
		error: 'tool intentionally unavailable',
		duration_ms: 1,
	});

	try {
		_internals.runLintWrapped = skipped;
		_internals.runSecretscanWrapped = skipped;
		_internals.runSastScanWrapped = skipped;
		_internals.runQualityBudgetWrapped = skipped;
		_internals.saveEvidence = async () => undefined;

		const result = await runPreCheckBatch({
			files: ['test.ts'],
			directory,
		});

		expect(result.batch_status).toBe('skipped');
		expect(result.gates_passed).toBe(false);
		expect(
			[
				result.lint,
				result.secretscan,
				result.sast_scan,
				result.quality_budget,
			].every((toolResult) => toolResult.ran === false),
		).toBe(true);
	} finally {
		_internals.runLintWrapped = originals.runLintWrapped;
		_internals.runSecretscanWrapped = originals.runSecretscanWrapped;
		_internals.runSastScanWrapped = originals.runSastScanWrapped;
		_internals.runQualityBudgetWrapped = originals.runQualityBudgetWrapped;
		_internals.saveEvidence = originals.saveEvidence;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('serializer compacts combined diagnostics while preserving a failed verdict', () => {
	const serialized = _internals.serializePreCheckResult(
		oversizedResult(false, 'x'.repeat(_internals.MAX_COMBINED_BYTES)),
	);
	const parsed = JSON.parse(serialized) as Record<string, unknown>;

	expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(
		_internals.MAX_COMBINED_BYTES,
	);
	expect(parsed.output_truncated).toBe(true);
	expect(decodePreCheckResult(serialized)).toEqual({
		kind: 'fail',
		code: 'PRE_CHECK_FAILED',
	});
});

test('serializer measures multibyte diagnostics in UTF-8 bytes and preserves a pass', () => {
	const multibyteDetail = '🔐'.repeat(
		Math.floor(_internals.MAX_COMBINED_BYTES / 4),
	);
	const serialized = _internals.serializePreCheckResult(
		oversizedResult(true, multibyteDetail),
	);
	const parsed = JSON.parse(serialized) as Record<string, unknown>;

	expect(multibyteDetail.length).toBeLessThan(_internals.MAX_COMBINED_BYTES);
	expect(Buffer.byteLength(multibyteDetail, 'utf8')).toBe(
		_internals.MAX_COMBINED_BYTES,
	);
	expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(
		_internals.MAX_COMBINED_BYTES,
	);
	expect(parsed.output_truncated).toBe(true);
	const secretscan = parsed.secretscan as Record<string, unknown>;
	// F-010 prior behavior mislabeled a successful omitted result as an error.
	expect(secretscan.error).toBeUndefined();
	expect(secretscan.result_omitted).toBe(true);
	expect(decodePreCheckResult(serialized)).toEqual({ kind: 'pass' });
});
