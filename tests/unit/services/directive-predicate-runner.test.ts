/**
 * Unit tests for the directive verification predicate runner
 * (Swarm Learning System, Change 2 / Task 2.2).
 *
 * Covers all four handlers (grep / tool / file_not_modified / file_modified),
 * malformed inputs (→ error), and the pass/fail boundaries.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDirectivePredicate } from '../../../src/services/directive-predicate-runner.js';

function git(dir: string, args: string[]): void {
	execFileSync('git', args, {
		cwd: dir,
		stdio: 'ignore',
		env: {
			...process.env,
			// Hermetic: ignore any global/system git config (signing, hooks, identity).
			GIT_CONFIG_GLOBAL: os.devNull,
			GIT_CONFIG_SYSTEM: os.devNull,
			GIT_AUTHOR_NAME: 'test',
			GIT_AUTHOR_EMAIL: 'test@test.com',
			GIT_COMMITTER_NAME: 'test',
			GIT_COMMITTER_EMAIL: 'test@test.com',
		},
	});
}

describe('runDirectivePredicate', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predicate-'));
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ---- grep handler ----

	describe('grep', () => {
		it('PASSES when the forbidden pattern is absent (zero matches)', async () => {
			fs.writeFileSync(path.join(dir, 'src', 'clean.ts'), 'const x = 1;\n');
			const out = await runDirectivePredicate(
				'grep:async iterator:src/**/*.ts',
				dir,
			);
			expect(out.result).toBe('pass');
		});

		it('FAILS when the forbidden pattern is present', async () => {
			fs.writeFileSync(
				path.join(dir, 'src', 'bad.ts'),
				'for await (const x of asyncIterator) {}\nasync iterator usage\n',
			);
			const out = await runDirectivePredicate(
				'grep:async iterator:src/**/*.ts',
				dir,
			);
			expect(out.result).toBe('fail');
			expect(out.detail).toContain('match');
		});

		it('handles regexes containing colons (splits on the LAST colon)', async () => {
			fs.writeFileSync(
				path.join(dir, 'src', 'time.ts'),
				'const t = "12:00";\n',
			);
			// regex "12:00" contains a colon; glob is after the final colon.
			const out = await runDirectivePredicate('grep:12:00:src/**/*.ts', dir);
			expect(out.result).toBe('fail');
		});

		it('returns error for a malformed grep predicate (no glob segment)', async () => {
			const out = await runDirectivePredicate('grep:onlyregex', dir);
			expect(out.result).toBe('error');
		});
	});

	// ---- tool handler ----

	describe('tool', () => {
		it('PASSES when an allowlisted command exits 0', async () => {
			const out = await runDirectivePredicate('tool:git --version', dir);
			expect(out.result).toBe('pass');
		});

		it('FAILS when an allowlisted command exits non-zero', async () => {
			git(dir, ['init']);
			const out = await runDirectivePredicate(
				'tool:git rev-parse --verify refs/heads/does-not-exist',
				dir,
			);
			expect(out.result).toBe('fail');
		});

		it('returns error for a binary not on the allowlist', async () => {
			const out = await runDirectivePredicate('tool:node --version', dir);
			expect(out.result).toBe('error');
			expect(out.detail).toContain('allowlist');
		});

		it('returns error for an empty tool command', async () => {
			const out = await runDirectivePredicate('tool:', dir);
			expect(out.result).toBe('error');
		});
	});

	// ---- file_modified / file_not_modified handlers ----

	describe('file_modified / file_not_modified', () => {
		function initRepoWithCommit(): void {
			git(dir, ['init']);
			git(dir, ['config', 'user.email', 'test@test.com']);
			git(dir, ['config', 'user.name', 'test']);
			fs.writeFileSync(path.join(dir, 'src', 'tracked.ts'), 'v1\n');
			fs.writeFileSync(path.join(dir, 'src', 'other.ts'), 'o1\n');
			git(dir, ['add', '.']);
			git(dir, ['commit', '-m', 'init']);
		}

		it('file_modified PASSES for a changed tracked file', async () => {
			initRepoWithCommit();
			fs.writeFileSync(path.join(dir, 'src', 'tracked.ts'), 'v2\n');
			const out = await runDirectivePredicate(
				'file_modified:src/tracked.ts',
				dir,
			);
			expect(out.result).toBe('pass');
		});

		it('file_modified FAILS for an unchanged file', async () => {
			initRepoWithCommit();
			const out = await runDirectivePredicate(
				'file_modified:src/other.ts',
				dir,
			);
			expect(out.result).toBe('fail');
		});

		it('file_not_modified PASSES for an unchanged file', async () => {
			initRepoWithCommit();
			fs.writeFileSync(path.join(dir, 'src', 'tracked.ts'), 'v2\n');
			const out = await runDirectivePredicate(
				'file_not_modified:src/other.ts',
				dir,
			);
			expect(out.result).toBe('pass');
		});

		it('file_not_modified FAILS for a changed file', async () => {
			initRepoWithCommit();
			fs.writeFileSync(path.join(dir, 'src', 'tracked.ts'), 'v2\n');
			const out = await runDirectivePredicate(
				'file_not_modified:src/tracked.ts',
				dir,
			);
			expect(out.result).toBe('fail');
		});
	});

	// ---- malformed / unknown ----

	describe('malformed predicates fail closed', () => {
		it('empty string → error', async () => {
			expect((await runDirectivePredicate('', dir)).result).toBe('error');
		});

		it('no handler prefix → error', async () => {
			expect((await runDirectivePredicate('justtext', dir)).result).toBe(
				'error',
			);
		});

		it('unknown handler → error', async () => {
			expect(
				(await runDirectivePredicate('frobnicate:foo:bar', dir)).result,
			).toBe('error');
		});
	});
});
