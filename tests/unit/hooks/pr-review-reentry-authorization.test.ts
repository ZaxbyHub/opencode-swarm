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
		const consumed = await reserveActivePrReviewReentryAuthorization(
			directory,
			PR_ARTIFACT_SESSION_ID,
			{ role: 'reviewer', callID: 'call-1' },
		);
		expect(consumed).not.toBeNull();
		expect(consumed!.consumedCallId).toBe('call-1');
		// REPLAY: a second consume finds nothing.
		await expect(
			reserveActivePrReviewReentryAuthorization(
				directory,
				PR_ARTIFACT_SESSION_ID,
				{
					role: 'reviewer',
					callID: 'call-2',
				},
			),
		).resolves.toBeNull();
	});

	test('wrong role does not consume a reviewer authorization', async () => {
		await establishActiveReview();
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		await expect(
			reserveActivePrReviewReentryAuthorization(
				directory,
				PR_ARTIFACT_SESSION_ID,
				{
					role: 'test_engineer',
					callID: 'call-1',
				},
			),
		).resolves.toBeNull();
		// The reviewer authorization is still unconsumed.
		const consumed = await reserveActivePrReviewReentryAuthorization(
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
			reserveActivePrReviewReentryAuthorization(directory, 'session-foreign', {
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
			reserveActivePrReviewReentryAuthorization(
				directory,
				PR_ARTIFACT_SESSION_ID,
				{
					role: 'reviewer',
					callID: 'call-1',
				},
			),
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
			reserveActivePrReviewReentryAuthorization(
				directory,
				PR_ARTIFACT_SESSION_ID,
				{
					role: 'reviewer',
					callID: 'call-1',
				},
			),
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

	test('prune retains unexpired consumed records for same-call verification', () => {
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
				consumedCallId: 'call-used',
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
			// Both survive; on a recency tie the unconsumed record sorts first
			// because prune prioritizes live authorizations within the cap.
			expect(kept.map((record) => record.authorizationId)).toEqual([
				'live',
				'used',
			]);
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
				reserveActivePrReviewReentryAuthorization(
					directory,
					PR_ARTIFACT_SESSION_ID,
					{
						role: 'reviewer',
						callID,
					},
				).catch(() => null),
			),
		);
		const winners = results.filter((result) => result !== null);
		expect(winners).toHaveLength(1);
	});

	test('the winning call can verify its persisted reservation idempotently', async () => {
		await establishActiveReview();
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		const request = { role: 'reviewer' as const, callID: 'same-call' };
		const reserved = await reserveActivePrReviewReentryAuthorization(
			directory,
			PR_ARTIFACT_SESSION_ID,
			request,
		);
		const verified = await reserveActivePrReviewReentryAuthorization(
			directory,
			PR_ARTIFACT_SESSION_ID,
			request,
		);
		expect(verified?.authorizationId).toBe(reserved?.authorizationId);
		expect(verified?.consumedCallId).toBe('same-call');
	});

	test('holds the workflow-session lock through authorization reservation commit', async () => {
		await establishActiveReview();
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		const ALTERNATE_SHA = 'e'.repeat(40);
		// Whether the head rebind resolves or rejects, settling requires the
		// session's workflow-state lock — that is the property under test.
		const competingBind = () =>
			activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
				prHeadSha: ALTERNATE_SHA,
			}).then(
				() => undefined,
				() => undefined,
			);
		const settlesWithin = async (
			promise: Promise<void>,
			budgetMs: number,
		): Promise<boolean> =>
			Promise.race([
				promise.then(() => true),
				new Promise<boolean>((resolve) =>
					setTimeout(() => resolve(false), budgetMs),
				),
			]);
		// Negative control: an uncontended mutation of the exact same shape
		// settles well inside the 2s budget, so the held-lock assertion below
		// cannot pass merely because the call is slow. It runs on a separate
		// session so it cannot disturb this session's gate state.
		const controlSettled = await settlesWithin(
			activatePrWorkflow(directory, 'lock-control-session', 'PR_REVIEW', {
				prHeadSha: ALTERNATE_SHA,
			}).then(
				() => undefined,
				() => undefined,
			),
			2_000,
		);
		expect(controlSettled).toBe(true);

		let signalEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			signalEntered = resolve;
		});
		let releaseReservation!: () => void;
		const hold = new Promise<void>((resolve) => {
			releaseReservation = resolve;
		});
		_test_exports.beforePrReviewReentryReservation = async () => {
			signalEntered();
			await hold;
		};
		const reservation = reserveActivePrReviewReentryAuthorization(
			directory,
			PR_ARTIFACT_SESSION_ID,
			{ role: 'reviewer', callID: 'locked-call' },
		);
		await entered;
		const competingSettled = await settlesWithin(competingBind(), 2_000);
		expect(competingSettled).toBe(false);
		releaseReservation();
		expect(await reservation).not.toBeNull();
	});

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
