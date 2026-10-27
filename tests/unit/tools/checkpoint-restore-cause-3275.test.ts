/**
 * Review round 2 pin (PRR-027 residual): the checkpoint restore SINK renders
 * the shared `describeUnreadableCause` cause when the destruction measurement
 * cannot be read. The rollback command sink was already covered by
 * rollback-two-step; the fragment advertises the diagnosable refusal for the
 * checkpoint path too, and no test drove it (`cannot verify the working
 * tree` had zero test hits).
 *
 * Drives the REAL tool against a real git scratch repo, stubbing only the
 * shared rollback-gate status seam so the read fails structurally.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { GitStatusReadResult } from '../../../src/commands/git-status-read';
import { _rollbackGateInternals } from '../../../src/commands/rollback-gate';
import { checkpoint } from '../../../src/tools/checkpoint';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function git(args: string[], cwd: string): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

const scratchDirs: string[] = [];
const originalRunGit = _rollbackGateInternals.runGit;

afterEach(() => {
	_rollbackGateInternals.runGit = originalRunGit;
	while (scratchDirs.length > 0) {
		const dir = scratchDirs.pop() as string;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

async function scratchRepo(): Promise<{ dir: string; label: string }> {
	const dir = canonicalMkdtemp('checkpoint-cause-');
	scratchDirs.push(dir);
	git(['init', '-q'], dir);
	git(['config', 'user.email', 'test@example.com'], dir);
	git(['config', 'user.name', 'Test'], dir);
	git(['config', 'commit.gpgsign', 'false'], dir);
	fs.writeFileSync(path.join(dir, 'src.txt'), 'committed-content');
	git(['add', '.'], dir);
	git(['commit', '-q', '-m', 'init'], dir);
	const label = 'cause-render';
	const result = await checkpoint.execute({ action: 'save', label }, {
		directory: dir,
	} as ToolContext);
	const raw =
		typeof result === 'string' ? result : (result as { output: string }).output;
	if (!raw.includes('"success": true')) {
		throw new Error(`checkpoint save failed: ${raw}`);
	}
	return { dir, label };
}

describe('checkpoint restore renders the structured unreadable cause (#3317 round-2 pin)', () => {
	test('an unreadable destruction measurement refuses with the shared cause text', async () => {
		const { dir, label } = await scratchRepo();
		_rollbackGateInternals.runGit = async () =>
			({
				ok: false,
				code: 'ETIMEDOUT',
				status: null,
				stderrTail: '',
			}) satisfies GitStatusReadResult;

		const result = await checkpoint.execute({ action: 'restore', label }, {
			directory: dir,
		} as ToolContext);
		const raw =
			typeof result === 'string'
				? result
				: (result as { output: string }).output;
		expect(raw).toContain(
			'cannot verify the working tree (git status unreadable;',
		);
		expect(raw).toContain('the read timed out (ETIMEDOUT)');
		expect(raw).toContain('refusing to restore without a preview');
		expect(raw).not.toContain('checkpoint not found');
	}, 30_000);
});
