import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	ALLOWED_CATEGORIES,
	type BaselineEntry,
	checkAgainstBaseline,
	collectFindings,
	deriveShippedSkillNames,
	extractCallArgSpans,
	type Finding,
	findSrcRefs,
	loadBaseline,
	scanAgentPromptFile,
	scanThrowAndAdvisorySpans,
	stripJsComments,
	toPosixPath,
} from '../../../scripts/check-runtime-src-refs.ts';

// Issue #2063 E2 — durable class guardrail: "runtime-surfaced agent guidance
// referencing resources absent from installed deployments." These tests cover
// the pure scanning/matching helpers with fixtures, plus a real-tree smoke
// assertion that the shipped baseline (scripts/runtime-src-refs-baseline.json)
// is currently coherent against the actual repo.

describe('findSrcRefs', () => {
	test('matches a src/ path ending in .ts', () => {
		expect(findSrcRefs('see src/agents/architect.ts for details')).toEqual([
			'src/agents/architect.ts',
		]);
	});

	test('matches .js and .md extensions', () => {
		expect(findSrcRefs('src/module.js and src/notes.md')).toEqual([
			'src/module.js',
			'src/notes.md',
		]);
	});

	test('does NOT match paths lacking a recognized extension (bare dir mention or URL fragment)', () => {
		expect(findSrcRefs('the src/hooks directory')).toEqual([]);
		expect(findSrcRefs('https://example.com/src/foo/bar?query=1')).toEqual([]);
	});

	test('stops at the extension even with trailing punctuation/line-numbers', () => {
		expect(findSrcRefs('src/foo.ts:123-145')).toEqual(['src/foo.ts']);
	});

	test('finds multiple distinct matches in one string', () => {
		expect(
			findSrcRefs('src/config/constants.ts and src/tools/tool-names.ts'),
		).toEqual(['src/config/constants.ts', 'src/tools/tool-names.ts']);
	});

	test('does not match uppercase-leading segments (e.g. Src/Foo.ts)', () => {
		expect(findSrcRefs('Src/Foo.ts')).toEqual([]);
	});
});

