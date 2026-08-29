import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BASELINE_FILENAME,
	type BaselineEntry,
	baselineKey,
	checkAnchorRatchet,
	collectFindings,
	formatReport,
	loadBaseline,
	main,
	type SourceTree,
	serializeBaseline,
	toBaselineEntry,
} from '../../../scripts/check-registry-citations.ts';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Issue #1534 — anchor ratchet semantics. Fixtures are hand-built so a passing
// test can never be an artifact of the real registry's current contents. The
// final block asserts the SHIPPED baseline is coherent against the real tree.

function makeTree(files: Record<string, string>): SourceTree {
	return {
		srcFiles: Object.keys(files).filter(
			(f) => f.startsWith('src/') && !f.endsWith('.test.ts'),
		),
		readFile: (p) => files[p] ?? null,
	};
}

/** `writeThing` is declared on line 4; `readThing` on line 6. */
const TEN_LINE_FILE = [
	'// line 1',
	'// line 2',
	'',
	'export function writeThing(): void {}',
	'',
	'export function readThing(): void {}',
	'',
	'// line 8',
	'// line 9',
	'// line 10',
].join('\n');

const TREE = makeTree({ 'src/a/b.ts': TEN_LINE_FILE });

const rowsCiting = (citation: string): readonly unknown[] => [
	{ id: 'demo', writerCitations: [citation] },
];

describe('anchor detection', () => {
	test('an identifier inside the cited range passes', () => {
		const result = collectFindings(rowsCiting('src/a/b.ts:4 writeThing'), TREE);
		expect(result.anchorFailures).toEqual([]);
	});

	test('an identifier present in the file but OUTSIDE the range fails', () => {
		// The #1534 "real-but-wrong statement" shape: line 6 is a real line and
		// a real declaration, but it is not `writeThing`.
		const result = collectFindings(rowsCiting('src/a/b.ts:6 writeThing'), TREE);
		expect(result.anchorFailures).toHaveLength(1);
		expect(result.anchorFailures[0]).toMatchObject({
			rowId: 'demo',
			file: 'src/a/b.ts',
			identifier: 'writeThing',
			kind: 'out-of-range',
		});
	});

	test('an identifier absent from the whole file is its own failure kind', () => {
		const result = collectFindings(
			rowsCiting('src/a/b.ts:4 writeThingy'),
			TREE,
		);
		expect(result.anchorFailures[0]?.kind).toBe('absent-from-file');
		expect(result.coverage.anchorAbsent).toBe(1);
	});

	test('a truncated identifier does not match its longer real symbol', () => {
		// `appendTaskGateRequirement` vs the real
		// `appendTaskGateRequirementsReceiptIfNeeded` — word boundaries matter.
		const tree = makeTree({
			'src/a/b.ts': 'export function writeThingLater(): void {}',
		});
		expect(
			collectFindings(rowsCiting('src/a/b.ts:1 writeThing'), tree)
				.anchorFailures[0]?.kind,
		).toBe('absent-from-file');
	});

	test('an all-lowercase adjacent word is reported as skipped, not failed', () => {
		const result = collectFindings(rowsCiting('src/a/b.ts:4 bounded'), TREE);
		expect(result.anchorFailures).toEqual([]);
		expect(result.coverage.anchorSkippedLowercase).toBe(1);
	});

	test('the identifier may satisfy ANY member of a comma-list range', () => {
		const result = collectFindings(
			rowsCiting('src/a/b.ts:2,4 writeThing'),
			TREE,
		);
		expect(result.anchorFailures).toEqual([]);
	});
});

describe('checkAnchorRatchet', () => {
	const failure = collectFindings(
		rowsCiting('src/a/b.ts:6 writeThing'),
		TREE,
	).anchorFailures;

	test('a failure NOT in the baseline is a new failure (hard error)', () => {
		const ratchet = checkAnchorRatchet(failure, []);
		expect(ratchet.newFailures).toHaveLength(1);
		expect(ratchet.removableEntries).toEqual([]);
	});

	test('a failure IN the baseline is tolerated', () => {
		const baseline: BaselineEntry[] = [toBaselineEntry(failure[0]!)];
		const ratchet = checkAnchorRatchet(failure, baseline);
		expect(ratchet.newFailures).toEqual([]);
		expect(ratchet.removableEntries).toEqual([]);
	});

	test('a baseline entry that now PASSES must be removed (may-only-shrink)', () => {
		const baseline: BaselineEntry[] = [toBaselineEntry(failure[0]!)];
		const nowPassing = collectFindings(
			rowsCiting('src/a/b.ts:4 writeThing'),
			TREE,
		).anchorFailures;
		const ratchet = checkAnchorRatchet(nowPassing, baseline);
		expect(ratchet.newFailures).toEqual([]);
		expect(ratchet.removableEntries).toHaveLength(1);
		expect(ratchet.removableEntries[0]?.identifier).toBe('writeThing');
	});

	test('the baseline key ignores the line number, so line churn does not invalidate an entry', () => {
		const baseline: BaselineEntry[] = [toBaselineEntry(failure[0]!)];
		// Same row/file/identifier, different (still wrong) line.
		const shifted = collectFindings(
			rowsCiting('src/a/b.ts:8 writeThing'),
			TREE,
		).anchorFailures;
		const ratchet = checkAnchorRatchet(shifted, baseline);
		expect(ratchet.newFailures).toEqual([]);
		expect(ratchet.removableEntries).toEqual([]);
	});

	test('the baseline key ignores kind, so out-of-range <-> absent is not new drift', () => {
		expect(baselineKey({ rowId: 'r', file: 'f', identifier: 'i' })).toBe(
			baselineKey({ rowId: 'r', file: 'f', identifier: 'i' }),
		);
	});
});

