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
	_storeInternals,
	activateHarnessCandidate,
	buildHarnessActivationApprovalRequest,
	buildHarnessRollbackApprovalRequest,
	loadHarnessCurrent,
	loadHarnessVersion,
	recordHarnessCandidate,
	rollbackHarnessVersion,
	type StoredHarnessCandidateV1,
} from '../../../src/harness/store.js';
import {
	computeWriteApprovalHash,
	issueWriteApprovalFact,
	type WriteApprovalFactV1,
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
	stored: StoredHarnessCandidateV1,
) {
	return {
		expectedCurrentHash:
			current.currentVersionId === null ? null : current.currentHash,
		expectedCurrentGeneration: current.generation,
		targetContentHash: stored.candidate.manifestHash,
		allowedPathDigest: allowedPathDigest(stored),
	};
}

describe('harness durable store mutation edges', () => {
	let root = '';
	const realRemoveVersionArtifact = _storeInternals.removeVersionArtifact;

	beforeEach(() => {
		root = canonicalMkdtemp('harness-store-mutation-edges-');
		_storeInternals.removeVersionArtifact = realRemoveVersionArtifact;
	});

	afterEach(() => {
		_storeInternals.removeVersionArtifact = realRemoveVersionArtifact;
		if (root) rmSync(root, { recursive: true, force: true });
		root = '';
	});

	it('rejects a forged approval fact id that is already committed before consuming it', async () => {
		const first = candidate('candidate-approval-first', '1'.repeat(64));
		const second = candidate('candidate-approval-second', '2'.repeat(64));
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
		});
		if (firstActivation.status !== 'activated') {
			throw new Error('expected first activation');
		}

		const secondRequest = buildHarnessActivationApprovalRequest({
			targetSessionId: 'session-a',
			candidate: second,
			...activationBinding(await loadHarnessCurrent(root), second),
		});
		const forgedFact: WriteApprovalFactV1 = {
			v: 1,
			id: firstActivation.version.approvalFactId,
			issuingSessionId: 'human-session',
			issuedByCommand: 'approve-write',
			issuedAt: '2099-08-28T00:00:00.000Z',
			expiresAt: '2099-08-28T01:00:00.000Z',
			...secondRequest,
		};
		const authorityPath = path.join(
			root,
			'.swarm',
			'authority',
			'write-approvals.jsonl',
		);
		writeFileSync(
			authorityPath,
			`${JSON.stringify({ kind: 'issued', fact: forgedFact })}\n`,
			'utf8',
		);

		const rejected = await activateHarnessCandidate({
			directory: root,
			candidateId: second.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(await loadHarnessCurrent(root), second),
		});
		expect(rejected.status).toBe('approval_required');
		if (rejected.status !== 'approval_required') {
			throw new Error('expected approval rejection');
		}
		expect(rejected.reason).toContain('already committed');
		expect(readFileSync(authorityPath, 'utf8').trim().split('\n')).toHaveLength(
			1,
		);
	});

	it('fails before commit when rollback ancestry cannot fit within maxVersions and discards the new version artifact', async () => {
		const first = candidate('candidate-retention-first', '3'.repeat(64));
		const second = candidate('candidate-retention-second', '4'.repeat(64));
		await recordHarnessCandidate({ directory: root, candidate: first });
		await recordHarnessCandidate({ directory: root, candidate: second });

		for (const stored of [first, second]) {
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
				maxVersions: 2,
			});
			if (activated.status !== 'activated') {
				throw new Error(
					`expected activation for ${stored.candidate.candidateId}`,
				);
			}
		}

		const current = await loadHarnessCurrent(root);
		const secondVersionId = current.currentVersionId!;
		const firstVersionId = current.versionIds[0]!;
		await issueWriteApprovalFact({
			directory: root,
			request: buildHarnessRollbackApprovalRequest({
				targetSessionId: 'session-a',
				currentVersionId: secondVersionId,
				targetVersionId: firstVersionId,
				expectedCurrentHash: current.currentHash,
				expectedCurrentGeneration: current.generation,
				targetContentHash: first.candidate.manifestHash,
				allowedPathDigest: allowedPathDigest(first),
			}),
			issuingSessionId: 'human-session',
		});

		const rolledBack = await rollbackHarnessVersion({
			directory: root,
			targetVersionId: firstVersionId,
			consumerSessionId: 'session-a',
			expectedCurrentHash: current.currentHash,
			expectedCurrentGeneration: current.generation,
			targetContentHash: first.candidate.manifestHash,
			allowedPathDigest: allowedPathDigest(first),
			maxVersions: 2,
		});
		expect(rolledBack.status).toBe('retention_conflict');
		if (rolledBack.status !== 'retention_conflict') {
			throw new Error('expected retention conflict');
		}
		expect(rolledBack.requiredVersionIds).toContain(firstVersionId);
		expect(rolledBack.requiredVersionIds).toContain(secondVersionId);
		expect(rolledBack.requiredVersionIds).toHaveLength(3);
		const rollbackVersionId = rolledBack.requiredVersionIds.find(
			(versionId) =>
				versionId !== firstVersionId && versionId !== secondVersionId,
		);
		expect(rollbackVersionId).toBeString();
		expect(await loadHarnessVersion(root, rollbackVersionId!)).toBeNull();
		expect((await loadHarnessCurrent(root)).currentVersionId).toBe(
			secondVersionId,
		);
	});

	it('reports a committed mutation when prune cleanup fails after the ledger commit', async () => {
		const first = candidate('candidate-prune-first', '5'.repeat(64));
		const second = candidate('candidate-prune-second', '6'.repeat(64));
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
			maxVersions: 1,
		});
		if (firstActivation.status !== 'activated') {
			throw new Error('expected first activation');
		}

		_storeInternals.removeVersionArtifact = () => {
			throw new Error('simulated prune failure');
		};
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
			maxVersions: 1,
		});
		expect(secondActivation.status).toBe('activated');
		if (secondActivation.status !== 'activated') {
			throw new Error('expected second activation');
		}
		expect(secondActivation.prunedArtifactsReconciled).toBe(false);
		expect(secondActivation.prunedArtifactFailures).toEqual([
			firstActivation.version.versionId,
		]);
		expect((await loadHarnessCurrent(root)).versionIds).toEqual([
			secondActivation.version.versionId,
		]);
		expect(
			existsSync(
				path.join(
					root,
					'.swarm',
					'evolution',
					'harness',
					'versions',
					`${firstActivation.version.versionId}.json`,
				),
			),
		).toBe(true);
	});
});
