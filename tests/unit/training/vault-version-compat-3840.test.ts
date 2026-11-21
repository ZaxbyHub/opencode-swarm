/**
 * #3840 vault version compatibility: tolerant read range, sweep retention of
 * version-only-quarantined lines, durable journal dedup, preflight-exact byte
 * cap. Synthetic tokens only.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { grantTrainingConsent } from '../../../src/training/consent';
import {
	trainingQuarantinePath,
	trainingVaultRecordsPath,
} from '../../../src/training/paths';
import { TRAINING_REDACTION_VERSION } from '../../../src/training/redact';
import {
	appendTrainingVaultRecord,
	buildTrainingVaultRecord,
	readTrainingVault,
	sweepTrainingVaultExpiry,
} from '../../../src/training/vault';

const NOW = new Date('2026-01-01T00:00:00Z');

function freshDir(): string {
	return realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sw-3840-vault-')));
}

function consent(dir: string, maxBytes = 1_000_000) {
	return grantTrainingConsent(dir, {
		now: NOW,
		quotas: { maxBytes, maxRecords: 100, retentionDays: 30 },
	});
}

function record(dir: string, cst: ReturnType<typeof consent>, content: string) {
	return buildTrainingVaultRecord({
		content,
		consent: cst,
		sessionId: 'sess-3840',
		kind: 'user_message',
		role: 'user',
		source: 'chat',
		pluginVersion: 'test',
		now: NOW,
	});
}

describe('#3840 vault version compatibility', () => {
	let dir: string;
	beforeAll(() => {
		dir = freshDir();
	});

	test('current writes stamp version 2', () => {
		const cst = consent(dir);
		expect(record(dir, cst, 'hello').redaction.version).toBe(
			TRAINING_REDACTION_VERSION,
		);
	});

	test('a hand-written v1 record stays readable and survives the sweep', () => {
		const d = freshDir();
		const cst = consent(d);
		const current = record(d, cst, 'v1 content');
		const v1Line = `${JSON.stringify({
			...current,
			redaction: { ...current.redaction, version: 1 },
		})}\n`;
		const target = trainingVaultRecordsPath(d);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, v1Line, 'utf8');
		const read = readTrainingVault(d);
		expect(read.quarantined).toHaveLength(0);
		expect(read.records).toHaveLength(1);
		expect(read.records[0]?.redaction.version).toBe(1);
		const sweep = sweepTrainingVaultExpiry(d, { now: NOW });
		expect(sweep.purged).toBe(0);
		expect(readFileSync(target, 'utf8')).toContain('v1 content');
	});

	test('version-99 record is read-quarantined but RETAINED by the sweep', () => {
		const d = freshDir();
		const cst = consent(d);
		const current = record(d, cst, 'future content');
		const v99 = `${JSON.stringify({
			...current,
			redaction: { ...current.redaction, version: 99 },
		})}\n`;
		const target = trainingVaultRecordsPath(d);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, v99, 'utf8');
		const read = readTrainingVault(d);
		expect(read.quarantined).toHaveLength(1);
		expect(read.records).toHaveLength(0);
		const sweep = sweepTrainingVaultExpiry(d, { now: NOW });
		expect(sweep.purged).toBe(0); // unexpired future version — retained
		const text = readFileSync(target, 'utf8');
		expect(text).toContain('future content'); // physically survived
	});

	test('EXPIRY WINS: an expired version-99 record is purged', () => {
		const d = freshDir();
		const cst = consent(d);
		const current = record(d, cst, 'expired future');
		const expired = `${JSON.stringify({
			...current,
			redaction: { ...current.redaction, version: 99 },
			retention: { expires_at: '2025-01-01T00:00:00.000Z' },
		})}\n`;
		const target = trainingVaultRecordsPath(d);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, expired, 'utf8');
		const sweep = sweepTrainingVaultExpiry(d, { now: NOW });
		expect(sweep.purged).toBe(1);
		expect(readFileSync(target, 'utf8')).toBe('');
	});

	test('malformed JSON is still purged by the sweep (unchanged class)', () => {
		const d = freshDir();
		const target = trainingVaultRecordsPath(d);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, 'not json\n', 'utf8');
		const sweep = sweepTrainingVaultExpiry(d, { now: NOW });
		expect(sweep.purged).toBe(1);
		expect(readFileSync(target, 'utf8')).toBe('');
	});

	test('durable journal dedup: the same retained line is journaled once ever (fresh processes)', async () => {
		const d = freshDir();
		const cst = consent(d);
		const current = record(d, cst, 'journal probe');
		const v99 = `${JSON.stringify({
			...current,
			redaction: { ...current.redaction, version: 99 },
		})}\n`;
		mkdirSync(path.dirname(trainingVaultRecordsPath(d)), { recursive: true });
		writeFileSync(trainingVaultRecordsPath(d), v99, 'utf8');
		// Simulate two fresh processes by spawning readers in children.
		const script = `
			const { readTrainingVault } = await import(${JSON.stringify(
				path
					.resolve(__dirname, '../../../src/training/vault')
					.replace(/\\/g, '/'),
			)});
			readTrainingVault(${JSON.stringify(d)});
		`;
		for (let i = 0; i < 2; i += 1) {
			await Bun.spawn({
				cmd: [process.execPath, '-e', script],
				stdout: 'ignore',
				stderr: 'inherit',
			}).exited;
		}
		const journal = readFileSync(trainingQuarantinePath(d), 'utf8');
		const entries = journal.split('\n').filter((line) => line.length > 0);
		expect(entries).toHaveLength(1); // once EVER, not once per process
		expect(JSON.parse(entries[0] as string).hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test('preflight-exact byte cap: an append that would cross maxBytes refuses with no overshoot', () => {
		const d = freshDir();
		// Fit one record exactly, refuse the second.
		const cst = consent(d);
		const first = record(d, cst, 'first record content');
		const lineBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`, 'utf8');
		const exactCst = grantTrainingConsent(d, {
			now: NOW,
			quotas: { maxBytes: lineBytes, maxRecords: 10, retentionDays: 30 },
		});
		const exact = appendTrainingVaultRecord(
			d,
			record(d, exactCst, 'first record content'),
		);
		expect(exact.appended).toBe(true); // exact fit allowed
		const second = appendTrainingVaultRecord(
			d,
			record(d, exactCst, 'must be refused'),
		);
		expect(second.appended).toBe(false);
		expect(second.stopReason).toBe('quota_bytes');
		const lines = readFileSync(trainingVaultRecordsPath(d), 'utf8')
			.split('\n')
			.filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
	});

	test('multibyte UTF-8 content counts by encoded bytes', () => {
		const d = freshDir();
		const cst = consent(d);
		const wide = record(d, cst, '日本語'.repeat(10));
		const lineBytes = Buffer.byteLength(`${JSON.stringify(wide)}\n`, 'utf8');
		const tight = grantTrainingConsent(d, {
			now: NOW,
			quotas: { maxBytes: lineBytes - 1, maxRecords: 10, retentionDays: 30 },
		});
		const refused = appendTrainingVaultRecord(
			d,
			record(d, tight, '日本語'.repeat(10)),
		);
		expect(refused.appended).toBe(false);
		expect(refused.stopReason).toBe('quota_bytes');
		expect(existsSync(trainingVaultRecordsPath(d))).toBe(false);
	});
});
