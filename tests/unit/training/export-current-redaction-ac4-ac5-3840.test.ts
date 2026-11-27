/**
 * #3701 AC4/AC5 (owner decision, 2026-11-22): the export applies the
 * CURRENT redaction to legacy (v1) records before output, the manifest
 * reports the SOURCE redaction versions separately from the verified floor,
 * and an export that cannot safely redact a record publishes NOTHING.
 *
 * The at-rest bytes stay byte-identical: migration is opt-in.
 *
 * Synthetic tokens only.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
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
	buildTrainingExportBundle,
	previewTrainingExport,
} from '../../../src/training/exporter';
import { trainingVaultRecordsPath } from '../../../src/training/paths';
import {
	TRAINING_REDACTION_FAILED_PLACEHOLDER,
	TRAINING_REDACTION_VERSION,
} from '../../../src/training/redact';
import {
	buildTrainingVaultRecord,
	_internals as vaultInternals,
} from '../../../src/training/vault';

const NOW = new Date('2026-01-01T00:00:00Z');
const GH = `ghp_${'w'.repeat(30)}`;

function freshDir(): string {
	return realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sw-3840-ac45-')));
}

function consent(dir: string) {
	return grantTrainingConsent(dir, {
		now: NOW,
		quotas: { maxBytes: 1_000_000, maxRecords: 100, retentionDays: 30 },
	});
}

function digestOf(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Seed the vault with a hand-written record whose CONTENT is still raw —
 * this is what a record captured BEFORE the #3840 widening looks like (the
 * capture path would have redacted it, so the raw token is written here).
 */
function seedLegacyRecord(
	dir: string,
	cst: ReturnType<typeof consent>,
	version: number,
	rawContent: string,
) {
	const current = buildTrainingVaultRecord({
		content: 'seed',
		consent: cst,
		sessionId: 'sess-ac45',
		kind: 'user_message',
		role: 'user',
		source: 'chat',
		pluginVersion: 'test',
		now: NOW,
	});
	const line = `${JSON.stringify({
		...current,
		content: rawContent,
		content_digest: digestOf(rawContent),
		redaction: { ...current.redaction, version, applied: false, redactions: 0 },
	})}\n`;
	const target = trainingVaultRecordsPath(dir);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, line, 'utf8');
	return { record: JSON.parse(line), target, line };
}

