import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	consumePrReviewReentryAuthorization,
	issuePrReviewReentryAuthorization,
	_internals as reentryInternals,
} from '../../../src/pr-review/authorization.js';
import {
	_test_exports,
	activatePrWorkflow,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;

beforeEach(() => {
	directory = canonicalMkdtemp('pr-reentry-auth-');
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
	const statePath = `${directory}/.swarm/${_test_exports.workflowGateStateRelativePath(PR_ARTIFACT_SESSION_ID)}`;
	const raw = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
		revision: number;
	};
	raw.revision += 1;
	await fs.writeFile(statePath, JSON.stringify(raw), 'utf8');
	_test_exports.resetTrackedStateCache();
	return raw.revision;
}

describe('pr-review reentry authorization (issue #2383)', () => {
	test('issue requires an active head-bound PR_REVIEW workflow', async () => {
		await expect(
			issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				role: 'reviewer',
			}),
		).rejects.toThrow(/active PR_REVIEW workflow/);
	});

	test('issue binds the exact active identity and is consumable exactly once', async () => {
		await establishActiveReview();
		const record = await issuePrReviewReentryAuthorization(
			directory,
			PR_ARTIFACT_SESSION_ID,
			{ prHeadSha: PR_ARTIFACT_HEAD_SHA, role: 'reviewer' },
		);
		expect(record).toMatchObject({
			sessionId: PR_ARTIFACT_SESSION_ID,
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			revisionDigest: PR_ARTIFACT_REVISION_DIGEST,
			role: 'reviewer',
		});
		expect(record.generation).toBeGreaterThanOrEqual(0);
		const consumed = await consumePrReviewReentryAuthorization(
			directory,
			PR_ARTIFACT_SESSION_ID,
			{ role: 'reviewer', callID: 'call-1' },
		);
		expect(consumed).not.toBeNull();
		expect(consumed!.consumedCallId).toBe('call-1');
		// REPLAY: a second consume finds nothing.
		await expect(
			consumePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
				role: 'reviewer',
				callID: 'call-2',
			}),
		).resolves.toBeNull();
	});

	test('wrong role does not consume a reviewer authorization', async () => {
		await establishActiveReview();
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		await expect(
			consumePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
				role: 'test_engineer',
				callID: 'call-1',
			}),
		).resolves.toBeNull();
		// The reviewer authorization is still unconsumed.
		const consumed = await consumePrReviewReentryAuthorization(
			directory,
			PR_ARTIFACT_SESSION_ID,
			{ role: 'reviewer', callID: 'call-2' },
		);
		expect(consumed).not.toBeNull();
	});

	test('a foreign session cannot consume another session\u2019s authorization', async () => {
		await establishActiveReview();
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		await expect(
			consumePrReviewReentryAuthorization(directory, 'session-foreign', {
				role: 'reviewer',
				callID: 'call-1',
			}),
		).resolves.toBeNull();
	});

	test('a stale generation (workflow progressed) fails closed at consume time', async () => {
		await establishActiveReview();
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		const nextGeneration = await bumpGeneration();
		expect(nextGeneration).toBeGreaterThan(1);
		// The store still holds the record, but the CURRENT gate generation moved:
		// consume must fail closed to null.
		await expect(
			consumePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
				role: 'reviewer',
				callID: 'call-1',
			}),
		).resolves.toBeNull();
	});

	test('expired authorizations are pruned and not consumable', async () => {
		await establishActiveReview();
		const record = await issuePrReviewReentryAuthorization(
			directory,
			PR_ARTIFACT_SESSION_ID,
			{ prHeadSha: PR_ARTIFACT_HEAD_SHA, role: 'reviewer' },
		);
		// Rewrite the store with the record already expired.
		const filePath = reentryInternals.reentryAuthorizationFilePath(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		const expired = {
			...record,
			expiresAt: '2020-01-01T00:00:00.000Z',
		};
		await fs.writeFile(
			filePath,
			JSON.stringify(
				{
					schemaVersion: 1,
					sessionId: record.sessionId,
					authorizations: [expired],
				},
				null,
				2,
			) + '\n',
			'utf8',
		);
		await expect(
			consumePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
				role: 'reviewer',
				callID: 'call-1',
			}),
		).resolves.toBeNull();
	});

	test('issue refuses stockpiling an unconsumed same-role+generation authorization', async () => {
		await establishActiveReview();
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		await expect(
			issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				role: 'reviewer',
			}),
		).rejects.toThrow(/unconsumed re-entry authorization/);
		// A different role is a separate slot.
		await expect(
			issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				role: 'test_engineer',
			}),
		).resolves.toBeTruthy();
	});

	test('prune drops consumed and expired records', () => {
		withFrozenClock(() => {
			const now = Date.now();
			const live = {
				schemaVersion: 1 as const,
				authorizationId: 'live',
				sessionId: 's',
				prHeadSha: 'abc123',
				revisionDigest: 'd',
				role: 'reviewer' as const,
				generation: 1,
				createdAt: new Date(now - 1000).toISOString(),
				expiresAt: new Date(now + 60_000).toISOString(),
			};
			const consumed = {
				...live,
				authorizationId: 'used',
				consumedAt: new Date(now).toISOString(),
			};
			const expired = {
				...live,
				authorizationId: 'old',
				expiresAt: new Date(now - 1).toISOString(),
			};
			const kept = reentryInternals.pruneAuthorizations(
				[consumed, expired, live],
				now,
			);
			expect(kept.map((record) => record.authorizationId)).toEqual(['live']);
		});
	});

	test('a concurrent double-consume has exactly one winner', async () => {
		await establishActiveReview();
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		const results = await Promise.all(
			['call-a', 'call-b', 'call-c'].map((callID) =>
				consumePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
					role: 'reviewer',
					callID,
				}).catch(() => null),
			),
		);
		const winners = results.filter((result) => result !== null);
		expect(winners).toHaveLength(1);
	});
});

