/**
 * FB-213 (#3836) — dual-field rollback classification coverage.
 *
 * The mixed-poison rule is symmetric in BOTH directions, and control-char
 * defects in BOTH path fields stay a single skip:
 *  - control chars in BOTH original_rel_path AND stored_rel_path => ONE
 *    unsafe-name skip, batch retained (`drained: false`), no filesystem move,
 *    stored bytes unchanged;
 *  - traversal in original_rel_path + control char in stored_rel_path =>
 *    tamper HARD REJECT of the whole call (the mirror image of the
 *    control-original + traversal-stored case pinned in
 *    swarm-residue-rollback-skip.test.ts).
 *
 * Fixtures are synthetic manifests; stored copies whose names carry control
 * characters are not creatable on every host (Win32 forbids C0/DEL in file
 * names), so creation is best-effort and the byte-unchanged assertion runs
 * only where the copy exists (elsewhere the strongest available no-move
 * assertion is absence).
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
import { rollbackResidueQuarantine } from '../../../src/services/swarm-residue';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const CONTROL_BYTE = /[\u0000-\u001f\u007f-\u009f]/;
const BEL = String.fromCharCode(0x07);

let projectDir: string;
let swarmDir: string;

beforeEach(() => {
	projectDir = canonicalMkdtemp('residue-rollback-dual-');
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

/**
 * Same synthetic-manifest fixture style as swarm-residue-rollback-skip.test.ts,
 * except stored-copy creation is best-effort: a stored_rel_path carrying a
 * control character cannot be created on every host, and the classification
 * under test reads the MANIFEST, so a non-creatable stored copy is fine. The
 * set of stored paths that were actually creatable is returned so the
 * byte-unchanged assertion can run only where it is meaningful.
 */
function writeBatch(
	batchId: string,
	entries: readonly FixtureEntry[],
): { batchAbs: string; creatableStoredAbs: string[] } {
	const batchAbs = path.join(swarmDir, 'quarantine', batchId);
	const creatableStoredAbs: string[] = [];
	for (const entry of entries) {
		const storedAbs = path.join(swarmDir, ...entry.stored_rel_path.split('/'));
		try {
			mkdirSync(path.dirname(storedAbs), { recursive: true });
			writeFileSync(storedAbs, entry.storedContent, 'utf-8');
			creatableStoredAbs.push(storedAbs);
		} catch {
			// Best-effort only — see the helper doc comment.
		}
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
	mkdirSync(batchAbs, { recursive: true });
	writeFileSync(
		path.join(batchAbs, 'manifest.json'),
		`${JSON.stringify(manifest, null, 2)}\n`,
		'utf-8',
	);
	return { batchAbs, creatableStoredAbs };
}

describe('rollbackResidueQuarantine dual-field control-char classification (FB-213)', () => {
	test('control chars in BOTH path fields: one unsafe-name skip, batch retained, no move, stored bytes unchanged', async () => {
		const validRel = 'valid/notes.md.tmp.1710000000.abcdef';
		const validContent = 'valid-payload';
		const poisonedOriginalRel = 'poison\norig.md.tmp.1710000000.abcdef';
		const poisonedStoredRel = `quarantine/batch-dual/stored${BEL}copy.bin`;
		const poisonedContent = 'dual-poisoned-payload';
		const { batchAbs, creatableStoredAbs } = writeBatch('batch-dual', [
			{
				original_rel_path: validRel,
				stored_rel_path: `quarantine/batch-dual/${validRel}`,
				storedContent: validContent,
			},
			{
				original_rel_path: poisonedOriginalRel,
				stored_rel_path: poisonedStoredRel,
				storedContent: poisonedContent,
			},
		]);
		const poisonedStoredAbs = path.join(
			swarmDir,
			...poisonedStoredRel.split('/'),
		);

		const rb = await rollbackResidueQuarantine(projectDir, 'batch-dual');

		// The valid sibling restored normally — the loop DID run, so the
		// poisoned entry's absence below is the skip, not an early abort.
		expect(
			readFileSync(path.join(swarmDir, ...validRel.split('/')), 'utf-8'),
		).toBe(validContent);
		expect(rb.items.find((i) => i.relPath === validRel)?.status).toBe(
			'restored',
		);

		// Exactly ONE skip for the dual-poisoned entry, reason unsafe-name,
		// with a safe (control-byte-free) rendering of its name.
		const skips = rb.items.filter((i) => i.status === 'skipped');
		expect(skips).toHaveLength(1);
		expect([...(skips[0]?.reasons ?? [])]).toContain('unsafe-name');
		expect(CONTROL_BYTE.test(skips[0]?.relPath ?? '')).toBe(false);

		// No filesystem move: nothing appears under the poisoned original
		// name or under its control-stripped rendering.
		expect(
			existsSync(path.join(swarmDir, ...poisonedOriginalRel.split('/'))),
		).toBe(false);
		expect(
			existsSync(
				path.join(
					swarmDir,
					...poisonedOriginalRel.replace(/\p{Cc}/gu, '').split('/'),
				),
			),
		).toBe(false);

		// Batch retained with the poisoned entry unresolved.
		expect(rb.drained).toBe(false);
		expect(existsSync(batchAbs)).toBe(true);

		// Stored bytes unchanged where the stored copy is creatable; on hosts
		// that forbid control-char names it must simply remain absent.
		if (creatableStoredAbs.includes(poisonedStoredAbs)) {
			expect(readFileSync(poisonedStoredAbs, 'utf-8')).toBe(poisonedContent);
		} else {
			expect(existsSync(poisonedStoredAbs)).toBe(false);
		}
	});

	test('traversal in original_rel_path + control char in stored_rel_path is a tamper HARD REJECT', async () => {
		const validRel = 'valid/notes.md.tmp.1710000000.abcdef';
		const { batchAbs } = writeBatch('batch-rev-mixed', [
			{
				// Tamper entry FIRST so a wrong "skip" would still leave the
				// valid sibling unrestored — the discriminator for hard-reject.
				original_rel_path: '../../escape.md',
				stored_rel_path: `quarantine/batch-rev-mixed/stored${BEL}copy.bin`,
				storedContent: 'x',
			},
			{
				original_rel_path: validRel,
				stored_rel_path: `quarantine/batch-rev-mixed/${validRel}`,
				storedContent: 'valid-payload',
			},
		]);

		await expect(
			rollbackResidueQuarantine(projectDir, 'batch-rev-mixed'),
		).rejects.toThrow(/unsafe original_rel_path/);

		// Whole-call abort: the valid sibling was NOT restored and the batch
		// is intact.
		expect(existsSync(path.join(swarmDir, ...validRel.split('/')))).toBe(false);
		expect(existsSync(batchAbs)).toBe(true);
	});
});