describe('#3701 AC4/AC5 export current-redaction contract', () => {
	test('AC5a: a legacy record is current-redacted on output and the at-rest bytes are untouched', () => {
		const dir = freshDir();
		const cst = consent(dir);
		const { record: legacy, target } = seedLegacyRecord(
			dir,
			cst,
			1,
			`leaked ${GH} in prose`,
		);
		const before = readFileSync(target, 'utf-8');
		// The at-rest record still carries the raw token.
		expect(before).toContain(GH);

		const bundle = buildTrainingExportBundle([legacy]);
		const exported = bundle.files['records.jsonl'] ?? '';
		expect(exported).not.toContain(GH);
		expect(exported).toContain('<redacted:github>');
		// The emitted record is the running redactor's output.
		const emitted = JSON.parse(exported);
		expect(emitted.redaction.version).toBe(TRAINING_REDACTION_VERSION);

		// The at-rest file is byte-identical: migration stays opt-in.
		expect(readFileSync(target, 'utf-8')).toBe(before);
	});

	test('the export PRESERVES the capture-time redaction history', () => {
		// A record whose credential was already replaced at CAPTURE has no
		// new match on export — overwriting the counters with the export
		// pass's own result would claim "no redaction applied" for a record
		// whose content IS redacted.
		const dir = freshDir();
		const cst = consent(dir);
		const current = buildTrainingVaultRecord({
			// A KEY/VALUE credential: its capture placeholder is a
			// re-matchable form, so the export pass would count it again
			// without the fix (a bare family token's placeholder is not).
			content: 'the literal password=hunter2 is committed',
			kind: 'user_message',
			role: 'user',
			capturedAt: NOW,
			consent: cst,
			pluginVersion: '0.0.0-test',
			source: 'chat',
			retentionMs: 60_000,
			projectRef: 'p1',
			sessionId: 's1',
			labels: [],
		});
		expect(current.redaction.applied).toBe(true);
		expect(current.redaction.redactions).toBeGreaterThan(0);

		const bundle = buildTrainingExportBundle([current]);
		const emitted = JSON.parse(bundle.files['records.jsonl'] ?? '');
		expect(emitted.redaction.applied).toBe(true);
		expect(emitted.redaction.redactions).toBeGreaterThan(0);
		expect(emitted.redaction.version).toBe(TRAINING_REDACTION_VERSION);
		// The export pass re-matches the capture-time placeholder, so it
		// must not be COUNTED again: the exported count is the capture count.
		expect(emitted.redaction.redactions).toBe(current.redaction.redactions);
	});

	test('the export counts ONLY the credential it newly redacted (a re-matched placeholder is not a redaction)', () => {
		// A legacy record whose stored content carries BOTH a re-matchable
		// placeholder and a raw credential. The export redacts the raw
		// credential (ONE redaction); the placeholder it re-matches is not a
		// new redaction, so the exported counter is the capture count plus
		// ONE.
		const dir = freshDir();
		const cst = consent(dir);
		const { record: legacy } = seedLegacyRecord(
			dir,
			cst,
			1,
			`password=<redacted> and a raw ${GH} token`,
		);
		const bundle = buildTrainingExportBundle([legacy]);
		const emitted = JSON.parse(bundle.files['records.jsonl'] ?? '');
		expect(emitted.redaction.applied).toBe(true);
		// Exactly ONE new redaction: the raw token.
		expect(emitted.redaction.redactions).toBe(legacy.redaction.redactions + 1);
		expect(emitted.content).not.toContain(GH);
	});

	test('the export counts only the credential it newly redacted (a QUOTED placeholder is not a redaction)', () => {
		// A legacy record whose stored content carries a QUOTED placeholder and
		// a raw credential. The quoted form is re-matchable by the training
		// redactor's JSON arm, so without the guard the export counted the
		// placeholder as a new redaction.
		const dir = freshDir();
		const cst = consent(dir);
		const { record: legacy } = seedLegacyRecord(
			dir,
			cst,
			1,
			`"password": "<redacted>" and a raw ${GH} token`,
		);
		const bundle = buildTrainingExportBundle([legacy]);
		const emitted = JSON.parse(bundle.files['records.jsonl'] ?? '');
		expect(emitted.redaction.applied).toBe(true);
		expect(emitted.redaction.redactions).toBe(legacy.redaction.redactions + 1);
		expect(emitted.content).not.toContain(GH);
	});

	test('AC4a: the manifest reports the SOURCE versions separately from the verified floor', () => {
		const dir = freshDir();
		const cst = consent(dir);
		const { record: legacy } = seedLegacyRecord(dir, cst, 1, 'legacy content');
		const current = buildTrainingVaultRecord({
			content: 'current content',
			consent: cst,
			sessionId: 'sess-ac45',
			kind: 'user_message',
			role: 'user',
			source: 'chat',
			pluginVersion: 'test',
			now: NOW,
		});

		const bundle = buildTrainingExportBundle([legacy, current]);
		const manifest = JSON.parse(bundle.files['manifest.json'] ?? '{}');
		// The source versions of the records INCLUDED ... (the legacy leg is
		// seeded at v1; the current record carries the RUNNING version — 3
		// since the #3893 AC4 floor composition, was 2 under #3840).
		expect(manifest.redaction_versions_represented).toEqual([
			1,
			TRAINING_REDACTION_VERSION,
		]);
		// ... and, separately, the floor every emitted record was verified at.
		expect(manifest.redaction_version).toBe(TRAINING_REDACTION_VERSION);
	});

	test('FB-012: an inconsistent stored digest is REPAIRED on output', () => {
		const dir = freshDir();
		const cst = consent(dir);
		const { record: legacy } = seedLegacyRecord(dir, cst, 1, 'legacy content');
		// The vault's schema validates the digest only as HEX, so a record
		// whose stored digest does not match its content still reaches the
		// export. The emitted record must carry a digest that binds its own
		// content and a record id that binds that digest.
		const corrupted = {
			...legacy,
			content_digest: digestOf('a different content'),
		};
		const bundle = buildTrainingExportBundle([corrupted as never]);
		const emitted = JSON.parse(bundle.files['records.jsonl'] ?? '{}');
		expect(emitted.content_digest).toBe(digestOf(emitted.content));
		expect(emitted.record_id).not.toBe(legacy.record_id);
		// The repaired id is the deterministic binding of the repaired digest.
		expect(emitted.record_id).toBe(
			digestOf(
				`training-record-v1\0${emitted.lineage.project_ref}\0${emitted.lineage.session_id}\0${emitted.kind}\0${emitted.role}\0${emitted.content_digest}`,
			),
		);
	});

	test('AC4c: a record that cannot be safely redacted fails the export and publishes nothing', () => {
		const dir = freshDir();
		const cst = consent(dir);
		const { record: legacy } = seedLegacyRecord(dir, cst, 1, 'legacy content');

		const real = vaultInternals.redactTrainingContent;
		vaultInternals.redactTrainingContent = () => ({
			content: TRAINING_REDACTION_FAILED_PLACEHOLDER,
			applied: true,
			redactions: 1,
		});
		try {
			expect(() => buildTrainingExportBundle([legacy])).toThrow(
				/could not be safely redacted/,
			);
			expect(() => previewTrainingExport(dir)).toThrow(
				/could not be safely redacted/,
			);
		} finally {
			vaultInternals.redactTrainingContent = real;
		}
		// Nothing was published.
		const exportsDir = path.join(dir, '.swarm', 'training', 'v1', 'exports');
		expect(existsSync(exportsDir) ? fs.readdirSync(exportsDir).length : 0).toBe(
			0,
		);
	});
});
