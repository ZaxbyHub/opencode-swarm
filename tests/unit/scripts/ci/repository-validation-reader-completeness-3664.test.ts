/**
 * #3664 — a validation row must not record a clean `passed` on the strength
 * of an INCOMPLETE output reader.
 *
 * The contract is pinned DETERMINISTICALLY through the
 * `_internals.readBoundedWithStatus` seam (the derivation's input) and the
 * `_internals.killProcessTree` seam (the most adverse cleanup shape), plus
 * persisted attempt-history and verifier-terminal parity legs. A real-process
 * pipe-holding fixture variant was removed after CI proved the mechanism
 * non-portable: on ubuntu-latest the bun-test grandchild's inherited stdout
 * fd closes when the fixture's bun process exits, so the reader legitimately
 * observes EOF and the row is `passed` — that tests Linux/bun fd-inheritance
 * semantics, not the harness derivation (which the seam leg pins exactly and
 * mutation M2 killed three legs on).
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	exitCodeForValidationStatus,
	validateRepository,
} from '../../../../scripts/ci/repository-validation';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

describe('repository validation reader completeness — issue #3664', () => {
	// C9/C10 (critic amendment): deterministic seam-driven leg — no dependence
	// on the real pipe fixture. RED reasoning at the current code:
	// runDefaultProcess invokes the module-LOCAL readBoundedWithStatus for the
	// child's stdout/stderr readers (not `_internals.readBoundedWithStatus`),
	// so the completeness stub below has NO effect today, the quick fixture
	// reads complete, exits 0, and the row records 'passed' — the exact-terminal
	// assertion fails. After the fix routes the child readers through the
	// `_internals` seam (or otherwise honors reader completeness), both
	// channels report complete:false and the row must be the exact
	// 'output_truncated' terminal carrying a reason that names the channel and
	// its incompleteness, the run reports 'failed' with the row counted in the
	// failed counter, and the derived exit code is 1.
	test('C9/C10: incomplete reader stubs (both channels) yield the output_truncated terminal with a channel-naming reason', async () => {
		const QUICK_FIXTURE = path.resolve(
			'tests/unit/scripts/ci/fixtures/quick-pass-fixture.ts',
		);
		const originalRead = _internals.readBoundedWithStatus;
		const originalKillProcessTree = _internals.killProcessTree;
		_internals.readBoundedWithStatus = (async () => ({
			value: 'partial',
			truncated: false,
			complete: false,
		})) as typeof originalRead;
		_internals.killProcessTree = (async () =>
			true) as typeof originalKillProcessTree;
		try {
			const report = await validateRepository({
				root: path.resolve('.'),
				mode: 'full',
				testFiles: [QUICK_FIXTURE],
				perItemTimeoutMs: 2_000,
				suiteTimeoutMs: 10_000,
			});
			const row = report.results[0];
			expect(row).toBeDefined();
			// RED at the current code: the stub is ignored and the row is
			// 'passed'. The fix ships the exact 'output_truncated' terminal.
			expect(row?.status).toBe('output_truncated');
			// The reason must name the channel AND its incompleteness directly
			// (NOT via JSON.stringify(row), which is vacuous — every row carries
			// stdout/stderr keys).
			expect(String(row?.reason)).toMatch(/stdout|stderr/i);
			expect(String(row?.reason)).toMatch(/incomplete|truncat/i);
			// Run-level derivation: the output_truncated row fails the run.
			expect(report.status).toBe('failed');
			expect(report.summary.passed).toBe(0);
			expect(report.summary.failed).toBeGreaterThanOrEqual(1);
			// Exit-code leg: a failed validation run must exit 1.
			expect(exitCodeForValidationStatus(report.status)).toBe(1);
		} finally {
			_internals.readBoundedWithStatus = originalRead;
			_internals.killProcessTree = originalKillProcessTree;
		}
	}, 60_000);

	// C10 attempt-history leg: the persisted report must carry the
	// output_truncated row into the attempts history on a repeated run over
	// the same destination. Attempt history materializes ONLY through the
	// report-writing path (`writeValidationReport` reads the previous report
	// at the destination and `withPreviousAttemptHistory` appends
	// `validationAttempt(prior)` — scripts/ci/repository-validation.ts), so
	// this leg passes an explicit reportPath under a THROWAWAY root (copied
	// preload so the harness argv resolves) and reads the persisted JSON back.
	// RED at the current code at the first assertion (stub inert → 'passed').
	test('C10: a repeated run persists the output_truncated row into attempt history', async () => {
		const QUICK_FIXTURE = path.resolve(
			'tests/unit/scripts/ci/fixtures/quick-pass-fixture.ts',
		);
		const tmpRoot = canonicalMkdtemp('reader-completeness-attempts-3664-');
		fs.mkdirSync(path.join(tmpRoot, 'scripts', 'ci'), { recursive: true });
		fs.copyFileSync(
			path.resolve('scripts/ci/bun-32056-keepalive.ts'),
			path.join(tmpRoot, 'scripts', 'ci', 'bun-32056-keepalive.ts'),
		);
		// The harness argv is `bun --smol --preload <root>/... test <file> ...`;
		// bun resolves the bare `test` token through package.json scripts (the
		// repo root's own `"test": "bun test"`), so a throwaway root needs the
		// same script shim or the run fails with `Script not found "test"`
		// (executed probe) and the row reads 'failed' for the wrong reason.
		fs.writeFileSync(
			path.join(tmpRoot, 'package.json'),
			'{"name":"reader-completeness-fixture-root","private":true,"scripts":{"test":"bun test"}}',
		);
		const reportPath = path.join(
			tmpRoot,
			'.swarm',
			'repository-validation.json',
		);
		const originalRead = _internals.readBoundedWithStatus;
		const originalKillProcessTree = _internals.killProcessTree;
		_internals.readBoundedWithStatus = (async () => ({
			value: 'partial',
			truncated: false,
			complete: false,
		})) as typeof originalRead;
		_internals.killProcessTree = (async () =>
			true) as typeof originalKillProcessTree;
		try {
			const options = {
				root: tmpRoot,
				mode: 'full' as const,
				testFiles: [QUICK_FIXTURE],
				// Generous budgets: the throwaway root runs the fixture through
				// the package.json script shim (a second bun startup, ~2.5s cold
				// — executed probe), so the 2s warm-root budget would time the
				// row out for an unrelated reason. The terminal under test comes
				// from the reader stubs, not the clock.
				perItemTimeoutMs: 30_000,
				suiteTimeoutMs: 60_000,
				reportPath,
			};
			const first = await validateRepository(options);
			expect(first.results[0]?.status).toBe('output_truncated');
			const second = await validateRepository(options);
			expect(second.results[0]?.status).toBe('output_truncated');
			// The returned report object does not carry the merged history (the
			// merge happens inside writeValidationReport for the persisted
			// payload), so read the written artifact back.
			const persisted = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
				results?: Array<{
					status?: string;
					attempts?: Array<{ status?: string }>;
				}>;
			};
			const attempts = persisted.results[0]?.attempts ?? [];
			expect(attempts.length).toBe(1);
			expect(attempts[0]?.status).toBe('output_truncated');
		} finally {
			_internals.readBoundedWithStatus = originalRead;
			_internals.killProcessTree = originalKillProcessTree;
			removeTreeWithRetry(tmpRoot);
		}
	}, 60_000);

	// C10 report-verifier leg (source-pin form): the standalone verifier
	// (scripts/ci/verify-repository-validation-reports.ts) rejects any result
	// status outside its module-PRIVATE TERMINAL_STATUSES set and requires the
	// report's terminalStatuses array to match it exactly, so the fix must add
	// 'output_truncated' there too or every report the harness writes with the
	// new terminal fails verification. The constant is NOT exported
	// (_test_exports exposes only readBoundedText/readBoundedReport), and a
	// hermetic verifyReports() run needs artifact/inventory scaffolding
	// (expected-files inventory, artifact directories, report identity
	// matching) outside this battery's scope — hence the source-shape pin,
	// with that coverage gap noted for the implementation reviewer.
	test('C10: the standalone verifier accepts the output_truncated terminal', () => {
		const verifierSource = fs.readFileSync(
			path.resolve('scripts/ci/verify-repository-validation-reports.ts'),
			'utf-8',
		);
		const terminalSet = /TERMINAL_STATUSES = new Set\(\[([^\]]*)\]/.exec(
			verifierSource,
		);
		expect(terminalSet).not.toBeNull();
		expect(terminalSet?.[1]).toContain("'output_truncated'");
	}, 10_000);
});
