/**
 * CI-round regression (PR #3668 feedback, FB-026): the capture prefix must be
 * resolved by GIT, not lexically. `path.relative(rev-parse --show-toplevel,
 * resolve(directory))` breaks whenever the two strings disagree about
 * Windows 8.3 short names — the ambient TEMP root hands out `RUNNER~1`
 * while rev-parse
 * prints `runneradmin`, so on CI Windows runners every porcelain path was
 * classified "outside the capture root": declared-scope dirt silently left
 * the routing loop (no fingerprint, no recorded failure →
 * REVIEWER_CAPTURE_INCOMPLETE with empty failures) and no-change workspaces
 * read dirty. The production fix resolves the prefix with
 * `rev-parse --show-prefix` (git-resolved, form-independent), pinned by the
 * spawn-sequence suite; this leg reproduces the 8.3 divergence end-to-end
 * and self-skips wherever the volume disables 8.3 name generation (CI
 * Windows runners are the live discriminator there).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	beginApprovedReviewerScopeLifecycle,
	completeReviewerScopeLifecycle,
} from '../../../src/hooks/reviewer-scope-lifecycle';
import {
	getReviewerScopeGenerationForCoderCall,
	recordReviewerScopeGenerationFile,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const TASK_ID = '4.3';
const CODER_PROMPT = `TASK: ${TASK_ID}\nWrite docs/declared.md.`;
const SUCCESS_OUTPUT = { status: 'completed', output: 'done' };

let parent = '';

function git(args: string[], cwd: string): void {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		timeout: 15_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(' ')} failed`);
	}
}

beforeEach(() => {
	resetSwarmState();
	parent = canonicalMkdtemp('reviewer-scope-prefix-3655-');
	fs.mkdirSync(path.join(parent, 'proj', 'docs'), { recursive: true });
	fs.writeFileSync(path.join(parent, 'README.md'), 'outer baseline\n');
	git(['init'], parent);
	git(['config', 'user.email', 'test@example.com'], parent);
	git(['config', 'user.name', 'Test'], parent);
	git(['add', 'README.md'], parent);
	git(['commit', '-m', 'outer baseline'], parent);
	fs.appendFileSync(path.join(parent, '.git', 'info/exclude'), '\n.swarm/\n');
	startAgentSession('parent', 'architect', path.join(parent, 'proj'));
});

afterEach(() => {
	resetSwarmState();
	safeRmRecursive(parent);
});

describe('reviewer scope capture prefix (PR #3668 feedback, FB-026)', () => {
	test('8.3 short-form workspace path keeps the git-resolved capture prefix', async () => {
		if (process.platform !== 'win32') return;
		const proj = path.join(parent, 'proj');
		const fso = spawnSync(
			'powershell.exe',
			[
				'-NoProfile',
				'-Command',
				`(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${proj.replaceAll("'", "''")}').ShortPath`,
			],
			{
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				timeout: 30_000,
			},
		);
		const shortProj = fso.stdout?.trim();
		if (
			fso.status !== 0 ||
			!shortProj ||
			shortProj.length === 0 ||
			shortProj === proj
		) {
			// 8.3 name generation disabled on this volume: the divergence
			// cannot be constructed here. The CI Windows runners (whose TEMP
			// is `RUNNER~1`) are the live discriminator for this leg.
			return;
		}
		startAgentSession('child-c83', 'coder', shortProj);
		installActiveScopeBinding({
			directory: shortProj,
			childSessionId: 'child-c83',
			parentSessionId: 'parent',
			dispatchCallId: 'c83',
			taskId: TASK_ID,
			files: ['docs/'],
		});
		expect(
			await beginApprovedReviewerScopeLifecycle({
				directory: shortProj,
				tool: 'Task',
				args: { subagent_type: 'coder', prompt: CODER_PROMPT },
				parentSessionID: 'parent',
				callID: 'c83',
			}),
		).toBe('coder_started');
		fs.writeFileSync(path.join(shortProj, 'docs/a.md'), 'routed bytes\n');
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: TASK_ID,
				coderCallID: 'c83',
				file: 'docs/a.md',
			}),
		).toBe(true);
		fs.writeFileSync(path.join(shortProj, 'docs/b.md'), 'committed bytes\n');
		git(['add', 'docs/b.md'], shortProj);
		git(['commit', '-m', 'committed declared output'], shortProj);
		expect(
			await completeReviewerScopeLifecycle({
				directory: shortProj,
				tool: 'Task',
				args: { subagent_type: 'coder', prompt: CODER_PROMPT },
				output: SUCCESS_OUTPUT,
				parentSessionID: 'parent',
				callID: 'c83',
			}),
		).toBe('coder_ready');
		const generation = getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			taskId: TASK_ID,
			coderCallID: 'c83',
		});
		expect(generation?.status).toBe('ready');
		expect(generation?.modifiedFiles).toContain('docs/a.md');
		expect(generation?.modifiedFiles).toContain('docs/b.md');
		const advisories = (
			swarmState.agentSessions.get('parent')?.pendingAdvisoryMessages ?? []
		).join('\n');
		expect(advisories).not.toContain('REVIEWER_CAPTURE_INCOMPLETE');
	}, 60_000);
});
