import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleDoctorCommand } from '../../../src/commands/doctor.js';
import {
	quarantineSwarmResidue,
	_internals as residueInternals,
	rollbackResidueQuarantine,
} from '../../../src/services/swarm-residue.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const FIXED_NOW = 1_800_000_000_000;
const TOKEN = 'c'.repeat(32);
const realQueryTracked = residueInternals.queryTracked;
const realNow = residueInternals.now;
let project = '';

function setup(): string {
	project = canonicalMkdtemp('residue-ownership-3951-');
	fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
	residueInternals.now = () => FIXED_NOW;
	residueInternals.queryTracked = () => ({ tracked: new Set<string>() });
	return project;
}

function seed(): string {
	const swarmRoot = path.join(project, '.swarm');
	const rel = `plan.json.${TOKEN}.tmp`;
	fs.writeFileSync(path.join(swarmRoot, 'plan.json'), 'target', 'utf-8');
	const original = path.join(swarmRoot, rel);
	fs.writeFileSync(original, 'payload', 'utf-8');
	const old = new Date(FIXED_NOW - 2 * 60 * 60_000);
	fs.utimesSync(original, old, old);
	return original;
}

async function quarantine(): Promise<{ batchId: string; batchAbs: string }> {
	const result = await quarantineSwarmResidue(project, { trigger: 'test' });
	const batchId = (result.batchRelDir as string).split('/')[1]!;
	return {
		batchId,
		batchAbs: path.join(project, '.swarm', 'quarantine', batchId),
	};
}

function writeManifestBatch(
	batchId: string,
	rel: string,
	content: string,
): string {
	const swarmRoot = path.join(project, '.swarm');
	const batchAbs = path.join(swarmRoot, 'quarantine', batchId);
	const storedRel = `quarantine/${batchId}/${rel}`;
	const storedAbs = path.join(swarmRoot, ...storedRel.split('/'));
	fs.mkdirSync(path.dirname(storedAbs), { recursive: true });
	fs.writeFileSync(storedAbs, content, 'utf-8');
	fs.writeFileSync(
		path.join(batchAbs, 'manifest.recovery.json'),
		JSON.stringify({
			schema_version: 1,
			batch_id: batchId,
			created_at: new Date(FIXED_NOW).toISOString(),
			trigger: 'test',
			entries: [
				{
					original_rel_path: rel,
					stored_rel_path: storedRel,
					sha256: createHash('sha256').update(content).digest('hex'),
					bytes: Buffer.byteLength(content),
					mtime_ms: FIXED_NOW,
					grammar_id: 'canonical-v1',
					reason: 'test',
				},
			],
		}),
		'utf-8',
	);
	return batchAbs;
}

afterEach(() => {
	residueInternals.queryTracked = realQueryTracked;
	residueInternals.now = realNow;
	if (project) fs.rmSync(project, { recursive: true, force: true });
	project = '';
});