describe('formatReport', () => {
	test('a structural failure fails the run and names file, citation and expectation', () => {
		const result = collectFindings(
			rowsCiting('src/a/gone.ts:4 writeThing'),
			TREE,
		);
		const { lines, failed } = formatReport(
			result,
			checkAnchorRatchet(result.anchorFailures, []),
			0,
		);
		expect(failed).toBe(true);
		const text = lines.join('\n');
		expect(text).toContain('demo.writerCitations[0]');
		expect(text).toContain('src/a/gone.ts:4');
		expect(text).toContain('unresolvable-path');
	});

	test('a stale baseline entry fails the run and names the regeneration command', () => {
		const result = collectFindings(rowsCiting('src/a/b.ts:4 writeThing'), TREE);
		const stale: BaselineEntry[] = [
			{
				rowId: 'demo',
				file: 'src/a/b.ts',
				identifier: 'writeThing',
				kind: 'out-of-range',
				note: 'pre-existing',
			},
		];
		const { lines, failed } = formatReport(
			result,
			checkAnchorRatchet(result.anchorFailures, stale),
			stale.length,
		);
		expect(failed).toBe(true);
		const text = lines.join('\n');
		expect(text).toContain('now PASS and must be removed');
		expect(text).toContain('--write');
	});

	test('a clean run passes and reports every coverage bucket', () => {
		const result = collectFindings(rowsCiting('src/a/b.ts:4 writeThing'), TREE);
		const { lines, failed } = formatReport(
			result,
			checkAnchorRatchet(result.anchorFailures, []),
			0,
		);
		expect(failed).toBe(false);
		const text = lines.join('\n');
		expect(text).toContain('Citations scanned:');
		expect(text).toContain('Continuations unresolvable:');
		expect(text).toContain('All registry citation checks passed.');
	});
});

