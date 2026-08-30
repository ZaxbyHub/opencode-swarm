import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	linkSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
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
	auditHarnessLedger,
	loadHarnessCandidate,
	recordHarnessCandidate,
} from '../../../src/harness/store.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function candidate(id: string) {
	const manifest = {
		v: 1 as const,
		candidateId: id,
		baseSha: 'a'.repeat(40),
		origin: 'issue-1825',
		patchSha256: sha256(id),
		approvedPaths: ['src/agents/demo.ts'],
		promptArtifactHashes: [],
		files: [
			{
				relativePath: 'src/agents/demo.ts',
				trackedMode: '100644',
				beforeSha256: 'b'.repeat(64),
				afterSha256: 'c'.repeat(64),
				bytesBefore: 1,
				bytesAfter: 1,
				addedLines: 1,
				removedLines: 1,
				changedLines: 1,
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
					prompt: 'static',
					tools: {},
				},
			},
		],
		registeredToolIds: [],
	}).projectBlueprint({ blueprintId: `blueprint-${id}` });
	return {
		v: 1 as const,
		baseBlueprint: blueprint,
		targetBlueprint: blueprint,
		blueprintPatch: {
			v: 1 as const,
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

describe('harness store torn-tail recovery with missing projection', () => {
	let root = '';

	beforeEach(() => {
		root = canonicalMkdtemp('harness-store-crash-missing-current-');
	});

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = '';
	});

	it('repairs the torn tail before a mutation when current.json is missing', async () => {
		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('first'),
		});
		const ledgerPath = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'ledger',
			'000001.jsonl',
		);
		writeFileSync(
			`${ledgerPath}`,
			`${readFileSync(ledgerPath, 'utf8')}{"torn":`,
			'utf8',
		);
		rmSync(path.join(root, '.swarm', 'evolution', 'harness', 'current.json'));

		await recordHarnessCandidate({
			directory: root,
			candidate: candidate('second'),
		});
		const audit = await auditHarnessLedger(root, {
			maxReplayRecords: 10,
			maxSegments: 10,
		});
		expect(audit.outcome).toBe('ok');
		if (audit.outcome !== 'ok') throw new Error('expected audit');
		expect(audit.truncated).toBe(false);
		expect(audit.records.map((record) => record.kind)).toEqual([
			'candidate_recorded',
			'recovered_tail',
			'candidate_recorded',
		]);
	});

	it('rejects a hardlinked stored candidate artifact', async () => {
		const stored = candidate('hardlinked-candidate');
		await recordHarnessCandidate({ directory: root, candidate: stored });
		const candidateDir = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'candidates',
			stored.candidate.candidateId,
		);
		const recordPath = path.join(candidateDir, 'record.json');
		const externalPath = path.join(root, 'external-record.json');
		renameSync(recordPath, externalPath);
		linkSync(externalPath, recordPath);
		await expect(
			loadHarnessCandidate(root, stored.candidate.candidateId),
		).rejects.toThrow(/malformed harness JSON/);
	});

	it('rejects stored artifacts reached through a parent junction', async () => {
		const stored = candidate('junction-candidate');
		await recordHarnessCandidate({ directory: root, candidate: stored });
		const candidatesDir = path.join(
			root,
			'.swarm',
			'evolution',
			'harness',
			'candidates',
		);
		const candidateDir = path.join(candidatesDir, stored.candidate.candidateId);
		const movedDir = path.join(root, 'moved-candidate');
		renameSync(candidateDir, movedDir);
		symlinkSync(movedDir, candidateDir, 'junction');
		await expect(
			loadHarnessCandidate(root, stored.candidate.candidateId),
		).rejects.toThrow(/symlink or junction/);
	});
});
