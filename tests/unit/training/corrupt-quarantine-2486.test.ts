/**
 * Acceptance checks for issue #2486 — AC8 (corrupt item quarantine).
 *
 * Frozen contract: .agents/issue-traces/2486-consented-training-vault-export/check-contract.md
 *
 * Malformed vault items must be quarantined with a typed reason (malformed_json
 * for non-JSON lines, schema_invalid for JSON lines missing required fields),
 * journaled to quarantine.jsonl, excluded from reads and exports, and counted
 * in manifest counts.quarantined_excluded. Never silently included or dropped.
 *
 * RED at base: src/training/* does not exist yet.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { grantTrainingConsent } from '../../../src/training/consent.js';
import {
	executeTrainingExport,
	issueTrainingConfirmToken,
	previewTrainingExport,
} from '../../../src/training/exporter.js';
import {
	trainingRootDir,
	trainingVaultRecordsPath,
} from '../../../src/training/paths.js';
import {
	appendTrainingVaultRecord,
	buildTrainingVaultRecord,
	getTrainingVaultStatus,
	readTrainingVault,
} from '../../../src/training/vault.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

type Consent = ReturnType<typeof grantTrainingConsent>;
type VaultRecord = ReturnType<typeof buildTrainingVaultRecord>;

const NOW = new Date('2026-08-01T10:00:00.000Z');

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** Grants consent, appends two valid records, then hand-corrupts two more lines. */
function seedCorruptedVault(dir: string): VaultRecord[] {
	const consent = grantTrainingConsent(dir, {
		now: NOW,
		quotas: { maxBytes: 10_485_760, maxRecords: 100, retentionDays: 30 },
		expiresAt: '2030-01-01T00:00:00.000Z',
	});
	const valid: VaultRecord[] = [];
	for (const [content, sessionId] of [
		['valid record one', 'sess-q1'],
		['valid record two', 'sess-q2'],
	] as const) {
		const record = buildTrainingVaultRecord({
			directory: dir,
			kind: 'user_message',
			role: 'user',
			content,
			sessionId,
			pluginVersion: 'test-0.0.0',
			source: 'chat',
			consent,
			now: NOW,
		});
		expect(appendTrainingVaultRecord(dir, record).appended).toBe(true);
		valid.push(record);
	}
	// Hand-write one non-JSON line and one JSON line missing required fields.
	const vaultPath = trainingVaultRecordsPath(dir);
	const existing = fs.readFileSync(vaultPath, 'utf-8');
	fs.writeFileSync(
		vaultPath,
		`${existing}this line is not json at all{{{\n{"foo":"bar","unrelated":true}\n`,
		'utf-8',
	);
	return valid;
}

describe('AC8 corrupt quarantine - reads', () => {
	test('corrupt lines are quarantined with typed reasons and excluded from records', () => {
		const dir = canonicalMkdtemp('training-ac8-read-');
		try {
			const valid = seedCorruptedVault(dir);

			const read = readTrainingVault(dir);
			// Only the valid records survive into records; read never throws.
			expect(read.records).toHaveLength(2);
			expect([...read.records.map((r) => r.record_id)].sort()).toEqual(
				[valid[0].record_id, valid[1].record_id].sort(),
			);

			// Typed quarantine reasons at the corrupt line positions (3 and 4).
			const reasons = read.quarantined.map((q) => ({
				line: q.line,
				reason: q.reason,
			}));
			expect(reasons).toContainEqual({ line: 3, reason: 'malformed_json' });
			expect(reasons).toContainEqual({ line: 4, reason: 'schema_invalid' });
			expect(read.quarantined).toHaveLength(2);

			// The quarantine journal lives under <root>/vault/quarantine.jsonl.
			const quarantinePath = path.join(
				trainingRootDir(dir),
				'vault',
				'quarantine.jsonl',
			);
			expect(fs.existsSync(quarantinePath)).toBe(true);
			const journalLines = fs
				.readFileSync(quarantinePath, 'utf-8')
				.split('\n')
				.filter(Boolean);
			expect(journalLines).toHaveLength(2);
			expect(JSON.parse(journalLines[0]).reason).toBe('malformed_json');
			expect(JSON.parse(journalLines[1]).reason).toBe('schema_invalid');

			// Status counts the quarantined lines.
			expect(getTrainingVaultStatus(dir).quarantinedCount).toBe(2);
		} finally {
			rmDir(dir);
		}
	});
});

describe('AC8 corrupt quarantine - exports exclude corrupt content', () => {
	test('preview and execute exclude corrupt lines; manifest counts quarantined_excluded', () => {
		const dir = canonicalMkdtemp('training-ac8-export-');
		try {
			seedCorruptedVault(dir);

			const preview = previewTrainingExport(dir);
			expect(preview.recordCount).toBe(2);
			expect(preview.quarantinedExcluded).toBe(2);

			const token = issueTrainingConfirmToken(dir, {
				kind: 'export',
				digest: preview.exportId,
			});
			const res = executeTrainingExport(dir, undefined, {
				confirmToken: token,
			});
			expect(res.written).toBe(true);
			const destination = res.destination as string;

			const recordsText = fs.readFileSync(
				path.join(destination, 'records.jsonl'),
				'utf-8',
			);
			// Corrupt content never reaches the bundle.
			expect(recordsText.includes('this line is not json')).toBe(false);
			expect(recordsText.includes('"foo"')).toBe(false);
			const lines = recordsText.split('\n').filter(Boolean);
			expect(lines).toHaveLength(2);
			for (const line of lines) {
				const parsed = JSON.parse(line);
				expect(parsed.record_id).toMatch(/^[0-9a-f]{64}$/);
				expect(parsed.schema_version).toBe(1);
			}

			const manifest = JSON.parse(
				fs.readFileSync(path.join(destination, 'manifest.json'), 'utf-8'),
			);
			expect(manifest.counts.total).toBe(2);
			expect(manifest.counts.quarantined_excluded).toBe(2);
		} finally {
			rmDir(dir);
		}
	});
});
