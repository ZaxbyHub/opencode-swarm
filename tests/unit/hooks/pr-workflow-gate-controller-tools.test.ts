import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
	type PrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-controller-tools-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => 'abc123';
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolvePrWorkflowRevisionDigest = () => 'revision-1';
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	await fs.rm(directory, { recursive: true, force: true });
});

/** Write a raw armed PR_FEEDBACK state directly to disk. */
async function writeArmedState(sessionID: string): Promise<void> {
	const relative = _test_exports.workflowGateStateRelativePath(sessionID);
	const absolute = path.join(directory, '.swarm', relative);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	const state: PrWorkflowGateState = {
		schemaVersion: 1,
		revision: 5,
		sessionID,
		mode: 'PR_FEEDBACK',
		activatedAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T00:00:00.000Z',
		prHeadSha: 'abc123',
		prFeedbackReadyToPublish: {
			revisionDigest: 'revision-1',
			localHead: 'def456',
			remoteName: 'origin',
			remoteBranchRef: 'refs/heads/fix/x',
			remoteRef: 'refs/remotes/origin/fix/x',
			validatedAt: '2026-07-19T00:00:00.000Z',
		} as PrWorkflowGateState['prFeedbackReadyToPublish'],
	};
	await fs.writeFile(absolute, JSON.stringify(state, null, 2), 'utf-8');
}

describe('abort_pr_workflow controller-tool gating (defense in depth)', () => {
	test('passes the PR_REVIEW read-only gate as an internal controller tool', async () => {
		// The deadlock scenario: PR_REVIEW is active but unbound. Every bash
		// command fails closed, but abort_pr_workflow must be reachable so the
		// architect can clear the gate.
		await activatePrWorkflow(directory, 'stuck-review', 'PR_REVIEW');
		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				'stuck-review',
				'abort_pr_workflow',
				{ mode: 'PR_REVIEW' },
			),
		).resolves.toBeUndefined();
	});

	test('passes the PR_FEEDBACK pre-armed (bound-but-not-armed) gate', async () => {
		// The realistic PR_FEEDBACK deadlock: the workflow is activated AND
		// bound to a PR head, but the architect cannot complete the ordered
		// mechanical gates (Stage A, Stage B, closeout). Before arming,
		// abort_pr_workflow must be reachable so the architect can clear the
		// gate without forcing the workflow through to publication.
		await activatePrWorkflow(directory, 'feedback-bound', 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				'feedback-bound',
				'abort_pr_workflow',
				{ mode: 'PR_FEEDBACK' },
			),
		).resolves.toBeUndefined();
	});

	test('is REJECTED by the armed-publication branch (defense in depth)', async () => {
		// Once PR_FEEDBACK is armed, abort must fail closed at the tool gate
		// too — not only at the hook. This is the deliberate omission called
		// out in the source comment at the armed branch.
		await writeArmedState('armed');
		await expect(
			enforcePrWorkflowToolBefore(directory, 'armed', 'abort_pr_workflow', {
				mode: 'PR_FEEDBACK',
			}),
		).rejects.toThrow(/armed for publication/i);
	});

	test('bash stays fail-closed under the same unbound PR_REVIEW gate', async () => {
		// Sanity check: the abort tool being reachable does NOT loosen the
		// read-only shell surface. A compound `git fetch && git checkout`
		// (the literal trigger from the incident) must still be rejected.
		await activatePrWorkflow(directory, 'stuck-review-2', 'PR_REVIEW');
		await expect(
			enforcePrWorkflowToolBefore(directory, 'stuck-review-2', 'bash', {
				command: 'git fetch origin && git checkout pr-431-head',
			}),
		).rejects.toThrow(/read-only and fail-closed/i);
	});
});
