/**
 * Issue #2483 ratchet rungs, driven through the REAL gate logic exported by
 * scripts/check-retention-registry.ts (no sandbox copy needed — both
 * `collectRowShapeErrors` and `RESOLVED_SCOPE_ISSUES` are exported and the
 * script's CLI entry is guarded by `import.meta.main`):
 *
 *  Rung 1 — an `authoritative` row on a DIRECT-FILE store (pathGrammar that
 *  does not route through swarm.db) with no reviewed `directFileExemption`
 *  is rejected naming the rule; the same row WITH an exemption passes.
 *
 *  Rung 2 — a `fix-in-issue` disposition naming a resolved scope issue
 *  (#2309, #2483) is rejected (the recurrence hatch); a valid fix-in-issue
 *  naming an OPEN amendment issue (#2485) passes with zero shape errors.
 */
import { describe, expect, it } from 'bun:test';
import {
	collectRowShapeErrors,
	RESOLVED_SCOPE_ISSUES,
} from '../../../scripts/check-retention-registry';
import type { RetentionRow } from '../../../scripts/retention-registry.data';

/**
 * A fully valid synthetic row: zero shape errors as-is. Its pathGrammar
 * routes through swarm.db, so rung 1 does not fire on the base shape.
 */
function baseRow(overrides: Partial<RetentionRow> = {}): RetentionRow {
	return {
		id: 'synthetic-ratchet-row',
		category: 1,
		pathGrammar: '.swarm/swarm.db (synthetic coordination surface)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/synthetic/writer.ts'],
		writerCitations: ['src/synthetic/writer.ts:10 appendSynthetic — append'],
		readerCitations: ['src/synthetic/reader.ts:20 readSynthetic — tail, sync'],
		schemaVersion: '1',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'global cap 100 entries enforced on every append',
			scope: 'global',
			citation: 'src/synthetic/writer.ts:12',
		},
		readBound: {
			pattern: 'tail',
			bound: 'last 100 entries via the shared tail reader',
			sync: true,
			citation: 'src/synthetic/reader.ts:22',
		},
		lockModel: 'single-writer append seam',
		crashBehavior: 'append-only; torn trailing line tolerated',
		closePolicy: 'untouched',
		resetPolicy: 'reset-session does not touch it',
		legacyCompatibility: 'none',
		healthSignal: 'parse failures surface through the reader',
		owner: '#2483',
		disposition: {
			kind: 'retain-by-design',
			citation: 'src/synthetic/writer.ts:12 (cap) + sweep family',
		},
		...overrides,
	};
}

describe('ratchet rung 1: authoritative direct-file stores need a reviewed exemption', () => {
	it('rejects an authoritative direct-file row with no directFileExemption, naming the rule', () => {
		const row = baseRow({
			pathGrammar: '.swarm/synthetic-authority.jsonl',
		});
		const errors = collectRowShapeErrors(row);
		expect(errors.length).toBeGreaterThan(0);
		const joined = errors.join('\n');
		expect(joined).toContain('authoritative');
		expect(joined).toContain('direct-file');
		expect(joined).toContain('directFileExemption.reason');
		expect(joined).toContain('ratchet rung 1');
	});

	it('accepts the same row once it carries a reviewed directFileExemption', () => {
		const row = baseRow({
			pathGrammar: '.swarm/synthetic-authority.jsonl',
			directFileExemption: {
				reason:
					'hash-chained append-only ledger; truncation forbidden by the durability contract; SQLite migration owned by an open tracking issue',
				reviewedIssue: 2499,
			},
		});
		expect(collectRowShapeErrors(row)).toEqual([]);
	});

	it('does not fire for an authoritative row whose pathGrammar routes through swarm.db', () => {
		const errors = collectRowShapeErrors(baseRow());
		expect(errors).toEqual([]);
	});
});

describe('ratchet rung 2: fix-in-issue cannot name a resolved scope issue', () => {
	it('the frozen RESOLVED_SCOPE_ISSUES set is exactly the #2483 closure set', () => {
		expect([...RESOLVED_SCOPE_ISSUES].sort((a, b) => a - b)).toEqual([
			2045, 2046, 2047, 2048, 2309, 2483,
		]);
	});

	it('rejects a fix-in-issue disposition naming #2309 (the umbrella that absorbed every unbounded stream)', () => {
		const row = baseRow({
			writeLimits: {
				...baseRow().writeLimits,
				bound: 'none — no writer-side bound exists',
				scope: 'none',
				citation: 'src/synthetic/writer.ts:12 (no cap call)',
			},
			disposition: {
				kind: 'fix-in-issue',
				issue: 2309,
				note: 'attempting to park a new unbounded stream under the resolved umbrella',
			},
		});
		const joined = collectRowShapeErrors(row).join('\n');
		expect(joined).toContain('RESOLVED_SCOPE_ISSUES');
		expect(joined).toContain('#2309');
	});

	it('rejects a fix-in-issue disposition naming #2483 itself', () => {
		const row = baseRow({
			writeLimits: {
				...baseRow().writeLimits,
				bound: 'none — no writer-side bound exists',
				scope: 'none',
				citation: 'src/synthetic/writer.ts:12 (no cap call)',
			},
			disposition: {
				kind: 'fix-in-issue',
				issue: 2483,
				note: 'attempting to re-open the closed scope under itself',
			},
		});
		const errors = collectRowShapeErrors(row);
		const joined = errors.join('\n');
		expect(joined).toContain('RESOLVED_SCOPE_ISSUES');
		expect(joined).toContain('#2483');
		// #2483 is outside the amendment sequence, so the sequence-window
		// check fires as well — expected, and subordinate to the rung-2
		// rejection above.
		expect(joined).toContain('outside the');
	});

	it('accepts a valid fix-in-issue naming the OPEN amendment issue #2485 with zero shape errors', () => {
		const row = baseRow({
			writeLimits: {
				...baseRow().writeLimits,
				bound: 'none — no writer-side bound exists',
				scope: 'none',
				citation: 'src/synthetic/writer.ts:12 (no cap call)',
			},
			disposition: {
				kind: 'fix-in-issue',
				issue: 2485,
				note: 'migration to the planned sink is owned by the open amendment issue',
			},
		});
		expect(collectRowShapeErrors(row)).toEqual([]);
	});
});
