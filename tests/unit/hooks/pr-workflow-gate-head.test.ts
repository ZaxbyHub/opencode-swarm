import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	assertPrReviewBaseCoverageSettled,
	bindPrReviewBase,
	bindPrWorkflowHead,
	clearPrWorkflowGateState,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { withFrozenClock } from '../../helpers/test-clock.js';

const HEAD_SHA = 'abcdef1234567890';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;
const originalIsProcessAlive = _test_exports.isProcessAlive;
const originalNowMs = _test_exports.nowMs;
let directory = '';

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-gate-head-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveIsWorkingTreeClean = () => true;
	// The gate bind/verify path resolves Git off the blocking spawn (async).
	// Route the async resolvers through the sync stubs each test already sets,
	// so existing synchronous fixtures drive the async production path.
	_test_exports.resolveCurrentGitHeadAsync = async (dir) =>
		_test_exports.resolveCurrentGitHead(dir);
	_test_exports.resolveIsWorkingTreeCleanAsync = async (dir) =>
		_test_exports.resolveIsWorkingTreeClean(dir);
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	_test_exports.isProcessAlive = originalIsProcessAlive;
	_test_exports.nowMs = originalNowMs;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR workflow exact checkout head', () => {
	test('fails closed when HEAD is unavailable or differs from the claimed PR head', async () => {
		await activatePrWorkflow(directory, 'review-head', 'PR_REVIEW');
		_test_exports.resolveCurrentGitHead = () => null;
		await expect(
			bindPrWorkflowHead(directory, 'review-head', HEAD_SHA),
		).rejects.toThrow('cannot resolve the current Git HEAD');

		_test_exports.resolveCurrentGitHead = () => 'different-head';
		await expect(
			bindPrWorkflowHead(directory, 'review-head', HEAD_SHA),
		).rejects.toThrow('does not match PR head');
	});

	test('diagnostic-rich error when HEAD cannot be resolved (issue #1931)', async () => {
		// The null-HEAD branch must name the directory and the exact
		// remediation command so callers can self-diagnose instead of
		// cascading into fictional root causes (missing gate file, etc).
		await activatePrWorkflow(directory, 'review-diagnostic', 'PR_REVIEW');
		_test_exports.resolveCurrentGitHead = () => null;
		const promise = bindPrWorkflowHead(
			directory,
			'review-diagnostic',
			HEAD_SHA,
		);
		await expect(promise).rejects.toThrow(
			`cannot resolve the current Git HEAD in "${directory}"`,
		);
		await expect(promise).rejects.toThrow('git -C');
		await expect(promise).rejects.toThrow('rev-parse --verify HEAD^{commit}');
		// Must enumerate at least one real cause so the caller knows where
		// to look (unborn HEAD, shallow clone, missing binary, timeout, non-repo).
		await expect(promise).rejects.toThrow(
			/unborn|shallow|PATH|timed out|repository/i,
		);
	});

	test('diagnostic-rich error when HEAD does not match (issue #1931)', async () => {
		// The mismatch branch must name the directory and the exact
		// remediation command (switch --detach) so the caller can recover.
		await activatePrWorkflow(directory, 'review-mismatch', 'PR_REVIEW');
		_test_exports.resolveCurrentGitHead = () => 'different-head';
		const promise = bindPrWorkflowHead(directory, 'review-mismatch', HEAD_SHA);
		await expect(promise).rejects.toThrow(
			`does not match PR head "${HEAD_SHA}"`,
		);
		await expect(promise).rejects.toThrow(`working directory: "${directory}"`);
		await expect(promise).rejects.toThrow(/switch --detach/);
	});

	test('revalidates live HEAD throughout PR review after binding', async () => {
		await activatePrWorkflow(directory, 'review-drift', 'PR_REVIEW');
		_test_exports.resolveCurrentGitHead = () => HEAD_SHA.toUpperCase();
		await bindPrWorkflowHead(directory, 'review-drift', HEAD_SHA);

		_test_exports.resolveCurrentGitHead = () => 'later-checkout';
		await expect(
			assertPrReviewBaseCoverageSettled(directory, 'review-drift'),
		).rejects.toThrow('does not match PR head');
	});

	test('fails closed when the exact PR checkout is dirty or cleanliness is unknown', async () => {
		await activatePrWorkflow(directory, 'review-dirty', 'PR_REVIEW');
		_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
		for (const cleanliness of [false, null]) {
			_test_exports.resolveIsWorkingTreeClean = () => cleanliness;
			await expect(
				bindPrWorkflowHead(directory, 'review-dirty', HEAD_SHA),
			).rejects.toThrow('clean index and working tree');
		}
	});

	test('keeps a durable gate when a concurrent transition changes its revision before terminal clear', async () => {
		_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
		await activatePrWorkflow(directory, 'completion-race', 'PR_REVIEW');
		const completionSnapshot = await readPrWorkflowGateState(
			directory,
			'completion-race',
		);
		expect(completionSnapshot).not.toBeNull();

		// This models a same-session mutation that lands after completion has
		// validated its snapshot but before it removes the durable gate.
		await bindPrWorkflowHead(directory, 'completion-race', HEAD_SHA);

		await expect(
			clearPrWorkflowGateState(
				directory,
				'completion-race',
				completionSnapshot!.revision,
			),
		).rejects.toThrow('state changed during terminal completion');
		const current = await readPrWorkflowGateState(directory, 'completion-race');
		expect(current?.prHeadSha).toBe(HEAD_SHA);
		expect(current?.revision).toBe(completionSnapshot!.revision + 1);
	});

	test('refreshes cached state after an external writer updates then clears the durable file', async () => {
		const sessionID = 'external-state-refresh';
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		const cached = await readPrWorkflowGateState(directory, sessionID);
		expect(cached).not.toBeNull();
		const statePath = path.join(
			directory,
			'.swarm',
			_test_exports.workflowGateStateRelativePath(sessionID),
		);
		const external = {
			...cached!,
			revision: cached!.revision + 1,
			updatedAt: withFrozenClock(() => new Date().toISOString()),
		};
		await fs.writeFile(statePath, JSON.stringify(external), 'utf-8');

		const refreshed = await readPrWorkflowGateState(directory, sessionID);
		expect(refreshed?.revision).toBe(external.revision);

		await fs.rm(statePath);
		await expect(
			readPrWorkflowGateState(directory, sessionID),
		).resolves.toBeNull();
	});

	test('clears pre-existing checkoutRecovery on successful bind (ML-TI-001)', async () => {
		const sessionID = 'clear-checkout-recovery';
		_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		const statePath = path.join(
			directory,
			'.swarm',
			_test_exports.workflowGateStateRelativePath(sessionID),
		);
		const existing = await readPrWorkflowGateState(directory, sessionID);
		await fs.writeFile(
			statePath,
			JSON.stringify({
				...existing!,
				checkoutRecovery: {
					code: 'GIT_STATE_INDETERMINATE',
					retryable: false,
					requiredAction: 'Resolve the indeterminate git state.',
					evidence: {
						worktreeRoot: directory,
						gitDir: null,
						operations: [],
						unmergedCodes: [],
						paths: [],
						trackedCount: 0,
						untrackedCount: 0,
						pathsTruncated: false,
					},
					detectedAt: '2026-01-01T00:00:00Z',
				},
			}),
			'utf-8',
		);
		_test_exports.resetTrackedStateCache();

		// Precondition: checkoutRecovery must be present before bind to prove clearing.
		const preBind = await readPrWorkflowGateState(directory, sessionID);
		expect((preBind as Record<string, unknown>).checkoutRecovery).toBeDefined();

		await bindPrWorkflowHead(directory, sessionID, HEAD_SHA);

		const bound = await readPrWorkflowGateState(directory, sessionID);
		expect(bound?.prHeadSha).toBe(HEAD_SHA);
		expect((bound as Record<string, unknown>).checkoutRecovery).toBeUndefined();
	});

	test('reclaims a lock abandoned by a crashed process without removing a live owner lock', async () => {
		const sessionID = 'abandoned-lock';
		_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		const lockPath = path.join(
			directory,
			'.swarm',
			_test_exports.workflowGateStateLockRelativePath(sessionID),
		);
		await fs.writeFile(
			lockPath,
			JSON.stringify({
				ownerToken: 'crashed-owner',
				pid: 999_999,
				createdAtMs: 0,
			}),
			'utf-8',
		);
		_test_exports.isProcessAlive = () => false;

		await expect(
			bindPrWorkflowHead(directory, sessionID, HEAD_SHA),
		).resolves.toMatchObject({ prHeadSha: HEAD_SHA });
		await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

		await fs.writeFile(
			lockPath,
			JSON.stringify({
				ownerToken: 'live-owner',
				pid: 1,
				createdAtMs: 0,
			}),
			'utf-8',
		);
		_test_exports.isProcessAlive = () => true;
		await expect(
			bindPrReviewBase(directory, sessionID, {
				prHeadSha: HEAD_SHA,
				baseRef: 'main',
				baseSha: '1234567890abcdef',
			}),
		).rejects.toThrow('being mutated by another process');
	});

	test('reclaims an uninitialized lock left by a crash during lock creation', async () => {
		const sessionID = 'uninitialized-lock';
		_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		const lockPath = path.join(
			directory,
			'.swarm',
			_test_exports.workflowGateStateLockRelativePath(sessionID),
		);
		await fs.writeFile(lockPath, '', 'utf-8');
		await fs.utimes(lockPath, 0, 0);

		await expect(
			bindPrWorkflowHead(directory, sessionID, HEAD_SHA),
		).resolves.toMatchObject({ prHeadSha: HEAD_SHA });
		await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test.skipIf(process.platform === 'win32')(
		'rejects a state-lock parent swapped after exclusive open (PRR-009)',
		async () => {
			const sessionID = 'state-lock-parent-swap';
			_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
			await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
			const lockPath = path.join(
				directory,
				'.swarm',
				_test_exports.workflowGateStateLockRelativePath(sessionID),
			);
			const gateDirectory = path.dirname(lockPath);
			const preserved = `${gateDirectory}-preserved`;
			const outside = path.join(directory, 'outside-state-lock-race');
			let swapInstalled = false;
			await fs.mkdir(outside, { recursive: true });
			_test_exports.beforeSessionStateLockWrite = async () => {
				_test_exports.beforeSessionStateLockWrite = undefined;
				await fs.rename(gateDirectory, preserved);
				await fs.symlink(
					outside,
					gateDirectory,
					process.platform === 'win32' ? 'junction' : 'dir',
				);
				expect(path.normalize(await fs.realpath(gateDirectory))).toBe(
					path.normalize(await fs.realpath(outside)),
				);
				swapInstalled = true;
			};

			await expect(
				bindPrWorkflowHead(directory, sessionID, HEAD_SHA),
			).rejects.toThrow(/changed|escaped|ENOENT/i);
			expect(swapInstalled).toBe(true);
			expect(await fs.readdir(outside)).toEqual([]);
		},
	);

	test.skipIf(process.platform !== 'win32')(
		'Windows blocks a state-lock parent rename after exclusive open (PRR-009)',
		async () => {
			const sessionID = 'state-lock-parent-rename-blocked';
			_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
			await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
			const lockPath = path.join(
				directory,
				'.swarm',
				_test_exports.workflowGateStateLockRelativePath(sessionID),
			);
			const gateDirectory = path.dirname(lockPath);
			const preserved = `${gateDirectory}-preserved`;
			let hookReached = false;
			let renameBlocked = false;
			_test_exports.beforeSessionStateLockWrite = async () => {
				_test_exports.beforeSessionStateLockWrite = undefined;
				hookReached = true;
				try {
					await fs.rename(gateDirectory, preserved);
				} catch (error) {
					renameBlocked = (error as NodeJS.ErrnoException).code === 'EPERM';
					throw error;
				}
			};

			await expect(
				bindPrWorkflowHead(directory, sessionID, HEAD_SHA),
			).rejects.toThrow(/EPERM/i);
			expect(hookReached).toBe(true);
			expect(renameBlocked).toBe(true);
		},
	);
});
