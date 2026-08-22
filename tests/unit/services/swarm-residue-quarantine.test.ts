/**
 * Issue #2035 / PR-feedback PRR-003: rollback + quarantine regression suites,
 * split from swarm-residue.test.ts to honor the FR-006 500-line cap.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import {
	_internals,
	inventorySwarmResidue,
	quarantineSwarmResidue,
	rollbackResidueQuarantine,
} from '../../../src/services/swarm-residue';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let projectDir: string;
let swarmDir: string;
const realQueryTracked = _internals.queryTracked;

function makeResidue(rel: string, hoursOld = 2, content = 'x'): string {
	const abs = path.join(swarmDir, ...rel.split('/'));
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, content, 'utf-8');
	const t = withFrozenClock(
		() => new Date(Date.now() - hoursOld * 60 * 60 * 1000),
		// anchor the frozen instant to the real clock: relative fixtures must
		// stay on the same side of the staleness window as before freezing
		{ fixedNow: Date.now() },
	);
	utimesSync(abs, t, t);
	return abs;
}

function makeTarget(rel: string): string {
	const abs = path.join(swarmDir, ...rel.split('/'));
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, '{"target":true}', 'utf-8');
	return abs;
}

beforeEach(() => {
	projectDir = canonicalMkdtemp('swarm-residue-q-');
	swarmDir = path.join(projectDir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	_internals.queryTracked = () => ({ tracked: new Set<string>() });
});

afterEach(() => {
	_internals.queryTracked = realQueryTracked;
	rmSync(projectDir, { recursive: true, force: true });
});

describe('rollbackResidueQuarantine', () => {
	test('restores originals and drains the batch', async () => {
		makeTarget('context.md');
		const rel = 'context.md.tmp.1710000000.123456789';
		makeResidue(rel, 3, 'payload');
		const q = await quarantineSwarmResidue(projectDir, { trigger: 'test' });
		expect(q.quarantined).toBe(1);

		const rb = await rollbackResidueQuarantine(projectDir);
		expect(rb.items).toEqual([{ relPath: rel, status: 'restored' }]);
		expect(existsSync(path.join(swarmDir, rel))).toBe(true);
		expect(readFileSync(path.join(swarmDir, rel), 'utf-8')).toBe('payload');
		expect(rb.drained).toBe(true);
		// Batch dir fully removed.
		expect(existsSync(path.join(swarmDir, ...rb.batchRelDir.split('/')))).toBe(
			false,
		);
	});

	test('collision: an original recreated with different content is NEVER overwritten', async () => {
		makeTarget('context.md');
		const rel = 'context.md.tmp.1710000000.123456789';
		makeResidue(rel, 3, 'quarantined-payload');
		const q = await quarantineSwarmResidue(projectDir, { trigger: 'test' });
		expect(q.quarantined).toBe(1);

		// Recreate the residue at the original location with DIFFERENT content
		// (simulating another quarantine batch's rollback or a new writer).
		writeFileSync(path.join(swarmDir, rel), 'new-different-content', 'utf-8');

		const rb = await rollbackResidueQuarantine(projectDir);
		expect(rb.items[0]?.status).toBe('collision');
		expect(rb.drained).toBe(false);
		// The differing original is untouched; the quarantine copy is retained.
		expect(readFileSync(path.join(swarmDir, rel), 'utf-8')).toBe(
			'new-different-content',
		);
	});

	test('re-rollback of an already-restored batch is a clean no-op error', async () => {
		makeTarget('context.md');
		makeResidue('context.md.tmp.1710000000.123456789', 3);
		await quarantineSwarmResidue(projectDir, { trigger: 'test' });
		await rollbackResidueQuarantine(projectDir);
		await expect(rollbackResidueQuarantine(projectDir)).rejects.toThrow(
			/No quarantine batches/,
		);
	});

	test('already-restored identical copy is dropped (idempotent restore)', async () => {
		makeTarget('context.md');
		const rel = 'context.md.tmp.1710000000.123456789';
		makeResidue(rel, 3, 'same');
		const q = await quarantineSwarmResidue(projectDir, { trigger: 'test' });
		// Manually restore the identical content at the original location.
		writeFileSync(path.join(swarmDir, rel), 'same', 'utf-8');
		const rb = await rollbackResidueQuarantine(projectDir);
		expect(rb.items[0]?.status).toBe('already-restored');
		expect(rb.drained).toBe(true);
	});

	test('tampered manifest with traversal relpaths is rejected', async () => {
		makeTarget('context.md');
		makeResidue('context.md.tmp.1710000000.123456789', 3);
		const q = await quarantineSwarmResidue(projectDir, { trigger: 'test' });
		const manifestPath = path.join(
			swarmDir,
			...q.batchRelDir!.split('/'),
			'manifest.json',
		);
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
			entries: Array<{ original_rel_path: string }>;
		};
		manifest.entries[0]!.original_rel_path = '../../escape.json';
		writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
		await expect(rollbackResidueQuarantine(projectDir)).rejects.toThrow(
			/unsafe original_rel_path/,
		);
	});
});

// ── Shared formatter ────────────────────────────────────────────────────────

describe('quarantine move-failure containment (PRR-005)', () => {
	const realRename = _internals.renameResidueEntry;

	afterEach(() => {
		_internals.renameResidueEntry = realRename;
	});

	test('a per-entry rename failure preserves that entry, still moves the rest, and writes the manifest', async () => {
		makeTarget('alpha.json');
		makeTarget('beta.json');
		const first = 'alpha.json.tmp.1710000000.111111111';
		const second = 'beta.json.tmp.1710000000.222222222';
		makeResidue(first, 3, 'alpha-stale');
		makeResidue(second, 3, 'beta-stale');

		// Simulate a concurrent process winning the SECOND entry: our rename
		// throws ENOENT mid-batch (the exact PRR-005 trigger).
		let calls = 0;
		_internals.renameResidueEntry = (from: string, to: string) => {
			if (++calls === 2) {
				throw Object.assign(new Error('ENOENT: no such file'), {
					code: 'ENOENT',
				});
			}
			realRename(from, to);
		};

		const result = await quarantineSwarmResidue(projectDir, {
			trigger: 'test',
		});

		// First entry moved and MANIFEST STILL WRITTEN — the orphaned-batch
		// failure mode (payloads with no manifest, poisoning default
		// rollback) is gone.
		expect(result.quarantined).toBe(1);
		expect(result.batchRelDir).toBeDefined();
		const batchDir = path.join(swarmDir, ...result.batchRelDir!.split('/'));
		const manifest = JSON.parse(
			readFileSync(path.join(batchDir, 'manifest.json'), 'utf-8'),
		) as { entries: Array<{ original_rel_path: string }> };
		expect(manifest.entries.map((e) => e.original_rel_path)).toEqual([first]);
		// Default rollback still works (no orphan sorted last).
		const rb = await rollbackResidueQuarantine(projectDir);
		expect(rb.items[0]?.status).toBe('restored');
		expect(readFileSync(path.join(swarmDir, first), 'utf-8')).toBe(
			'alpha-stale',
		);

		// Failed entry preserved in place with the typed reason.
		const failed = result.preserved.find((p) => p.relPath === second);
		expect(failed?.reasons).toContain('move-failed:ENOENT');
		expect(readFileSync(path.join(swarmDir, second), 'utf-8')).toBe(
			'beta-stale',
		);
	});

	test('an EXDEV move failure is contained the same way', async () => {
		makeTarget('cross.json');
		const rel = 'cross.json.tmp.1710000000.333333333';
		makeResidue(rel, 3, 'cross-stale');
		_internals.renameResidueEntry = () => {
			throw Object.assign(new Error('EXDEV: cross-device link'), {
				code: 'EXDEV',
			});
		};
		const result = await quarantineSwarmResidue(projectDir, {
			trigger: 'test',
		});
		expect(result.quarantined).toBe(0);
		// Zero entries moved → batchRelDir undefined and NO batch dirs remain
		// (the parent quarantine/ dir may legitimately exist, empty).
		expect(result.batchRelDir).toBeUndefined();
		const quarantineRoot = path.join(swarmDir, 'quarantine');
		const batchesLeft = existsSync(quarantineRoot)
			? readdirSync(quarantineRoot)
			: [];
		expect(batchesLeft).toEqual([]);
		expect(result.preserved.find((p) => p.relPath === rel)?.reasons).toContain(
			'move-failed:EXDEV',
		);
	});
});

describe('nested-directory quarantine round-trip (PRR-020)', () => {
	test('quarantines and rolls back residue in nested subdirectories with correct manifest layout', async () => {
		// The DOMINANT production shape: writers nest under
		// .swarm/evidence/<dir>/ (see the target-suffix-tmp-num-alnum
		// producer map).
		const nested = 'evidence/retro-9';
		const targetRel = `${nested}/evidence.json`;
		const residueRel = `${nested}/evidence.json.tmp.1710000000.444444444`;
		const targetAbs = path.join(swarmDir, ...targetRel.split('/'));
		mkdirSync(path.dirname(targetAbs), { recursive: true });
		writeFileSync(targetAbs, '{}', 'utf-8');
		makeResidue(residueRel, 3, 'nested-stale');

		const q = await quarantineSwarmResidue(projectDir, { trigger: 'test' });
		expect(q.quarantined).toBe(1);
		expect(existsSync(path.join(swarmDir, ...residueRel.split('/')))).toBe(
			false,
		);

		const batchDir = path.join(swarmDir, ...q.batchRelDir!.split('/'));
		// Payload preserved the nested layout inside the batch.
		expect(
			readFileSync(path.join(batchDir, ...residueRel.split('/')), 'utf-8'),
		).toBe('nested-stale');

		const manifest = JSON.parse(
			readFileSync(path.join(batchDir, 'manifest.json'), 'utf-8'),
		) as {
			entries: Array<{ original_rel_path: string; stored_rel_path: string }>;
		};
		expect(manifest.entries[0]!.original_rel_path).toBe(residueRel);
		// stored_rel_path is POSIX-joined and rooted at quarantine/.
		expect(manifest.entries[0]!.stored_rel_path).toBe(
			`quarantine/${q.batchRelDir!.split('/')[1]}/${residueRel}`,
		);

		// Rollback restores the nested original.
		const rb = await rollbackResidueQuarantine(projectDir);
		expect(rb.items[0]?.status).toBe('restored');
		expect(readFileSync(targetAbs, 'utf-8'), 'target untouched');
		expect(
			readFileSync(path.join(swarmDir, ...residueRel.split('/')), 'utf-8'),
		).toBe('nested-stale');
	});
});

describe('non-ASCII tracked paths (PRR-013)', () => {
	test('tracked non-ASCII residue is NOT quarantined (core.quotepath=false)', async () => {
		try {
			const probe = Bun.spawnSync(['git', '--version'], {
				stdout: 'ignore',
				stderr: 'ignore',
			});
			if (probe.exitCode !== 0) return;
		} catch {
			return; // git unavailable — seam tests cover the logic
		}
		const { execSync } = await import('node:child_process');
		try {
			execSync('git init -q', { cwd: projectDir, stdio: 'ignore' });
		} catch {
			return;
		}
		// A tracked non-ASCII TARGET plus its same-name residue: without
		// -c core.quotepath=false, git C-quotes the tracked path, the
		// tracked-set membership misses, and the residue gets wrongly
		// quarantined (execution-verified during review).
		const targetRel = '报告.json';
		const residueRel = '报告.json.tmp.1710000000.555555555';
		const targetAbs = path.join(swarmDir, targetRel);
		writeFileSync(targetAbs, '{}', 'utf-8');
		makeResidue(residueRel, 3, 'nonascii-stale');
		try {
			execSync(`git add -f ".swarm/${targetRel}" ".swarm/${residueRel}"`, {
				cwd: projectDir,
				stdio: 'ignore',
			});
		} catch {
			return; // add failed — skip gracefully
		}
		_internals.queryTracked = realQueryTracked; // the REAL git path
		const result = await quarantineSwarmResidue(projectDir, {
			trigger: 'test',
		});
		_internals.queryTracked = () => ({ tracked: new Set<string>() });
		expect(result.quarantined).toBe(0);
		const tracked = result.preserved.find((p) => p.relPath === residueRel);
		expect(tracked?.reasons).toContain('git-tracked');
		expect(readFileSync(path.join(swarmDir, residueRel), 'utf-8')).toBe(
			'nonascii-stale',
		);
	});
});
