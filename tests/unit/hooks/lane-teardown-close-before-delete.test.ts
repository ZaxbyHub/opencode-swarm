import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Issue #2599 in-repo guardrail (mirrors the frozen acceptance check C5):
 * every lane-directory teardown path must release the lane's project-DB
 * handle (closeProjectDb) BEFORE deleting the directory — the Windows
 * WAL-lock ⇒ EBUSY failure class. Static source assertions, so the guard
 * survives outside the issue-tracer trace directory.
 *
 * Known limitation (recorded in docs/releases/pending/2599-*): the
 * reset-session enumeration covers only the default `.swarm-worktrees/`
 * layout; lanes under a `worktree_dir` override are tracked by #2527.
 */
function read(rel: string): string {
	return fs.readFileSync(
		path.join(import.meta.dir, '..', '..', '..', rel),
		'utf-8',
	);
}

function nonCommentLines(source: string): string[] {
	return source.split('\n').map((line) => line.replace(/\s*\/\/.*$/, ''));
}

describe('close-before-delete guardrail (#2599 AC5)', () => {
	test('worktree-isolation: every removeWorktree lane-teardown site is preceded by closeProjectDb', () => {
		const source = read('src/hooks/delegation-gate/worktree-isolation.ts');
		const lines = nonCommentLines(source);
		const failures: string[] = [];
		lines.forEach((line, index) => {
			if (!/removeWorktree\(/.test(line)) return;
			// The _internals seam declaration and type references are not call sites.
			if (/removeWorktree:/.test(line)) return;
			const windowStart = Math.max(0, index - 40);
			const window = lines.slice(windowStart, index).join('\n');
			if (!window.includes('closeProjectDb(')) {
				failures.push(
					`src/hooks/delegation-gate/worktree-isolation.ts:${index + 1} removeWorktree call without closeProjectDb in the preceding 40 lines`,
				);
			}
		});
		expect(failures).toEqual([]);
	});

	test('init-orphan-recovery: removeOrphanedWorktreeDir closes the DB before both deletion branches', () => {
		const source = read('src/hooks/init-orphan-recovery.ts');
		const lines = nonCommentLines(source);
		const fnStart = lines.findIndex((line) =>
			/async function removeOrphanedWorktreeDir\(/.test(line),
		);
		expect(fnStart).toBeGreaterThanOrEqual(0);
		const fnBody = lines.slice(fnStart, fnStart + 45);
		const closeIdx = fnBody.findIndex((line) => /closeProjectDb\(/.test(line));
		const rmSyncIdx = fnBody.findIndex((line) =>
			/_internals\.rmSync\(/.test(line),
		);
		const gitRemoveIdx = fnBody.findIndex((line) =>
			/_internals\.removeWorktree\(/.test(line),
		);
		expect(closeIdx).toBeGreaterThanOrEqual(0);
		expect(rmSyncIdx).toBeGreaterThan(closeIdx);
		expect(gitRemoveIdx).toBeGreaterThan(closeIdx);
	});

	test('reset-session: the bulk .swarm-worktrees removal enumerates lanes and closes each DB first', () => {
		const source = read('src/commands/reset-session.ts');
		const lines = nonCommentLines(source);
		const rmIdx = lines.findIndex((line) => /rmSync\(worktreesDir/.test(line));
		expect(rmIdx).toBeGreaterThanOrEqual(0);
		const window = lines.slice(Math.max(0, rmIdx - 60), rmIdx).join('\n');
		expect(window).toContain('closeProjectDb(');
		expect(/readdirSync/.test(window)).toBe(true);
	});

	test('delegation-gate terminal-failure cleanup closes the lane DB before removal', () => {
		const source = read('src/hooks/delegation-gate.ts');
		const lines = nonCommentLines(source);
		const failures: string[] = [];
		lines.forEach((line, index) => {
			if (!/\.removeWorktree\(/.test(line)) return;
			if (/get removeWorktree|set removeWorktree/.test(line)) return;
			const window = lines.slice(Math.max(0, index - 40), index).join('\n');
			if (!window.includes('closeProjectDb(')) {
				failures.push(`src/hooks/delegation-gate.ts:${index + 1}`);
			}
		});
		expect(failures).toEqual([]);
	});
});
