/**
 * #3661 AC1 — capture-required-check-evidence argv handling is strict.
 *
 * `main()` must reject unknown argv BEFORE any capture work and before any
 * write: an unrecognized flag (or a supported flag in an unsupported
 * `--flag=value` spelling) exits 2 and never reaches the capture path.
 *
 * At the current code both spellings fall through into `runCapture` (the argv
 * is only scanned for the exact token `--output`), so an unknown flag either
 * throws through the un-stubbed API seam or — worse — performs a full
 * capture; neither may exit 2 with nothing written. This test is RED at the
 * current code (the unknown-flag call throws out of `main`, and the
 * `--output=` call proceeds into the capture path).
 */

import { describe, expect, test } from 'bun:test';
import {
	_internals,
	main as captureMain,
} from '../../../scripts/capture-required-check-evidence';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

describe('capture-required-check-evidence strict argv (#3661 AC1)', () => {
	test('an unknown flag and a --output=<path> spelling both exit 2 without capturing or writing', () => {
		const root = canonicalMkdtemp('capture-argv-strict-3661-');
		const originalGhApi = _internals.ghApi;
		const originalWrite = _internals.writeArtifactAtomic;
		const writes: string[] = [];
		// Any capture attempt must be loud: the stub throws instead of serving
		// fixture data, so a fall-through into runCapture fails the leg for the
		// right reason instead of silently succeeding.
		_internals.ghApi = (() => {
			throw new Error('argv validation must refuse before any gh api call');
		}) as typeof _internals.ghApi;
		_internals.writeArtifactAtomic = ((target: string) => {
			writes.push(target);
		}) as typeof _internals.writeArtifactAtomic;
		try {
			expect(captureMain(['--totally-unknown-flag'], root)).toBe(2);
			expect(captureMain(['--output=<path>'], root)).toBe(2);
			expect(writes).toEqual([]);
		} finally {
			_internals.ghApi = originalGhApi;
			_internals.writeArtifactAtomic = originalWrite;
			removeTreeWithRetry(root);
		}
	}, 10_000);

	// C12 (critic amendment): strictness must be shape-complete — a
	// case-variant flag spelling is NOT `--dry-run`, and a stray positional is
	// not a valid invocation either. Both must exit 2 before any capture work.
	test('C12: a case-variant flag and a stray positional both exit 2 without capturing or writing', () => {
		const root = canonicalMkdtemp('capture-argv-strict-3661-c12-');
		const originalGhApi = _internals.ghApi;
		const originalWrite = _internals.writeArtifactAtomic;
		const writes: string[] = [];
		_internals.ghApi = (() => {
			throw new Error('argv validation must refuse before any gh api call');
		}) as typeof _internals.ghApi;
		_internals.writeArtifactAtomic = ((target: string) => {
			writes.push(target);
		}) as typeof _internals.writeArtifactAtomic;
		try {
			// RED at the current code: '--Dry-Run' misses the exact-token
			// `--dry-run` scan and falls into runCapture (throws through main);
			// 'stray-positional' is never inspected at all.
			expect(captureMain(['--Dry-Run'], root)).toBe(2);
			expect(captureMain(['stray-positional'], root)).toBe(2);
			expect(writes).toEqual([]);
		} finally {
			_internals.ghApi = originalGhApi;
			_internals.writeArtifactAtomic = originalWrite;
			removeTreeWithRetry(root);
		}
	}, 10_000);
});
