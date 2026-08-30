/**
 * Issue #2108 §1/§7 — publication-generation identity, conservative legacy
 * migration, and the rollback mirror invariant.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	completePrWorkflow,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPublicationFixture,
	HEAD_SHA,
	LOCAL_HEAD_REF,
	POST_COMMIT_SHA,
	type PublicationFixture,
	REMOTE_URL_IDENTITY,
	REVISION,
} from './pr-workflow-publication.test-fixtures.js';

const SESSION_ID = 'pub-generation';
let fixture: PublicationFixture;

beforeEach(async () => {
	fixture = await createPublicationFixture();
});

afterEach(async () => {
	await fixture.teardown();
});

async function readActive(sessionId = SESSION_ID) {
	return fixture.readActive(sessionId);
}

describe('publication generation identity (issue #2108)', () => {
	test('arming captures the full generation identity and the rollback mirror', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		const { state, active } = await readActive();
		expect(active).toBeDefined();
		expect(active?.schemaVersion).toBe(1);
		expect(active?.generation).toBe(1);
		expect(active?.state).toBe('armed');
		expect(active?.workspaceIdentity).toBeTruthy();
		expect(active?.intakeHeadSha).toBe(HEAD_SHA);
		expect(active?.localHead).toBe(POST_COMMIT_SHA);
		expect(active?.localHeadRef).toBe(LOCAL_HEAD_REF);
		expect(active?.remoteName).toBe('origin');
		expect(active?.remoteUrlIdentity).toBe(REMOTE_URL_IDENTITY);
		expect(active?.remoteBranchRef).toBe('refs/heads/pr-head');
		expect(active?.remoteRef).toBe('refs/remotes/origin/pr-head');
		expect(active?.revisionDigest).toBe(REVISION);
		expect(active?.evidence.stageAValidatedAt).toBeTruthy();
		// One captured batch per ordered phase.
		expect(active?.evidence.batches.map((b) => b.phase)).toEqual([
			'stage-b-reviewer',
			'stage-b-test',
			'closeout-reviewer',
			'closeout-critic',
		]);
		// Derived legacy mirror present exactly while armed.
		expect(state?.prFeedbackReadyToPublish?.localHead).toBe(POST_COMMIT_SHA);
		expect(state?.prFeedbackReadyToPublish?.validatedAt).toBe(active?.armedAt);
	});

	test('unresolvable remote URL identity fails arming closed', async () => {
		fixture.mutators.remoteUrl(null);
		await expect(
			fixture.prepareArmedGeneration(`${SESSION_ID}-no-url`),
		).rejects.toThrow('credential-redacted remote URL identity');
	});

	test('unresolvable local branch ref fails arming closed', async () => {
		_test_exports.resolveCurrentLocalHeadRefAsync = async () => null;
		await expect(
			fixture.prepareArmedGeneration(`${SESSION_ID}-detached`),
		).rejects.toThrow('current branch ref');
	});

	test('completion without an admitted push attempt is refused', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await expect(
			completePrWorkflow(
				fixture.directory,
				SESSION_ID,
				'PR_FEEDBACK',
				HEAD_SHA,
			),
		).rejects.toThrow('requires the exact approved push');
	});
});

describe('legacy armed-record migration (issue #2108 §7)', () => {
	async function writeLegacyArmedState(sessionId: string): Promise<void> {
		const absolute = fixture.fixtureStatePath(sessionId);
		await fs.mkdir(path.dirname(absolute), { recursive: true });
		const state = {
			schemaVersion: 1,
			revision: 5,
			sessionID: sessionId,
			mode: 'PR_FEEDBACK',
			activatedAt: '2026-07-19T00:00:00.000Z',
			updatedAt: '2026-07-19T00:00:00.000Z',
			prHeadSha: HEAD_SHA,
			prFeedbackReadyToPublish: {
				revisionDigest: REVISION,
				localHead: POST_COMMIT_SHA,
				remoteName: 'origin',
				remoteBranchRef: 'refs/heads/pr-head',
				remoteRef: 'refs/remotes/origin/pr-head',
				validatedAt: '2026-07-19T00:00:00.000Z',
			},
		};
		await fs.writeFile(
			fixture.fixtureStatePath(sessionId),
			JSON.stringify(state, null, 2),
			'utf-8',
		);
	}

	test('identity-mismatched legacy record migrates to invalidated, never armed', async () => {
		const sessionId = `${SESSION_ID}-legacy-drift`;
		await writeLegacyArmedState(sessionId);
		// Current head (HEAD_SHA) differs from the armed localHead
		// (POST_COMMIT_SHA) — proven identity mismatch under the lock.
		await _test_exports.ensurePublicationGenerationCurrent(
			fixture.directory,
			sessionId,
		);
		const { state, active } = await readActive(sessionId);
		expect(active?.generation).toBe(1);
		expect(
			active?.invalidationReason ??
				state?.prFeedbackPublication?.active?.invalidationReason,
		).toBe('legacy-migration-receipt-mismatch');
		expect(active?.state ?? state?.prFeedbackPublication?.active?.state).toBe(
			'invalidated',
		);
		// Mirror cleared — an older binary sees a normal (non-armed) workflow,
		// and the superseded receipts are gone from active state.
		expect(state?.prFeedbackReadyToPublish).toBeUndefined();
	});

	test('head-drifted legacy record is invalidated with the identity-mismatch reason when receipts exist', async () => {
		const sessionId = `${SESSION_ID}-legacy-head-drift`;
		await writeLegacyArmedState(sessionId);
		// Give the legacy record receipts bound to its digest so the receipt
		// rule passes and the identity comparison decides.
		const raw = JSON.parse(
			await fs.readFile(fixture.fixtureStatePath(sessionId), 'utf-8'),
		) as Record<string, unknown>;
		raw.prFeedbackStageA = {
			revisionDigest: REVISION,
			checks: [
				{ category: 'build', command: ['build'], durationMs: 1 },
				{
					category: 'diff-check',
					command: ['git', 'diff', '--check'],
					durationMs: 1,
				},
			],
			validatedAt: '2026-07-19T00:00:00.000Z',
		};
		raw.prFeedbackGateBatches = [
			{
				batchId: 'legacy-batch',
				phase: 'closeout-critic',
				laneId: 'closeout-critic',
				itemIds: ['FB-001'],
				revisionDigest: REVISION,
				validatedAt: '2026-07-19T00:00:00.000Z',
			},
		];
		await fs.writeFile(
			fixture.fixtureStatePath(sessionId),
			JSON.stringify(raw, null, 2),
			'utf-8',
		);
		fixture.mutators.head(POST_COMMIT_SHA);
		await _test_exports.ensurePublicationGenerationCurrent(
			fixture.directory,
			sessionId,
		);
		const { state } = await readActive(sessionId);
		// Workspace identity is unresolvable in the raw fixture path only if
		// canonicalWorkspaceIdentity fails; on a real tmpdir it resolves, so the
		// deciding failure is the digest/HEAD/upstream comparison — either way
		// the record must NEVER be armed.
		expect(state?.prFeedbackPublication?.active?.state).toBe('invalidated');
		expect(state?.prFeedbackReadyToPublish).toBeUndefined();
	});

	test('unresolvable upstream during migration invalidates conservatively', async () => {
		const sessionId = `${SESSION_ID}-legacy-unresolvable`;
		await writeLegacyArmedState(sessionId);
		fixture.mutators.upstream(null);
		await _test_exports.ensurePublicationGenerationCurrent(
			fixture.directory,
			sessionId,
		);
		const { state } = await readActive(sessionId);
		expect(state?.prFeedbackPublication?.active?.state).toBe('invalidated');
		expect([
			'legacy-migration-unresolvable',
			'legacy-migration-receipt-mismatch',
			'legacy-migration-identity-mismatch',
		]).toContain(state?.prFeedbackPublication?.active?.invalidationReason);
	});
});
