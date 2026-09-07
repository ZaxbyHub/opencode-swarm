/**
 * Acceptance checks for issue #2486 — AC3 (cross-project isolation).
 *
 * Frozen contract: .agents/issue-traces/2486-consented-training-vault-export/check-contract.md
 *
 * A consent record (or whole vault tree) copied verbatim to a different
 * canonical project root must NOT authorize capture there: the project-binding
 * digest check fails closed even though the file bytes are identical.
 *
 * RED at base: src/training/* does not exist yet.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	computeProjectBinding,
	grantTrainingConsent,
	readActiveTrainingConsent,
} from '../../../src/training/consent.js';
import {
	TRAINING_ROOT_NAME,
	trainingConsentPath,
	trainingExportsDir,
	trainingHealthPath,
	trainingRootDir,
	trainingTombstonesPath,
	trainingVaultRecordsPath,
} from '../../../src/training/paths.js';
import {
	appendTrainingVaultRecord,
	buildTrainingVaultRecord,
	readTrainingVault,
} from '../../../src/training/vault.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = new Date('2026-05-01T00:00:00.000Z');

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

describe('AC3 isolation - training tree paths live under .swarm/training/v1', () => {
	test('path helpers resolve the contract layout under the project root', () => {
		const dir = canonicalMkdtemp('training-ac3-paths-');
		try {
			const root = path.resolve(dir, '.swarm/training/v1');
			expect(TRAINING_ROOT_NAME).toBe('.swarm/training/v1');
			expect(trainingRootDir(dir)).toBe(root);
			expect(trainingVaultRecordsPath(dir)).toBe(
				path.join(root, 'vault', 'records.jsonl'),
			);
			expect(trainingConsentPath(dir)).toBe(path.join(root, 'consent.json'));
			expect(trainingTombstonesPath(dir)).toBe(
				path.join(root, 'tombstones.jsonl'),
			);
			expect(trainingHealthPath(dir)).toBe(path.join(root, 'health.json'));
			expect(trainingExportsDir(dir)).toBe(path.join(root, 'exports'));
		} finally {
			rmDir(dir);
		}
	});
});

describe('AC3 isolation - consent copied verbatim to another root does not authorize capture', () => {
	test('byte-identical consent.json is inert in project B while active in project A', () => {
		const projectA = canonicalMkdtemp('training-ac3-a-');
		const projectB = canonicalMkdtemp('training-ac3-b-');
		try {
			// Distinct canonical roots must produce distinct bindings (negative control).
			const bindingA = computeProjectBinding(projectA);
			const bindingB = computeProjectBinding(projectB);
			expect(bindingA.rootDigest).not.toBe(bindingB.rootDigest);

			const consent = grantTrainingConsent(projectA, { now: NOW });
			const record = buildTrainingVaultRecord({
				directory: projectA,
				kind: 'user_message',
				role: 'user',
				content: 'project a content',
				sessionId: 'sess-a',
				pluginVersion: 'test-0.0.0',
				source: 'chat',
				consent,
				now: NOW,
			});
			expect(appendTrainingVaultRecord(projectA, record).appended).toBe(true);

			// Copy the ENTIRE .swarm/training/v1 tree verbatim from A to B.
			fs.mkdirSync(trainingRootDir(projectB), { recursive: true });
			fs.cpSync(trainingRootDir(projectA), trainingRootDir(projectB), {
				recursive: true,
			});

			// B's consent.json is byte-identical to A's and parses with state granted.
			const bytesA = fs.readFileSync(trainingConsentPath(projectA));
			const bytesB = fs.readFileSync(trainingConsentPath(projectB));
			expect(bytesB.equals(bytesA)).toBe(true);
			expect(JSON.parse(bytesB.toString('utf-8')).state).toBe('granted');

			// Yet the active-consent read fails closed in B (project binding mismatch)
			// while remaining active in A, evaluated at the same instant.
			const atActiveTime = { now: new Date('2026-05-02T00:00:00.000Z') };
			expect(readActiveTrainingConsent(projectB, atActiveTime)).toBeNull();
			expect(readActiveTrainingConsent(projectA, atActiveTime)).not.toBeNull();

			// The copied consent cannot authorize a vault write in B either.
			const bRecord = buildTrainingVaultRecord({
				directory: projectB,
				kind: 'user_message',
				role: 'user',
				content: 'attempted project b content',
				sessionId: 'sess-b',
				pluginVersion: 'test-0.0.0',
				source: 'chat',
				consent,
				now: NOW,
			});
			const refused = appendTrainingVaultRecord(projectB, bRecord);
			expect(refused.appended).toBe(false);
			expect(refused.stopReason).toBe('consent_missing');

			// Neither vault was mutated by the refused write: A kept its record,
			// B still holds only the verbatim copy.
			expect(readTrainingVault(projectA).records).toHaveLength(1);
			expect(readTrainingVault(projectB).records).toHaveLength(1);
		} finally {
			rmDir(projectA);
			rmDir(projectB);
		}
	});
});
