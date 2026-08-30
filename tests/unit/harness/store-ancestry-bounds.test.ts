import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	computeHarnessCandidateManifestHash,
	deriveHarnessCandidateRiskTier,
} from '../../../src/harness/contracts.js';
import { createAgentFactory } from '../../../src/harness/factory.js';
import { canonicalJson, sha256 } from '../../../src/harness/hash.js';
import {
	activateHarnessCandidate,
	buildHarnessActivationApprovalRequest,
	type HarnessLedgerRecordV1,
	type HarnessVersionV1,
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

function candidate(id: string): StoredHarnessCandidateV1 {
	const manifest = {
		v: 1 as const,
		candidateId: id,
		baseSha: 'b'.repeat(40),
		origin: 'issue-1825',
		patchSha256: sha256(id),
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
			...manifest,
			manifestHash: computeHarnessCandidateManifestHash(manifest),
			riskTier: deriveHarnessCandidateRiskTier(manifest),
		},
		recordedAt: '2026-08-27T12:00:00.000Z',
	};
}

describe('harness ancestry traversal bounds', () => {
	let root = '';

	beforeEach(() => {
		root = canonicalMkdtemp('harness-ancestry-bounds-');
	});

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = '';
	});

	it(
		'replays a retained version ancestry chain beyond the legacy 128-node bound',
		{ timeout: 30_000 },
		async () => {
			const stored = candidate('candidate-ancestry');
			await recordHarnessCandidate({ directory: root, candidate: stored });
			const current = await loadHarnessCurrent(root);
			const allowedPathDigest = computeWriteApprovalHash({
				allowedPaths: [...stored.candidate.approvedPaths].sort(),
			});
			const approvalRequest = buildHarnessActivationApprovalRequest({
				targetSessionId: 'session-a',
				candidate: stored,
				expectedCurrentHash: null,
				expectedCurrentGeneration: current.generation,
				targetContentHash: stored.candidate.manifestHash,
				allowedPathDigest,
			});
			await issueWriteApprovalFact({
				directory: root,
				request: approvalRequest,
				issuingSessionId: 'human-session',
			});
			const activation = await activateHarnessCandidate({
				directory: root,
				candidateId: stored.candidate.candidateId,
				consumerSessionId: 'session-a',
				expectedCurrentHash: null,
				expectedCurrentGeneration: current.generation,
				targetContentHash: stored.candidate.manifestHash,
				allowedPathDigest,
				maxVersions: 10_000,
				maxReplayRecords: 1,
			});
			if (activation.status !== 'activated') {
				throw new Error(`expected activation, got ${activation.status}`);
			}

			const versionIds = [activation.version.versionId];
			const versions: HarnessVersionV1[] = [activation.version];
			const versionsDir = path.join(
				root,
				'.swarm',
				'evolution',
				'harness',
				'versions',
			);
			mkdirSync(versionsDir, { recursive: true });
			let previous: HarnessVersionV1 = activation.version;
			for (let index = 1; index <= 129; index++) {
				const next: HarnessVersionV1 = {
					...previous,
					versionId: randomUUID(),
					generation: previous.generation + 1,
					parentVersionId: previous.versionId,
					recordedAt: `2026-08-27T12:${String(index).padStart(2, '0')}:00.000Z`,
				};
				writeFileSync(
					path.join(versionsDir, `${next.versionId}.json`),
					`${JSON.stringify(next, null, 2)}\n`,
					'utf8',
				);
				versionIds.push(next.versionId);
				versions.push(next);
				previous = next;
			}

			const pointerPath = path.join(
				root,
				'.swarm',
				'evolution',
				'harness',
				'ledger',
				'active-generation.json',
			);
			const { generationDir } = JSON.parse(
				readFileSync(pointerPath, 'utf8'),
			) as { generationDir: string };
			const ledgerPath = path.join(
				root,
				'.swarm',
				'evolution',
				'harness',
				'ledger',
				generationDir,
				'000001.jsonl',
			);
			const lines = readFileSync(ledgerPath, 'utf8')
				.trimEnd()
				.split('\n')
				.map((line) => JSON.parse(line) as HarnessLedgerRecordV1);
			const compactionRecord = lines.find(
				(record) => record.kind === 'compacted',
			);
			if (!compactionRecord)
				throw new Error('expected compaction ledger record');
			const emptyHash = sha256(
				canonicalJson({
					currentVersionId: null,
					currentCandidateId: null,
					currentManifestHash: null,
					generation: 0,
					versionIds: [],
				}),
			);
			const rewrittenCompaction = {
				...compactionRecord,
				generation: 0,
				nextCurrentVersionId: null,
				nextCurrentCandidateId: null,
				nextCurrentManifestHash: null,
				nextVersionIds: [],
				nextUpdatedAt: '1970-01-01T00:00:00.000Z',
				currentHashAfter: emptyHash,
				payloadHash: sha256(
					canonicalJson({
						currentHash: emptyHash,
						generation: 0,
						versionIds: [],
						retainedCandidates: compactionRecord.retainedCandidates,
						compactedRecords: compactionRecord.compactedRecords,
					}),
				),
			};
			const { hashAfter: _oldHash, ...withoutHash } = rewrittenCompaction;
			const rewrittenRecords: HarnessLedgerRecordV1[] = [
				{
					...rewrittenCompaction,
					hashAfter: sha256(canonicalJson(withoutHash)),
				},
			];
			let currentHash = emptyHash;
			let previousHash = rewrittenRecords[0]!.hashAfter;
			let currentVersionIds: string[] = [];
			for (const version of [activation.version, ...versions.slice(1)]) {
				currentVersionIds = [...currentVersionIds, version.versionId];
				const nextCurrentHash = sha256(
					canonicalJson({
						currentVersionId: version.versionId,
						currentCandidateId: version.candidateId,
						currentManifestHash: version.manifestHash,
						generation: version.generation,
						versionIds: currentVersionIds,
					}),
				);
				const record = {
					v: 1 as const,
					seq: rewrittenRecords.length + 1,
					timestamp: version.recordedAt,
					kind: 'activated' as const,
					candidateId: version.candidateId,
					versionId: version.versionId,
					parentVersionId: version.parentVersionId,
					restoredFromVersionId: null,
					approvalFactId: version.approvalFactId,
					payloadHash: version.manifestHash,
					generation: version.generation,
					currentHashBefore: currentHash,
					currentHashAfter: nextCurrentHash,
					nextCurrentVersionId: version.versionId,
					nextCurrentCandidateId: version.candidateId,
					nextCurrentManifestHash: version.manifestHash,
					nextVersionIds: currentVersionIds,
					nextUpdatedAt: version.recordedAt,
					ledgerSegment: '000001.jsonl',
					prunedVersionIds: [],
					recoverySegment: null,
					recoveredBytes: null,
					retainedCandidates: [],
					compactedRecords: null,
					hashBefore: previousHash,
					hashAfter: '',
				};
				const { hashAfter: _placeholder, ...recordWithoutHash } = record;
				const completedRecord = {
					...record,
					hashAfter: sha256(canonicalJson(recordWithoutHash)),
				};
				rewrittenRecords.push(completedRecord);
				currentHash = nextCurrentHash;
				previousHash = completedRecord.hashAfter;
			}
			writeFileSync(
				ledgerPath,
				`${rewrittenRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
				'utf8',
			);
			rmSync(path.join(root, '.swarm', 'evolution', 'harness', 'current.json'));

			const rebuilt = await loadHarnessCurrent(root, 10_000);
			expect(rebuilt.versionIds.length).toBeGreaterThan(128);
			const history = await listHarnessHistory(root, {
				maxReplayRecords: 10_000,
				limit: 1,
			});
			expect(history.records).toHaveLength(1);
		},
	);
});