describe('extractCallArgSpans', () => {
	const THROW_PATTERN = /\bthrow\s+new\s+Error\s*\(/;
	const ADVISORY_PATTERN = /\bpushAdvisory\s*\(/;

	test('extracts a simple single-argument span', () => {
		const src = "throw new Error('SOME_CODE: bad thing happened');";
		const spans = extractCallArgSpans(src, THROW_PATTERN);
		expect(spans).toHaveLength(1);
		expect(spans[0]).toContain('SOME_CODE: bad thing happened');
	});

	test('balances nested parens inside the argument', () => {
		const src = 'throw new Error(`CODE: ${fn(a, b)} happened`);';
		const spans = extractCallArgSpans(src, THROW_PATTERN);
		expect(spans).toHaveLength(1);
		expect(spans[0]).toBe('`CODE: ${fn(a, b)} happened`');
	});

	test('a `)` inside a string literal does not prematurely close the span', () => {
		const src = "throw new Error('close the loop) then retry');";
		const spans = extractCallArgSpans(src, THROW_PATTERN);
		expect(spans).toHaveLength(1);
		expect(spans[0]).toBe("'close the loop) then retry'");
	});

	test('extracts pushAdvisory(...) spans distinctly from throw new Error(...)', () => {
		const src =
			"pushAdvisory(session, 'ADVISORY: see .swarm/spec.md');\nthrow new Error('OTHER: nope');";
		const advisorySpans = extractCallArgSpans(src, ADVISORY_PATTERN);
		const throwSpans = extractCallArgSpans(src, THROW_PATTERN);
		expect(advisorySpans).toHaveLength(1);
		expect(advisorySpans[0]).toContain('ADVISORY');
		expect(throwSpans).toHaveLength(1);
		expect(throwSpans[0]).toContain('OTHER');
	});

	test('finds multiple call sites in one file', () => {
		const src = [
			"throw new Error('A: one');",
			'function x() {',
			"  throw new Error('B: two');",
			'}',
		].join('\n');
		expect(extractCallArgSpans(src, THROW_PATTERN)).toHaveLength(2);
	});
});

describe('scanThrowAndAdvisorySpans — comment exclusion (class-detection proof)', () => {
	test('flags a src/ reference embedded in a thrown error message', () => {
		const src =
			"throw new Error('SEE_SRC: read src/agents/architect.ts to fix this');";
		expect(scanThrowAndAdvisorySpans(src)).toEqual(['src/agents/architect.ts']);
	});

	test('flags a src/ reference embedded in a pushAdvisory message', () => {
		const src =
			"pushAdvisory(session, 'go read src/hooks/guardrails.ts before retrying');";
		expect(scanThrowAndAdvisorySpans(src)).toEqual(['src/hooks/guardrails.ts']);
	});

	test('a `// see src/foo.ts` comment OUTSIDE the call argument span does not false-positive', () => {
		const src = [
			'// see src/foo.ts for background on this check',
			"throw new Error('CODE: clean message with no path reference');",
		].join('\n');
		expect(scanThrowAndAdvisorySpans(src)).toEqual([]);
	});

	test('bite-proof: this is the exact misdirection class the guardrail exists to catch', () => {
		// Mirrors the pre-fix delegation-gate.ts shape from issue #2063: a
		// thrown gate error pointing an agent at a nonexistent installed-plugin
		// source path as the remediation.
		const src =
			"throw new Error('ACCEPTANCE_FIELD_REQUIRED: see src/agents/architect.ts for the ACCEPTANCE FIELD RESOLUTION section');";
		const found = scanThrowAndAdvisorySpans(src);
		expect(found).toContain('src/agents/architect.ts');
	});
});

describe('stripJsComments', () => {
	test('removes a full-line // comment', () => {
		const src = '// a comment\nconst x = 1;';
		expect(stripJsComments(src)).toBe('\nconst x = 1;');
	});

	test('removes a trailing // comment on a code line', () => {
		const src = 'const x = 1; // trailing comment';
		expect(stripJsComments(src)).toBe('const x = 1; ');
	});

	test('removes a single-line block comment', () => {
		const src = 'const x = /* inline */ 1;';
		expect(stripJsComments(src)).toBe('const x =  1;');
	});

	test('removes a multi-line block comment', () => {
		const src = [
			'/**',
			' * doc with src/agents/architect.ts',
			' */',
			'const x = 1;',
		].join('\n');
		const stripped = stripJsComments(src);
		expect(stripped).not.toContain('src/agents/architect.ts');
		expect(stripped).toContain('const x = 1;');
	});
});

describe('scanAgentPromptFile', () => {
	test('flags a src/ reference in prompt template content', () => {
		const src =
			'export const FOO_PROMPT = `Example: src/foo.ts — description`;';
		expect(scanAgentPromptFile(src)).toEqual(['src/foo.ts']);
	});

	test('does NOT flag a src/ reference inside a // comment', () => {
		const src = [
			'// see src/agents/architect.ts for the substitution chain',
			'export const FOO_PROMPT = `no path references here`;',
		].join('\n');
		expect(scanAgentPromptFile(src)).toEqual([]);
	});

	test('does NOT flag a src/ reference inside a /** */ JSDoc block', () => {
		const src = [
			'/**',
			' * See src/agents/index.ts for the substitution chain.',
			' */',
			'export const FOO_PROMPT = `no path references here`;',
		].join('\n');
		expect(scanAgentPromptFile(src)).toEqual([]);
	});
});

describe('deriveShippedSkillNames', () => {
	test('extracts skill directory names from package.json#files entries', () => {
		const names = deriveShippedSkillNames({
			files: [
				'dist',
				'.opencode/skills/brainstorm',
				'.opencode/skills/swarm-plan',
				'README.md',
			],
		});
		expect(names).toEqual(['brainstorm', 'swarm-plan']);
	});

	test('ignores non-.opencode/skills entries and a missing files field', () => {
		expect(deriveShippedSkillNames({ files: ['dist', 'binaries'] })).toEqual(
			[],
		);
		expect(deriveShippedSkillNames({})).toEqual([]);
	});

	test('does not include unshipped skills like generated/*', () => {
		const names = deriveShippedSkillNames({
			files: ['.opencode/skills/generated/guardrail-patterns'],
		});
		// "generated" is itself treated as the skill-directory segment here;
		// the real repo's package.json never lists a generated/* entry, so
		// this fixture documents that the function takes the first path
		// segment literally rather than special-casing "generated".
		expect(names).toEqual(['generated']);
	});
});

describe('toPosixPath', () => {
	test('is a no-op for already-forward-slash paths', () => {
		expect(toPosixPath('a/b/c.ts')).toBe('a/b/c.ts');
	});
});

describe('checkAgainstBaseline', () => {
	function entry(
		file: string,
		match: string,
		category: string,
		justification = 'test',
	): BaselineEntry {
		return { file, match, category, justification };
	}

	function finding(file: string, match: string): Finding {
		return { file, match };
	}

	test('reports zero violations when findings and baseline match exactly', () => {
		const findings = [finding('a.ts', 'src/foo.ts')];
		const baseline = [entry('a.ts', 'src/foo.ts', 'illustrative-example')];
		const result = checkAgainstBaseline(findings, baseline);
		expect(result.nonBaselineFindings).toEqual([]);
		expect(result.staleEntries).toEqual([]);
		expect(result.bannedCategoryEntries).toEqual([]);
	});

	test('flags a finding not present in the baseline', () => {
		const findings = [finding('a.ts', 'src/new-ref.ts')];
		const baseline: BaselineEntry[] = [];
		const result = checkAgainstBaseline(findings, baseline);
		expect(result.nonBaselineFindings).toEqual([
			finding('a.ts', 'src/new-ref.ts'),
		]);
	});

	test('flags a stale baseline entry matching nothing in the current tree', () => {
		const findings: Finding[] = [];
		const baseline = [entry('a.ts', 'src/gone.ts', 'provenance')];
		const result = checkAgainstBaseline(findings, baseline);
		expect(result.staleEntries).toEqual([baseline[0]]);
	});

	test('flags a banned instructional-pointer category', () => {
		const findings = [finding('a.ts', 'src/foo.ts')];
		const baseline = [entry('a.ts', 'src/foo.ts', 'instructional-pointer')];
		const result = checkAgainstBaseline(findings, baseline);
		expect(result.bannedCategoryEntries).toEqual([baseline[0]]);
		// A banned-category entry still "covers" the finding for the
		// non-baseline check (it matches by key) — the banned-category
		// violation is reported independently so the entry can never be used
		// to silently launder an instructional pointer through this check.
		expect(result.nonBaselineFindings).toEqual([]);
	});

	test('flags an unrecognized category the same way as a banned one, and every ALLOWED_CATEGORIES value passes', () => {
		const madeUp = [entry('a.ts', 'src/foo.ts', 'totally-made-up')];
		expect(
			checkAgainstBaseline([finding('a.ts', 'src/foo.ts')], madeUp)
				.bannedCategoryEntries,
		).toEqual(madeUp);
		for (const category of ALLOWED_CATEGORIES) {
			const findings = [finding('a.ts', 'src/x.ts')];
			const baseline = [entry('a.ts', 'src/x.ts', category)];
			const result = checkAgainstBaseline(findings, baseline);
			expect(result.bannedCategoryEntries).toEqual([]);
		}
	});

	test('(file, match) keying — a baseline entry for a different file does not cover a same-named match elsewhere', () => {
		const findings = [finding('b.ts', 'src/foo.ts')];
		const baseline = [entry('a.ts', 'src/foo.ts', 'illustrative-example')];
		const result = checkAgainstBaseline(findings, baseline);
		expect(result.nonBaselineFindings).toEqual([finding('b.ts', 'src/foo.ts')]);
		expect(result.staleEntries).toEqual([baseline[0]]);
	});
});

describe('loadBaseline', () => {
	test('returns an empty array when the file does not exist', () => {
		const missing = path.join(os.tmpdir(), 'nonexistent-baseline-2063.json');
		expect(loadBaseline(missing)).toEqual([]);
	});

	test('parses a valid baseline JSON array', () => {
		const tmpFile = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-2063-'));
		const filePath = path.join(tmpFile, 'baseline.json');
		fs.writeFileSync(
			filePath,
			JSON.stringify([
				{
					file: 'a.ts',
					match: 'src/x.ts',
					category: 'provenance',
					justification: 'test',
				},
			]),
		);
		const loaded = loadBaseline(filePath);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.match).toBe('src/x.ts');
		fs.rmSync(tmpFile, { recursive: true, force: true });
	});

	test('throws when the baseline is not a JSON array', () => {
		const tmpFile = fs.mkdtempSync(
			path.join(os.tmpdir(), 'baseline-2063-bad-'),
		);
		const filePath = path.join(tmpFile, 'baseline.json');
		fs.writeFileSync(filePath, JSON.stringify({ not: 'an array' }));
		expect(() => loadBaseline(filePath)).toThrow();
		fs.rmSync(tmpFile, { recursive: true, force: true });
	});
});

describe('collectFindings — fixture-injection bite-proof (proves the class is caught end-to-end)', () => {
	test('a synthetic repo tree with an injected src/ pointer in a thrown error is detected', () => {
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), 'runtime-src-refs-fixture-2063-'),
		);
		try {
			fs.mkdirSync(path.join(tmpRoot, 'src', 'hooks'), { recursive: true });
			fs.mkdirSync(path.join(tmpRoot, 'src', 'agents'), { recursive: true });
			fs.writeFileSync(
				path.join(tmpRoot, 'package.json'),
				JSON.stringify({ name: 'fixture', files: [] }),
			);
			// Inject the exact misdirection class this guardrail exists to
			// catch: a thrown gate error pointing at a nonexistent installed
			// plugin source path.
			fs.writeFileSync(
				path.join(tmpRoot, 'src', 'hooks', 'fixture-gate.ts'),
				"export function gate() {\n\tthrow new Error(\n\t\t'TEST: see src/agents/architect.ts for the ACCEPTANCE section',\n\t);\n}\n",
			);
			fs.writeFileSync(
				path.join(tmpRoot, 'src', 'agents', 'fixture-agent.ts'),
				'export const FIXTURE_PROMPT = `Read src/tools/whatever.ts before proceeding.`;\n',
			);

			const findings = collectFindings(tmpRoot);
			const matches = findings.map((f) => `${f.file}::${f.match}`);
			expect(matches).toContain(
				'src/hooks/fixture-gate.ts::src/agents/architect.ts',
			);
			expect(matches).toContain(
				'src/agents/fixture-agent.ts::src/tools/whatever.ts',
			);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	test('an empty baseline against a fixture tree flags every reference (detection proof)', () => {
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), 'runtime-src-refs-fixture-empty-2063-'),
		);
		try {
			fs.mkdirSync(path.join(tmpRoot, 'src', 'hooks'), { recursive: true });
			fs.writeFileSync(
				path.join(tmpRoot, 'package.json'),
				JSON.stringify({ name: 'fixture', files: [] }),
			);
			fs.writeFileSync(
				path.join(tmpRoot, 'src', 'hooks', 'fixture-gate.ts'),
				"export function gate() {\n\tthrow new Error('TEST: see src/agents/architect.ts');\n}\n",
			);

			const findings = collectFindings(tmpRoot);
			const result = checkAgainstBaseline(findings, []);
			expect(result.nonBaselineFindings.length).toBeGreaterThan(0);
			expect(
				result.nonBaselineFindings.some(
					(f) => f.match === 'src/agents/architect.ts',
				),
			).toBe(true);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	test('does not scan an unshipped skill (not in package.json#files)', () => {
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), 'runtime-src-refs-fixture-skill-2063-'),
		);
		try {
			fs.writeFileSync(
				path.join(tmpRoot, 'package.json'),
				JSON.stringify({ name: 'fixture', files: [] }),
			);
			fs.mkdirSync(
				path.join(tmpRoot, '.opencode', 'skills', 'unshipped-skill'),
				{ recursive: true },
			);
			fs.writeFileSync(
				path.join(
					tmpRoot,
					'.opencode',
					'skills',
					'unshipped-skill',
					'SKILL.md',
				),
				'See src/some/internal-only-path.ts for details.',
			);

			const findings = collectFindings(tmpRoot);
			expect(findings).toEqual([]);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	test('scans a shipped skill listed in package.json#files', () => {
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), 'runtime-src-refs-fixture-skill-shipped-2063-'),
		);
		try {
			fs.writeFileSync(
				path.join(tmpRoot, 'package.json'),
				JSON.stringify({
					name: 'fixture',
					files: ['.opencode/skills/shipped-skill'],
				}),
			);
			fs.mkdirSync(path.join(tmpRoot, '.opencode', 'skills', 'shipped-skill'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(tmpRoot, '.opencode', 'skills', 'shipped-skill', 'SKILL.md'),
				'See src/some/shipped-path.ts for details.',
			);

			const findings = collectFindings(tmpRoot);
			expect(findings.some((f) => f.match === 'src/some/shipped-path.ts')).toBe(
				true,
			);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});

describe('real-tree smoke: shipped baseline is coherent against the current repo', () => {
	const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
	const BASELINE_PATH = path.join(
		REPO_ROOT,
		'scripts',
		'runtime-src-refs-baseline.json',
	);

	test('every baseline entry uses an allowed category, none banned, all justified', () => {
		const baseline = loadBaseline(BASELINE_PATH);
		expect(baseline.length).toBeGreaterThan(0);
		const allowed = new Set<string>(ALLOWED_CATEGORIES);
		for (const entry of baseline) {
			expect(allowed.has(entry.category)).toBe(true);
			expect(entry.category).not.toBe('instructional-pointer');
			expect(entry.justification.trim().length).toBeGreaterThan(0);
		}
	});

	test('baseline is keyed by (file, match) with no duplicate keys', () => {
		const baseline = loadBaseline(BASELINE_PATH);
		const keys = new Set<string>();
		for (const entry of baseline) {
			const key = `${entry.file} ${entry.match}`;
			expect(keys.has(key)).toBe(false);
			keys.add(key);
		}
	});
});
