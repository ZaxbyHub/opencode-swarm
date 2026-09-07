/**
 * Acceptance checks for issue #2486 — AC2 (consent record + record metadata).
 *
 * Frozen contract: .agents/issue-traces/2486-consented-training-vault-export/check-contract.md
 *
 * A granted consent must persist version, purpose/classes, quotas (clamped to
 * ceilings), retention/expiry, and project binding; every vault record must
 * carry lineage, role, labels with provenance/confidence, provenance, redaction
 * state, consent version, and retention/expiry. Digests are recomputed with
 * node:crypto per the contract formulas.
 *
 * RED at base: src/training/* does not exist yet.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createTrainingCaptureObserver } from '../../../src/training/capture.js';
import {
	computeProjectBinding,
	grantTrainingConsent,
	readActiveTrainingConsent,
	TRAINING_CONSENT_CURRENT_VERSION,
	TRAINING_CONSENT_SCHEMA_VERSION,
	TRAINING_EXPORT_QUOTA_CEILINGS,
	TRAINING_QUOTA_CEILINGS,
} from '../../../src/training/consent.js';
import { TRAINING_DISK_FLOOR_BYTES } from '../../../src/training/disk.js';
import { TRAINING_EXPORT_SCHEMA_VERSION } from '../../../src/training/exporter.js';
import { trainingConsentPath } from '../../../src/training/paths.js';
import {
	appendTrainingVaultRecord,
	buildTrainingVaultRecord,
	REDACTION_VERSION,
	readTrainingVault,
	TRAINING_VAULT_SCHEMA_VERSION,
} from '../../../src/training/vault.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

type Consent = ReturnType<typeof grantTrainingConsent>;
type Record_ = ReturnType<typeof buildTrainingVaultRecord>;

const NOW = new Date('2026-03-10T08:00:00.000Z');
const DAY_MS = 86_400_000;

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function sha256(input: string): string {
	return createHash('sha256').update(input).digest('hex');
}

function buildInput(
	dir: string,
	consent: Consent,
	overrides: Partial<Parameters<typeof buildTrainingVaultRecord>[0]> = {},
) {
	return {
		directory: dir,
		kind: 'user_message',
		role: 'user',
		content: 'hello vault',
		sessionId: 'sess-42',
		taskId: 'task-9',
		traceId: 'trace-7',
		pluginVersion: 'test-7.7.7',
		source: 'chat',
		consent,
		labels: [
			{
				name: 'source',
				value: 'chat',
				provenance: 'plugin-hook',
				confidence: 1,
			},
		],
		now: NOW,
		...overrides,
	};
}

describe('AC2 metadata - contract constants', () => {
	test('schema versions, redaction version, and quota ceilings match the frozen contract', () => {
		expect(TRAINING_CONSENT_SCHEMA_VERSION).toBe(1);
		expect(TRAINING_CONSENT_CURRENT_VERSION).toBe(1);
		expect(TRAINING_QUOTA_CEILINGS).toEqual({
			maxBytes: 1_073_741_824,
			maxRecords: 250_000,
			retentionDays: 30,
		});
		expect(TRAINING_EXPORT_QUOTA_CEILINGS).toEqual({
			maxBytes: 1_073_741_824,
			maxExports: 20,
			retentionDays: 30,
		});
		expect(TRAINING_VAULT_SCHEMA_VERSION).toBe(1);
		expect(REDACTION_VERSION).toBe(1);
		expect(TRAINING_EXPORT_SCHEMA_VERSION).toBe(1);
		expect(TRAINING_DISK_FLOOR_BYTES).toBe(2_147_483_648);
	});
});

describe('AC2 metadata - computeProjectBinding', () => {
	test('returns 16-hex digests, deterministic per root, distinct across roots', () => {
		const dirA = canonicalMkdtemp('training-ac2-bind-a-');
		const dirB = canonicalMkdtemp('training-ac2-bind-b-');
		try {
			const a = computeProjectBinding(dirA);
			expect(a.rootDigest).toMatch(/^[0-9a-f]{16}$/);
			expect(a.projectRef).toMatch(/^[0-9a-f]{16}$/);
			expect(computeProjectBinding(dirA)).toEqual(a);

			const b = computeProjectBinding(dirB);
			expect(b.rootDigest).not.toBe(a.rootDigest);
			expect(b.projectRef).not.toBe(a.projectRef);
		} finally {
			rmDir(dirA);
			rmDir(dirB);
		}
	});
});

describe('AC2 metadata - granted consent record on disk', () => {
	test('consent.json carries the full schema with clamped quotas and derived expiry', () => {
		const dir = canonicalMkdtemp('training-ac2-grant-');
		try {
			const consent = grantTrainingConsent(dir, {
				now: NOW,
				quotas: { maxBytes: 1_048_576, maxRecords: 500, retentionDays: 7 },
			});
			expect(consent.state).toBe('granted');
			expect(consent.schema_version).toBe(1);

			const consentPath = trainingConsentPath(dir);
			expect(fs.existsSync(consentPath)).toBe(true);
			const raw = JSON.parse(fs.readFileSync(consentPath, 'utf-8'));
			expect(raw.schema_version).toBe(1);
			expect(raw.state).toBe('granted');
			expect(raw.consent_version).toBe(1);
			expect(raw.granted_at).toBe(NOW.toISOString());
			expect(raw.expires_at).toBe(
				new Date(NOW.getTime() + 7 * DAY_MS).toISOString(),
			);
			expect(typeof raw.consent_id).toBe('string');
			expect(raw.consent_id.length).toBeGreaterThan(0);
			expect(typeof raw.purpose).toBe('string');
			expect(raw.purpose.length).toBeGreaterThan(0);
			expect(Array.isArray(raw.content_classes)).toBe(true);
			expect(raw.quotas).toEqual({
				maxBytes: 1_048_576,
				maxRecords: 500,
				retentionDays: 7,
			});
			expect(raw.redaction_version).toBe(1);
			expect(raw.project_binding).toEqual(computeProjectBinding(dir));

			// Round-trip: active before expiry, null after.
			expect(
				readActiveTrainingConsent(dir, {
					now: new Date('2026-03-11T00:00:00.000Z'),
				}),
			).not.toBeNull();
			expect(
				readActiveTrainingConsent(dir, {
					now: new Date('2026-03-20T00:00:00.000Z'),
				}),
			).toBeNull();
		} finally {
			rmDir(dir);
		}
	});

	test('quotas above the ceilings clamp down; lower values pass through', () => {
		const dir = canonicalMkdtemp('training-ac2-clamp-');
		try {
			const consent = grantTrainingConsent(dir, {
				now: NOW,
				quotas: {
					maxBytes: 2 ** 50,
					maxRecords: 999_999_999,
					retentionDays: 365,
				},
			});
			expect(consent.quotas).toEqual({
				maxBytes: 1_073_741_824,
				maxRecords: 250_000,
				retentionDays: 30,
			});
		} finally {
			rmDir(dir);
		}
	});

	test('an explicit expiresAt wins over the retention-derived default', () => {
		const dir = canonicalMkdtemp('training-ac2-exp-');
		try {
			const consent = grantTrainingConsent(dir, {
				now: NOW,
				expiresAt: '2027-01-01T00:00:00.000Z',
			});
			expect(consent.expires_at).toBe('2027-01-01T00:00:00.000Z');
		} finally {
			rmDir(dir);
		}
	});
});

describe('AC2 metadata - vault record built by the contract builder', () => {
	test('record carries lineage, role, labels, provenance, redaction, consent, retention', () => {
		const dir = canonicalMkdtemp('training-ac2-rec-');
		try {
			const consent = grantTrainingConsent(dir, {
				now: NOW,
				quotas: { maxBytes: 10_485_760, maxRecords: 100, retentionDays: 7 },
				expiresAt: '2027-01-01T00:00:00.000Z',
			});
			const record: Record_ = buildTrainingVaultRecord(
				buildInput(dir, consent),
			);

			const contentDigest = sha256('hello vault');
			expect(record.content_digest).toBe(contentDigest);
			expect(record.schema_version).toBe(1);
			expect(record.record_id).toMatch(/^[0-9a-f]{64}$/);
			// record_id formula from the frozen contract, recomputed locally.
			expect(record.record_id).toBe(
				sha256(
					'training-record-v1\0' +
						consent.project_binding.projectRef +
						'\0' +
						'sess-42' +
						'\0' +
						'user_message' +
						'\0' +
						'user' +
						'\0' +
						contentDigest,
				),
			);
			expect(record.kind).toBe('user_message');
			expect(record.role).toBe('user');
			expect(record.content).toBe('hello vault');
			expect(record.lineage).toEqual({
				session_id: 'sess-42',
				task_id: 'task-9',
				trace_id: 'trace-7',
				project_ref: consent.project_binding.projectRef,
				captured_at: NOW.toISOString(),
			});
			expect(record.labels).toEqual([
				{
					name: 'source',
					value: 'chat',
					provenance: 'plugin-hook',
					confidence: 1,
				},
			]);
			expect(record.provenance).toEqual({
				plugin_version: 'test-7.7.7',
				source: 'chat',
			});
			expect(record.redaction.version).toBe(1);
			expect(record.redaction.redactions).toBe(0);
			expect(record.consent).toEqual({ id: consent.consent_id, version: 1 });
			// retention = min(captured_at + retentionDays, consent.expires_at) —
			// here the 7-day retention is the smaller side.
			expect(record.retention.expires_at).toBe(
				new Date(NOW.getTime() + 7 * DAY_MS).toISOString(),
			);

			// Round-trip through the only vault write path preserves the record.
			expect(appendTrainingVaultRecord(dir, record).appended).toBe(true);
			const read = readTrainingVault(dir);
			expect(read.records).toHaveLength(1);
			expect(read.records[0]).toEqual(record);
		} finally {
			rmDir(dir);
		}
	});

	test('consent expiry caps retention when it is the smaller side', () => {
		const dir = canonicalMkdtemp('training-ac2-cap-');
		try {
			const consent = grantTrainingConsent(dir, {
				now: NOW,
				expiresAt: '2026-04-02T00:00:00.000Z',
			});
			const record = buildTrainingVaultRecord(buildInput(dir, consent));
			// Default retention (30d) would be 2026-04-09; consent expiry 04-02 wins.
			expect(record.retention.expires_at).toBe('2026-04-02T00:00:00.000Z');
		} finally {
			rmDir(dir);
		}
	});

	test('content is truncated to 4096 chars', () => {
		const dir = canonicalMkdtemp('training-ac2-trunc-');
		try {
			const consent = grantTrainingConsent(dir, { now: NOW });
			const record = buildTrainingVaultRecord(
				buildInput(dir, consent, { content: 'x'.repeat(6000) }),
			);
			expect(record.content.length).toBe(4096);
		} finally {
			rmDir(dir);
		}
	});

	test('defense-in-depth redaction strips URL/token patterns and records the state', () => {
		const dir = canonicalMkdtemp('training-ac2-redact-');
		try {
			const consent = grantTrainingConsent(dir, { now: NOW });
			const record = buildTrainingVaultRecord(
				buildInput(dir, consent, {
					content:
						'see https://internal.example.invalid/p?token=abc123def456 for details',
				}),
			);
			expect(record.redaction.version).toBe(1);
			expect(record.redaction.redactions).toBeGreaterThanOrEqual(1);
			expect(record.content.includes('https://internal.example.invalid')).toBe(
				false,
			);
			expect(record.content.includes('abc123def456')).toBe(false);
		} finally {
			rmDir(dir);
		}
	});
});

describe('AC2 metadata - tool capture records carry bounded summaries and labels', () => {
	test('observeToolExecution records a tool_call/tool_result pair with source labels', async () => {
		const dir = canonicalMkdtemp('training-ac2-tool-');
		try {
			grantTrainingConsent(dir);
			const observer = createTrainingCaptureObserver(dir);
			await observer.observeToolExecution({
				tool: 'bash',
				sessionID: 'sess-tool',
				input: { command: 'echo hi' },
				output: 'hi',
			});
			await observer.observeToolExecution({
				tool: 'bash',
				sessionID: 'sess-tool',
				input: { blob: 'y'.repeat(9000) },
				output: 'ok',
			});

			const vault = readTrainingVault(dir);
			expect(vault.records).toHaveLength(4);
			const kinds = vault.records.map((r) => r.kind).sort();
			expect(kinds).toEqual([
				'tool_call',
				'tool_call',
				'tool_result',
				'tool_result',
			]);
			let sawBounded = false;
			for (const rec of vault.records) {
				expect(rec.kind === 'tool_call' || rec.kind === 'tool_result').toBe(
					true,
				);
				expect(rec.content.length).toBeLessThanOrEqual(4096);
				if (rec.content.length === 4096) sawBounded = true;
				expect(rec.lineage.session_id).toBe('sess-tool');
				const sourceLabels = rec.labels.filter((l) => l.name === 'source');
				expect(sourceLabels).toHaveLength(1);
				expect(sourceLabels[0].value).toBe('tool');
				expect(sourceLabels[0].provenance).toBe('plugin-hook');
				expect(sourceLabels[0].confidence).toBe(1);
			}
			expect(sawBounded).toBe(true);
		} finally {
			rmDir(dir);
		}
	});
});
