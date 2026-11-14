/**
 * Final-critic round 1 regression (collated #3306): the `main()` git path
 * must decode git's `-z` diff listings byte-strictly, exactly like the
 * --print-requirement readers — a repository path that is not valid UTF-8
 * is an infrastructure-shaped failure (fail closed through the #3283
 * envelope), never a silently U+FFFD-substituted token that classifies.
 *
 * Drives main() in-process through the _internals.spawnSync seam: the mock
 * answers rev-parse/merge-base normally and emits the invalid bytes from
 * the `diff --name-only -z` listing. Pins BOTH the fail-closed exit AND the
 * DISTINCT operator message (delta-review round 2, D-V1): 'git emitted
 * non-UTF-8 bytes' — never 'spawn failed' (misdiagnosis) and never a
 * VIOLATION verdict.
 */

import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';

import { _internals, main } from '../../../scripts/check-pending-fragment.ts';

describe('check-pending-fragment main() strict git decode (3306 final critic)', () => {
	test('a non-UTF-8 path in the git diff listing fails closed with the undecodable-output message', () => {
		const realSpawn = _internals.spawnSync;
		const realError = console.error;
		const realEnforce = process.env.FRAGMENT_CHECK_ENFORCE;
		const errors: string[] = [];
		try {
			// Deterministic enforce-on regardless of the ambient shell.
			delete process.env.FRAGMENT_CHECK_ENFORCE;
			console.error = (...args: unknown[]) => {
				errors.push(args.map(String).join(' '));
			};
			_internals.spawnSync = ((options: any) => {
				const joined = options.cmd.join(' ');
				if (joined.includes('rev-parse')) {
					return {
						exitCode: 0,
						stdout: Buffer.from('a12b57b5\n'),
						stderr: Buffer.from(''),
					};
				}
				if (joined.includes('merge-base')) {
					return {
						exitCode: 0,
						stdout: Buffer.from('a12b57b5\n'),
						stderr: Buffer.from(''),
					};
				}
				if (joined.includes('diff') && joined.includes('-z')) {
					// 'src/x.ts\0docs/releases/pending/<0xFF>.md\0'
					return {
						exitCode: 0,
						stdout: Buffer.concat([
							Buffer.from('src/x.ts\0docs/releases/pending/'),
							Buffer.from([0xff]),
							Buffer.from('.md\0'),
						]),
						stderr: Buffer.from(''),
					};
				}
				return {
					exitCode: 0,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				};
			}) as typeof _internals.spawnSync;

			const rc = main(path.resolve(import.meta.dir, '..', '..', '..'));
			// Fail-closed envelope: enforce defaults to on, so an
			// infrastructure-shaped failure exits 1 (never a verdict over
			// substituted bytes).
			expect(rc).toBe(1);
			const logged = errors.join('\n');
			// The DISTINCT undecodable-output cause — not a spawn misdiagnosis
			// (delta-review mutant D-V1) and not an author-facing VIOLATION.
			expect(logged).toContain('git emitted non-UTF-8 bytes');
			expect(logged).not.toContain('spawn failed');
			expect(logged).not.toContain('VIOLATION');
		} finally {
			_internals.spawnSync = realSpawn;
			console.error = realError;
			if (realEnforce === undefined) {
				delete process.env.FRAGMENT_CHECK_ENFORCE;
			} else {
				process.env.FRAGMENT_CHECK_ENFORCE = realEnforce;
			}
		}
	});
});
