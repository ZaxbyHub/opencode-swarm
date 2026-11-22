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
		// The source versions of the records INCLUDED ...
		expect(manifest.redaction_versions_represented).toEqual([1, 2]);
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
