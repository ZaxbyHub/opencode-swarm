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

	test('init-orphan-recovery: the gated removal loop closes the DB before removeOwnedWorktreeDir (post-#2527)', () => {
		// Post-#2527 the rmSync-fallback helper was replaced by the
		// ownership-gated removeOwnedWorktreeDir flow; the invariant under
		// guard is unchanged: closeProjectDb precedes the gated removal.
		const source = read('src/hooks/init-orphan-recovery.ts');
		const lines = nonCommentLines(source);
		const closeIdx = lines.findIndex((line) => /closeProjectDb\(/.test(line));
		const removalIdx = lines.findIndex((line) =>
			/removeOwnedWorktreeDir\(/.test(line),
		);
		expect(closeIdx).toBeGreaterThanOrEqual(0);
		expect(removalIdx).toBeGreaterThan(closeIdx);
	});

	test('reset-session: the gated reclamation enumerates lanes and closes each DB first (post-#2527)', () => {
		// Post-#2527 reset-session reclaims per-lane through the ownership
		// gate (never a bulk rmSync); the invariant under guard is unchanged:
		// enumeration happens and closeProjectDb precedes the removal loop.
		const source = read('src/commands/reset-session.ts');
		const lines = nonCommentLines(source);
		const enumIdx = lines.findIndex((line) =>
			/for \(const base of resolveWorktreeEnumerationBases\(/.test(line),
		);
		expect(enumIdx).toBeGreaterThanOrEqual(0);
		const closeIdx = lines.findIndex((line) => /closeProjectDb\(/.test(line));
		const removalIdx = lines.findIndex((line) =>
			/removeOwnedWorktreeDir\(/.test(line),
		);
		expect(closeIdx).toBeGreaterThan(enumIdx);
		expect(closeIdx).toBeLessThan(removalIdx);
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