test('a residue TWO levels deep that rolls back completely does not retain the batch', async () => {
	await withFrozenClockAsync(
		async () => {
			setup();
			// The realistic layout: per-task evidence is written at
			// .swarm/evidence/<taskId>/evidence.json, so the stored copy lands under
			// <batch>/evidence/<taskId>/ and the rollback leaves BOTH folders behind.
			const swarmRoot = path.join(project, '.swarm');
			const rel = `evidence/1.1/x.json.tmp.${TOKEN}`;
			fs.mkdirSync(path.join(swarmRoot, 'evidence', '1.1'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(swarmRoot, 'evidence', '1.1', 'x.json'),
				'target',
				'utf-8',
			);
			const original = path.join(swarmRoot, rel);
			fs.writeFileSync(original, 'payload', 'utf-8');
			const old = new Date(FIXED_NOW - 3 * 60 * 60_000);
			fs.utimesSync(original, old, old);

			const { batchId, batchAbs } = await quarantine();

			const rb = await rollbackResidueQuarantine(project, batchId);
			expect(fs.existsSync(original)).toBe(true);
			expect(rb.drained).toBe(true);
			expect(rb.batchDirRetentionReason ?? null).not.toBe('foreign-content');
			expect(rb.batchDirRetained).toBe(false);
			expect(fs.existsSync(batchAbs)).toBe(false);
		},
		{ fixedNow: FIXED_NOW },
	);
}, 30_000);

test('a file DEEP inside a nested folder still keeps the batch', async () => {
	await withFrozenClockAsync(
		async () => {
			setup();
			const swarmRoot = path.join(project, '.swarm');
			const rel = `evidence/1.1/x.json.tmp.${TOKEN}`;
			fs.mkdirSync(path.join(swarmRoot, 'evidence', '1.1'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(swarmRoot, 'evidence', '1.1', 'x.json'),
				'target',
				'utf-8',
			);
			const original = path.join(swarmRoot, rel);
			fs.writeFileSync(original, 'payload', 'utf-8');
			const old = new Date(FIXED_NOW - 3 * 60 * 60_000);
			fs.utimesSync(original, old, old);

			const { batchId, batchAbs } = await quarantine();

			// A foreign file deep inside the nested folder: the subtree is NOT
			// directory-only, so the batch must be retained.
			const nestedDir = path.join(batchAbs, 'evidence', '1.1');
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.writeFileSync(
				path.join(nestedDir, 'foreign.bin'),
				'not ours',
				'utf-8',
			);

			const rb = await rollbackResidueQuarantine(project, batchId);
			expect(rb.batchDirRetained).toBe(true);
			expect(rb.batchDirRetentionReason).toBe('foreign-content');
			expect(fs.existsSync(path.join(nestedDir, 'foreign.bin'))).toBe(true);
		},
		{ fixedNow: FIXED_NOW },
	);
}, 30_000);

test('a nested residue that rolls back completely does not leave the batch retained as unowned content', async () => {
	await withFrozenClockAsync(
		async () => {
			setup();
			// A NESTED residue: the stored copy lands under
			// <batch>/evidence/, so the rollback leaves an empty folder behind.
			const swarmRoot = path.join(project, '.swarm');
			const rel = `evidence/x.json.tmp.${TOKEN}`;
			fs.mkdirSync(path.join(swarmRoot, 'evidence'), { recursive: true });
			fs.writeFileSync(
				path.join(swarmRoot, 'evidence', 'x.json'),
				'target',
				'utf-8',
			);
			const original = path.join(swarmRoot, rel);
			fs.writeFileSync(original, 'payload', 'utf-8');
			const old = new Date(FIXED_NOW - 3 * 60 * 60_000);
			fs.utimesSync(original, old, old);

			const { batchId, batchAbs } = await quarantine();

			const rb = await rollbackResidueQuarantine(project, batchId);
			// The payload is back at its original path.
			expect(fs.existsSync(original)).toBe(true);
			expect(rb.drained).toBe(true);
			// The leftover folder is EMPTY and was created by the quarantine, so
			// the batch must not be retained as "unowned content".
			expect(rb.batchDirRetentionReason ?? null).not.toBe('foreign-content');
			expect(rb.batchDirRetained).toBe(false);
			expect(fs.existsSync(batchAbs)).toBe(false);
		},
		{ fixedNow: FIXED_NOW },
	);
}, 30_000);

describe('residue metadata ownership — regression (NEW-1)', () => {
	test('doctor describes sibling recovery as the cause after that file is removed', async () => {
		await withFrozenClockAsync(async () => {
			setup();
			seed();
			const { batchId, batchAbs } = await quarantine();
			const sibling = path.join(
				project,
				'.swarm',
				'quarantine',
				`${batchId}.recovery.json`,
			);
			fs.writeFileSync(
				sibling,
				fs.readFileSync(path.join(batchAbs, 'manifest.json'), 'utf-8'),
			);

			const output = await handleDoctorCommand(project, [
				`--rollback-residue-quarantine=${batchId}`,
			]);

			expect(fs.existsSync(sibling)).toBe(false);
			expect(output).not.toContain(
				'parent-sibling recovery manifest is present',
			);
			expect(output).toContain(
				'metadata cleanup was skipped because a parent-sibling recovery manifest was present',
			);
		});
	});
});

describe('residue metadata ownership — regression (NEW-3)', () => {
	test('nested marker under root manifest directory is foreign and survives drain', async () => {
		await withFrozenClockAsync(async () => {
			setup();
			const rel = `plan.json.${TOKEN}.tmp`;
			const batchAbs = writeManifestBatch('foreign-owned', rel, 'payload');
			const foreignNestedDir = path.join(batchAbs, 'manifest.json');
			const foreignFile = path.join(foreignNestedDir, 'rollback.drained');
			fs.mkdirSync(foreignNestedDir);
			fs.writeFileSync(foreignFile, 'foreign marker', 'utf-8');

			const result = await rollbackResidueQuarantine(project, 'foreign-owned');

			expect(result.drained).toBe(true);
			expect(result.batchDirRetained).toBe(true);
			expect(result.batchDirRetentionReason).toBe('foreign-content');
			expect(fs.existsSync(foreignFile)).toBe(true);
			expect(fs.readFileSync(foreignFile, 'utf-8')).toBe('foreign marker');
		});
	});
});

describe('explicit drained rollback — regression (NEW-4)', () => {
	test('operator edits after drain survive explicit rollback without collision reclassification', async () => {
		await withFrozenClockAsync(async () => {
			setup();
			const original = seed();
			const { batchId, batchAbs } = await quarantine();
			fs.writeFileSync(path.join(batchAbs, 'operator.txt'), 'retain batch');

			const first = await rollbackResidueQuarantine(project, batchId);
			expect(first.drained).toBe(true);
			expect(first.batchDirRetained).toBe(true);
			fs.writeFileSync(original, 'operator-edited', 'utf-8');

			const second = await rollbackResidueQuarantine(project, batchId);

			expect(second.drained).toBe(true);
			expect(second.items.some((item) => item.status === 'collision')).toBe(
				false,
			);
			expect(second.items.some((item) => item.status === 'missing-copy')).toBe(
				false,
			);
			expect(second.items[0]?.status).toBe('already-restored');
			expect(fs.readFileSync(original, 'utf-8')).toBe('operator-edited');
		});
	});
});
