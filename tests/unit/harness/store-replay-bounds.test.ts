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
import { sha256 } from '../../../src/harness/hash.js';
import {
	_storeInternals,
	activateHarnessCandidate,
	auditHarnessLedger,
	buildHarnessActivationApprovalRequest,
	loadHarnessCandidate,
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
		candidate: {
			...manifestBase,
			manifestHash: computeHarnessCandidateManifestHash(manifestBase),
			riskTier: deriveHarnessCandidateRiskTier(manifestBase),
		},
		recordedAt: '2026-08-27T12:00:00.000Z',
	};
}

function allowedPathDigest(candidateRecord: StoredHarnessCandidateV1): string {
	return computeWriteApprovalHash({
		allowedPaths: [...candidateRecord.candidate.approvedPaths].sort(),
	});
}

function harnessCurrentPath(root: string): string {
	return path.join(root, '.swarm', 'evolution', 'harness', 'current.json');
}

function activationBinding(
	current: Awaited<ReturnType<typeof loadHarnessCurrent>>,
	candidateRecord: StoredHarnessCandidateV1,
) {
	return {
		expectedCurrentHash:
			current.currentVersionId === null ? null : current.currentHash,
		expectedCurrentGeneration: current.generation,
		targetContentHash: candidateRecord.candidate.manifestHash,
		allowedPathDigest: allowedPathDigest(candidateRecord),
	};
}

async function recordAndActivate(
	root: string,
	stored: StoredHarnessCandidateV1,
	maxReplayRecords: number,
) {
	await recordHarnessCandidate({
		directory: root,
		candidate: stored,
		maxReplayRecords,
	});
	const current = await loadHarnessCurrent(root, maxReplayRecords);
	await issueWriteApprovalFact({
		directory: root,
		request: buildHarnessActivationApprovalRequest({
			targetSessionId: 'session-a',
			candidate: stored,
			...activationBinding(current, stored),
		}),
		issuingSessionId: 'human-session',
	});
	return activateHarnessCandidate({
		directory: root,
		candidateId: stored.candidate.candidateId,
		consumerSessionId: 'session-a',
		...activationBinding(current, stored),
		maxReplayRecords,
	});
}

