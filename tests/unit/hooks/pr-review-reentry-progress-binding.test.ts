import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	reserveActivePrReviewReentryAuthorization,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	issuePrReviewReentryAuthorization,
	_internals as reentryInternals,
} from '../../../src/pr-review/authorization.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;

beforeEach(() => {
	directory = canonicalMkdtemp('pr-reentry-progress-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	await fs.rm(directory, { recursive: true, force: true });
});

async function establishActiveReview(): Promise<void> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
	});
}

/** Bump the gate state's revision on disk to simulate workflow progress. */
async function bumpGeneration(): Promise<number> {
	const statePath = path.join(
		directory,
		'.swarm',
		_test_exports.workflowGateStateRelativePath(PR_ARTIFACT_SESSION_ID),
	);
	const raw = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
		revision: number;
	};
	raw.revision += 1;
	await fs.writeFile(statePath, JSON.stringify(raw), 'utf8');
	_test_exports.resetTrackedStateCache();
	return raw.revision;
}

describe('pr-review re-entry reservation progress binding', () => {
	test('workflow progress between reserve and same-call verify fails closed', async () => {
		await establishActiveReview();
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		const reserved = await reserveActivePrReviewReentryAuthorization(
			directory,
			PR_ARTIFACT_SESSION_ID,
			{ role: 'reviewer', callID: 'burned-call' },
		);
		expect(reserved).not.toBeNull();
		// Controller state advanced after the reservation was committed. The
		// same call's later verification re-derives the CURRENT binding and
		// must fail closed: the one-shot authorization is burned for the old
		// generation and cannot be replayed against the new one.
		await bumpGeneration();
		await expect(
			reserveActivePrReviewReentryAuthorization(
				directory,
				PR_ARTIFACT_SESSION_ID,
				{
					role: 'reviewer',
					callID: 'burned-call',
				},
			),
		).resolves.toBeNull();
	});
});
