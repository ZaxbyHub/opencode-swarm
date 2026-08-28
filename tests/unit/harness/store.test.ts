import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	computeHarnessCandidateManifestHash,
	deriveHarnessCandidateRiskTier,
} from '../../../src/harness/contracts.js';
import { createAgentFactory } from '../../../src/harness/factory.js';
import { sha256 } from '../../../src/harness/hash.js';
import {
	activateHarnessCandidate,
	auditHarnessLedger,
	buildHarnessActivationApprovalRequest,
	buildHarnessRollbackApprovalRequest,
	listHarnessHistory,
	loadHarnessCurrent,
	loadHarnessVersion,
	recordHarnessCandidate,
	rollbackHarnessVersion,
	type StoredHarnessCandidateV1,
} from '../../../src/harness/store.js';
import {
	computeWriteApprovalHash,
	consumeWriteApprovalFact,
	issueWriteApprovalFact,
} from '../../../src/security/write-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function candidate(
	id: string,
	seedHash = 'a'.repeat(64),
): StoredHarnessCandidateV1 {
	const manifestBase = {
		v: 1 as const,
		candidateId: id,
		baseSha: 'b'.repeat(40),
		origin: 'issue-1825',
		patchSha256: sha256(seedHash),
		approvedPaths: ['src/agents/demo.ts'],
		promptArtifactHashes: [],
		files: [
			{
				relativePath: 'src/agents/demo.ts',
				trackedMode: '100644',
				beforeSha256: 'd'.repeat(64),
				afterSha256: 'e'.repeat(64),
				bytesBefore: 20,
				bytesAfter: 20,
				addedLines: 1,
				removedLines: 1,
				changedLines: 2,
			},
		],
	};
	const blueprint = createAgentFactory({
		runtimeDefinitions: [
			{
				name: 'architect',
				config: {
					mode: 'primary',
					temperature: 0.1,
					prompt: 'Static runtime prompt',
					tools: {},
				},
			},
		],
		registeredToolIds: [],
	}).projectBlueprint({ blueprintId: `blueprint-${id}` });
	return {
		v: 1,
		baseBlueprint: blueprint,
		targetBlueprint: blueprint,
		blueprintPatch: {
			v: 1,
			patchId: `patch-${id}`,
			expectedBaseHash: blueprint.contentHash,
			expectedResultHash: blueprint.contentHash,
			operations: [],
		},
		candidate: {
			...manifestBase,
			manifestHash: computeHarnessCandidateManifestHash(manifestBase),
			riskTier: deriveHarnessCandidateRiskTier(manifestBase),
		},
		recordedAt: '2026-08-27T12:00:00.000Z',
	};
}

function allowedPathDigest(candidate: StoredHarnessCandidateV1): string {
	return computeWriteApprovalHash({
		allowedPaths: [...candidate.candidate.approvedPaths].sort(),
	});
}

function activationBinding(
	current: Awaited<ReturnType<typeof loadHarnessCurrent>>,
	candidate: StoredHarnessCandidateV1,
) {
	return {
		expectedCurrentHash:
			current.currentVersionId === null ? null : current.currentHash,
		expectedCurrentGeneration: current.generation,
		targetContentHash: candidate.candidate.manifestHash,
		allowedPathDigest: allowedPathDigest(candidate),
	};
}

