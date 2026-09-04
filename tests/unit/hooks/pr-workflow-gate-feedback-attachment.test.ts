import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	bindPrWorkflowHead,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate';

let root = '';
const originalBeforePrFeedbackTrackingPersist =
	_test_exports.beforePrFeedbackTrackingPersist;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveCurrentUpstreamPushTargetAsync =
	_test_exports.resolveCurrentUpstreamPushTargetAsync;
const originalResolveRemoteRefsContainingHeadAsync =
	_test_exports.resolveRemoteRefsContainingHeadAsync;

function git(
	cwd: string,
	args: string[],
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		timeout: 10_000,
		maxBuffer: 512 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

function expectGit(cwd: string, args: string[]): string {
	const result = git(cwd, args);
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

async function makeDetachedFeedbackCheckout(
	options: { extraExactRemote?: boolean } = {},
): Promise<{ checkout: string; head: string }> {
	const source = path.join(root, 'source');
	const checkout = path.join(root, 'checkout');
	await fs.mkdir(source);
	expectGit(source, ['init', '--initial-branch=main']);
	expectGit(source, ['config', 'user.name', 'Swarm Test']);
	expectGit(source, ['config', 'user.email', 'swarm@example.invalid']);
	await fs.writeFile(path.join(source, 'file.txt'), 'base\n', 'utf-8');
	expectGit(source, ['add', 'file.txt']);
	expectGit(source, ['commit', '-m', 'base']);
	expectGit(source, ['switch', '-c', 'feature/nested']);
	await fs.writeFile(path.join(source, 'file.txt'), 'pr head\n', 'utf-8');
	expectGit(source, ['commit', '-am', 'pr head']);
	const head = expectGit(source, ['rev-parse', 'HEAD']);
	if (options.extraExactRemote) {
		expectGit(source, ['branch', 'feature/copy', head]);
	}
	expectGit(source, ['switch', 'main']);
	expectGit(root, ['clone', source, checkout]);
	await fs.appendFile(
		path.join(checkout, '.git', 'info', 'exclude'),
		'\n.swarm/\n',
		'utf-8',
	);
	expectGit(checkout, ['switch', '--detach', head]);
	return { checkout, head };
}

beforeEach(() => {
	root = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'feedback-attachment-')),
	);
	_test_exports.resetTrackedStateCache();
});

afterEach(async () => {
	_test_exports.beforePrFeedbackTrackingPersist =
		originalBeforePrFeedbackTrackingPersist;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolveCurrentUpstreamPushTargetAsync =
		originalResolveCurrentUpstreamPushTargetAsync;
	_test_exports.resolveRemoteRefsContainingHeadAsync =
		originalResolveRemoteRefsContainingHeadAsync;
	_test_exports.resetTrackedStateCache();
	await fs.rm(root, { recursive: true, force: true });
});