describe('baseline round-trip and --write', () => {
	test('serializeBaseline sorts deterministically and loadBaseline reads it back', () => {
		const tmp = canonicalMkdtemp('registry-citations-baseline-');
		try {
			const file = path.join(tmp, BASELINE_FILENAME);
			const entries: BaselineEntry[] = [
				{
					rowId: 'z',
					file: 'src/z.ts',
					identifier: 'zed',
					kind: 'out-of-range',
					note: 'n',
				},
				{
					rowId: 'a',
					file: 'src/a.ts',
					identifier: 'ay',
					kind: 'absent-from-file',
					note: 'n',
				},
			];
			fs.writeFileSync(file, serializeBaseline(entries), 'utf-8');
			const loaded = loadBaseline(file);
			expect(loaded.map((e) => e.rowId)).toEqual(['a', 'z']);
			expect(fs.readFileSync(file, 'utf-8')).toContain('may only SHRINK');
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('loadBaseline returns [] when the baseline file is absent', () => {
		const tmp = canonicalMkdtemp('registry-citations-absent-');
		try {
			expect(loadBaseline(path.join(tmp, 'nope.json'))).toEqual([]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('--write refuses while structural failures exist', () => {
		const tmp = canonicalMkdtemp('registry-citations-refuse-');
		try {
			const file = path.join(tmp, BASELINE_FILENAME);
			const exit = main(
				['--write'],
				tmp,
				file,
				rowsCiting('src/a/gone.ts:4 writeThing'),
			);
			expect(exit).toBe(1);
			expect(fs.existsSync(file)).toBe(false);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe('shipped baseline coherence (real tree)', () => {
	const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
	const baselinePath = path.join(repoRoot, 'scripts', BASELINE_FILENAME);

	test('the shipped baseline exists, is non-empty, and every entry is well-formed', () => {
		const entries = loadBaseline(baselinePath);
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			expect(typeof entry.rowId).toBe('string');
			expect(entry.file.startsWith('src/')).toBe(true);
			expect(entry.identifier.length).toBeGreaterThan(0);
			expect(['out-of-range', 'absent-from-file']).toContain(entry.kind);
			expect(entry.note).toContain('Pre-existing debt, not approved drift');
		}
	});

	test('the shipped baseline has no duplicate keys', () => {
		const entries = loadBaseline(baselinePath);
		expect(new Set(entries.map(baselineKey)).size).toBe(entries.length);
	});

	test('the wired gate is green on the current tree', () => {
		expect(main([], repoRoot, baselinePath)).toBe(0);
	});

	// The baseline exists to freeze debt this change does NOT own. Twice during
	// review it froze drift this branch had just caused: once for a row the
	// branch itself added, and once for three citations into
	// `reflection-service.ts` that PASSED on origin/main and broke only because
	// the branch shifted lines in that file. Both were caught by a reviewer
	// reading entries by hand.
	//
	// The precise property is "you broke it, you fix it": an entry is only this
	// branch's drift if the citation PASSED at the merge base and fails now.
	// Merely citing a touched file is not enough — four of the five entries this
	// check first surfaced were already broken on main, and failing them would
	// force remediation of rows this change does not own, which is the exact
	// expansion the recurrence sweep refused.
	//
	// Skips (rather than fails) when the merge base cannot be resolved, so the
	// suite stays runnable in a shallow clone or a detached checkout with no
	// origin/main.
	test('no baseline entry freezes drift this branch itself caused', () => {
		const base = Bun.spawnSync(['git', 'merge-base', 'HEAD', 'origin/main'], {
			cwd: repoRoot,
		});
		if (base.exitCode !== 0) return; // no origin/main here; nothing to compare
		const mergeBase = base.stdout.toString().trim();
		const diff = Bun.spawnSync(
			['git', 'diff', '--name-only', `${mergeBase}...HEAD`],
			{ cwd: repoRoot },
		);
		if (diff.exitCode !== 0) return;
		const changed = new Set(
			diff.stdout
				.toString()
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.length > 0),
		);
		const registry = fs.readFileSync(
			path.join(repoRoot, 'scripts', 'retention-registry.data.ts'),
			'utf8',
		);
		const baseAtMergeBase = new Map<string, string[]>();
		const linesAtMergeBase = (file: string): string[] | null => {
			if (!baseAtMergeBase.has(file)) {
				const shown = Bun.spawnSync(['git', 'show', `${mergeBase}:${file}`], {
					cwd: repoRoot,
				});
				if (shown.exitCode !== 0) return null;
				baseAtMergeBase.set(file, shown.stdout.toString().split(/\r?\n/));
			}
			return baseAtMergeBase.get(file) ?? null;
		};

		const offenders: string[] = [];
		let examined = 0;
		let citedInChangedFile = 0;
		for (const entry of loadBaseline(baselinePath)) {
			if (!changed.has(entry.file)) continue;
			citedInChangedFile++;
			// Locate this entry's citation to recover its range. N2: search only
			// within the OWNING ROW, not the whole registry — an unscoped search
			// can bind to another row's citation of the same file+identifier.
			const escapedFile = entry.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const rowStart = registry.indexOf(`id: '${entry.rowId}'`);
			const rowEnd =
				rowStart === -1 ? -1 : registry.indexOf('\n\t{', rowStart + 1);
			const scope =
				rowStart === -1
					? registry
					: registry.slice(rowStart, rowEnd === -1 ? undefined : rowEnd);
			// N1/N3: a bare continuation (`:506 loadOrCreateGraph`) carries no
			// filename, so match that shape too rather than skipping the entry.
			const cite =
				new RegExp(
					`${escapedFile}:(\\d+)(?:-(\\d+))?\\s+${entry.identifier}`,
				).exec(scope) ??
				new RegExp(`:(\\d+)(?:-(\\d+))?\\s+${entry.identifier}`).exec(scope);
			if (!cite) continue;
			examined++;
			const lo = Number(cite[1]);
			const hi = cite[2] ? Number(cite[2]) : lo;
			const baseLines = linesAtMergeBase(entry.file);
			if (!baseLines) {
				// N3: the file does not exist at the merge base, so an entry citing
				// it CANNOT be pre-existing debt — it is necessarily this branch's.
				offenders.push(
					`${entry.rowId} -> ${entry.file} (${entry.identifier}) cites a file absent at the merge base`,
				);
				continue;
			}
			const passedAtBase = baseLines
				.slice(lo - 1, Math.min(hi, baseLines.length))
				.some((line) => line.includes(entry.identifier));
			if (passedAtBase) {
				offenders.push(
					`${entry.rowId} -> ${entry.file}:${lo} (${entry.identifier}) passed at the merge base and fails now`,
				);
			}
		}
		// ANTI-VACUITY CONTROL. The first version of this guard used an
		// over-escaped regex that never matched, so it passed while examining
		// nothing — and a reintroduced real defect did not fail it.
		//
		// N1: the control was `examined > 0`, which tolerated silently skipping
		// SOME entries — it missed 1 of 5, a bare continuation citation. EVERY
		// at-risk entry must resolve back to its citation, so assert equality.
		expect(examined).toBe(citedInChangedFile);
		expect(offenders).toEqual([]);
	});
});