describe('harness durable store', () => {
	let root = '';

	beforeEach(() => {
		root = canonicalMkdtemp('harness-store-');
	});

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = '';
	});

	it('records immutable candidates and keeps a durable history', async () => {
		const recorded = await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-1'),
		});
		expect(recorded.status).toBe('recorded');
		const duplicate = await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-1'),
		});
		expect(duplicate.status).toBe('recorded');
		const history = await listHarnessHistory(root);
		expect(history.truncated).toBe(false);
		expect(history.totalRecordCount).toBe(1);
		expect(history.limit).toBe(100);
		expect(history.records.map((record) => record.kind)).toEqual([
			'candidate_recorded',
		]);
	});

	it('keeps source-only candidates inert and non-activatable', async () => {
		const stored = candidate('candidate-source-only');
		delete stored.baseBlueprint;
		delete stored.targetBlueprint;
		delete stored.blueprintPatch;
		await recordHarnessCandidate({ directory: root, candidate: stored });
		const result = await activateHarnessCandidate({
			directory: root,
			candidateId: stored.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(await loadHarnessCurrent(root), stored),
		});
		expect(result.status).toBe('candidate_not_activatable');
	});

	it('activates a candidate only with exact one-shot approval and optimistic current hash', async () => {
		const stored = candidate('candidate-activate', 'f'.repeat(64));
		await recordHarnessCandidate({ directory: root, candidate: stored });
		const request = buildHarnessActivationApprovalRequest({
			targetSessionId: 'session-a',
			candidate: stored,
			...activationBinding(await loadHarnessCurrent(root), stored),
		});
		await issueWriteApprovalFact({
			directory: root,
			request,
			issuingSessionId: 'human-session',
		});
		const activated = await activateHarnessCandidate({
			directory: root,
			candidateId: stored.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(await loadHarnessCurrent(root), stored),
		});
		expect(activated.status).toBe('activated');
		if (activated.status !== 'activated')
			throw new Error('expected activation');
		expect(activated.current.currentCandidateId).toBe(
			stored.candidate.candidateId,
		);
		expect(activated.version.parentVersionId).toBeNull();
		expect(activated.version.restoredFromVersionId).toBeNull();
		expect(activated.version.blueprint?.contentHash).toBe(
			stored.targetBlueprint.contentHash,
		);
		const current = await loadHarnessCurrent(root);
		expect(current.currentCandidateId).toBe(stored.candidate.candidateId);
		const second = await activateHarnessCandidate({
			directory: root,
			candidateId: stored.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(current, stored),
		});
		expect(second.status).toBe('approval_required');
	});

	it('rejects a consumer session mismatch before the approval is consumed', async () => {
		const stored = candidate('candidate-consumer', '1'.repeat(64));
		await recordHarnessCandidate({ directory: root, candidate: stored });
		const request = buildHarnessActivationApprovalRequest({
			targetSessionId: 'session-good',
			candidate: stored,
			...activationBinding(await loadHarnessCurrent(root), stored),
		});
		await issueWriteApprovalFact({
			directory: root,
			request,
			issuingSessionId: 'human-session',
		});
		const denied = await activateHarnessCandidate({
			directory: root,
			candidateId: stored.candidate.candidateId,
			consumerSessionId: 'session-bad',
			targetSessionId: 'session-good',
			...activationBinding(await loadHarnessCurrent(root), stored),
		});
		expect(denied.status).toBe('consumer_mismatch');
		const fact = await consumeWriteApprovalFact({
			directory: root,
			request,
			consumerSessionId: 'session-good',
		});
		expect(fact?.targetSessionId).toBe('session-good');
	});

	it('rejects stale current hashes and rolls back as a new version', async () => {
		const first = candidate('candidate-first', '2'.repeat(64));
		const second = candidate('candidate-second', '3'.repeat(64));
		await recordHarnessCandidate({ directory: root, candidate: first });
		await recordHarnessCandidate({ directory: root, candidate: second });

		const firstApproval = buildHarnessActivationApprovalRequest({
			targetSessionId: 'session-a',
			candidate: first,
			...activationBinding(await loadHarnessCurrent(root), first),
		});
		const staleSecondApproval = buildHarnessActivationApprovalRequest({
			targetSessionId: 'session-a',
			candidate: second,
			...activationBinding(await loadHarnessCurrent(root), second),
		});
		await issueWriteApprovalFact({
			directory: root,
			request: firstApproval,
			issuingSessionId: 'human-session',
		});
		await issueWriteApprovalFact({
			directory: root,
			request: staleSecondApproval,
			issuingSessionId: 'human-session',
		});
		const firstActivation = await activateHarnessCandidate({
			directory: root,
			candidateId: first.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(await loadHarnessCurrent(root), first),
		});
		if (firstActivation.status !== 'activated') {
			throw new Error('expected first activation');
		}
		const staleAttempt = await activateHarnessCandidate({
			directory: root,
			candidateId: second.candidate.candidateId,
			consumerSessionId: 'session-a',
			expectedCurrentHash: '0'.repeat(64),
			expectedCurrentGeneration: firstActivation.current.generation,
			targetContentHash: second.candidate.manifestHash,
			allowedPathDigest: allowedPathDigest(second),
		});
		expect(staleAttempt.status).toBe('stale_current');
		const staleApprovalReuse = await activateHarnessCandidate({
			directory: root,
			candidateId: second.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(firstActivation.current, second),
		});
		expect(staleApprovalReuse.status).toBe('approval_required');

		const secondApproval = buildHarnessActivationApprovalRequest({
			targetSessionId: 'session-a',
			candidate: second,
			...activationBinding(firstActivation.current, second),
		});
		await issueWriteApprovalFact({
			directory: root,
			request: secondApproval,
			issuingSessionId: 'human-session',
		});
		const secondActivation = await activateHarnessCandidate({
			directory: root,
			candidateId: second.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(firstActivation.current, second),
		});
		if (secondActivation.status !== 'activated') {
			throw new Error('expected second activation');
		}
		expect(secondActivation.version.parentVersionId).toBe(
			firstActivation.version.versionId,
		);
		expect(secondActivation.version.restoredFromVersionId).toBeNull();
		const rollbackRequest = buildHarnessRollbackApprovalRequest({
			targetSessionId: 'session-a',
			currentVersionId: secondActivation.version.versionId,
			targetVersionId: firstActivation.version.versionId,
			expectedCurrentHash: secondActivation.current.currentHash,
			expectedCurrentGeneration: secondActivation.current.generation,
			targetContentHash: first.candidate.manifestHash,
			allowedPathDigest: firstActivation.version.allowedPathDigest,
		});
		await issueWriteApprovalFact({
			directory: root,
			request: rollbackRequest,
			issuingSessionId: 'human-session',
		});
		const rolledBack = await rollbackHarnessVersion({
			directory: root,
			targetVersionId: firstActivation.version.versionId,
			consumerSessionId: 'session-a',
			expectedCurrentHash: secondActivation.current.currentHash,
			expectedCurrentGeneration: secondActivation.current.generation,
			targetContentHash: first.candidate.manifestHash,
			allowedPathDigest: firstActivation.version.allowedPathDigest,
		});
		expect(rolledBack.status).toBe('rolled_back');
		if (rolledBack.status !== 'rolled_back')
			throw new Error('expected rollback');
		expect(rolledBack.version.parentVersionId).toBe(
			secondActivation.version.versionId,
		);
		expect(rolledBack.version.restoredFromVersionId).toBe(
			firstActivation.version.versionId,
		);
		const current = await loadHarnessCurrent(root);
		expect(current.currentCandidateId).toBe(first.candidate.candidateId);
	});

	it('retains only the newest configured versions on activation', async () => {
		const activatedVersionIds: string[] = [];
		for (const id of ['candidate-a', 'candidate-b', 'candidate-c']) {
			const stored = candidate(id, id.padEnd(64, id[0] ?? 'a'));
			await recordHarnessCandidate({ directory: root, candidate: stored });
			const current = await loadHarnessCurrent(root);
			const request = buildHarnessActivationApprovalRequest({
				targetSessionId: 'session-a',
				candidate: stored,
				...activationBinding(current, stored),
			});
			await issueWriteApprovalFact({
				directory: root,
				request,
				issuingSessionId: 'human-session',
			});
			const activated = await activateHarnessCandidate({
				directory: root,
				candidateId: stored.candidate.candidateId,
				consumerSessionId: 'session-a',
				...activationBinding(current, stored),
				maxVersions: 2,
			});
			if (activated.status !== 'activated')
				throw new Error('expected activation');
			activatedVersionIds.push(activated.version.versionId);
		}
		const finalCurrent = await loadHarnessCurrent(root);
		expect(finalCurrent.versionIds).toHaveLength(2);
		expect(
			await loadHarnessVersion(root, finalCurrent.versionIds[0]!),
		).not.toBeNull();
		expect(
			await loadHarnessVersion(root, finalCurrent.versionIds[1]!),
		).not.toBeNull();
		expect(await loadHarnessVersion(root, activatedVersionIds[0]!)).toBeNull();
		expect((await listHarnessHistory(root)).records.length).toBeLessThanOrEqual(
			6,
		);
	});

	it('fails before commit when rollback ancestry cannot fit within maxVersions', async () => {
		const first = candidate('candidate-rollback-keep-a', '1'.repeat(64));
		const second = candidate('candidate-rollback-prune-b', '2'.repeat(64));
		await recordHarnessCandidate({ directory: root, candidate: first });
		await recordHarnessCandidate({ directory: root, candidate: second });

		await issueWriteApprovalFact({
			directory: root,
			request: buildHarnessActivationApprovalRequest({
				targetSessionId: 'session-a',
				candidate: first,
				...activationBinding(await loadHarnessCurrent(root), first),
			}),
			issuingSessionId: 'human-session',
		});
		const firstActivation = await activateHarnessCandidate({
			directory: root,
			candidateId: first.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(await loadHarnessCurrent(root), first),
			maxVersions: 2,
		});
		if (firstActivation.status !== 'activated') {
			throw new Error('expected first activation');
		}

		await issueWriteApprovalFact({
			directory: root,
			request: buildHarnessActivationApprovalRequest({
				targetSessionId: 'session-a',
				candidate: second,
				...activationBinding(await loadHarnessCurrent(root), second),
			}),
			issuingSessionId: 'human-session',
		});
		const secondActivation = await activateHarnessCandidate({
			directory: root,
			candidateId: second.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(await loadHarnessCurrent(root), second),
			maxVersions: 2,
		});
		if (secondActivation.status !== 'activated') {
			throw new Error('expected second activation');
		}

		await issueWriteApprovalFact({
			directory: root,
			request: buildHarnessRollbackApprovalRequest({
				targetSessionId: 'session-a',
				currentVersionId: secondActivation.version.versionId,
				targetVersionId: firstActivation.version.versionId,
				expectedCurrentHash: secondActivation.current.currentHash,
				expectedCurrentGeneration: secondActivation.current.generation,
				targetContentHash: first.candidate.manifestHash,
				allowedPathDigest: firstActivation.version.allowedPathDigest,
			}),
			issuingSessionId: 'human-session',
		});
		const rolledBack = await rollbackHarnessVersion({
			directory: root,
			targetVersionId: firstActivation.version.versionId,
			consumerSessionId: 'session-a',
			expectedCurrentHash: secondActivation.current.currentHash,
			expectedCurrentGeneration: secondActivation.current.generation,
			targetContentHash: first.candidate.manifestHash,
			allowedPathDigest: firstActivation.version.allowedPathDigest,
			maxVersions: 2,
		});
		expect(rolledBack.status).toBe('retention_conflict');
		if (rolledBack.status !== 'retention_conflict') {
			throw new Error('expected retention conflict');
		}

		const finalCurrent = await loadHarnessCurrent(root);
		expect(finalCurrent.versionIds).toEqual([
			firstActivation.version.versionId,
			secondActivation.version.versionId,
		]);
		expect(rolledBack.requiredVersionIds).toContain(
			firstActivation.version.versionId,
		);
		expect(rolledBack.requiredVersionIds).toContain(
			secondActivation.version.versionId,
		);
		expect(
			await loadHarnessVersion(root, firstActivation.version.versionId),
		).not.toBeNull();
		expect(
			await loadHarnessVersion(root, secondActivation.version.versionId),
		).not.toBeNull();
	});

	it('serves recent history and allows new mutations after the ledger outgrows the replay window', async () => {
		for (const id of ['candidate-window-a', 'candidate-window-b']) {
			const stored = candidate(id, id[0]!.repeat(64));
			await recordHarnessCandidate({ directory: root, candidate: stored });
			await issueWriteApprovalFact({
				directory: root,
				request: buildHarnessActivationApprovalRequest({
					targetSessionId: 'session-a',
					candidate: stored,
					...activationBinding(await loadHarnessCurrent(root), stored),
				}),
				issuingSessionId: 'human-session',
			});
			const activated = await activateHarnessCandidate({
				directory: root,
				candidateId: stored.candidate.candidateId,
				consumerSessionId: 'session-a',
				...activationBinding(await loadHarnessCurrent(root), stored),
				maxReplayRecords: 2,
			});
			if (activated.status !== 'activated') {
				throw new Error('expected activation');
			}
		}

		const third = candidate('candidate-window-c', 'c'.repeat(64));
		await recordHarnessCandidate({ directory: root, candidate: third });
		await issueWriteApprovalFact({
			directory: root,
			request: buildHarnessActivationApprovalRequest({
				targetSessionId: 'session-a',
				candidate: third,
				...activationBinding(await loadHarnessCurrent(root), third),
			}),
			issuingSessionId: 'human-session',
		});
		const activated = await activateHarnessCandidate({
			directory: root,
			candidateId: third.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(await loadHarnessCurrent(root), third),
			maxReplayRecords: 2,
		});
		expect(activated.status).toBe('activated');

		const page = await listHarnessHistory(root, {
			limit: 1,
			maxReplayRecords: 1,
		});
		expect(page.totalRecordCount).toBe(1);
		expect(page.records).toHaveLength(1);
		expect(page.records[0]?.kind).toBe('compacted');
	});

	it('returns newest-first bounded history pages and full chronological audits', async () => {
		for (const id of ['candidate-audit-a', 'candidate-audit-b']) {
			await recordHarnessCandidate({
				directory: root,
				candidate: candidate(id),
			});
		}
		const page = await listHarnessHistory(root, { limit: 1 });
		expect(page.totalRecordCount).toBe(2);
		expect(page.records).toHaveLength(1);
		expect(page.records[0]?.candidateId).toBe('candidate-audit-b');
		const audit = await auditHarnessLedger(root, {
			maxReplayRecords: 10,
			maxSegments: 10,
		});
		expect(audit.outcome).toBe('ok');
		if (audit.outcome !== 'ok') throw new Error('expected audit');
		expect(audit.records.map((record) => record.candidateId)).toEqual([
			'candidate-audit-a',
			'candidate-audit-b',
		]);
	});
});
