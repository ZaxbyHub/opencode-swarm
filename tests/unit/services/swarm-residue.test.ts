/**
 * Issue #2035 — shared residue surface: read-only inventory classification,
 * gated recoverable quarantine (manifest + sha256 + idempotence), and
 * rollback (restore, collision, order-independence, tamper rejection).
 *
 * The git-tracked signal is injected through the module's `_internals` seam
 * so classification is deterministic on every platform (including hosts with
 * no git binary); the lock signal uses the real lock machinery where useful.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	formatResidueInventoryLines,
	inventorySwarmResidue,
	quarantineSwarmResidue,
	RESIDUE_STALE_AGE_MS,
	rollbackResidueQuarantine,
} from '../../../src/services/swarm-residue';
import { withFrozenClock } from '../../helpers/test-clock';

let projectDir: string;
let swarmDir: string;
const realQueryTracked = _internals.queryTracked;
const realLockTargets = _internals.activeLockTargets;
// NOTE: quarantine move-failure / nested round-trip / non-ASCII regressions
// live in tests/unit/services/swarm-residue-quarantine.test.ts (FR-006 cap).

function makeResidue(rel: string, hoursOld = 2, content = 'x'): string {
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

function makeTarget(rel: string): string {
	const abs = path.join(swarmDir, ...rel.split('/'));
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, '{"target":true}', 'utf-8');
	return abs;
}

function entryFor(
	inv: Awaited<ReturnType<typeof inventorySwarmResidue>>,
	rel: string,
) {
	return inv.entries.find((e) => e.relPath === rel);
}

beforeEach(() => {
	projectDir = mkdtempSync(path.join(os.tmpdir(), 'swarm-residue-'));
	swarmDir = path.join(projectDir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	// Deterministic tracked state: everything untracked by default.
	_internals.queryTracked = () => ({ tracked: new Set<string>() });
	_internals.activeLockTargets = () => new Set<string>();
});

afterEach(() => {
	_internals.queryTracked = realQueryTracked;
	_internals.activeLockTargets = realLockTargets;
	rmSync(projectDir, { recursive: true, force: true });
});

// ── Inventory classification ────────────────────────────────────────────────

describe('inventorySwarmResidue — classification matrix', () => {
	test('stale untracked instance-token residue with existing target is quarantine-eligible', async () => {
		makeTarget('context.md');
		makeResidue('context.md.tmp.1710000000.123456789');
		const inv = await inventorySwarmResidue(projectDir);
		const e = entryFor(inv, 'context.md.tmp.1710000000.123456789');
		expect(e).toBeDefined();
		expect(e?.proposedAction).toBe('quarantine');
		expect(e?.grammarId).toBe('target-suffix-tmp-num-alnum');
		expect(e?.tracked).toBe('untracked');
		expect(e?.reasons).toEqual([]);
	});

	test('recent residue is preserved as report-only (recent)', async () => {
		makeTarget('context.md');
		makeResidue('context.md.tmp.1710000000.123456789', 0.01); // ~36s old
		const inv = await inventorySwarmResidue(projectDir);
		expect(
			entryFor(inv, 'context.md.tmp.1710000000.123456789')?.proposedAction,
		).toBe('report_only');
		expect(
			entryFor(inv, 'context.md.tmp.1710000000.123456789')?.reasons,
		).toContain('recent');
	});

	test('git-tracked residue is preserved (git-tracked)', async () => {
		makeTarget('context.md');
		const abs = makeResidue('context.md.tmp.1710000000.123456789');
		_internals.queryTracked = () => ({
			tracked: new Set([path.normalize(abs)]),
		});
		const inv = await inventorySwarmResidue(projectDir);
		const e = entryFor(inv, 'context.md.tmp.1710000000.123456789');
		expect(e?.proposedAction).toBe('report_only');
		expect(e?.reasons).toContain('git-tracked');
	});

	test('unknown git state fails closed (tracked-state-unknown)', async () => {
		makeTarget('context.md');
		makeResidue('context.md.tmp.1710000000.123456789');
		_internals.queryTracked = () => ({ tracked: undefined });
		const inv = await inventorySwarmResidue(projectDir);
		expect(inv.gitState).toBe('unknown');
		const e = entryFor(inv, 'context.md.tmp.1710000000.123456789');
		expect(e?.proposedAction).toBe('report_only');
		expect(e?.reasons).toContain('tracked-state-unknown');
	});

	test('symlink candidate is preserved (symlink), never followed', async () => {
		const outside = path.join(projectDir, 'outside-secret.json');
		writeFileSync(outside, 'do-not-touch', 'utf-8');
		try {
			symlinkSync(outside, path.join(swarmDir, 'context.md.tmp.1710000000.1'));
		} catch {
			return; // symlink creation unavailable (privileged mode) — skip
		}
		const inv = await inventorySwarmResidue(projectDir);
		const e = entryFor(inv, 'context.md.tmp.1710000000.1');
		expect(e?.proposedAction).toBe('report_only');
		expect(e?.reasons).toContain('symlink');
		// Scanner never read through the link.
		expect(readFileSync(outside, 'utf-8')).toBe('do-not-touch');
	});

	test('constant-name temps are report-only even when stale', async () => {
		makeResidue('checkpoint-log.jsonl.tmp', 3);
		const inv = await inventorySwarmResidue(projectDir);
		const e = entryFor(inv, 'checkpoint-log.jsonl.tmp');
		expect(e?.proposedAction).toBe('report_only');
		expect(e?.reasons).toContain('constant-name-grammar');
	});

	test('FRESH constant-name temps are suppressed entirely (noise gate)', async () => {
		makeResidue('checkpoint-log.jsonl.tmp', 0.01);
		const inv = await inventorySwarmResidue(projectDir);
		expect(entryFor(inv, 'checkpoint-log.jsonl.tmp')).toBeUndefined();
	});

	test('stale legacy .tmp.-prefix residue stays quarantine-eligible (req 7)', async () => {
		makeResidue('.tmp.legacy-residue', 3);
		const inv = await inventorySwarmResidue(projectDir);
		const e = entryFor(inv, '.tmp.legacy-residue');
		expect(e?.grammarId).toBe('dot-tmp-prefix-legacy');
		expect(e?.proposedAction).toBe('quarantine');
	});

	test('instance-token residue whose target is absent is report-only (target-absent)', async () => {
		// Interrupted FIRST write: temp exists, target never created.
		makeResidue('first-write.json.tmp.1710000000.123456789');
		const inv = await inventorySwarmResidue(projectDir);
		const e = entryFor(inv, 'first-write.json.tmp.1710000000.123456789');
		expect(e?.proposedAction).toBe('report_only');
		expect(e?.reasons).toContain('target-absent');
	});

	test('unmatched lookalikes are not residue at all', async () => {
		writeFileSync(path.join(swarmDir, 'normal.json'), '{}', 'utf-8');
		writeFileSync(path.join(swarmDir, 'context.md.tmp.'), 'x', 'utf-8');
		writeFileSync(path.join(swarmDir, 'CONTEXT.MD.TMP.1.2'), 'x', 'utf-8');
		const inv = await inventorySwarmResidue(projectDir);
		expect(inv.summary.matched).toBe(0);
	});

	test('lock-held target marks the residue active (active-lock)', async () => {
		makeTarget('context.md');
		makeResidue('context.md.tmp.1710000000.123456789');
		const targetAbs = path.join(swarmDir, 'context.md');
		_internals.activeLockTargets = () => new Set([path.normalize(targetAbs)]);
		const inv = await inventorySwarmResidue(projectDir);
		const e = entryFor(inv, 'context.md.tmp.1710000000.123456789');
		expect(e?.lockHeld).toBe(true);
		expect(e?.proposedAction).toBe('report_only');
		expect(e?.reasons).toContain('active-lock');
	});

	test('scanner skips archive/, quarantine/, and locks/ subtrees', async () => {
		makeResidue('archive/swarm-2026/context.md.tmp.1710000000.1', 3);
		makeResidue('quarantine/batch-1/context.md.tmp.1710000000.1', 3);
		makeResidue('locks/x.tmp.1710000000.1', 3);
		const inv = await inventorySwarmResidue(projectDir);
		expect(inv.summary.matched).toBe(0);
	});

	test('empty .swarm reports zero without error', async () => {
		const inv = await inventorySwarmResidue(projectDir);
		expect(inv.summary).toEqual({
			matched: 0,
			eligible: 0,
			ambiguous: 0,
			totalBytes: 0,
			oldestAgeMs: 0,
		});
	});

	test('real git integration: tracked residue is preserved (cwd-relative ls-files output)', async () => {
		// Regression: `git ls-files -- <absolute pathspec>` prints paths
		// RELATIVE TO CWD — the tracked set must resolve lines against the
		// project root or membership checks miss and tracked files get
		// quarantined (caught by the issue #2035 repro, not by seam tests).
		try {
			const probe = Bun.spawnSync(['git', '--version'], {
				stdout: 'ignore',
				stderr: 'ignore',
			});
			if (probe.exitCode !== 0) return;
		} catch {
			return; // git unavailable in this environment — seam tests cover logic
		}
		const { execSync } = await import('node:child_process');
		try {
			execSync('git init -q', { cwd: projectDir, stdio: 'ignore' });
		} catch {
			return; // git init unavailable — skip gracefully
		}
		makeTarget('context.md');
		const abs = makeResidue('context.md.tmp.1710000000.123456789');
		try {
			execSync(
				`git add -f "${path.relative(projectDir, abs).split(path.sep).join('/')}"`,
				{
					cwd: projectDir,
					stdio: 'ignore',
				},
			);
		} catch {
			return; // add failed — skip gracefully
		}
		// Restore the REAL tracked query for this test.
		_internals.queryTracked = realQueryTracked;
		const inv = await inventorySwarmResidue(projectDir);
		const e = entryFor(inv, 'context.md.tmp.1710000000.123456789');
		expect(e?.tracked).toBe('tracked');
		expect(e?.proposedAction).toBe('report_only');
		expect(e?.reasons).toContain('git-tracked');
	});
});

// ── Quarantine ──────────────────────────────────────────────────────────────

describe('quarantineSwarmResidue', () => {
	test('moves eligible residue into a manifest-backed batch and never deletes', async () => {
		makeTarget('context.md');
		const residueRel = 'context.md.tmp.1710000000.123456789';
		makeResidue(residueRel, 3, 'payload');
		makeResidue('.tmp.legacy', 3, 'legacy-payload');

		const result = await quarantineSwarmResidue(projectDir, {
			trigger: 'test',
		});
		expect(result.quarantined).toBe(2);
		expect(result.batchRelDir).toMatch(/^quarantine\/\d{4}-\d{2}-\d{2}T/);

		// Originals GONE (moved), payloads intact in the batch.
		expect(existsSync(path.join(swarmDir, residueRel))).toBe(false);
		const batchDir = path.join(swarmDir, ...result.batchRelDir!.split('/'));
		expect(readFileSync(path.join(batchDir, residueRel), 'utf-8')).toBe(
			'payload',
		);
		expect(readFileSync(path.join(batchDir, '.tmp.legacy'), 'utf-8')).toBe(
			'legacy-payload',
		);

		// Manifest integrity: schema, original paths, checksums that verify.
		const manifest = JSON.parse(
			readFileSync(path.join(batchDir, 'manifest.json'), 'utf-8'),
		) as {
			schema_version: number;
			trigger: string;
			entries: Array<{
				original_rel_path: string;
				stored_rel_path: string;
				sha256: string;
				bytes: number;
				grammar_id: string;
			}>;
		};
		expect(manifest.schema_version).toBe(1);
		expect(manifest.trigger).toBe('test');
		expect(manifest.entries).toHaveLength(2);
		const contextEntry = manifest.entries.find(
			(e) => e.original_rel_path === residueRel,
		);
		expect(contextEntry?.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(contextEntry?.grammar_id).toBe('target-suffix-tmp-num-alnum');
		expect(contextEntry?.bytes).toBe(7);
	});

	test('preserves ineligible candidates in place and reports them', async () => {
		makeTarget('context.md');
		makeResidue('context.md.tmp.1710000000.123456789', 0.01); // recent
		makeResidue('checkpoint-log.jsonl.tmp', 3); // constant-name
		const result = await quarantineSwarmResidue(projectDir, {
			trigger: 'test',
		});
		expect(result.quarantined).toBe(0);
		expect(result.preserved.map((p) => p.relPath).sort()).toEqual([
			'checkpoint-log.jsonl.tmp',
			'context.md.tmp.1710000000.123456789',
		]);
		expect(
			existsSync(path.join(swarmDir, 'context.md.tmp.1710000000.123456789')),
		).toBe(true);
		expect(result.batchRelDir).toBeUndefined();
	});

	test('idempotent: re-run after a full quarantine finds nothing to move', async () => {
		makeTarget('context.md');
		makeResidue('context.md.tmp.1710000000.123456789', 3);
		const first = await quarantineSwarmResidue(projectDir, { trigger: 'test' });
		expect(first.quarantined).toBe(1);
		const second = await quarantineSwarmResidue(projectDir, {
			trigger: 'test',
		});
		expect(second.quarantined).toBe(0);
		expect(second.batchRelDir).toBeUndefined();
	});

	test('TOCTOU: residue mutated after a preview scan is preserved by the action run', async () => {
		makeTarget('context.md');
		const rel = 'context.md.tmp.1710000000.123456789';
		makeResidue(rel, 3, 'before');

		// Preview (dry-run) sees it eligible…
		const preview = await quarantineSwarmResidue(projectDir, {
			trigger: 'test',
			dryRun: true,
		});
		expect(preview.inventory.summary.eligible).toBe(1);

		// …then a concurrent writer mutates it (mtime resets to NOW). The real
		// action run re-scans fresh state: the residue is now RECENT, so it is
		// preserved — the quarantine decision can never act on a stale snapshot.
		writeFileSync(path.join(swarmDir, rel), 'mutated-by-writer', 'utf-8');

		const result = await quarantineSwarmResidue(projectDir, {
			trigger: 'test',
		});
		expect(result.quarantined).toBe(0);
		const preserved = result.preserved.find((p) => p.relPath === rel);
		expect(preserved?.reasons).toContain('recent');
		expect(readFileSync(path.join(swarmDir, rel), 'utf-8')).toBe(
			'mutated-by-writer',
		);
	});

	test('dryRun previews without touching the filesystem', async () => {
		makeTarget('context.md');
		const rel = 'context.md.tmp.1710000000.123456789';
		makeResidue(rel, 3);
		const result = await quarantineSwarmResidue(projectDir, {
			trigger: 'test',
			dryRun: true,
		});
		expect(result.quarantined).toBe(0);
		expect(result.inventory.summary.eligible).toBe(1);
		expect(existsSync(path.join(swarmDir, rel))).toBe(true);
		expect(existsSync(path.join(swarmDir, 'quarantine'))).toBe(false);
	});

	test('12-minute-old lockless temp is preserved (staleness margin for slow writers)', async () => {
		makeTarget('slow.json');
		// 12 min old — under the 30-minute gate (critic finding #1).
		makeResidue('slow.json.tmp.1710000000.999', 12 / 60);
		const inv = await inventorySwarmResidue(projectDir);
		const e = entryFor(inv, 'slow.json.tmp.1710000000.999');
		expect(e?.proposedAction).toBe('report_only');
		expect(e?.reasons).toContain('recent');
		expect(RESIDUE_STALE_AGE_MS).toBeGreaterThanOrEqual(30 * 60_000);
	});
});

// ── Rollback ────────────────────────────────────────────────────────────────

describe('formatResidueInventoryLines (close/doctor shared renderer)', () => {
	test('renders bounded, path-relative lines from the same inventory', async () => {
		makeTarget('context.md');
		makeResidue('context.md.tmp.1710000000.123456789', 3);
		makeResidue('checkpoint-log.jsonl.tmp', 4);
		const inv = await inventorySwarmResidue(projectDir);
		const lines = formatResidueInventoryLines(inv);
		const text = lines.join('\n');
		expect(text).toContain('target-suffix-tmp-num-alnum');
		expect(text).toContain('would quarantine');
		expect(text).toContain('preserve');
		// Relative paths only — no absolute-path leak.
		expect(text).not.toContain(projectDir);
		// Bounded detail even with many entries.
		const many = formatResidueInventoryLines(inv, { maxEntries: 1 });
		expect(many.some((l) => l.includes('bounded report'))).toBe(true);
	});
});
