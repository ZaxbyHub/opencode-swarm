/**
 * BOT-M1 regression: the gate's diff must be merge-base-relative. A two-dot
 * `base HEAD` diff blames a PR for main-side commits that landed after the
 * branch diverged (false-positive block on ordinary base drift). These tests
 * build real scratch git repos and assert both directions:
 *   - a test-only PR is NOT flagged when main advanced with user-visible files
 *   - a user-visible PR without a fragment IS still flagged (gate not defanged)
 */

import { describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../../scripts/check-pending-fragment.ts';

function git(dir: string, ...args: string[]): void {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd: dir,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	if (proc.exitCode !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: ${proc.stderr.toString()} ${proc.stdout.toString()}`,
		);
	}
}

function scratchRepo(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cpf-git-')));
	git(dir, 'init', '-b', 'main');
	git(dir, 'config', 'user.email', 't@t');
	git(dir, 'config', 'user.name', 't');
	writeFileSync(join(dir, 'README.md'), 'base\n');
	git(dir, 'add', '.');
	git(dir, 'commit', '-m', 'base');
	return dir;
}

describe('check-pending-fragment main() — merge-base diff (BOT-H1/M1)', () => {
	test('test-only PR is NOT flagged when main advanced with user-visible files', () => {
		const dir = scratchRepo();
		try {
			// Branch point: create PR branch from current main.
			git(dir, 'checkout', '-b', 'pr-branch');
			mkdirSync(join(dir, 'tests'), { recursive: true });
			writeFileSync(join(dir, 'tests', 'a.test.ts'), 'test {}\n');
			git(dir, 'add', '.');
			git(dir, 'commit', '-m', 'test only');
			// Simulate origin/main advancing past the merge-base with an
			// unrelated USER-VISIBLE change (with its own fragment).
			git(dir, 'checkout', 'main');
			mkdirSync(join(dir, 'src'), { recursive: true });
			writeFileSync(
				join(dir, 'src', 'newfeature.ts'),
				'export const mainSideFeature = unrelatedContent();\n',
			);
			mkdirSync(join(dir, 'docs', 'releases', 'pending'), { recursive: true });
			writeFileSync(
				join(dir, 'docs', 'releases', 'pending', 'main-side.md'),
				'# main-side fragment\n',
			);
			git(dir, 'add', '.');
			git(dir, 'commit', '-m', 'main-side user-visible change');
			// Simulate CI's fresh origin/main pointing at advanced main.
			git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
			git(dir, 'checkout', 'pr-branch');
			// OLD two-dot behavior: exit 1 blaming src/newfeature.ts.
			expect(main(dir)).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('user-visible PR without a fragment IS flagged (gate not defanged)', () => {
		const dir = scratchRepo();
		try {
			git(dir, 'checkout', '-b', 'pr-branch');
			mkdirSync(join(dir, 'src'));
			writeFileSync(join(dir, 'src', 'feature.ts'), 'export {};\n');
			git(dir, 'add', '.');
			git(dir, 'commit', '-m', 'user-visible only');
			git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
			expect(main(dir)).toBe(1);
			// And the escape hatch soft-warns.
			const prev = process.env.FRAGMENT_CHECK_ENFORCE;
			process.env.FRAGMENT_CHECK_ENFORCE = '0';
			try {
				expect(main(dir)).toBe(0);
			} finally {
				if (prev === undefined) delete process.env.FRAGMENT_CHECK_ENFORCE;
				else process.env.FRAGMENT_CHECK_ENFORCE = prev;
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('user-visible PR WITH a fragment passes', () => {
		const dir = scratchRepo();
		try {
			git(dir, 'checkout', '-b', 'pr-branch');
			mkdirSync(join(dir, 'src'), { recursive: true });
			writeFileSync(join(dir, 'src', 'feature.ts'), 'export {}\n');
			mkdirSync(join(dir, 'docs', 'releases', 'pending'), { recursive: true });
			writeFileSync(
				join(dir, 'docs', 'releases', 'pending', 'my-feature.md'),
				'# my feature\n',
			);
			git(dir, 'add', '.');
			git(dir, 'commit', '-m', 'user-visible with fragment');
			git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
			expect(main(dir)).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