describe('detached PR_FEEDBACK attachment', () => {
	test('rejects when HEAD changes between intake verification and attachment (PRR-012)', async () => {
		const { checkout, head } = await makeDetachedFeedbackCheckout();
		await activatePrWorkflow(checkout, 'feedback-head-changed', 'PR_FEEDBACK');
		let headReads = 0;
		_test_exports.resolveCurrentGitHeadAsync = async () =>
			++headReads === 1 ? head : 'b'.repeat(40);

		await expect(
			bindPrWorkflowHead(checkout, 'feedback-head-changed', head),
		).rejects.toThrow('exact head changed before attach');
		expect(
			(await readPrWorkflowGateState(checkout, 'feedback-head-changed'))
				?.prHeadSha,
		).toBeUndefined();
		expect(expectGit(checkout, ['branch', '--show-current'])).toBe('');
	});

	test('refuses to replace an existing upstream that misses the intake head (PRR-012)', async () => {
		const { checkout, head } = await makeDetachedFeedbackCheckout();
		await activatePrWorkflow(
			checkout,
			'feedback-upstream-mismatch',
			'PR_FEEDBACK',
		);
		_test_exports.resolveCurrentUpstreamPushTargetAsync = async () => ({
			remoteName: 'origin',
			remoteBranchRef: 'refs/heads/main',
			remoteTrackingRef: 'refs/remotes/origin/main',
		});
		_test_exports.resolveRemoteRefsContainingHeadAsync = async () => [
			'refs/remotes/origin/feature/nested',
		];

		await expect(
			bindPrWorkflowHead(checkout, 'feedback-upstream-mismatch', head),
		).rejects.toThrow('refusing to replace an existing tracking relationship');
		expect(
			(await readPrWorkflowGateState(checkout, 'feedback-upstream-mismatch'))
				?.prHeadSha,
		).toBeUndefined();
	});

	test('rejects multiple exact local tracking branches without choosing one (PRR-012)', async () => {
		const { checkout, head } = await makeDetachedFeedbackCheckout({
			extraExactRemote: true,
		});
		for (const branch of ['feature/nested', 'feature/copy']) {
			expectGit(checkout, [
				'switch',
				'-c',
				branch,
				'--track',
				`origin/${branch}`,
			]);
			expectGit(checkout, ['switch', '--detach', head]);
		}
		await activatePrWorkflow(
			checkout,
			'feedback-local-ambiguous',
			'PR_FEEDBACK',
		);

		await expect(
			bindPrWorkflowHead(checkout, 'feedback-local-ambiguous', head),
		).rejects.toThrow('matches multiple local tracked branches');
		expect(
			(await readPrWorkflowGateState(checkout, 'feedback-local-ambiguous'))
				?.prHeadSha,
		).toBeUndefined();
		expect(expectGit(checkout, ['branch', '--show-current'])).toBe('');
	});

	test('promotes one exact remote-tracking ref and binds the immutable head', async () => {
		const { checkout, head } = await makeDetachedFeedbackCheckout();
		await activatePrWorkflow(checkout, 'feedback-remote-only', 'PR_FEEDBACK');

		const state = await bindPrWorkflowHead(
			checkout,
			'feedback-remote-only',
			head,
		);

		expect(state.prHeadSha).toBe(head);
		expect(expectGit(checkout, ['branch', '--show-current'])).toBe(
			'feature/nested',
		);
		expect(
			expectGit(checkout, ['rev-parse', '--symbolic-full-name', '@{u}']),
		).toBe('refs/remotes/origin/feature/nested');
		expect(expectGit(checkout, ['rev-parse', 'HEAD'])).toBe(head);
	});

	test('prefers one exact local tracked branch even when remote refs are ambiguous', async () => {
		const { checkout, head } = await makeDetachedFeedbackCheckout({
			extraExactRemote: true,
		});
		expectGit(checkout, [
			'switch',
			'-c',
			'feature/nested',
			'--track',
			'origin/feature/nested',
		]);
		expectGit(checkout, ['switch', '--detach', head]);
		await activatePrWorkflow(checkout, 'feedback-local-exact', 'PR_FEEDBACK');

		await expect(
			bindPrWorkflowHead(checkout, 'feedback-local-exact', head),
		).resolves.toMatchObject({ prHeadSha: head });
		expect(expectGit(checkout, ['branch', '--show-current'])).toBe(
			'feature/nested',
		);
		expect(
			expectGit(checkout, ['rev-parse', '--symbolic-full-name', '@{u}']),
		).toBe('refs/remotes/origin/feature/nested');
	});

	test('rejects when no exact local or remote tracking candidate exists', async () => {
		const { checkout, head } = await makeDetachedFeedbackCheckout();
		expectGit(checkout, [
			'update-ref',
			'-d',
			'refs/remotes/origin/feature/nested',
		]);
		await activatePrWorkflow(checkout, 'feedback-no-candidate', 'PR_FEEDBACK');

		await expect(
			bindPrWorkflowHead(checkout, 'feedback-no-candidate', head),
		).rejects.toThrow(
			'requires a current local branch or exact remote-tracking',
		);
		expect(
			(await readPrWorkflowGateState(checkout, 'feedback-no-candidate'))
				?.prHeadSha,
		).toBeUndefined();
		expect(expectGit(checkout, ['branch', '--show-current'])).toBe('');
	});

	test('covers a failed exact-local switch held by another linked worktree (PRR-012)', async () => {
		const { checkout, head } = await makeDetachedFeedbackCheckout();
		const linked = path.join(root, 'linked');
		expectGit(checkout, [
			'switch',
			'-c',
			'feature/nested',
			'--track',
			'origin/feature/nested',
		]);
		expectGit(checkout, ['switch', '--detach', head]);
		expectGit(checkout, ['worktree', 'add', linked, 'feature/nested']);
		await activatePrWorkflow(checkout, 'feedback-linked', 'PR_FEEDBACK');

		await expect(
			bindPrWorkflowHead(checkout, 'feedback-linked', head),
		).rejects.toThrow('another linked worktree');
		expect(
			(await readPrWorkflowGateState(checkout, 'feedback-linked'))?.prHeadSha,
		).toBeUndefined();
		expect(expectGit(checkout, ['branch', '--show-current'])).toBe('');
	});

	test('revalidates exact HEAD after switching before publishing the bind', async () => {
		const { checkout, head } = await makeDetachedFeedbackCheckout();
		await activatePrWorkflow(checkout, 'feedback-revalidate', 'PR_FEEDBACK');
		_test_exports.afterPrFeedbackTrackingSwitch = async () => {
			expectGit(checkout, ['switch', '--detach', 'origin/main']);
		};

		await expect(
			bindPrWorkflowHead(checkout, 'feedback-revalidate', head),
		).rejects.toThrow('exact head changed after attach');
		expect(
			(await readPrWorkflowGateState(checkout, 'feedback-revalidate'))
				?.prHeadSha,
		).toBeUndefined();
	});

	test('rejects ambiguous exact remote refs without publishing a bind', async () => {
		const { checkout, head } = await makeDetachedFeedbackCheckout({
			extraExactRemote: true,
		});
		await activatePrWorkflow(checkout, 'feedback-ambiguous', 'PR_FEEDBACK');

		await expect(
			bindPrWorkflowHead(checkout, 'feedback-ambiguous', head),
		).rejects.toThrow('multiple remote-tracking');
		expect(
			(await readPrWorkflowGateState(checkout, 'feedback-ambiguous'))
				?.prHeadSha,
		).toBeUndefined();
		expect(expectGit(checkout, ['branch', '--show-current'])).toBe('');
	});

	test('recovers idempotently when switch succeeds but state persistence fails', async () => {
		const { checkout, head } = await makeDetachedFeedbackCheckout();
		await activatePrWorkflow(checkout, 'feedback-retry', 'PR_FEEDBACK');
		const denied = Object.assign(new Error('state write denied'), {
			code: 'EACCES',
		});
		_test_exports.beforePrFeedbackTrackingPersist = async () => {
			throw denied;
		};

		await expect(
			bindPrWorkflowHead(checkout, 'feedback-retry', head),
		).rejects.toThrow('state write denied');
		expect(expectGit(checkout, ['branch', '--show-current'])).toBe(
			'feature/nested',
		);
		expect(
			(await readPrWorkflowGateState(checkout, 'feedback-retry'))?.prHeadSha,
		).toBeUndefined();

		_test_exports.beforePrFeedbackTrackingPersist =
			originalBeforePrFeedbackTrackingPersist;
		await expect(
			bindPrWorkflowHead(checkout, 'feedback-retry', head),
		).resolves.toMatchObject({ prHeadSha: head });
	});
});
