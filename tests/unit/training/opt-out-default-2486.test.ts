/**
 * Acceptance checks for issue #2486 — AC1 (opt-out default).
 *
 * Frozen contract: .agents/issue-traces/2486-consented-training-vault-export/check-contract.md
 *
 * With no durable consent record the production capture path must write ZERO
 * vault records: the capture observer captures nothing, the direct vault write
 * path refuses with a typed stopReason, and the consent reader fails closed on
 * every non-granted shape. Plugin-injected guidance carriers (the "prompt"
 * surface named by AC1) must never be captured even when consent IS granted.
 *
 * RED at base: src/training/* does not exist yet (intended — these checks are
 * the frozen spec the implementer must satisfy).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTrainingCaptureObserver } from '../../../src/training/capture.js';
import {
	grantTrainingConsent,
	readActiveTrainingConsent,
} from '../../../src/training/consent.js';
import {
	trainingConsentPath,
	trainingVaultRecordsPath,
} from '../../../src/training/paths.js';
import {
	appendTrainingVaultRecord,
	buildTrainingVaultRecord,
	getTrainingVaultStatus,
	readTrainingVault,
} from '../../../src/training/vault.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = new Date('2026-03-15T00:00:00.000Z');

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

describe('AC1 opt-out default - no consent record means zero capture', () => {
	test('capture observer writes zero vault records without consent', async () => {
		const dir = canonicalMkdtemp('training-ac1-none-');
		try {
			const observer = createTrainingCaptureObserver(dir);
			await observer.observeMessages({
				messages: [
					{
						info: { role: 'user', id: 'msg-1', sessionID: 'sess-1' },
						parts: [
							{ type: 'text', text: 'user text that must not be captured' },
						],
					},
				],
			});
			await observer.observeToolExecution({
				tool: 'read',
				sessionID: 'sess-1',
				input: { path: 'x.ts' },
				output: 'contents',
			});

			const status = getTrainingVaultStatus(dir);
			expect(status.recordCount).toBe(0);
			expect(status.consentState).toBe('absent');

			const vault = readTrainingVault(dir);
			expect(vault.records).toHaveLength(0);
			expect(vault.quarantined).toHaveLength(0);
		} finally {
			rmDir(dir);
		}
	});

	test('direct vault write path refuses without an active consent record (typed stopReason)', () => {
		const projectA = canonicalMkdtemp('training-ac1-a-');
		const projectB = canonicalMkdtemp('training-ac1-b-');
		try {
			const consent = grantTrainingConsent(projectA, { now: NOW });
			const record = buildTrainingVaultRecord({
				directory: projectA,
				kind: 'user_message',
				role: 'user',
				content: 'must not land in project B',
				sessionId: 'sess-b',
				pluginVersion: 'test-0.0.0',
				source: 'chat',
				consent,
				now: NOW,
			});

			const result = appendTrainingVaultRecord(projectB, record);
			expect(result.appended).toBe(false);
			expect(result.stopReason).toBe('consent_missing');
			// The refused write must not create a vault file in the non-consented root.
			expect(fs.existsSync(trainingVaultRecordsPath(projectB))).toBe(false);
		} finally {
			rmDir(projectA);
			rmDir(projectB);
		}
	});

	test('readActiveTrainingConsent fails closed: missing file, malformed JSON, schema mismatch', () => {
		const dir = canonicalMkdtemp('training-ac1-closed-');
		try {
			// No consent file at all.
			expect(readActiveTrainingConsent(dir)).toBeNull();

			fs.mkdirSync(path.dirname(trainingConsentPath(dir)), { recursive: true });
			fs.writeFileSync(trainingConsentPath(dir), 'this is not json{', 'utf-8');
			expect(readActiveTrainingConsent(dir)).toBeNull();

			fs.writeFileSync(
				trainingConsentPath(dir),
				JSON.stringify({ unrelated: true }),
				'utf-8',
			);
			expect(readActiveTrainingConsent(dir)).toBeNull();
		} finally {
			rmDir(dir);
		}
	});
});

describe('AC1 opt-out default - no config surface mentions training', () => {
	test('src/config/schema.ts contains no training opt-in flag', () => {
		const schemaPath = path.resolve(
			import.meta.dir,
			'../../../src/config/schema.ts',
		);
		const content = fs.readFileSync(schemaPath, 'utf-8');
		expect(/training/i.test(content)).toBe(false);
	});
});

describe('AC1 opt-out default - plugin-injected guidance is never captured', () => {
	test('guidance carriers, directive text, non-user roles, and non-text parts are skipped', async () => {
		const dir = canonicalMkdtemp('training-ac1-filter-');
		try {
			grantTrainingConsent(dir);
			const observer = createTrainingCaptureObserver(dir);
			await observer.observeMessages({
				messages: [
					{
						info: { role: 'user', id: 'msg-1', sessionID: 'sess-1' },
						parts: [{ type: 'text', text: 'real user text' }],
					},
					{
						info: {
							role: 'user',
							id: 'swarm-guidance:carrier',
							sessionID: 'sess-1',
						},
						parts: [{ type: 'text', text: 'plugin injected guidance carrier' }],
					},
					{
						info: { role: 'assistant', id: 'msg-2', sessionID: 'sess-1' },
						parts: [
							{
								type: 'text',
								text: '<swarm_system_directive source="opencode-swarm">hidden directive</swarm_system_directive>',
							},
						],
					},
					{
						info: { role: 'system', id: 'msg-3', sessionID: 'sess-1' },
						parts: [{ type: 'text', text: 'system role text' }],
					},
					{
						info: { role: 'user', id: 'msg-4', sessionID: 'sess-1' },
						parts: [{ type: 'tool_invocation' }],
					},
					{
						info: { role: 'user', id: 'msg-5', sessionID: 'sess-1' },
						parts: [{ type: 'text', text: '' }],
					},
				],
			});

			const vault = readTrainingVault(dir);
			expect(vault.records).toHaveLength(1);
			const captured = vault.records[0];
			expect(captured.content).toBe('real user text');
			expect(captured.role).toBe('user');
			expect(captured.kind).toBe('user_message');
		} finally {
			rmDir(dir);
		}
	});

	test('duplicate observation of identical content captures once (in-process dedup)', async () => {
		const dir = canonicalMkdtemp('training-ac1-dedup-');
		try {
			grantTrainingConsent(dir);
			const observer = createTrainingCaptureObserver(dir);
			const message = {
				info: { role: 'user', id: 'msg-dup', sessionID: 'sess-dup' },
				parts: [{ type: 'text', text: 'identical content observed twice' }],
			};
			await observer.observeMessages({ messages: [message] });
			await observer.observeMessages({ messages: [message] });

			const vault = readTrainingVault(dir);
			expect(vault.records).toHaveLength(1);
		} finally {
			rmDir(dir);
		}
	});
});
