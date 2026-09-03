import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	hasActivePrReviewReentryAuthorization,
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

// Exercise the same lock-held production path used by the delegation gate;
// the former direct-consume compatibility export was intentionally removed.
const consumePrReviewReentryAuthorization =
	reserveActivePrReviewReentryAuthorization;

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
			expect(kept.map((record) => record.authorizationId)).toEqual([
				'used',
				'live',
			]);
		});
	});

	test('prune preserves every live authorization ahead of consumed replay history', () => {
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
				createdAt: new Date(now).toISOString(),
				expiresAt: new Date(now + 60_000).toISOString(),
			};
			const consumed = Array.from({ length: 32 }, (_, index) => ({
				...live,
				authorizationId: `used-${index}`,
				createdAt: new Date(now + index + 1).toISOString(),
				consumedAt: new Date(now + index + 1).toISOString(),
				consumedCallId: `call-${index}`,
			}));
			const kept = reentryInternals.pruneAuthorizations(
				[live, ...consumed],
				now,
			);
			expect(kept).toHaveLength(32);
			expect(kept.some((record) => record.authorizationId === 'live')).toBe(
				true,
			);
		});
	});

	test('PR workflow admission checks a token without consuming it', async () => {
		await establishActiveReview();
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		expect(
			await hasActivePrReviewReentryAuthorization(
				directory,
				PR_ARTIFACT_SESSION_ID,
				{ role: 'reviewer' },
			),
		).toBe(true);
		const filePath = reentryInternals.reentryAuthorizationFilePath(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		const stored = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
			authorizations: Array<{ consumedAt?: string }>;
		};
		expect(stored.authorizations[0]?.consumedAt).toBeUndefined();
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

	test('the winning call can verify its persisted reservation idempotently', async () => {
		await establishActiveReview();
		await issuePrReviewReentryAuthorization(directory, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		const request = { role: 'reviewer' as const, callID: 'same-call' };
		const reserved = await consumePrReviewReentryAuthorization(
			directory,
			PR_ARTIFACT_SESSION_ID,
			request,
		);
		const verified = await consumePrReviewReentryAuthorization(
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
		const settlesWithin = async (
			promise: Promise<unknown>,
			timeoutMs: number,
		): Promise<boolean> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					promise.then(() => true),
					new Promise<boolean>((resolve) => {
						timer = setTimeout(() => resolve(false), timeoutMs);
					}),
				]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		};
		// Negative control: the same activation path completes when no reservation
		// owns the workflow-session lock.
		expect(
			await settlesWithin(
				activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
					prHeadSha: PR_ARTIFACT_HEAD_SHA,
				}),
				1_000,
			),
		).toBe(true);
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
		let competingMutationSettled = false;
		const competingMutation = activatePrWorkflow(
			directory,
			PR_ARTIFACT_SESSION_ID,
			'PR_REVIEW',
			{ prHeadSha: PR_ARTIFACT_HEAD_SHA },
		).then(() => {
			competingMutationSettled = true;
		});
		expect(await settlesWithin(competingMutation, 100)).toBe(false);
		expect(competingMutationSettled).toBe(false);
		releaseReservation();
		expect(await reservation).not.toBeNull();
		await competingMutation;
		expect(competingMutationSettled).toBe(true);
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