describe('harness store replay bounds', () => {
	let root = '';
	let originalAppendLedgerLine = _storeInternals.appendLedgerLine;

	beforeEach(() => {
		root = canonicalMkdtemp('harness-store-replay-');
		originalAppendLedgerLine = _storeInternals.appendLedgerLine;
	});

	afterEach(() => {
		_storeInternals.appendLedgerLine = originalAppendLedgerLine;
		if (root) rmSync(root, { recursive: true, force: true });
		root = '';
	});

	it('keeps pointer-valid candidate recording and activation available past the replay window', async () => {
		for (const id of ['candidate-a', 'candidate-b']) {
			const activated = await recordAndActivate(
				root,
				candidate(id, id[0]!.repeat(64)),
				2,
			);
			expect(activated.status).toBe('activated');
		}

		const third = candidate('candidate-c', 'c'.repeat(64));
		await recordHarnessCandidate({
			directory: root,
			candidate: third,
			maxReplayRecords: 2,
		});
		const current = await loadHarnessCurrent(root, 2);
		await issueWriteApprovalFact({
			directory: root,
			request: buildHarnessActivationApprovalRequest({
				targetSessionId: 'session-a',
				candidate: third,
				...activationBinding(current, third),
			}),
			issuingSessionId: 'human-session',
		});
		const activated = await activateHarnessCandidate({
			directory: root,
			candidateId: third.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(current, third),
			maxReplayRecords: 2,
		});
		expect(activated.status).toBe('activated');
	});

	it('replays forward from a stale current pointer when later committed records stay within the configured bound', async () => {
		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-forward-a'),
		});
		const currentFile = harnessCurrentPath(root);
		const staleProjection = readFileSync(currentFile, 'utf8');
		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-forward-b'),
		});
		writeFileSync(currentFile, staleProjection, 'utf8');

		const rebuilt = await loadHarnessCurrent(root, 1);
		expect(rebuilt.ledgerHeadSeq).toBe(2);
		expect(readFileSync(currentFile, 'utf8')).toBe(staleProjection);
		expect(
			(await loadHarnessCandidate(root, 'candidate-forward-b', 1))?.candidate
				.candidateId,
		).toBe('candidate-forward-b');
	});

	it('replays the first committed record in a new segment from a stale current pointer within the configured bound', async () => {
		const currentFile = harnessCurrentPath(root);
		const secondSegmentPath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'ledger',
			'000002.jsonl',
		);
		let staleProjection = '';
		let latestCandidateId = '';
		for (
			let index = 0;
			index < 1000 && !existsSync(secondSegmentPath);
			index++
		) {
			staleProjection = existsSync(currentFile)
				? readFileSync(currentFile, 'utf8')
				: '';
			latestCandidateId = `candidate-rollover-${index}`;
			await recordHarnessCandidate({
				directory: root,
				candidate: candidate(
					latestCandidateId,
					String(index).padStart(64, 'a'),
				),
			});
		}
		expect(existsSync(secondSegmentPath)).toBe(true);
		expect(staleProjection.length).toBeGreaterThan(0);
		writeFileSync(currentFile, staleProjection, 'utf8');

		const rebuilt = await loadHarnessCurrent(root, 1);
		expect(rebuilt.ledgerHeadSegment).toBe('000002.jsonl');
		expect(
			(await loadHarnessCandidate(root, latestCandidateId, 1))?.candidate
				.candidateId,
		).toBe(latestCandidateId);
	});

	it('fails closed when a stale current pointer would require replay past the configured bound', async () => {
		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-stale-a'),
		});
		const currentFile = harnessCurrentPath(root);
		const staleProjection = readFileSync(currentFile, 'utf8');
		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-stale-b'),
		});
		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-stale-c'),
		});
		writeFileSync(currentFile, staleProjection, 'utf8');

		await expect(loadHarnessCurrent(root, 1)).rejects.toThrow('replay bound 1');
		await expect(
			loadHarnessCandidate(root, 'candidate-stale-c', 1),
		).rejects.toThrow('replay bound 1');
	});

	it('rejects same-segment corruption before the stored head record', async () => {
		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-corrupt-a'),
		});
		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-corrupt-b'),
		});
		const ledgerPath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'ledger',
			'000001.jsonl',
		);
		const [firstLine, secondLine] = readFileSync(ledgerPath, 'utf8')
			.trim()
			.split('\n');
		const firstRecord = JSON.parse(firstLine!) as Record<string, unknown>;
		firstRecord.hashAfter = 'f'.repeat(64);
		writeFileSync(
			ledgerPath,
			`${JSON.stringify(firstRecord)}\n${secondLine!}\n`,
			'utf8',
		);

		await expect(loadHarnessCurrent(root, 10)).rejects.toThrow('hash mismatch');
	});

	it('returns scope_exceeded from audit when the authoritative replay exceeds the configured bound', async () => {
		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-audit-a'),
		});
		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-audit-b'),
		});

		expect(
			await auditHarnessLedger(root, {
				maxReplayRecords: 1,
				maxSegments: 10,
			}),
		).toEqual({
			outcome: 'scope_exceeded',
			maxSegments: 10,
			totalSegments: 1,
			replayBoundExceeded: true,
			maxReplayRecords: 1,
		});
	});

	it('surfaces replay-bound exhaustion instead of quarantining maybe-committed candidates after append errors', async () => {
		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('candidate-committed-a'),
		});
		const original = _storeInternals.appendLedgerLine;
		_storeInternals.appendLedgerLine = (...args) => {
			original(...args);
			throw new Error('simulated post-commit append failure');
		};

		const committed = candidate('candidate-committed-b');
		await expect(
			recordHarnessCandidate({
				directory: root,
				candidate: committed,
				maxReplayRecords: 1,
			}),
		).rejects.toThrow('replay bound 1');

		const orphanedCandidatesDir = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'orphaned-candidates',
		);
		expect(existsSync(orphanedCandidatesDir)).toBe(false);
		expect(
			await loadHarnessCandidate(root, committed.candidate.candidateId, 2),
		).not.toBeNull();
		expect(
			readFileSync(
				path.join(
					root,
					'.swarm',
					'evolution',
					'harness',
					'ledger',
					'000001.jsonl',
				),
				'utf8',
			),
		).toContain(committed.candidate.candidateId);
		expect(
			readdirSync(
				path.join(root, '.swarm', 'evolution', 'harness', 'candidates'),
			),
		).toContain(committed.candidate.candidateId);
	});
});
