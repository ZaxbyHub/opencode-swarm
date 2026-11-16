/**
 * scope_validate × non-canonical interpreter spelling — the
 * implementation-review round-1 finding-2 leg (plan U6/r2-5 disposition).
 *
 * scope_validate consumes detectPosixWrites + resolveWriteTargets, so the
 * #3343 normalization changes its verdicts BY DESIGN: a non-canonical inline
 * eval (`env python3.12 -c …`) that previously passed through as an
 * UNDETECTED write (allowed, zero targets) is now detected as a capability
 * eval and resolved against the scope. These legs pin that seam so a future
 * regression silencing the eval on the scope_validate path goes RED:
 * - the non-canonical eval spellings now fail closed with the SAME
 *   UNRESOLVED_TARGET verdict a canonical `python -c` always produced
 *   (base behavior for the non-canonical spellings: allowed, undetected);
 * - a non-eval non-canonical invocation stays allowed (control).
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateScopeValidate } from '../../../src/tools/scope-validate';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const root = canonicalMkdtemp('scope-validate-eval-');
mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, 'src', 'note.md'), 'before\n', 'utf8');

describe('scope_validate non-canonical eval verdicts (#3343 integration)', () => {
	// scope_validate's own contract for a detected null-target write is the
	// fail-closed UNRESOLVED_TARGET throw (src/tools/scope-validate.ts ~:187)
	// — the same verdict a canonical `python -c` has always produced. The
	// #3343 change this pins: the NON-canonical spelling now reaches that
	// verdict instead of passing through as an undetected write (base:
	// allowed, zero targets).
	test('env python3.12 -c now fails closed like canonical python -c (UNRESOLVED_TARGET)', () => {
		for (const command of [
			`env python3.12 -c "print(1)"`,
			`/usr/bin/python3 -c "print(1)"`,
			`python3.11 -c "print(1)"`,
		]) {
			expect(() =>
				evaluateScopeValidate(
					{ command, shell: 'posix', scope_files: ['src/'] },
					root,
				),
			).toThrow(/UNRESOLVED_TARGET/);
		}
	});

	test('non-eval non-canonical invocations stay allowed (control)', () => {
		const result = evaluateScopeValidate(
			{
				command: 'python3.11 --version',
				shell: 'posix',
				scope_files: ['src/'],
			},
			root,
		);
		expect(result.allowed).toBe(true);
		expect(result.targets).toEqual([]);
	});
});
