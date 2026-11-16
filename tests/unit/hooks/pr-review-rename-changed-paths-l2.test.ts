/**
 * Feedback-round coverage (PRR-005 / FB-5 / FB-25): the PR-workflow changed-
 * path set and the dirty-path disclosure must parse `git status --porcelain
 * -z` rename records correctly. In the -z format a rename is TWO NUL-
 * separated records (`R  <new>\0<old>\0`); the fixed parser skips the ORIGPATH
 * record and requires the status field to be a path-bearing one (`entry[2] !==
 * ' '`), so the old path must never leak into the set (it would admit `git
 * add` of a path that no longer exists and poison the digest comparison) and
 * the disclosure must name the NEW path only.
 *
 * NOT a frozen check — companion coverage to frozen C22 (dirty disclosure)
 * and the FB-13 admission floors.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	resolvePrWorkflowChangedPathSetAsync,
	resolveWorkingTreeDirtyPathsAsync,
} from '../../../src/background/workspace-snapshot.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

function gitRun(dir: string, args: string[]): void {
	execFileSync('git', ['-C', dir, ...args], {
		stdio: 'ignore',
		timeout: 15_000,
	});
}

function gitHead(dir: string): string {
	return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
		encoding: 'utf8',
		timeout: 15_000,
	}).trim();
}

describe('porcelain -z rename records: new path in, ORIGPATH record out (FB-5)', () => {
	test('a staged rename contributes the new path only, to the set and the disclosure', async () => {
		const dir = canonicalMkdtemp('pr-review-rename-paths-');
		try {
			writeFileSync(join(dir, 'old-name.ts'), 'export const a = 1;\n');
			writeFileSync(join(dir, 'untouched.ts'), 'export const u = 1;\n');
			gitRun(dir, ['init', '-q', '-b', 'main']);
			gitRun(dir, ['config', 'user.email', 'swarm-test@example.com']);
			gitRun(dir, ['config', 'user.name', 'Swarm Test']);
			gitRun(dir, ['add', '.']);
			gitRun(dir, ['commit', '-q', '-m', 'init']);
			const base = gitHead(dir);

			// Stage a rename (R status, two-record -z shape) plus an edit.
			gitRun(dir, ['mv', 'old-name.ts', 'new-name.ts']);
			writeFileSync(join(dir, 'untouched.ts'), 'export const u = 2;\n');

			const changed = await resolvePrWorkflowChangedPathSetAsync(dir, base);
			expect(changed).not.toBeNull();
			expect(changed!.has('new-name.ts')).toBe(true);
			expect(changed!.has('untouched.ts')).toBe(true);
			// The ORIGPATH record must have been consumed as metadata, not as a
			// changed path of its own.
			expect(changed!.has('old-name.ts')).toBe(false);

			const dirty = await resolveWorkingTreeDirtyPathsAsync(dir);
			expect(dirty).not.toBeNull();
			expect(dirty!.includes('new-name.ts')).toBe(true);
			expect(dirty!.includes('untouched.ts')).toBe(true);
			expect(dirty!.includes('old-name.ts')).toBe(false);
		} finally {
			removeTreeWithRetry(dir);
		}
	});
});
