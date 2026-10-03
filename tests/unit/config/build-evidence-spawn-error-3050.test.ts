/**
 * Issue #3050 — the `spawn_error` field must survive the evidence READ path.
 *
 * The `runs` element of `BuildEvidenceSchema` is a plain (strip-mode) zod
 * object, so a key the schema does not declare is silently dropped when a
 * bundle is re-read through `EvidenceBundleSchema.parse`
 * (`src/evidence/manager.ts:232`). That is why `spawn_error` is declared
 * optional on the schema rather than only on the TypeScript interface: without
 * it, persisted build evidence would lose the launch-failure distinction the
 * moment it was loaded back, while every behavioural test stayed green.
 *
 * The WRITE path is not what this pins — `validateEvidence`'s parse result is
 * discarded at `manager.ts:212`, so the first write already keeps the raw key.
 */
import { describe, expect, test } from 'bun:test';
import { BuildEvidenceSchema } from '../../../src/config/evidence-schema';

const baseRun = {
	kind: 'build' as const,
	command: 'npm run build',
	cwd: '/repo',
	exit_code: 1,
	duration_ms: 12,
	stdout_tail: '',
	stderr_tail: '',
};

function evidence(runs: unknown[]) {
	return {
		task_id: 'task-3050',
		type: 'build' as const,
		timestamp: '2026-10-03T12:00:00.000Z',
		agent: 'coder',
		verdict: 'fail' as const,
		summary: 'build check',
		runs,
		files_scanned: 3,
		runs_count: runs.length,
		failed_count: 1,
	};
}

describe('#3050: BuildEvidenceSchema keeps the launch-failure distinction', () => {
	test('a run carrying spawn_error survives the parse', () => {
		const parsed = BuildEvidenceSchema.parse(
			evidence([{ ...baseRun, spawn_error: 'spawn ENOENT missing-toolchain' }]),
		);
		expect(parsed.runs[0]!.spawn_error).toBe('spawn ENOENT missing-toolchain');
		expect(parsed.runs[0]!.exit_code).toBe(1);
	});

	test('a run without spawn_error stays field-free', () => {
		const parsed = BuildEvidenceSchema.parse(evidence([baseRun]));
		expect('spawn_error' in parsed.runs[0]!).toBe(false);
		expect(parsed.runs[0]!.exit_code).toBe(1);
	});

	test('an empty-string spawn_error is still preserved, not dropped', () => {
		// The writer guards on `spawnError?.message`, so an empty string should
		// never reach persisted evidence. If one somehow did, the property that
		// matters for this guardrail is that the key is NOT silently stripped on
		// the read path — that stripping is the failure mode being pinned.
		const parsed = BuildEvidenceSchema.parse(
			evidence([{ ...baseRun, spawn_error: '' }]),
		);
		expect(parsed.runs[0]!.spawn_error).toBe('');
	});
});
