import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	bindPrWorkflowHead,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveCurrentUpstreamPushTarget =
	_test_exports.resolveCurrentUpstreamPushTarget;
const originalResolveRemoteRefsContainingHead =
	_test_exports.resolveRemoteRefsContainingHead;

function git(
	cwd: string,
	args: string[],
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		timeout: 10_000,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return {
		status: result.status,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-checkout-bootstrap-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => 'a'.repeat(40);
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-head',
		remoteTrackingRef: 'refs/remotes/origin/pr-head',
	});
	_test_exports.resolveRemoteRefsContainingHead = () => [
		'refs/remotes/origin/pr-head',
	];
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveCurrentUpstreamPushTarget =
		originalResolveCurrentUpstreamPushTarget;
	_test_exports.resolveRemoteRefsContainingHead =
		originalResolveRemoteRefsContainingHead;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR workflow checkout bootstrap', () => {
	test('admits the canonical standalone exact-SHA review checkout before binding', async () => {
		const sha = 'a'.repeat(40);
		await activatePrWorkflow(directory, 'review-bootstrap', 'PR_REVIEW');

		await expect(
			enforcePrWorkflowToolBefore(directory, 'review-bootstrap', 'shell', {
				command: 'git fetch origin refs/pull/1911/head',
			}),
		).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(directory, 'review-bootstrap', 'shell', {
				command: `git cat-file -e ${sha}^{commit}`,
			}),
		).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(directory, 'review-bootstrap', 'shell', {
				command: `git switch --detach ${sha}`,
			}),
		).resolves.toBeUndefined();
		await expect(
			bindPrWorkflowHead(directory, 'review-bootstrap', sha),
		).resolves.toMatchObject({ prHeadSha: sha });
	});

	test('checkout denial points the architect to the exact supported review sequence', async () => {
		await activatePrWorkflow(directory, 'review-guidance', 'PR_REVIEW');
		for (const command of [
			'git switch -c pr-1911-review --track FETCH_HEAD',
			'git checkout main',
			'gh pr checkout 1911',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(directory, 'review-guidance', 'shell', {
					command,
				}),
			).rejects.toThrow('git switch --detach <full_pr_head_sha>');
		}
	});

	test('rejects destructive gh checkout flags and mutating git -C outside the project', async () => {
		await activatePrWorkflow(
			directory,
			'feedback-safe-checkout',
			'PR_FEEDBACK',
		);
		for (const command of [
			'gh pr checkout 1911 --force',
			'gh pr checkout 1911 --recurse-submodules',
			'git -C ../other switch --detach abc123',
			'git -C C:/other fetch origin feature',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(
					directory,
					'feedback-safe-checkout',
					'shell',
					{ command },
				),
			).rejects.toThrow('PR_FEEDBACK');
		}
	});

	test('accepts safe gh checkout long flags in separate and equals forms (F-009)', async () => {
		await activatePrWorkflow(directory, 'feedback-gh-equals', 'PR_FEEDBACK');
		for (const command of [
			'gh pr checkout 1911 --repo owner/repo --branch pr-head',
			'gh pr checkout 1911 --repo=owner/repo --branch=pr-head',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(directory, 'feedback-gh-equals', 'shell', {
					command,
				}),
			).resolves.toBeUndefined();
		}
	});

	test('does not classify a leading flag as a detached feedback ref (F-008)', async () => {
		await activatePrWorkflow(directory, 'feedback-detach-flag', 'PR_FEEDBACK');
		await expect(
			enforcePrWorkflowToolBefore(directory, 'feedback-detach-flag', 'shell', {
				command: 'git switch --detach --help',
			}),
		).rejects.not.toThrow(
			'requires a tracked PR branch before the first head bind',
		);
	});

	test('rejects multiline checkout before the per-command matcher (F-011d)', async () => {
		await activatePrWorkflow(directory, 'feedback-multiline', 'PR_FEEDBACK');
		await expect(
			enforcePrWorkflowToolBefore(directory, 'feedback-multiline', 'shell', {
				command: 'git switch -c local\n--track origin/pr-head',
			}),
		).rejects.toThrow('PR_FEEDBACK');
	});

	test('requires a clean checkout on the first PR_FEEDBACK head bind', async () => {
		await activatePrWorkflow(directory, 'feedback-clean-bind', 'PR_FEEDBACK');
		_test_exports.resolveIsWorkingTreeClean = () => false;
		await expect(
			bindPrWorkflowHead(directory, 'feedback-clean-bind', 'a'.repeat(40)),
		).rejects.toThrow('clean');
	});

	test('requires a tracking branch on the first real PR_FEEDBACK head bind', async () => {
		_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
		_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
		_test_exports.resolveCurrentUpstreamPushTarget =
			originalResolveCurrentUpstreamPushTarget;
		_test_exports.resolveRemoteRefsContainingHead =
			originalResolveRemoteRefsContainingHead;
		const source = path.join(directory, 'source-feedback');
		const checkout = path.join(directory, 'checkout-feedback');
		mkdirSync(source);
		expect(git(source, ['init', '--initial-branch=main']).status).toBe(0);
		expect(git(source, ['config', 'user.name', 'Swarm Test']).status).toBe(0);
		expect(
			git(source, ['config', 'user.email', 'swarm@example.invalid']).status,
		).toBe(0);
		await fs.writeFile(path.join(source, 'feedback.txt'), 'base\n', 'utf-8');
		expect(git(source, ['add', 'feedback.txt']).status).toBe(0);
		expect(git(source, ['commit', '-m', 'base']).status).toBe(0);
		expect(git(source, ['switch', '-c', 'pr-feedback']).status).toBe(0);
		await fs.writeFile(path.join(source, 'feedback.txt'), 'from-pr\n', 'utf-8');
		expect(git(source, ['commit', '-am', 'pr head']).status).toBe(0);
		const sha = git(source, ['rev-parse', 'HEAD']).stdout.trim();
		expect(git(source, ['switch', 'main']).status).toBe(0);
		expect(git(directory, ['clone', source, checkout]).status).toBe(0);
		await fs.appendFile(
			path.join(checkout, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
			'utf-8',
		);
		expect(
			git(checkout, ['fetch', 'origin', 'refs/heads/pr-feedback']).status,
		).toBe(0);
		expect(git(checkout, ['switch', '--detach', sha]).status).toBe(0);

		await activatePrWorkflow(checkout, 'feedback-detached', 'PR_FEEDBACK');
		await expect(
			bindPrWorkflowHead(checkout, 'feedback-detached', sha),
		).rejects.toThrow('remote-tracking ref');

		expect(
			git(checkout, [
				'switch',
				'-c',
				'pr-feedback',
				'--track',
				'origin/pr-feedback',
			]).status,
		).toBe(0);
		await activatePrWorkflow(checkout, 'feedback-tracking', 'PR_FEEDBACK');
		await expect(
			bindPrWorkflowHead(checkout, 'feedback-tracking', sha),
		).resolves.toMatchObject({ prHeadSha: sha });
	});

	test('rejects a PR_FEEDBACK upstream whose tip is not the exact PR head', async () => {
		await activatePrWorkflow(
			directory,
			'feedback-wrong-upstream',
			'PR_FEEDBACK',
		);
		_test_exports.resolveRemoteRefsContainingHead = () => [
			'refs/remotes/origin/different-branch',
		];
		await expect(
			bindPrWorkflowHead(directory, 'feedback-wrong-upstream', 'a'.repeat(40)),
		).rejects.toThrow('must point to the exact intake PR head');
	});

	test('real Git bootstrap exposes PR files before exact-head binding', async () => {
		_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
		_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
		const source = path.join(directory, 'source');
		const checkout = path.join(directory, 'checkout');
		mkdirSync(source);
		expect(git(source, ['init', '--initial-branch=main']).status).toBe(0);
		expect(git(source, ['config', 'user.name', 'Swarm Test']).status).toBe(0);
		expect(
			git(source, ['config', 'user.email', 'swarm@example.invalid']).status,
		).toBe(0);
		await fs.writeFile(path.join(source, 'review.txt'), 'base\n', 'utf-8');
		expect(git(source, ['add', 'review.txt']).status).toBe(0);
		expect(git(source, ['commit', '-m', 'base']).status).toBe(0);
		expect(git(source, ['switch', '-c', 'pr-head']).status).toBe(0);
		await fs.writeFile(path.join(source, 'review.txt'), 'from-pr\n', 'utf-8');
		expect(git(source, ['commit', '-am', 'pr head']).status).toBe(0);
		const sha = git(source, ['rev-parse', 'HEAD']).stdout.trim();
		expect(sha).toMatch(/^[0-9a-f]{40,64}$/);
		expect(git(source, ['switch', 'main']).status).toBe(0);
		expect(git(directory, ['clone', source, checkout]).status).toBe(0);
		await fs.appendFile(
			path.join(checkout, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
			'utf-8',
		);

		await activatePrWorkflow(checkout, 'real-review', 'PR_REVIEW');
		const fetch = 'git fetch origin refs/heads/pr-head';
		await expect(
			enforcePrWorkflowToolBefore(checkout, 'real-review', 'shell', {
				command: fetch,
			}),
		).resolves.toBeUndefined();
		expect(
			git(checkout, ['fetch', 'origin', 'refs/heads/pr-head']).status,
		).toBe(0);

		const verify = `git cat-file -e ${sha}^{commit}`;
		await expect(
			enforcePrWorkflowToolBefore(checkout, 'real-review', 'shell', {
				command: verify,
			}),
		).resolves.toBeUndefined();
		expect(git(checkout, ['cat-file', '-e', `${sha}^{commit}`]).status).toBe(0);

		const switchCommand = `git switch --detach ${sha}`;
		await expect(
			enforcePrWorkflowToolBefore(checkout, 'real-review', 'shell', {
				command: switchCommand,
			}),
		).resolves.toBeUndefined();
		expect(git(checkout, ['switch', '--detach', sha]).status).toBe(0);
		expect(
			(await fs.readFile(path.join(checkout, 'review.txt'), 'utf-8')).trim(),
		).toBe('from-pr');
		await expect(
			bindPrWorkflowHead(checkout, 'real-review', sha),
		).resolves.toMatchObject({ prHeadSha: sha });
	});
});

