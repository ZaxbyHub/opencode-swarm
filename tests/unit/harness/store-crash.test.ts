import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
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
	listHarnessHistory,
	loadHarnessCandidate,
	loadHarnessCurrent,
	reconcileHarnessCurrent,
	recordHarnessCandidate,
	recoverHarnessCorruptTail,
	type StoredHarnessCandidateV1,
} from '../../../src/harness/store.js';
import {
	computeWriteApprovalHash,
	issueWriteApprovalFact,
} from '../../../src/security/write-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function candidate(id: string): StoredHarnessCandidateV1 {
	const manifestBase = {
		v: 1 as const,
		candidateId: id,
		baseSha: 'a'.repeat(40),
		origin: 'issue-1825',
		patchSha256: 'b'.repeat(64),
		approvedPaths: ['src/agents/demo.ts'],
		promptArtifactHashes: [],
		files: [
			{
				relativePath: 'src/agents/demo.ts',
				trackedMode: '100644',
				beforeSha256: 'd'.repeat(64),
				afterSha256: 'e'.repeat(64),
				bytesBefore: 10,
				bytesAfter: 10,
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

describe('harness store crash recovery', () => {
	let root = '';

	beforeEach(() => {
		root = canonicalMkdtemp('harness-store-crash-');
	});

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = '';
	});

	it('replays the last complete ledger state when current.json is stale or missing', async () => {
		const stored = candidate('candidate-1');
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
		if (activated.status !== 'activated')
			throw new Error('expected activation');
		const currentPath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'current.json',
		);
		writeFileSync(currentPath, '{"v":1,"currentHash":"bad"}\n', 'utf8');
		const rebuilt = await loadHarnessCurrent(root);
		expect(rebuilt.currentCandidateId).toBe(stored.candidate.candidateId);
		expect(rebuilt.currentHash).toBe(activated.current.currentHash);
	});

	it('returns a committed activation result when current.json projection write fails and can later reconcile from the ledger', async () => {
		const stored = candidate('candidate-projection-failure');
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
		const currentPath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'current.json',
		);
		rmSync(currentPath, { force: true });
		mkdirSync(currentPath, { recursive: true });

		const activated = await activateHarnessCandidate({
			directory: root,
			candidateId: stored.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(await loadHarnessCurrent(root), stored),
		});
		expect(activated.status).toBe('activated');
		if (activated.status !== 'activated')
			throw new Error('expected activation');
		expect(activated.projectionReconciled).toBe(false);
		expect(activated.current.currentCandidateId).toBe(
			stored.candidate.candidateId,
		);
		rmSync(currentPath, { recursive: true, force: true });

		const reconciled = await reconcileHarnessCurrent(root);
		expect(reconciled.currentCandidateId).toBe(stored.candidate.candidateId);
		expect(readFileSync(currentPath, 'utf8')).toContain(
			stored.candidate.candidateId,
		);
	});

	it('recovers only a physically torn final ledger line', async () => {
		const stored = candidate('candidate-2');
		await recordHarnessCandidate({ directory: root, candidate: stored });
		const ledgerDir = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'ledger',
		);
		mkdirSync(ledgerDir, { recursive: true });
		const ledgerPath = path.join(ledgerDir, '000001.jsonl');
		writeFileSync(
			ledgerPath,
			`${readFileSync(ledgerPath, 'utf8')}{"broken":`,
			'utf8',
		);
		const history = await listHarnessHistory(root);
		expect(history.truncated).toBe(true);
		expect(history.records).toHaveLength(1);
		expect(history.quarantinePath).toBeNull();
		expect(
			readdirSync(path.dirname(ledgerDir)).filter((name) =>
				name.startsWith('ledger-quarantine.'),
			),
		).toEqual([]);
	});

	it('repairs a torn tail under lock before a later mutation appends', async () => {
		const first = candidate('candidate-torn-first');
		await recordHarnessCandidate({ directory: root, candidate: first });
		const ledgerPath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'ledger',
			'000001.jsonl',
		);
		writeFileSync(
			ledgerPath,
			`${readFileSync(ledgerPath, 'utf8')}{"torn":`,
			'utf8',
		);
		const second = candidate('candidate-torn-second');
		await recordHarnessCandidate({ directory: root, candidate: second });
		const audit = await auditHarnessLedger(root, {
			maxReplayRecords: 10,
			maxSegments: 10,
		});
		expect(audit.outcome).toBe('ok');
		if (audit.outcome !== 'ok') throw new Error('expected audit');
		expect(audit.truncated).toBe(false);
		expect(audit.records.map((record) => record.candidateId)).toEqual([
			first.candidate.candidateId,
			'system.recovered-tail',
			second.candidate.candidateId,
		]);
		expect(audit.records[1]?.kind).toBe('recovered_tail');
	});

	it('recovers a torn tail through the explicit API and records the repair event', async () => {
		const stored = candidate('candidate-explicit-recovery');
		await recordHarnessCandidate({ directory: root, candidate: stored });
		const ledgerPath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'ledger',
			'000001.jsonl',
		);
		writeFileSync(
			ledgerPath,
			`${readFileSync(ledgerPath, 'utf8')}{"torn":`,
			'utf8',
		);
		const repaired = await recoverHarnessCorruptTail(root, 10);
		expect(repaired.truncated).toBe(false);
		expect(repaired.records[0]?.kind).toBe('recovered_tail');
		const audit = await auditHarnessLedger(root, {
			maxReplayRecords: 10,
			maxSegments: 10,
		});
		expect(audit.outcome).toBe('ok');
		if (audit.outcome !== 'ok') throw new Error('expected audit');
		expect(audit.records.map((record) => record.kind)).toEqual([
			'candidate_recorded',
			'recovered_tail',
		]);
		expect(audit.records[1]?.recoverySegment).toBe('000001.jsonl');
		expect(audit.records[1]?.recoveredBytes).toBeGreaterThan(0);
	});

	it('verifies committed artifacts before accepting a torn-tail replay', async () => {
		const stored = candidate('candidate-torn-integrity');
		await recordHarnessCandidate({ directory: root, candidate: stored });
		const ledgerPath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'ledger',
			'000001.jsonl',
		);
		writeFileSync(
			ledgerPath,
			`${readFileSync(ledgerPath, 'utf8')}{"torn":`,
			'utf8',
		);
		rmSync(
			path.join(
				root,
				'.swarm',
				'evolution',
				'harness',
				'candidates',
				stored.candidate.candidateId,
				'record.json',
			),
		);
		await expect(listHarnessHistory(root)).rejects.toThrow(
			'missing or mismatched candidate',
		);
	});

	it('quarantines the candidate if the ledger append fails after candidate write', async () => {
		const originalAppendLedgerLine = _storeInternals.appendLedgerLine;
		_storeInternals.appendLedgerLine = () => {
			throw new Error('simulated append failure');
		};

		try {
			for (let index = 0; index < 20; index++) {
				await expect(
					recordHarnessCandidate({
						directory: root,
						candidate: candidate(`candidate-quarantine-${index}`),
					}),
				).rejects.toThrow('simulated append failure');
			}

			const orphaned = readdirSync(
				path.join(
					root,
					'.swarm',
					'evolution',
					'harness',
					'orphaned-candidates',
				),
			);
			expect(orphaned).toHaveLength(16);
		} finally {
			_storeInternals.appendLedgerLine = originalAppendLedgerLine;
		}
	});

	it('fails closed on a complete malformed ledger record', async () => {
		const stored = candidate('candidate-3');
		await recordHarnessCandidate({ directory: root, candidate: stored });
		const ledgerPath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'ledger',
			'000001.jsonl',
		);
		writeFileSync(
			ledgerPath,
			`${readFileSync(ledgerPath, 'utf8')}{"broken":\n`,
			'utf8',
		);
		await expect(listHarnessHistory(root)).rejects.toThrow('JSON Parse error');
	});

	it('fails closed on a rehashed sequence discontinuity', async () => {
		const stored = candidate('candidate-sequence-gap');
		await recordHarnessCandidate({ directory: root, candidate: stored });
		const ledgerPath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'ledger',
			'000001.jsonl',
		);
		const record = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<
			string,
			unknown
		>;
		record.seq = 2;
		const { hashAfter: _ignored, ...withoutHash } = record;
		record.hashAfter = sha256(canonicalJson(withoutHash));
		writeFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
		await expect(listHarnessHistory(root)).rejects.toThrow('sequence gap');
	});

	it('fails closed when ledger segment numbering has a gap', async () => {
		const stored = candidate('candidate-segment-gap');
		await recordHarnessCandidate({ directory: root, candidate: stored });
		const ledgerDir = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'ledger',
		);
		writeFileSync(path.join(ledgerDir, '000003.jsonl'), '', 'utf8');
		await expect(listHarnessHistory(root)).rejects.toThrow('segment gap');
	});

	it('returns scope_exceeded from full ledger audit when the segment bound is too small', async () => {
		const stored = candidate('candidate-audit-bound');
		await recordHarnessCandidate({ directory: root, candidate: stored });
		expect(
			await auditHarnessLedger(root, { maxReplayRecords: 10, maxSegments: 0 }),
		).toEqual({
			outcome: 'scope_exceeded',
			maxSegments: 0,
			totalSegments: 1,
		});
	});

	it('fails closed with a typed integrity error for malformed immutable records', async () => {
		const stored = candidate('candidate-corrupt');
		await recordHarnessCandidate({ directory: root, candidate: stored });
		const candidatePath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'candidates',
			stored.candidate.candidateId,
			'record.json',
		);
		writeFileSync(candidatePath, '{"v":1', 'utf8');
		try {
			await loadHarnessCandidate(root, stored.candidate.candidateId);
			throw new Error('expected integrity failure');
		} catch (error) {
			expect((error as { code?: string }).code).toBe('HARNESS_STORE_INTEGRITY');
		}
	});

	it('quarantines a version written before a crashed ledger append', async () => {
		const stored = candidate('candidate-orphan-recovery');
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
		const versionsDir = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'versions',
		);
		mkdirSync(versionsDir, { recursive: true });
		writeFileSync(
			path.join(versionsDir, 'orphan-version.json'),
			'{"uncommitted":true}\n',
		);

		const activated = await activateHarnessCandidate({
			directory: root,
			candidateId: stored.candidate.candidateId,
			consumerSessionId: 'session-a',
			...activationBinding(await loadHarnessCurrent(root), stored),
		});
		expect(activated.status).toBe('activated');
		const quarantined = readdirSync(
			path.join(root, '.swarm', 'evolution', 'harness', 'orphaned-versions'),
		);
		expect(
			quarantined.some((name) => name.startsWith('orphan-version.json.')),
		).toBe(true);
	});
});
