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

import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { _internals, main } from '../../../scripts/check-pending-fragment.ts';
import { runCli } from './_check-pending-fragment-cli-helpers';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Directories this process created (exact-list cleanup, #3308 pattern). */
const createdTempDirs: string[] = [];

afterAll(() => {
	for (const dir of createdTempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

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

	test('a BOM-prefixed fragment path does NOT satisfy the mandate (final-critic round 2)', () => {
		// The fatal decoder must PRESERVE the leading U+FEFF (ignoreBOM):
		// in git -z output those bytes are part of the PATH. With the BOM
		// stripped, '\uFEFFdocs/releases/pending/x.md' classified as a
		// pending fragment while the release aggregator can never collect
		// it (its filter requires the literal docs/ prefix) — a gate pass
		// with no release note.
		const realSpawn = _internals.spawnSync;
		const realError = console.error;
		const realEnforce = process.env.FRAGMENT_CHECK_ENFORCE;
		const errors: string[] = [];
		try {
			delete process.env.FRAGMENT_CHECK_ENFORCE;
			console.error = (...args: unknown[]) => {
				errors.push(args.map(String).join(' '));
			};
			_internals.spawnSync = ((options: any) => {
				const joined = options.cmd.join(' ');
				if (joined.includes('rev-parse') || joined.includes('merge-base')) {
					return {
						exitCode: 0,
						stdout: Buffer.from('a12b57b5\n'),
						stderr: Buffer.from(''),
					};
				}
				if (joined.includes('diff') && joined.includes('--diff-filter=A')) {
					return {
						exitCode: 0,
						// '<BOM>docs/releases/pending/x.md\0' — the BOM is
						// part of the added name.
						stdout: Buffer.concat([
							Buffer.from([0xef, 0xbb, 0xbf]),
							Buffer.from('docs/releases/pending/x.md\0'),
						]),
						stderr: Buffer.from(''),
					};
				}
				if (joined.includes('diff') && joined.includes('-z')) {
					return {
						exitCode: 0,
						// One user-visible change; the only added file is
						// the BOM-prefixed pseudo-fragment.
						stdout: Buffer.concat([
							Buffer.from('src/index.ts\0'),
							Buffer.from([0xef, 0xbb, 0xbf]),
							Buffer.from('docs/releases/pending/x.md\0'),
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
			// The BOM-prefixed name must NOT satisfy: with a user-visible
			// change present, the gate reports a real VIOLATION.
			expect(rc).toBe(1);
			const logged = errors.join('\n');
			expect(logged).toContain('VIOLATION');
			expect(logged).not.toContain('pending fragment present');
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

	test('a BOM-prefixed added name is not a fragment through the nul arm (final-critic round 2)', () => {
		// The CI pull_request arm shape: --added-file in nul framing,
		// through the spawned CLI.
		const dir = canonicalMkdtemp('bom-nul-3306-');
		createdTempDirs.push(dir);
		const changed = `${dir}/changed.bin`;
		const added = `${dir}/added.bin`;
		writeFileSync(changed, Buffer.from('src/index.ts\0'));
		writeFileSync(
			added,
			Buffer.concat([
				Buffer.from([0xef, 0xbb, 0xbf]),
				Buffer.from('docs/releases/pending/x.md\0'),
			]),
		);
		const result = runCli({
			args: [
				'--print-requirement',
				'--paths-format',
				'nul',
				'--changed-file',
				changed,
				'--added-file',
				added,
			],
			stdin: '',
		});
		// The BOM survives decoding; the name does not start with the
		// literal docs/ prefix, so the mandate is NOT satisfied.
		expect(result.stdout.trim()).toBe('required=true satisfied=false');
		expect(result.exitCode).toBe(1);
	});
});
