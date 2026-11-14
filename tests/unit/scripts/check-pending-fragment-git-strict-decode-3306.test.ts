/**
 * Final-critic round 1 regression (collated #3306): the `main()` git path
 * must decode git's `-z` diff listings byte-strictly, exactly like the
 * --print-requirement readers — a repository path that is not valid UTF-8
 * is an infrastructure-shaped failure (fail closed through the #3283
 * envelope), never a silently U+FFFD-substituted token that classifies.
 *
 * Drives main() in-process through the _internals.spawnSync seam: the mock
 * answers rev-parse/merge-base normally and emits the invalid bytes from
 * the `diff --name-only -z` listing.
 */

import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';

import { _internals, main } from '../../../scripts/check-pending-fragment.ts';

describe('check-pending-fragment main() strict git decode (3306 final critic)', () => {
	test('a non-UTF-8 path in the git diff listing fails closed with the undecodable-output message', () => {
		const realSpawn = _internals.spawnSync;
		try {
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
			// Fail-closed envelope: FRAGMENT_CHECK_ENFORCE defaults to on, so
			// an infrastructure-shaped failure exits 1 with the operator
			// message (never a verdict over substituted bytes).
			expect(rc).toBe(1);
		} finally {
			_internals.spawnSync = realSpawn;
		}
	});
});
