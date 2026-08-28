import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
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
	listHarnessHistory,
	loadHarnessCurrent,
	recordHarnessCandidate,
	type StoredHarnessCandidateV1,
} from '../../../src/harness/store.js';
import {
	computeWriteApprovalHash,
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
		recordedAt: '2026-08-27T12:00:00.000Z',
		candidate: {
			...manifestBase,
			manifestHash: computeHarnessCandidateManifestHash(manifestBase),
			riskTier: deriveHarnessCandidateRiskTier(manifestBase),
		},
	};
}

function allowedPathDigest(candidateValue: StoredHarnessCandidateV1): string {
	return computeWriteApprovalHash({
		allowedPaths: [...candidateValue.candidate.approvedPaths].sort(),
	});
}

function activationBinding(
	current: Awaited<ReturnType<typeof loadHarnessCurrent>>,
	candidateValue: StoredHarnessCandidateV1,
) {
	return {
		expectedCurrentHash:
			current.currentVersionId === null ? null : current.currentHash,
		expectedCurrentGeneration: current.generation,
		targetContentHash: candidateValue.candidate.manifestHash,
		allowedPathDigest: allowedPathDigest(candidateValue),
	};
}

describe('harness durable store history windows', () => {
	let root = '';

	beforeEach(() => {
		root = canonicalMkdtemp('harness-store-history-');
	});

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = '';
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