describe('renameWithRetryAsync Windows retry contract (PRR-003)', () => {
	const originalRenameImpl = reentryInternals.renameImpl;
	const originalDelays = reentryInternals.renameRetryDelaysMs;
	// Shrink the backoff so exhaustion tests do not real-sleep 385 ms.
	const fastDelays = [1, 1, 1, 1, 1];

	afterEach(() => {
		reentryInternals.renameImpl = originalRenameImpl;
		reentryInternals.renameRetryDelaysMs = originalDelays;
	});

	const codedError = (code: string) => Object.assign(new Error(code), { code });

	test('retries a transient EPERM/EBUSY and succeeds without extra calls', async () => {
		let calls = 0;
		reentryInternals.renameImpl = async () => {
			calls++;
			if (calls <= 2) throw codedError(calls === 1 ? 'EPERM' : 'EBUSY');
			return undefined;
		};
		await expect(
			reentryInternals.renameWithRetryAsync('from', 'to'),
		).resolves.toBeUndefined();
		expect(calls).toBe(3);
	});

	test('a non-retryable code rethrows immediately (single call)', async () => {
		let calls = 0;
		reentryInternals.renameImpl = async () => {
			calls++;
			throw codedError('ENOENT');
		};
		await expect(
			reentryInternals.renameWithRetryAsync('from', 'to'),
		).rejects.toMatchObject({ code: 'ENOENT' });
		expect(calls).toBe(1);
	});

	test('persistent retryable failure exhausts the bounded schedule', async () => {
		let calls = 0;
		reentryInternals.renameImpl = async () => {
			calls++;
			throw codedError('EBUSY');
		};
		reentryInternals.renameRetryDelaysMs = fastDelays;
		await expect(
			reentryInternals.renameWithRetryAsync('from', 'to'),
		).rejects.toMatchObject({ code: 'EBUSY' });
		// Initial attempt + one retry per delay entry.
		expect(calls).toBe(fastDelays.length + 1);
	});

	test('writeAuthorizationFile leaves no stranded temp file after rename failure', async () => {
		reentryInternals.renameImpl = async () => {
			throw codedError('ENOENT');
		};
		const storePath = reentryInternals.reentryAuthorizationFilePath(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		const record = {
			schemaVersion: 1 as const,
			authorizationId: 'temp-leftover',
			sessionId: PR_ARTIFACT_SESSION_ID,
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			revisionDigest: PR_ARTIFACT_REVISION_DIGEST,
			role: 'reviewer' as const,
			generation: 0,
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		};
		await expect(
			reentryInternals.writeAuthorizationFile(storePath, {
				schemaVersion: 1,
				sessionId: PR_ARTIFACT_SESSION_ID,
				authorizations: [record],
			}),
		).rejects.toMatchObject({ code: 'ENOENT' });
		const siblings = await fs.readdir(path.dirname(storePath));
		expect(siblings.filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});
});