describe('architect-visible checkout contract', () => {
	const root = process.cwd();
	const reviewSurfaces = [
		'src/agents/architect.ts',
		'.opencode/skills/swarm-pr-review/SKILL.md',
		'.claude/skills/swarm-pr-review/SKILL.md',
		'.agents/skills/swarm-pr-review/SKILL.md',
	];
	const feedbackSurfaces = [
		'src/agents/architect.ts',
		'.opencode/skills/swarm-pr-feedback/SKILL.md',
		'.claude/skills/swarm-pr-feedback/SKILL.md',
		'.agents/skills/swarm-pr-feedback/SKILL.md',
	];

	test.each(
		reviewSurfaces,
	)('%s requires exact detached checkout before explorer dispatch', (relative) => {
		const content = readFileSync(path.join(root, relative), 'utf-8')
			.replace(/\\`/g, '`')
			.toLowerCase();
		expect(content).toContain('git switch --detach <full_pr_head_sha>');
		expect(content).toContain('do not use `--track fetch_head`');
		expect(content).toContain('before dispatching explorer lanes');
	});

	test.each(
		feedbackSurfaces,
	)('%s requires safe local PR feedback checkout before verification', (relative) => {
		const content = readFileSync(path.join(root, relative), 'utf-8')
			.replace(/\\`/g, '`')
			.toLowerCase();
		expect(content).toContain('before dispatching feedback lanes');
		expect(content).toContain('pr head');
		expect(content).toContain('`--force`');
		expect(content).toContain('`--recurse-submodules`');
	});
});
