/**
 * #3664 final-critic round-1 regression: a fully-read child whose output
 * EXCEEDS the byte cap was completely observed — the reader drains the
 * stream to EOF and the exit code is known — so the byte-cap `truncated`
 * flag (which means the SAVED log is bounded) must NOT feed the
 * output_truncated derivation. Executed CI evidence: three real passing
 * test files exceed the 64 KiB cap; folding the flag in failed them.
 */
import { expect, test } from 'bun:test';
import path from 'node:path';
import {
	validateRepository,
	_internals as validationInternals,
} from '../../../../scripts/ci/repository-validation';

test('an exit-0 child whose output exceeds the byte cap records passed (final-critic #3664)', async () => {
	// Real child, real readers, tiny cap: the child writes more than the
	// cap and exits 0. Cleanup succeeds (direct child exits; nothing
	// inherits the pipe). Expectation: status `passed` — the observation
	// was complete (EOF reached), only the saved log is bounded.
	const report = await validateRepository({
		root: path.resolve('.'),
		mode: 'full',
		testFiles: [
			path.resolve('tests/unit/scripts/ci/fixtures/output-cap-writer-3664.ts'),
		],
		perItemTimeoutMs: 30_000,
		suiteTimeoutMs: 60_000,
		maxOutputBytes: 1024,
	});
	const row = report.results[0];
	expect(row?.exitCode).toBe(0);
	expect(row?.status).toBe('passed');
	expect(row?.reason).toBeUndefined();
	// The saved log is bounded at the cap — disclosed by the bound, not
	// by the terminal.
	expect(Buffer.byteLength(row?.stdout ?? '', 'utf8')).toBeLessThanOrEqual(
		1024,
	);
}, 60_000);
