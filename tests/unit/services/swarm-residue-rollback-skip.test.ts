/**
 * Issue #3836 D1/D2 — rollback per-entry skip-and-report containment.
 *
 * Contract: a manifest entry whose path fields carry ONLY control characters
 * (C0/DEL/C1 after the D2 grammar alignment) is skipped and reported ONCE
 * (`status: 'skipped'`, reason `unsafe-name`) while the valid siblings still
 * restore; the batch is retained (`drained: false`) and the poisoned stored
 * copy is left byte-unchanged. Retry is idempotent. The TAMPER class
 * (traversal / empty segment / absolute path) — including the mixed-poison
 * combination of a control-bearing original_rel_path with a traversal-bearing
 * stored_rel_path — is still a HARD REJECT of the whole call.
 *
 * Fixtures are synthetic manifests (control-char names are not creatable on
 * all hosts); stored copies are real files under the batch dir.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { withFrozenClock } from '../../helpers/test-clock.js';
import {
	neutralizeResidueName,
	rollbackResidueQuarantine,
} from '../../../src/services/swarm-residue';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const CONTROL_BYTE = /[\u0000-\u001f\u007f-\u009f]/;
const NEL = String.fromCharCode(0x85);
const DEL = String.fromCharCode(0x7f);

let projectDir: string;
let swarmDir: string;

beforeEach(() => {
	projectDir = canonicalMkdtemp('residue-rollback-skip-');
	swarmDir = path.join(projectDir, '.swarm');
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function sha256(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

interface FixtureEntry {
	original_rel_path: string;
	stored_rel_path: string;
	storedContent: string;
}

function writeBatch(batchId: string, entries: readonly FixtureEntry[]): string {
	const batchAbs = path.join(swarmDir, 'quarantine', batchId);
	for (const entry of entries) {
		const storedAbs = path.join(swarmDir, ...entry.stored_rel_path.split('/'));
		mkdirSync(path.dirname(storedAbs), { recursive: true });
		writeFileSync(storedAbs, entry.storedContent, 'utf-8');
	}
	const manifest = {
		schema_version: 1,
		batch_id: batchId,
		created_at: withFrozenClock(() => new Date().toISOString(), {
			fixedNow: Date.now(),
		}),
		trigger: 'test',
		entries: entries.map((e) => ({
			original_rel_path: e.original_rel_path,
			stored_rel_path: e.stored_rel_path,
			sha256: sha256(e.storedContent),
			bytes: e.storedContent.length,
			mtime_ms: 0,
			grammar_id: 'target-suffix-tmp-num-alnum',
			reason: 'stale-atomic-write-temp',
		})),
	};
	// A tampered stored_rel_path can point outside the batch dir, so the
	// stored-copy writes above may never have created it.
	mkdirSync(batchAbs, { recursive: true });
	writeFileSync(
		path.join(batchAbs, 'manifest.json'),
		`${JSON.stringify(manifest, null, 2)}\n`,
		'utf-8',
	);
	return batchAbs;
}

describe('rollbackResidueQuarantine per-entry skip-and-report (#3836 D1)', () => {
	test('C0-poisoned entry skipped once, valid sibling restored, batch retained, retry idempotent, poisoned copy byte-unchanged', async () => {
		const validRel = 'valid/notes.md.tmp.1710000000.abcdef';
		const validContent = 'valid-payload';
		const poisonedRel = 'poison\ninjected.md.tmp.1710000000.abcdef';
		const poisonedContent = 'poisoned-payload';
		const batchAbs = writeBatch('batch-c0', [
			{
				original_rel_path: validRel,
				stored_rel_path: `quarantine/batch-c0/${validRel}`,
				storedContent: validContent,
			},
			{
				original_rel_path: poisonedRel,
				stored_rel_path: 'quarantine/batch-c0/poison-copy.bin',
				storedContent: poisonedContent,
			},
		]);
		const poisonedStoredAbs = path.join(batchAbs, 'poison-copy.bin');

		const rb1 = await rollbackResidueQuarantine(projectDir, 'batch-c0');

		// Valid sibling restored with its payload.
		expect(
			readFileSync(path.join(swarmDir, ...validRel.split('/')), 'utf-8'),
		).toBe(validContent);
		const restored = rb1.items.filter((i) => i.relPath === validRel);
		expect(restored).toHaveLength(1);
		expect(restored[0]?.status).toBe('restored');

		// Poisoned entry reported EXACTLY ONCE, as a skip with its reason, and
		// the reported name is a safe (control-byte-free) rendering.
		const skipped = rb1.items.filter((i) => i.relPath.includes('poison'));
		expect(skipped).toHaveLength(1);
		expect(skipped[0]?.status).toBe('skipped');
		expect([...(skipped[0]?.reasons ?? [])]).toContain('unsafe-name');
		expect(CONTROL_BYTE.test(skipped[0]?.relPath ?? '')).toBe(false);
		// Never restored under the poisoned name.
		expect(existsSync(path.join(swarmDir, ...poisonedRel.split('/')))).toBe(
			false,
		);

		// Batch disposition: not drained, retained, poisoned copy untouched.
		expect(rb1.drained).toBe(false);
		expect(existsSync(batchAbs)).toBe(true);
		expect(readFileSync(poisonedStoredAbs, 'utf-8')).toBe(poisonedContent);
		// The resolved entry's stored copy WAS consumed.
		expect(existsSync(path.join(batchAbs, ...validRel.split('/')))).toBe(false);

		// Retry: the resolved entry's stored copy was consumed by the first
		// rollback, so the documented flip lands on 'missing-copy' here
		// (nothing left to restore); the poisoned entry skips again (exactly
		// once) and the batch stays retained.
		const rb2 = await rollbackResidueQuarantine(projectDir, 'batch-c0');
		expect(rb2.items.find((i) => i.relPath === validRel)?.status).toBe(
			'missing-copy',
		);
		expect(rb2.items.filter((i) => i.relPath.includes('poison'))).toHaveLength(
			1,
		);
		expect(rb2.drained).toBe(false);
		expect(existsSync(batchAbs)).toBe(true);
		expect(readFileSync(poisonedStoredAbs, 'utf-8')).toBe(poisonedContent);
	});

	test('C1/DEL-only relPath is skipped and never reported raw', async () => {
		const poisonedRel = `evil${NEL}name${DEL}.tmp.1710000000.abcdef`;
		const content = 'c1-del-payload';
		writeBatch('batch-c1del', [
			{
				original_rel_path: poisonedRel,
				stored_rel_path: 'quarantine/batch-c1del/stored-copy.bin',
				storedContent: content,
			},
		]);

		const rb = await rollbackResidueQuarantine(projectDir, 'batch-c1del');

		const skips = rb.items.filter((i) => i.status === 'skipped');
		expect(skips).toHaveLength(1);
		expect(skips[0]?.relPath.includes('evil')).toBe(true);
		// No raw C1/DEL byte survives anywhere in the reported items.
		const serialized = JSON.stringify(rb.items);
		expect(serialized.includes(NEL)).toBe(false);
		expect(serialized.includes(DEL)).toBe(false);
		// The stored copy is never moved to an unsafe original location.
		expect(existsSync(path.join(swarmDir, ...poisonedRel.split('/')))).toBe(
			false,
		);
		expect(rb.drained).toBe(false);
	});

	test('mixed poison (control-char original_rel_path + traversal stored_rel_path) is a HARD REJECT', async () => {
		const validRel = 'valid/notes.md.tmp.1710000000.abcdef';
		const batchAbs = writeBatch('batch-mixed', [
			{
				// Poisoned entry FIRST so a wrong "skip" would still leave the
				// valid sibling unrestored — the discriminator for hard-reject.
				original_rel_path: 'poison\ninjected.tmp.txt',
				stored_rel_path: '../../escape.bin',
				storedContent: 'x',
			},
			{
				original_rel_path: validRel,
				stored_rel_path: `quarantine/batch-mixed/${validRel}`,
				storedContent: 'valid-payload',
			},
		]);

		await expect(
			rollbackResidueQuarantine(projectDir, 'batch-mixed'),
		).rejects.toThrow(/unsafe original_rel_path/);

		// Whole-call abort: the valid sibling was NOT restored and the batch
		// is intact.
		expect(existsSync(path.join(swarmDir, ...validRel.split('/')))).toBe(false);
		expect(existsSync(batchAbs)).toBe(true);
	});

	test('traversal in stored_rel_path alone is still a hard reject', async () => {
		const rel = 'valid/notes.md.tmp.1710000000.abcdef';
		writeBatch('batch-traversal-stored', [
			{
				original_rel_path: rel,
				stored_rel_path: '../../escape.bin',
				storedContent: 'x',
			},
		]);

		await expect(
			rollbackResidueQuarantine(projectDir, 'batch-traversal-stored'),
		).rejects.toThrow(/unsafe stored_rel_path/);
	});
});

describe('neutralizeResidueName (#3836 D3 export)', () => {
	test('strips C0/DEL/C1 and rewrites backticks, preserving the rest verbatim', () => {
		expect(neutralizeResidueName('a\u0000b\x1b[2Kc\u007fd\u0085`e')).toBe(
			"ab[2Kcd'e",
		);
		expect(neutralizeResidueName('context.md.tmp.1710000000.123456789')).toBe(
			'context.md.tmp.1710000000.123456789',
		);
	});
});
