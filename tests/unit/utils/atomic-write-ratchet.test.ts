/**
 * Issue #2035 / PR-feedback PRR-003: the WRITER_CLASSIFICATION ratchet and
 * the grammar-registry persisted-contract pin, split from
 * tests/unit/utils/atomic-write.test.ts to honor the FR-006 500-line cap.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import {
	matchTempGrammar,
	SWARM_TEMP_GRAMMARS,
	WRITER_CLASSIFICATION,
} from '../../../src/utils/atomic-write';

function symbolBody(absPath: string, symbol: string): string | null {
	const source = readFileSync(absPath, 'utf-8');
	const sourceFile = ts.createSourceFile(
		absPath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	let body: string | null = null;
	const visit = (node: ts.Node): void => {
		if (
			ts.isFunctionDeclaration(node) &&
			node.name?.text === symbol &&
			node.body
		) {
			body = node.body.getText(sourceFile);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return body;
}

function citationError(producer: string, repoRoot: string): string | null {
	const liveLine = /^(src\/[A-Za-z0-9/_.-]+):(\d+)$/.exec(producer);
	if (liveLine) {
		const abs = path.join(repoRoot, ...liveLine[1].split('/'));
		if (!existsSync(abs)) return 'file missing';
		const line = readFileSync(abs, 'utf-8').split(/\r?\n/)[
			Number(liveLine[2]) - 1
		];
		if (line === undefined) return 'line missing';
		return /\.tmp(?:[^A-Za-z0-9]|$)|\.(?:rebuild|close|migration)[.-]/.test(
			line,
		)
			? null
			: 'line has no temp construction';
	}
	const liveSymbol =
		/^(src\/[A-Za-z0-9/_.-]+):([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(producer);
	if (liveSymbol) {
		const abs = path.join(repoRoot, ...liveSymbol[1].split('/'));
		if (!existsSync(abs)) return 'file missing';
		const body = symbolBody(abs, liveSymbol[2]);
		if (!body) return 'symbol missing';
		if (/\.tmp(?:[^A-Za-z0-9]|$)/.test(body)) return null;
		if (/\bwriteAtomicSync\s*\(/.test(body)) {
			const core = symbolBody(abs, 'writeAtomicSync');
			return core && /\.tmp(?:[^A-Za-z0-9]|$)/.test(core)
				? null
				: 'canonical core has no temp construction';
		}
		return 'symbol has no temp construction';
	}
	const migrated =
		/^(src\/[A-Za-z0-9/_.-]+) \(pre-#(\d+); (?:site=[A-Za-z0-9_.-]+; )?migrated-to=(src\/[A-Za-z0-9/_.-]+):([A-Za-z_$][A-Za-z0-9_$]*)\)$/.exec(
			producer,
		);
	if (migrated) {
		const oldAbs = path.join(repoRoot, ...migrated[1].split('/'));
		const targetAbs = path.join(repoRoot, ...migrated[3].split('/'));
		if (!existsSync(oldAbs) || !existsSync(targetAbs))
			return 'migration file missing';
		const body = symbolBody(targetAbs, migrated[4]);
		if (!body) return 'migration symbol missing';
		return /atomicWrite(?:SwarmFile|SwarmFileSync|FileAnyRoot)|\.tmp(?:[^A-Za-z0-9]|$)/.test(
			body,
		)
			? null
			: 'migration target has no canonical delegation or temp construction';
	}
	const legacy =
		/^pre-7\.x writers \(pre-#2035; scanner=(src\/[A-Za-z0-9/_.-]+):([A-Za-z_$][A-Za-z0-9_$]*)\)$/.exec(
			producer,
		);
	if (legacy) {
		const abs = path.join(repoRoot, ...legacy[1].split('/'));
		if (!existsSync(abs)) return 'legacy scanner file missing';
		const body = symbolBody(abs, legacy[2]);
		return body && /matchTempGrammar/.test(body)
			? null
			: 'legacy scanner does not apply registered grammars';
	}
	return 'unrecognized citation grammar';
}

describe('WRITER_CLASSIFICATION ratchet (no unregistered temp constructor)', () => {
	test('every src file containing a .tmp./.tmp- construction is classified', () => {
		const repoRoot = path.resolve(import.meta.dir, '../../..');
		const srcRoot = path.join(repoRoot, 'src');
		const unclassified: string[] = [];
		const walk = (dir: string, rel: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const relPath = rel ? `${rel}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					walk(path.join(dir, entry.name), relPath);
					continue;
				}
				if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) {
					continue;
				}
				const posixRel = `src/${relPath.split(path.sep).join('/')}`;
				if (posixRel === 'src/utils/atomic-write.ts') continue; // the registry itself
				if (posixRel === 'src/services/swarm-residue.ts') continue; // scanner
				let text = '';
				try {
					text = readFileSync(path.join(dir, entry.name), 'utf-8');
				} catch {
					continue;
				}
				// Construction shapes: `.tmp.` / `.tmp-` (mid-name), and
				// `.tmp` at a string/template terminator (quote, backtick, or
				// end-of-line) — the final-critic round caught a live
				// unclassified writer (`${metaPath}.tmp`) that the
				// mid-name-only form missed.
				if (
					/\.tmp(?:[.-]|['"`]|$)/.test(text) &&
					!WRITER_CLASSIFICATION[posixRel]
				) {
					unclassified.push(posixRel);
				}
			}
		};
		walk(srcRoot, '');
		expect(unclassified).toEqual([]);
	});

	test('classification values come from the closed vocabulary', () => {
		const allowed = new Set([
			'migrated',
			'registered-bespoke',
			'external',
			'reader-only',
		]);
		for (const value of Object.values(WRITER_CLASSIFICATION)) {
			expect(allowed.has(value)).toBe(true);
		}
	});

	test('every classification entry names a real src file (no dead entries)', () => {
		const repoRoot = path.resolve(import.meta.dir, '../../..');
		for (const key of Object.keys(WRITER_CLASSIFICATION)) {
			expect(existsSync(path.join(repoRoot, ...key.split('/')))).toBe(true);
		}
	});

	test('every registry producer citation resolves to a live temp construction or a historical marker', () => {
		const repoRoot = path.resolve(import.meta.dir, '../../..');
		const stale: string[] = [];
		for (const grammar of SWARM_TEMP_GRAMMARS) {
			for (const producer of grammar.producers) {
				const error = citationError(producer, repoRoot);
				if (error) stale.push(`${grammar.id}: ${producer} — ${error}`);
			}
		}
		expect(stale).toEqual([]);
	});

	test('rejects all three historical and suffix bypass classes from issue #2391', () => {
		const repoRoot = path.resolve(import.meta.dir, '../../..');
		expect(
			citationError('src/commands/handoff.ts:1 (pre-#2035)', repoRoot),
		).toBe('unrecognized citation grammar');
		expect(
			citationError('src/utils/atomic-write.ts:missingSymbol', repoRoot),
		).toBe('symbol missing');
		expect(citationError('src/commands/handoff.ts:48 bogus', repoRoot)).toBe(
			'unrecognized citation grammar',
		);
	});
});

// ── Containment ─────────────────────────────────────────────────────────────

describe('grammar registry persisted-contract pin (PRR-019)', () => {
	// This is a deliberate CONTRACT SNAPSHOT, not SUT-derived coverage: the
	// id ORDER below is a persisted wire contract. Grammar ids flow into
	// quarantine manifests (grammar_id) and residue_health telemetry
	// (grammar_counts keys), and matchTempGrammar is FIRST-MATCH — so both
	// the exact id set AND the array order are load-bearing. Renaming an id
	// or reordering the array silently breaks mixed-version manifest readers
	// and changes classification of overlapping basenames. If this test
	// fails, you changed a shipped contract: either revert, or ship a
	// migration for existing manifests/telemetry and update this pin in the
	// same commit with that migration noted.
	test('grammar ids and order are pinned exactly (persisted-contract snapshot)', () => {
		expect(SWARM_TEMP_GRAMMARS.map((g) => g.id)).toEqual([
			'canonical-v1',
			'target-suffix-tmp-uuid',
			'target-suffix-tmp-pid-uuid',
			'target-suffix-tmp-num-num-json',
			'target-suffix-tmp-num-alnum',
			'target-suffix-tmp-token',
			'target-suffix-tmp-dash',
			'target-suffix-tmp-dash-num',
			'target-dot-pid-uuid-tmp',
			'dot-numeric-instance-tmp',
			'dot-uuid-instance-tmp',
			'tmp-prefix-named',
			'target-rebuild-close',
			'target-migration-pid',
			'dot-tmp-prefix-legacy',
			'dot-constant-tmp',
			'target-constant-tmp',
		]);
	});

	test('overlap-critical orderings classify to the specific family, not the generic one', () => {
		// uuid BEFORE single-token: a uuid-shaped token must not fall into
		// target-suffix-tmp-token.
		expect(
			matchTempGrammar('x.tmp.0f6c3e29-fc00-4a1b-9d3d-a1b2c3d4e5f6')?.id,
		).toBe('target-suffix-tmp-uuid');
		// .json-terminated BEFORE bare two-token: the trailing .json must not
		// be absorbed as the alnum token.
		expect(matchTempGrammar('x.tmp.4242.1710000000.json')?.id).toBe(
			'target-suffix-tmp-num-num-json',
		);
		// two-token BEFORE single-token: digits.alnum must not collapse into
		// the generic single-token family.
		expect(matchTempGrammar('x.tmp.1710000000.0abc123')?.id).toBe(
			'target-suffix-tmp-num-alnum',
		);
	});
});
