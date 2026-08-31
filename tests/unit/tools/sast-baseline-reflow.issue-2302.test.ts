/**
 * Issue #2302 — SAST baseline reflow identity, partition, and audited
 * absorption (unit level): reflow-key derivation, three-way partition with
 * multiset counting (issue Cases A/B), reflow_keys alignment + hybrid
 * absorption gate, and 1.0.0/1.1.0 schema compat.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	assignOccurrenceIndices,
	BASELINE_SCHEMA_VERSION,
	captureOrMergeBaseline,
	LEGACY_BASELINE_SCHEMA_VERSION,
	loadBaseline,
	MAX_BASELINE_FINDINGS,
	partitionAgainstBaseline,
} from '../../../src/tools/sast-baseline';
import type { SastScanFinding } from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// ============ Helpers ============

function makeFinding(
	file: string,
	line: number,
	ruleId = 'sast/js-eval',
): SastScanFinding {
	return {
		rule_id: ruleId,
		severity: 'high',
		message: 'Test finding',
		location: { file, line },
	};
}

function rel(dir: string, file: string): string {
	return path.relative(dir, file).replace(/\\/g, '/');
}

let tempDir = '';

beforeEach(() => {
	tempDir = canonicalMkdtemp('sast-reflow-2302-');
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

// ============ assignOccurrenceIndices — reflow keys ============

describe('assignOccurrenceIndices reflow keys (#2302)', () => {
	it('records a reflow key derived from the flagged line content', () => {
		const file = path.join(tempDir, 'a.js');
		fs.writeFileSync(file, 'function f() {\n  eval(x);\n}\n');
		const [indexed] = assignOccurrenceIndices([makeFinding(file, 2)], tempDir);
		expect(indexed?.stable).toBe(true);
		// Format: relFile|rule_id|hash — position-independent identity.
		expect(indexed?.reflowKey).toMatch(/^a\.js\|sast\/js-eval\|[0-9a-f]{16}$/);
	});

	it('reflow key survives an adjacent-line edit while the fingerprint changes', () => {
		const file = path.join(tempDir, 'adj.js');
		fs.writeFileSync(file, 'function old() {\n  eval(x);\n}\n');
		const [before] = assignOccurrenceIndices([makeFinding(file, 2)], tempDir);

		fs.writeFileSync(file, 'function renamed() {\n  eval(x);\n}\n');
		const [after] = assignOccurrenceIndices([makeFinding(file, 2)], tempDir);

		expect(after?.fingerprint).not.toBe(before?.fingerprint);
		expect(after?.reflowKey).toBe(before?.reflowKey);
	});

	it('reflow key is empty for an unreadable file (unstable, never reflow-matched)', () => {
		const missing = path.join(tempDir, 'missing.js');
		const [indexed] = assignOccurrenceIndices(
			[makeFinding(missing, 1)],
			tempDir,
		);
		expect(indexed?.stable).toBe(false);
		expect(indexed?.reflowKey).toBe('');
	});
});

// ============ partitionAgainstBaseline ============

describe('partitionAgainstBaseline (#2302)', () => {
	it('Case A: adjacent-line edit reclassifies the unchanged finding as moved, not new', () => {
		const file = path.join(tempDir, 'case-a.js');
		fs.writeFileSync(file, 'function old() {\n  eval(x);\n}\n');
		const baselineIndexed = assignOccurrenceIndices(
			[makeFinding(file, 2)],
			tempDir,
		);

		fs.writeFileSync(file, 'function renamed() {\n  eval(x);\n}\n');
		const currentIndexed = assignOccurrenceIndices(
			[makeFinding(file, 2)],
			tempDir,
		);

		const partition = partitionAgainstBaseline(
			currentIndexed,
			new Set(baselineIndexed.map((i) => i.fingerprint)),
			baselineIndexed.map((i) => i.reflowKey),
		);
		expect(partition.preExisting).toHaveLength(0);
		expect(partition.moved).toHaveLength(1);
		expect(partition.newFindings).toHaveLength(0);
	});

	it('criterion 1: flagged line moved below other code with changed neighbors classifies as moved', () => {
		const file = path.join(tempDir, 'move.js');
		fs.writeFileSync(file, 'eval(x);\nfoo();\nbar();\n');
		const baselineIndexed = assignOccurrenceIndices(
			[makeFinding(file, 1)],
			tempDir,
		);

		// Same eval line relocated below unrelated code — its ±1 window
		// neighbors are now different lines.
		fs.writeFileSync(file, 'foo();\nbar();\nbaz();\neval(x);\n');
		const currentIndexed = assignOccurrenceIndices(
			[makeFinding(file, 4)],
			tempDir,
		);

		const partition = partitionAgainstBaseline(
			currentIndexed,
			new Set(baselineIndexed.map((i) => i.fingerprint)),
			baselineIndexed.map((i) => i.reflowKey),
		);
		expect(partition.moved).toHaveLength(1);
		expect(partition.newFindings).toHaveLength(0);
	});

	it('pure relocation with the window intact stays exact pre-existing (today behavior)', () => {
		const file = path.join(tempDir, 'intact.js');
		fs.writeFileSync(file, 'const a = 1;\n\nfunction f() {\n  eval(x);\n}\n');
		const baselineIndexed = assignOccurrenceIndices(
			[makeFinding(file, 4)],
			tempDir,
		);

		// Insert lines far ABOVE the finding — the ±1 window travels with it.
		fs.writeFileSync(
			file,
			'const a = 1;\n\nconst b = 2;\nconst c = 3;\nconst d = 4;\n\nfunction f() {\n  eval(x);\n}\n',
		);
		const currentIndexed = assignOccurrenceIndices(
			[makeFinding(file, 8)],
			tempDir,
		);

		const partition = partitionAgainstBaseline(
			currentIndexed,
			new Set(baselineIndexed.map((i) => i.fingerprint)),
			baselineIndexed.map((i) => i.reflowKey),
		);
		expect(partition.preExisting).toHaveLength(1);
		expect(partition.moved).toHaveLength(0);
	});

	it('Case B: identical duplicate inserted above → 1 moved + 1 new (index decoupling)', () => {
		const file = path.join(tempDir, 'case-b.js');
		fs.writeFileSync(file, 'function run() {\n  eval(x);\n}\n');
		const baselineIndexed = assignOccurrenceIndices(
			[makeFinding(file, 2)],
			tempDir,
		);

		fs.writeFileSync(file, 'function run() {\n  eval(x);\n  eval(x);\n}\n');
		const currentIndexed = assignOccurrenceIndices(
			[makeFinding(file, 2), makeFinding(file, 3)],
			tempDir,
		);

		const partition = partitionAgainstBaseline(
			currentIndexed,
			new Set(baselineIndexed.map((i) => i.fingerprint)),
			baselineIndexed.map((i) => i.reflowKey),
		);
		// Multiset: baseline had one identical line; exactly one current
		// finding is absorbed as moved, the duplicate stays NEW.
		expect(partition.moved).toHaveLength(1);
		expect(partition.newFindings).toHaveLength(1);
		expect(partition.preExisting).toHaveLength(0);
	});

	it('an exact match consumes its reflow count so a far-away duplicate cannot also reflow-match', () => {
		const file = path.join(tempDir, 'consume.js');
		fs.writeFileSync(file, 'pad1\npad2\neval(x);\npad4\n');
		const baselineIndexed = assignOccurrenceIndices(
			[makeFinding(file, 3)],
			tempDir,
		);

		// An identical line appended FAR below: line 3 keeps its original ±1
		// window (exact match) and must consume the baseline's single reflow
		// count, so the new duplicate cannot also reflow-match it.
		fs.writeFileSync(file, 'pad1\npad2\neval(x);\npad4\neval(x);\n');
		const currentIndexed = assignOccurrenceIndices(
			[makeFinding(file, 3), makeFinding(file, 5)],
			tempDir,
		);

		const partition = partitionAgainstBaseline(
			currentIndexed,
			new Set(baselineIndexed.map((i) => i.fingerprint)),
			baselineIndexed.map((i) => i.reflowKey),
		);
		expect(partition.preExisting).toHaveLength(1);
		expect(partition.moved).toHaveLength(0);
		expect(partition.newFindings).toHaveLength(1);
	});

	it('unstable findings are always NEW even with a matching reflow key present', () => {
		const file = path.join(tempDir, 'unstable.js');
		fs.writeFileSync(file, 'eval(x);\n');
		const baselineIndexed = assignOccurrenceIndices(
			[makeFinding(file, 1)],
			tempDir,
		);

		fs.rmSync(file);
		const currentIndexed = assignOccurrenceIndices(
			[makeFinding(file, 1)],
			tempDir,
		);

		const partition = partitionAgainstBaseline(
			currentIndexed,
			new Set(baselineIndexed.map((i) => i.fingerprint)),
			baselineIndexed.map((i) => i.reflowKey),
		);
		expect(partition.newFindings).toHaveLength(1);
	});

	it('empty baseline reflow keys (legacy 1.0.0 file) degrade to exact matching only', () => {
		const file = path.join(tempDir, 'legacy.js');
		fs.writeFileSync(file, 'function old() {\n  eval(x);\n}\n');
		const baselineIndexed = assignOccurrenceIndices(
			[makeFinding(file, 2)],
			tempDir,
		);

		fs.writeFileSync(file, 'function renamed() {\n  eval(x);\n}\n');
		const currentIndexed = assignOccurrenceIndices(
			[makeFinding(file, 2)],
			tempDir,
		);

		const partition = partitionAgainstBaseline(
			currentIndexed,
			new Set(baselineIndexed.map((i) => i.fingerprint)),
			[], // 1.0.0 baseline: no reflow keys
		);
		expect(partition.newFindings).toHaveLength(1);
		expect(partition.moved).toHaveLength(0);
	});
});

// ============ captureOrMergeBaseline — reflow keys + gate ============

describe('captureOrMergeBaseline reflow + absorption (#2302)', () => {
	it('writes reflow_keys aligned with fingerprints on first write, with no triage entries', async () => {
		const file = path.join(tempDir, 'w.js');
		fs.writeFileSync(file, 'function f() {\n  eval(x);\n}\n');
		const r = await captureOrMergeBaseline(
			tempDir,
			1,
			[makeFinding(file, 2)],
			'tier_a',
			[file],
		);
		expect(r.status).toBe('written');

		const loaded = loadBaseline(tempDir, 1);
		expect(loaded.status).toBe('found');
		if (loaded.status === 'found') {
			expect(loaded.bundle.schema_version).toBe(BASELINE_SCHEMA_VERSION);
			expect(loaded.reflowKeys).toHaveLength(1);
			expect(loaded.bundle.reflow_keys).toEqual(loaded.reflowKeys);
			// First write is a snapshot, not an acceptance (#2302).
			expect(loaded.bundle.triage_log).toEqual([]);
		}
	});

	it('re-capturing a file whose finding only moved (adjacent edit) merges freely — no rationale needed', async () => {
		const file = path.join(tempDir, 'moved.js');
		fs.writeFileSync(file, 'function old() {\n  eval(x);\n}\n');
		await captureOrMergeBaseline(tempDir, 1, [makeFinding(file, 2)], 'tier_a', [
			file,
		]);

		fs.writeFileSync(file, 'function renamed() {\n  eval(x);\n}\n');
		const r = await captureOrMergeBaseline(
			tempDir,
			1,
			[makeFinding(file, 2)],
			'tier_a',
			[file],
		);
		// The reflow match makes this a mechanical re-fingerprint, not an
		// absorption — the routine "recapture to fix positions" path stays free.
		expect(r.status).toBe('merged');
		if (r.status === 'merged') {
			expect(r.absorbed_finding_count).toBe(0);
		}
		const loaded = loadBaseline(tempDir, 1);
		if (loaded.status === 'found') {
			expect(loaded.bundle.triage_log).toEqual([]);
		}
	});

	it('re-capturing with fewer findings merges freely (fixed vulnerabilities)', async () => {
		const file = path.join(tempDir, 'fewer.js');
		fs.writeFileSync(file, 'eval(x);\n');
		await captureOrMergeBaseline(tempDir, 1, [makeFinding(file, 1)], 'tier_a', [
			file,
		]);
		const r = await captureOrMergeBaseline(tempDir, 1, [], 'tier_a', [file]);
		expect(r.status).toBe('merged');
		if (r.status === 'merged') {
			expect(r.absorbed_finding_count).toBe(0);
		}
	});

	it('keeps fingerprints, reflow_keys, and snapshot aligned under truncation', async () => {
		const file = path.join(tempDir, 'many.js');
		fs.writeFileSync(
			file,
			'eval(a);\neval(b);\neval(c);\neval(d);\neval(e);\n',
		);
		const findings: SastScanFinding[] = [];
		for (let i = 0; i < MAX_BASELINE_FINDINGS + 5; i++) {
			findings.push(makeFinding(file, (i % 5) + 1));
		}

		const r = await captureOrMergeBaseline(tempDir, 1, findings, 'tier_a', [
			file,
		]);
		expect(r.status).toBe('written');

		const loaded = loadBaseline(tempDir, 1);
		expect(loaded.status).toBe('found');
		if (loaded.status === 'found') {
			expect(loaded.bundle.truncated).toBe(true);
			const n = loaded.bundle.fingerprints.length;
			expect(n).toBe(MAX_BASELINE_FINDINGS);
			// Parallel-array truncation contract: same index range everywhere.
			expect(loaded.bundle.reflow_keys).toHaveLength(n);
			expect(loaded.bundle.findings_snapshot).toHaveLength(n);
			expect(loaded.reflowKeys).toHaveLength(n);
		}
	});
});

// ============ loadBaseline — schema compat ============

describe('loadBaseline schema compat (#2302)', () => {
	function writeBaseline(phase: number, bundle: Record<string, unknown>) {
		const dir = path.join(tempDir, '.swarm', 'evidence', String(phase));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'sast-baseline.json'),
			JSON.stringify(bundle, null, 2),
		);
	}

	it('loads a legacy 1.0.0 baseline with empty reflow keys (exact matching only)', () => {
		writeBaseline(1, {
			schema_version: LEGACY_BASELINE_SCHEMA_VERSION,
			phase: 1,
			created_at: '2026-08-30T00:00:00.000Z',
			updated_at: '2026-08-30T00:00:00.000Z',
			engine: 'tier_a',
			files_indexed: ['old.js'],
			fingerprints: ['old.js|sast/js-eval|abc|#0'],
			findings_snapshot: [],
			truncated: false,
		});

		const loaded = loadBaseline(tempDir, 1);
		expect(loaded.status).toBe('found');
		if (loaded.status === 'found') {
			expect(loaded.reflowKeys).toEqual([]);
			expect(loaded.bundle.schema_version).toBe(LEGACY_BASELINE_SCHEMA_VERSION);
		}
	});

	it('rejects a 1.1.0 baseline whose reflow_keys length mismatches fingerprints', () => {
		writeBaseline(2, {
			schema_version: BASELINE_SCHEMA_VERSION,
			phase: 2,
			created_at: '2026-08-30T00:00:00.000Z',
			updated_at: '2026-08-30T00:00:00.000Z',
			engine: 'tier_a',
			files_indexed: ['x.js'],
			fingerprints: ['x.js|sast/js-eval|a|#0', 'x.js|sast/js-eval|b|#0'],
			reflow_keys: ['x.js|sast/js-eval|k'],
			findings_snapshot: [],
			triage_log: [],
			truncated: false,
		});

		expect(loadBaseline(tempDir, 2).status).toBe('invalid_schema');
	});

	it('tolerates a 1.1.0 baseline with absent reflow_keys (exact-only, fail-closed)', () => {
		writeBaseline(3, {
			schema_version: BASELINE_SCHEMA_VERSION,
			phase: 3,
			created_at: '2026-08-30T00:00:00.000Z',
			updated_at: '2026-08-30T00:00:00.000Z',
			engine: 'tier_a',
			files_indexed: [],
			fingerprints: [],
			findings_snapshot: [],
			truncated: false,
		});

		const loaded = loadBaseline(tempDir, 3);
		expect(loaded.status).toBe('found');
		if (loaded.status === 'found') {
			expect(loaded.reflowKeys).toEqual([]);
		}
	});

	it('upgrades a legacy 1.0.0 baseline to 1.1.0 (with reflow keys) on its next merge', async () => {
		writeBaseline(4, {
			schema_version: LEGACY_BASELINE_SCHEMA_VERSION,
			phase: 4,
			created_at: '2026-08-30T00:00:00.000Z',
			updated_at: '2026-08-30T00:00:00.000Z',
			engine: 'tier_a',
			files_indexed: ['up.js'],
			fingerprints: ['up.js|sast/js-eval|deadbeefdeadbeef|#0'],
			findings_snapshot: [
				{
					rule_id: 'sast/js-eval',
					severity: 'high',
					message: 'legacy',
					location: { file: path.join(tempDir, 'up.js'), line: 1 },
				},
			],
			truncated: false,
		});
		const file = path.join(tempDir, 'up.js');
		fs.writeFileSync(file, 'eval(x);\n');

		// Legacy entry has no reflow key: the unchanged-content finding cannot
		// exact-match the legacy fingerprint and is novel → blocked bare.
		const rBare = await captureOrMergeBaseline(
			tempDir,
			4,
			[makeFinding(file, 1)],
			'tier_a',
			[file],
		);
		expect(rBare.status).toBe('absorption_blocked');

		const r = await captureOrMergeBaseline(
			tempDir,
			4,
			[makeFinding(file, 1)],
			'tier_a',
			[file],
			{ refreshRationale: 'legacy baseline upgrade', actor: 's-up' },
		);
		expect(r.status).toBe('merged');

		const loaded = loadBaseline(tempDir, 4);
		expect(loaded.status).toBe('found');
		if (loaded.status === 'found') {
			expect(loaded.bundle.schema_version).toBe(BASELINE_SCHEMA_VERSION);
			expect(loaded.reflowKeys).toHaveLength(1);
			expect(loaded.bundle.triage_log?.[0]?.rationale).toBe(
				'legacy baseline upgrade',
			);
		}
	});
});
