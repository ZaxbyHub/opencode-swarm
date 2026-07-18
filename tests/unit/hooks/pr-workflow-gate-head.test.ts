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

const HEAD_SHA = 'abcdef1234567890';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalIsProcessAlive = _test_exports.isProcessAlive;
const originalNowMs = _test_exports.nowMs;
let directory = '';

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-gate-head-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveIsWorkingTreeClean = () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
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
		).rejects.toThrow('cannot verify the current Git HEAD');

		_test_exports.resolveCurrentGitHead = () => 'different-head';
		await expect(
			bindPrWorkflowHead(directory, 'review-head', HEAD_SHA),
		).rejects.toThrow('does not match PR head');
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
			updatedAt: new Date().toISOString(),
		};
		await fs.writeFile(statePath, JSON.stringify(external), 'utf-8');

		const refreshed = await readPrWorkflowGateState(directory, sessionID);
		expect(refreshed?.revision).toBe(external.revision);

		await fs.rm(statePath);
		await expect(
			readPrWorkflowGateState(directory, sessionID),
		).resolves.toBeNull();
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
});
