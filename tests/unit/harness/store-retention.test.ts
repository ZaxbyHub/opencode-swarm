import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import {
	computeHarnessCandidateManifestHash,
	deriveHarnessCandidateRiskTier,
} from '../../../src/harness/contracts.js';
import { createAgentFactory } from '../../../src/harness/factory.js';
import { canonicalJson, sha256 } from '../../../src/harness/hash.js';
import {
	_storeInternals,
	activateHarnessCandidate,
	auditHarnessLedger,
	buildHarnessActivationApprovalRequest,
	buildHarnessRollbackApprovalRequest,
	loadHarnessCandidate,
	loadHarnessCurrent,
	recordHarnessCandidate,
	rollbackHarnessVersion,
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

describe('harness durable store physical retention', () => {
	let root = '';
	const realRemoveCandidateArtifact = _storeInternals.removeCandidateArtifact;

	beforeEach(() => {
		root = canonicalMkdtemp('harness-store-retention-');
		_storeInternals.removeCandidateArtifact = realRemoveCandidateArtifact;
	});

	afterEach(() => {
		_storeInternals.removeCandidateArtifact = realRemoveCandidateArtifact;
		if (root) rmSync(root, { recursive: true, force: true });
		root = '';
	});

	it('compacts old ledger history into a single snapshot and prunes older inactive candidates', async () => {
		let latest: StoredHarnessCandidateV1 | null = null;
		let outcome: Awaited<ReturnType<typeof recordHarnessCandidate>> | null =
			null;
		for (const id of ['candidate-1', 'candidate-2', 'candidate-3']) {
			latest = candidate(id, id[0]!.repeat(64));
			outcome = await recordHarnessCandidate({
				directory: root,
				candidate: latest,
				maxReplayRecords: 2,
				maxInactiveCandidates: 1,
			});
		}
		expect(outcome?.status).toBe('recorded');
		if (outcome?.status !== 'recorded' || !latest) {
			throw new Error('expected retained recording');
		}
		expect(outcome.retentionReconciled).toBe(true);
		const audit = await auditHarnessLedger(root, {
			maxReplayRecords: 10,
			maxSegments: 10,
		});
		expect(audit.outcome).toBe('ok');
		if (audit.outcome !== 'ok') throw new Error('expected audit');
		expect(audit.records.map((record) => record.kind)).toEqual(['compacted']);
		expect(audit.records[0]?.retainedCandidates).toEqual([
			{
				candidateId: latest.candidate.candidateId,
				manifestHash: latest.candidate.manifestHash,
			},
		]);
		expect(
			await loadHarnessCandidate(root, latest.candidate.candidateId, 2),
		).not.toBeNull();
		expect(await loadHarnessCandidate(root, 'candidate-1', 2)).toBeNull();
		expect(await loadHarnessCandidate(root, 'candidate-2', 2)).toBeNull();
		expect(
			readdirSync(
				path.join(root, '.swarm', 'evolution', 'harness', 'ledger'),
			).some((name) => name === 'active-generation.json'),
		).toBe(true);
	});

	it('retains version-linked candidates across compaction even when inactive retention is disabled', async () => {
		const first = candidate('candidate-active-first', '1'.repeat(64));
		const second = candidate('candidate-active-second', '2'.repeat(64));
		for (const stored of [first, second]) {
			await recordHarnessCandidate({
				directory: root,
				candidate: stored,
				maxReplayRecords: 2,
				maxInactiveCandidates: 0,
			});
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
				maxVersions: 3,
				maxReplayRecords: 2,
				maxInactiveCandidates: 0,
			});
			expect(activated.status).toBe('activated');
		}
		const current = await loadHarnessCurrent(root);
		await issueWriteApprovalFact({
			directory: root,
			request: buildHarnessRollbackApprovalRequest({
				targetSessionId: 'session-a',
				currentVersionId: current.currentVersionId!,
				targetVersionId: current.versionIds[0]!,
				expectedCurrentHash: current.currentHash,
				expectedCurrentGeneration: current.generation,
				targetContentHash: first.candidate.manifestHash,
				allowedPathDigest: allowedPathDigest(first),
			}),
			issuingSessionId: 'human-session',
		});
		const rolledBack = await rollbackHarnessVersion({
			directory: root,
			targetVersionId: current.versionIds[0]!,
			consumerSessionId: 'session-a',
			expectedCurrentHash: current.currentHash,
			expectedCurrentGeneration: current.generation,
			targetContentHash: first.candidate.manifestHash,
			allowedPathDigest: allowedPathDigest(first),
			maxVersions: 3,
			maxReplayRecords: 2,
			maxInactiveCandidates: 0,
		});
		expect(rolledBack.status).toBe('rolled_back');
		if (rolledBack.status !== 'rolled_back') {
			throw new Error('expected rollback');
		}
		expect(rolledBack.current.currentCandidateId).toBe(
			first.candidate.candidateId,
		);
		expect(
			await loadHarnessCandidate(root, first.candidate.candidateId, 2),
		).not.toBeNull();
		expect(
			await loadHarnessCandidate(root, second.candidate.candidateId, 2),
		).not.toBeNull();
	});

	it('fails closed when a compaction snapshot claims a retained candidate with the wrong manifest hash', async () => {
		for (const id of [
			'candidate-tamper-a',
			'candidate-tamper-b',
			'candidate-tamper-c',
		]) {
			await recordHarnessCandidate({
				directory: root,
				candidate: candidate(id, id[0]!.repeat(64)),
				maxReplayRecords: 2,
				maxInactiveCandidates: 1,
			});
		}
		const ledgerRoot = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'ledger',
		);
		const pointer = JSON.parse(
			readFileSync(path.join(ledgerRoot, 'active-generation.json'), 'utf8'),
		) as { generationDir: string };
		const segmentPath = path.join(
			ledgerRoot,
			pointer.generationDir,
			'000001.jsonl',
		);
		const record = JSON.parse(readFileSync(segmentPath, 'utf8')) as Record<
			string,
			unknown
		>;
		const retained = [
			...(record.retainedCandidates as Array<Record<string, unknown>>),
		];
		retained[0] = {
			...retained[0],
			manifestHash: '0'.repeat(64),
		};
		record.retainedCandidates = retained;
		const { hashAfter: _ignored, ...withoutHash } = record;
		record.hashAfter = sha256(canonicalJson(withoutHash));
		writeFileSync(segmentPath, `${JSON.stringify(record)}\n`, 'utf8');
		await expect(
			loadHarnessCandidate(root, 'candidate-tamper-c', 2),
		).rejects.toThrow(
			'compaction snapshot references a missing or mismatched candidate',
		);
	});

	it('reports retention failures when old candidate artifacts cannot be removed', async () => {
		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-prune-a', '7'.repeat(64)),
			maxReplayRecords: 1,
			maxInactiveCandidates: 1,
		});
		_storeInternals.removeCandidateArtifact = () => {
			throw new Error('simulated candidate prune failure');
		};
		const recorded = await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-prune-b', '8'.repeat(64)),
			maxReplayRecords: 1,
			maxInactiveCandidates: 1,
		});
		expect(recorded.status).toBe('recorded');
		if (recorded.status !== 'recorded') {
			throw new Error('expected recording');
		}
		expect(recorded.retentionReconciled).toBe(false);
		expect(recorded.retentionFailures).toEqual(['candidate:candidate-prune-a']);
		expect(
			existsSync(
				path.join(
					root,
					'.swarm',
					'evolution',
					'harness',
					'candidates',
					'candidate-prune-a',
					'record.json',
				),
			),
		).toBe(true);
		expect(
			await loadHarnessCandidate(root, 'candidate-prune-b', 10),
		).not.toBeNull();
	});
});
