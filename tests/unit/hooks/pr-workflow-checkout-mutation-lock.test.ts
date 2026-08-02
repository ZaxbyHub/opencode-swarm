import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	bindPrWorkflowHead,
	withPrWorkflowCheckoutMutationLock,
	withPrWorkflowCheckoutPreparationLock,
} from '../../../src/hooks/pr-workflow-gate';

let directory = '';
const originalIsProcessAlive = _test_exports.isProcessAlive;
const originalOpenCheckoutLock = _test_exports.openCheckoutLock;
const originalRemoveCheckoutLock = _test_exports.removeCheckoutLock;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;
const originalResolveCurrentUpstreamPushTargetAsync =
	_test_exports.resolveCurrentUpstreamPushTargetAsync;
const originalResolveRemoteRefsContainingHeadAsync =
	_test_exports.resolveRemoteRefsContainingHeadAsync;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'checkout-mutation-lock-')),
	);
	_test_exports.resetTrackedStateCache();
});

afterEach(async () => {
	_test_exports.isProcessAlive = originalIsProcessAlive;
	_test_exports.openCheckoutLock = originalOpenCheckoutLock;
	_test_exports.removeCheckoutLock = originalRemoveCheckoutLock;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	_test_exports.resolveCurrentUpstreamPushTargetAsync =
		originalResolveCurrentUpstreamPushTargetAsync;
	_test_exports.resolveRemoteRefsContainingHeadAsync =
		originalResolveRemoteRefsContainingHeadAsync;
	_test_exports.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('project-scoped checkout mutation lock', () => {
	test('serializes different session actions in one project', async () => {
		let releaseFirst!: () => void;
		const firstMayFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstEntered!: () => void;
		const firstDidEnter = new Promise<void>((resolve) => {
			firstEntered = resolve;
		});
		const order: string[] = [];

		const first = withPrWorkflowCheckoutMutationLock(directory, async () => {
			order.push('session-a-enter');
			firstEntered();
			await firstMayFinish;
			order.push('session-a-exit');
		});
		await firstDidEnter;
		const second = withPrWorkflowCheckoutMutationLock(directory, async () => {
			order.push('session-b-enter');
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		expect(order).toEqual(['session-a-enter']);

		releaseFirst();
		await Promise.all([first, second]);
		expect(order).toEqual([
			'session-a-enter',
			'session-a-exit',
			'session-b-enter',
		]);
	});

	test('serializes checkout preparation against another session head attachment', async () => {
		const head = 'a'.repeat(40);
		_test_exports.resolveCurrentGitHeadAsync = async () => head;
		_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
		_test_exports.resolveCurrentUpstreamPushTargetAsync = async () => ({
			remoteName: 'origin',
			remoteBranchRef: 'refs/heads/pr-head',
			remoteTrackingRef: 'refs/remotes/origin/pr-head',
		});
		_test_exports.resolveRemoteRefsContainingHeadAsync = async () => [
			'refs/remotes/origin/pr-head',
		];
		await activatePrWorkflow(directory, 'prepare-session', 'PR_FEEDBACK');
		await activatePrWorkflow(directory, 'attach-session', 'PR_FEEDBACK');
		let releasePreparation!: () => void;
		const preparationMayFinish = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		let preparationEntered!: () => void;
		const preparationDidEnter = new Promise<void>((resolve) => {
			preparationEntered = resolve;
		});
		const preparation = withPrWorkflowCheckoutPreparationLock(
			directory,
			'prepare-session',
			async () => {
				preparationEntered();
				await preparationMayFinish;
			},
		);
		await preparationDidEnter;
		let attachmentSettled = false;
		const attachment = bindPrWorkflowHead(
			directory,
			'attach-session',
			head,
		).finally(() => {
			attachmentSettled = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		expect(attachmentSettled).toBe(false);

		releasePreparation();
		await expect(attachment).resolves.toMatchObject({ prHeadSha: head });
		await preparation;
	});

	test('reclaims a lock whose recorded process is no longer alive', async () => {
		const relative = _test_exports.workflowCheckoutMutationLockRelativePath();
		const lockPath = path.join(directory, '.swarm', relative);
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
		await fs.writeFile(
			lockPath,
			JSON.stringify({
				ownerToken: 'abandoned-owner',
				pid: 123456,
				createdAtMs: Date.now() - 60_000,
			}),
			'utf-8',
		);
		_test_exports.isProcessAlive = () => false;

		await expect(
			withPrWorkflowCheckoutMutationLock(directory, async () => 'entered'),
		).resolves.toBe('entered');
		await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('fails closed when the checkout lock cannot be created', async () => {
		const denied = Object.assign(new Error('checkout lock denied'), {
			code: 'EACCES',
		});
		_test_exports.openCheckoutLock = async () => {
			throw denied;
		};
		let entered = false;

		await expect(
			withPrWorkflowCheckoutMutationLock(directory, async () => {
				entered = true;
			}),
		).rejects.toThrow('checkout lock denied');
		expect(entered).toBe(false);
	});

	test('removes an exclusively-created lock when metadata writing fails', async () => {
		const lockPath = path.join(
			directory,
			'.swarm',
			_test_exports.workflowCheckoutMutationLockRelativePath(),
		);
		_test_exports.beforeCheckoutLockWrite = async () => {
			throw new Error('checkout lock metadata denied');
		};

		await expect(
			withPrWorkflowCheckoutMutationLock(directory, async () => 'not-entered'),
		).rejects.toThrow('checkout lock metadata denied');
		await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

		_test_exports.beforeCheckoutLockWrite = undefined;
		await expect(
			withPrWorkflowCheckoutMutationLock(directory, async () => 'entered'),
		).resolves.toBe('entered');
	});

	test('retries a transient checkout-lock removal failure', async () => {
		let failuresRemaining = 1;
		_test_exports.removeCheckoutLock = async (lockPath) => {
			if (failuresRemaining-- > 0) {
				throw Object.assign(new Error('checkout lock busy'), { code: 'EBUSY' });
			}
			await originalRemoveCheckoutLock(lockPath);
		};

		await expect(
			withPrWorkflowCheckoutMutationLock(directory, async () => 'entered'),
		).resolves.toBe('entered');
		expect(failuresRemaining).toBe(-1);
	});

	test('reclaims a completed same-process lock after persistent removal failure', async () => {
		const lockPath = path.join(
			directory,
			'.swarm',
			_test_exports.workflowCheckoutMutationLockRelativePath(),
		);
		_test_exports.removeCheckoutLock = async () => {
			throw Object.assign(new Error('checkout lock persistently busy'), {
				code: 'EBUSY',
			});
		};

		await expect(
			withPrWorkflowCheckoutMutationLock(
				directory,
				async () => 'first-entered',
			),
		).rejects.toThrow('checkout lock persistently busy');
		await expect(fs.stat(lockPath)).resolves.toBeDefined();

		_test_exports.removeCheckoutLock = originalRemoveCheckoutLock;
		await expect(
			withPrWorkflowCheckoutMutationLock(
				directory,
				async () => 'second-entered',
			),
		).resolves.toBe('second-entered');
		await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('rejects a live cross-process contender before entering its action', async () => {
		const fixture = path.resolve(
			'tests/fixtures/pr-workflow-checkout-lock-holder.ts',
		);
		let child: ChildProcess | undefined;
		try {
			child = spawn(process.execPath, [fixture, directory], {
				cwd: process.cwd(),
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 10_000,
				windowsHide: true,
			});
			await waitForLockSignal(child);
			let entered = false;
			await expect(
				withPrWorkflowCheckoutMutationLock(directory, async () => {
					entered = true;
				}),
			).rejects.toThrow('another process');
			expect(entered).toBe(false);
		} finally {
			try {
				child?.kill();
			} catch {
				// Child already exited.
			}
		}
	});
});

async function waitForLockSignal(child: ChildProcess): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		const timeout = setTimeout(() => {
			reject(new Error(`lock-holder signal timed out: ${stderr}`));
		}, 5_000);
		const finish = (error?: Error) => {
			clearTimeout(timeout);
			if (error) reject(error);
			else resolve();
		};
		child.stdout?.setEncoding('utf-8');
		child.stdout?.on('data', (chunk: string) => {
			stdout = `${stdout}${chunk}`.slice(-8_192);
			if (stdout.includes('LOCKED')) finish();
		});
		child.stderr?.setEncoding('utf-8');
		child.stderr?.on('data', (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-8_192);
		});
		child.once('error', (error) => finish(error));
		child.once('exit', (code) => {
			if (!stdout.includes('LOCKED')) {
				finish(new Error(`lock holder exited ${code}: ${stderr}`));
			}
		});
	});
}
