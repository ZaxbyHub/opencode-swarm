/**
 * Issue #2035 — /swarm config doctor residue wiring: read-only by default,
 * explicit recoverable quarantine via --quarantine-residue, and rollback via
 * --rollback-residue-quarantine. All three surfaces render from the shared
 * inventory implementation.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleDoctorCommand } from '../../../src/commands/doctor';
import { _internals as residueInternals } from '../../../src/services/swarm-residue';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let projectDir: string;
let swarmDir: string;
const realQueryTracked = residueInternals.queryTracked;
const realUnlinkResidueCopy = residueInternals.unlinkResidueCopy;
const realRemoveDrainedBatch = residueInternals.removeDrainedBatch;
const realReadBatchDirectory = residueInternals.readBatchDirectory;

function makeResidue(rel: string, hoursOld = 2, content = 'stale'): string {
	const abs = path.join(swarmDir, ...rel.split('/'));
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, content, 'utf-8');
	const t = withFrozenClock(
		() => new Date(Date.now() - hoursOld * 60 * 60 * 1000),
		// anchor the frozen instant to the real clock: relative fixtures must
		// // stay on the same side of the staleness window as before freezing
		{ fixedNow: Date.now() },
	);
	utimesSync(abs, t, t);
	return abs;
}

beforeEach(() => {
	projectDir = canonicalMkdtemp('doctor-residue-');
	swarmDir = path.join(projectDir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	residueInternals.queryTracked = () => ({ tracked: new Set<string>() });
});

afterEach(() => {
	residueInternals.queryTracked = realQueryTracked;
	residueInternals.unlinkResidueCopy = realUnlinkResidueCopy;
	residueInternals.removeDrainedBatch = realRemoveDrainedBatch;
	residueInternals.readBatchDirectory = realReadBatchDirectory;
	rmSync(projectDir, { recursive: true, force: true });
});

describe('handleDoctorCommand — atomic-write residue (issue #2035)', () => {
	test('rollback renders at most ten unresolved details and neutralizes paths (#3951 FB-001/FB-002)', async () => {
		const batchId = 'unresolved-batch';
		const batchAbs = path.join(swarmDir, 'quarantine', batchId);
		const originals = Array.from({ length: 11 }, (_, index) =>
			index === 0
				? 'bad`name.tmp.1710000000.123456789'
				: `unresolved-${index}.tmp.1710000000.123456789`,
		);
		const hash = createHash('sha256').update('payload').digest('hex');
		const entries = originals.map((originalRel) => {
			const storedRel = `quarantine/${batchId}/${originalRel}`;
			const storedAbs = path.join(swarmDir, ...storedRel.split('/'));
			mkdirSync(path.dirname(storedAbs), { recursive: true });
			writeFileSync(
				path.join(swarmDir, ...originalRel.split('/')),
				'payload',
				'utf-8',
			);
			writeFileSync(storedAbs, 'payload', 'utf-8');
			return {
				original_rel_path: originalRel,
				stored_rel_path: storedRel,
				sha256: hash,
				bytes: 7,
				mtime_ms: Date.now(),
				grammar_id: 'test',
				reason: 'test',
			};
		});
		writeFileSync(
			path.join(batchAbs, 'manifest.json'),
			JSON.stringify({
				schema_version: 1,
				batch_id: batchId,
				created_at: new Date().toISOString(),
				trigger: 'test',
				entries,
			}),
			'utf-8',
		);
		residueInternals.unlinkResidueCopy = () => {
			throw Object.assign(new Error('denied'), { code: 'EPERM' });
		};
		const out = await handleDoctorCommand(projectDir, [
			'--rollback-residue-quarantine=unresolved-batch',
		]);
		expect(out).toContain(
			"- `bad'name.tmp.1710000000.123456789` — unresolved (stored-copy-retained:EPERM)",
		);
		expect(out).toContain('- … 1 more unresolved');
		expect(out).not.toContain('bad`name.tmp');
	});

	test('rollback doctor labels unsupported batches with their version (#3951 FB-103)', async () => {
		const batchId = 'unsupported-batch';
		const batchAbs = path.join(swarmDir, 'quarantine', batchId);
		mkdirSync(batchAbs, { recursive: true });
		writeFileSync(
			path.join(batchAbs, 'manifest.json'),
			JSON.stringify({ schema_version: 2, entries: [] }),
			'utf-8',
		);
		const out = await handleDoctorCommand(projectDir, [
			'--rollback-residue-quarantine',
		]);
		expect(out).toContain(
			'- unsupported quarantine batch `unsupported-batch`: unsupported manifest version 2',
		);
		expect(out).not.toContain('no readable manifest surface');
	});
});

test('default run is READ-ONLY: reports inventory, moves nothing', async () => {
	makeResidue('context.md.tmp.1710000000.123456789');
	writeFileSync(path.join(swarmDir, 'context.md'), 'target', 'utf-8');

	const out = await handleDoctorCommand(projectDir, []);

	expect(out).toContain('Atomic-write Residue');
	expect(out).toContain('target-suffix-tmp-num-alnum');
	expect(out).toContain('--quarantine-residue');
	// Nothing moved, nothing deleted.
	expect(
		existsSync(path.join(swarmDir, 'context.md.tmp.1710000000.123456789')),
	).toBe(true);
	expect(existsSync(path.join(swarmDir, 'quarantine'))).toBe(false);
});

test('clean project shows no residue section', async () => {
	const out = await handleDoctorCommand(projectDir, []);
	expect(out).not.toContain('Atomic-write Residue');
});

test('--quarantine-residue moves verified stale residue with manifest', async () => {
	writeFileSync(path.join(swarmDir, 'context.md'), 'target', 'utf-8');
	makeResidue('context.md.tmp.1710000000.123456789');

	const out = await handleDoctorCommand(projectDir, ['--quarantine-residue']);

	expect(out).toContain('Residue Quarantine');
	expect(out).toContain('Quarantined 1 stale temp file(s)');
	expect(out).toContain('--rollback-residue-quarantine');
	expect(
		existsSync(path.join(swarmDir, 'context.md.tmp.1710000000.123456789')),
	).toBe(false);
	const quarantineRoot = path.join(swarmDir, 'quarantine');
	const batch = readdirSync(quarantineRoot)[0]!;
	expect(
		existsSync(
			path.join(quarantineRoot, batch, 'context.md.tmp.1710000000.123456789'),
		),
	).toBe(true);
	expect(
		JSON.parse(
			readFileSync(path.join(quarantineRoot, batch, 'manifest.json'), 'utf-8'),
		).schema_version,
	).toBe(1);
});

test('--rollback-residue-quarantine restores the latest batch', async () => {
	writeFileSync(path.join(swarmDir, 'context.md'), 'target', 'utf-8');
	const rel = 'context.md.tmp.1710000000.123456789';
	makeResidue(rel, 3, 'recover-me');
	await handleDoctorCommand(projectDir, ['--quarantine-residue']);
	expect(existsSync(path.join(swarmDir, rel))).toBe(false);

	const out = await handleDoctorCommand(projectDir, [
		'--rollback-residue-quarantine',
	]);

	expect(out).toContain('Residue Quarantine Rollback');
	expect(out).toContain('1 restored');
	expect(readFileSync(path.join(swarmDir, rel), 'utf-8')).toBe('recover-me');
});

test('rollback cleanup failure does not attribute retained metadata to unowned files (#3951 FB-102)', async () => {
	writeFileSync(path.join(swarmDir, 'context.md'), 'target', 'utf-8');
	makeResidue('context.md.tmp.1710000000.123456789', 3, 'recover-me');
	await handleDoctorCommand(projectDir, ['--quarantine-residue']);

	const quarantineRoot = path.join(swarmDir, 'quarantine');
	const batch = readdirSync(quarantineRoot)[0]!;
	const batchAbs = path.join(quarantineRoot, batch);
	residueInternals.removeDrainedBatch = () => {
		throw Object.assign(new Error('cleanup failed'), { code: 'EACCES' });
	};

	const output = await handleDoctorCommand(projectDir, [
		`--rollback-residue-quarantine=${batch}`,
	]);

	expect(existsSync(batchAbs)).toBe(true);
	expect(output).toContain(
		'Batch fully drained; its owned metadata was not removed; directory remains.',
	);
	expect(output).not.toContain('unowned content present');
	expect(output).not.toContain('nothing was deleted');
});

test('an in-flight batch is reported distinctly, not as a drained batch (#3951 NEW-12)', async () => {
	// A drained marker plus a still-present stored copy means a concurrent
	// quarantine wrote the batch. The doctor must say so — the generic
	// "Batch retained (unresolved entries)" line lists no entries and tells
	// the operator nothing they can act on.
	const dir = canonicalMkdtemp('doctor-inflight-');
	try {
		const swarmDir = path.join(dir, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
		const batchDir = path.join(swarmDir, 'quarantine', 'inflightbatch');
		mkdirSync(batchDir, { recursive: true });
		writeFileSync(
			path.join(batchDir, 'manifest.json'),
			JSON.stringify({
				schema_version: 1,
				batch_id: 'inflightbatch',
				created_at: '2026-01-01T00:00:00.000Z',
				trigger: 'test',
				entries: [
					{
						original_rel_path: 'plan.json.abc.tmp',
						stored_rel_path: 'quarantine/inflightbatch/plan.json.abc.tmp',
						sha256: 'a'.repeat(64),
						bytes: 7,
						mtime_ms: 0,
						grammar_id: 'atomic-write-temp',
						reason: 'stale-atomic-write-temp',
					},
				],
			}),
		);
		writeFileSync(
			path.join(batchDir, 'rollback.drained'),
			JSON.stringify({
				at: '2026-01-01T00:00:00.000Z',
				batchId: 'inflightbatch',
			}),
		);
		// A stored copy is still present: the batch is not drained.
		writeFileSync(path.join(batchDir, 'plan.json.abc.tmp'), 'payload');

		const out = await handleDoctorCommand(dir, [
			'--rollback-residue-quarantine=inflightbatch',
		]);
		expect(out).toContain('still holds a stored copy');
		expect(out).not.toContain('Batch fully drained');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('sibling recovery manifest is named without asserting foreign content (#3951 FB-102)', async () => {
	writeFileSync(path.join(swarmDir, 'context.md'), 'target', 'utf-8');
	makeResidue('context.md.tmp.1710000000.123456789', 3, 'recover-me');
	await handleDoctorCommand(projectDir, ['--quarantine-residue']);

	const quarantineRoot = path.join(swarmDir, 'quarantine');
	const batch = readdirSync(quarantineRoot)[0]!;
	const batchAbs = path.join(quarantineRoot, batch);
	const siblingRecovery = path.join(quarantineRoot, `${batch}.recovery.json`);
	writeFileSync(
		siblingRecovery,
		readFileSync(path.join(batchAbs, 'manifest.json'), 'utf-8'),
		'utf-8',
	);

	const output = await handleDoctorCommand(projectDir, [
		`--rollback-residue-quarantine=${batch}`,
	]);

	expect(existsSync(batchAbs)).toBe(true);
	expect(existsSync(siblingRecovery)).toBe(false);
	expect(output).not.toContain('parent-sibling recovery manifest is present');
	expect(output).toContain(
		'metadata cleanup was skipped because a parent-sibling recovery manifest was present',
	);
	expect(output).not.toContain('unowned content present');
});

test('metadata scan failure does not claim that foreign content exists (#3951 FB-102)', async () => {
	writeFileSync(path.join(swarmDir, 'context.md'), 'target', 'utf-8');
	makeResidue('context.md.tmp.1710000000.123456789', 3, 'recover-me');
	await handleDoctorCommand(projectDir, ['--quarantine-residue']);

	const quarantineRoot = path.join(swarmDir, 'quarantine');
	const batch = readdirSync(quarantineRoot)[0]!;
	const batchAbs = path.join(quarantineRoot, batch);
	residueInternals.readBatchDirectory = (target) => {
		if (path.normalize(target) === path.normalize(batchAbs)) {
			throw Object.assign(new Error('directory cannot be enumerated'), {
				code: 'EACCES',
			});
		}
		return realReadBatchDirectory(target);
	};

	const output = await handleDoctorCommand(projectDir, [
		`--rollback-residue-quarantine=${batch}`,
	]);

	expect(existsSync(batchAbs)).toBe(true);
	expect(output).toContain('its contents could not be enumerated');
	expect(output).not.toContain('unowned content present');
});

test('rollback render pins retained-drained batches and neutralized wedged names (#3951)', async () => {
	writeFileSync(path.join(swarmDir, 'context.md'), 'target', 'utf-8');
	const rel = 'context.md.tmp.1710000000.123456789';
	makeResidue(rel, 3, 'recover-me');
	await handleDoctorCommand(projectDir, ['--quarantine-residue']);

	const quarantineRoot = path.join(swarmDir, 'quarantine');
	const batch = readdirSync(quarantineRoot)[0]!;
	writeFileSync(
		path.join(quarantineRoot, batch, 'operator-notes.txt'),
		'unowned content must be retained',
		'utf-8',
	);
	const retainedOut = await handleDoctorCommand(projectDir, [
		'--rollback-residue-quarantine',
	]);
	expect(retainedOut).toContain(
		`Batch \`quarantine/${batch}\`: 1 restored, 0 already restored. Batch fully drained; directory retained (unowned content present — every unowned file was preserved).`,
	);

	const controlByte = String.fromCodePoint(0x85);
	const wedgedBatch = `wedged${controlByte}batch`;
	mkdirSync(path.join(quarantineRoot, wedgedBatch));
	writeFileSync(path.join(swarmDir, 'context.md'), 'target', 'utf-8');
	makeResidue(rel, 3, 'recover-again');
	await handleDoctorCommand(projectDir, ['--quarantine-residue']);

	const skippedOut = await handleDoctorCommand(projectDir, [
		'--rollback-residue-quarantine',
	]);
	const actualWedgedBatch = readdirSync(quarantineRoot).find((name) =>
		name.startsWith('wedged'),
	)!;
	const neutralizedBatch = actualWedgedBatch.replace(controlByte, '');
	expect(skippedOut).toContain(
		`- skipped wedged batch \`${neutralizedBatch}\`: no readable manifest surface (manifest.json, manifest.intent.json, manifest.recovery.json, <id>.recovery.json) — payload retained under .swarm/quarantine/${neutralizedBatch}/ for manual recovery`,
	);
	expect(skippedOut).not.toContain(controlByte);
});

// ── PR-feedback round: PRR-024 flag exactness ───────────────────────────────

describe('doctor rollback flag parsing exactness (PRR-024)', () => {
	test("a typo'd longer prefixed flag is NOT treated as rollback", async () => {
		const out = await handleDoctorCommand(projectDir, [
			'--rollback-residue-quarantine-batch',
		]);
		// Falls through to the read-only default surface — no rollback
		// section, no error.
		expect(out).not.toContain('Residue Quarantine Rollback');
	});

	test("the '=' form still selects an explicit batch", async () => {
		// No batches exist: the exact '=' form must reach the rollback path
		// and surface its typed error, not silently fall back to read-only.
		const out = await handleDoctorCommand(projectDir, [
			'--rollback-residue-quarantine=nonexistent-batch',
		]);
		expect(out).toContain('rollback failed');
		// No batches exist at all, so the empty-store error fires before the
		// batch-id lookup — either way the '=' form reached the rollback path.
		expect(out).toContain('No quarantine batches found');
	});
});
