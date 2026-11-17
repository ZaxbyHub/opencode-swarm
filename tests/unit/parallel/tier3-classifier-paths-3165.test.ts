import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	isTier3Path,
	matchesTier3,
	normalizeTier3Path,
} from '../../../src/parallel/tier3-classifier';
import { normalizeScopeFiles } from '../../../src/scope/scope-binding';

/**
 * #3165 F-2: the issue's named deep-path modules classify as Tier 3, the
 * normalization is fail-closed for unprovable path forms, and a RUNTIME
 * CENSUS asserts the known-sensitive set over the real tree stays Tier 3
 * (the PR #2224 anti-silent-drop guard: a future rule change that drops real
 * sensitive files fails here instead of shipping green).
 */

describe('tier3-classifier named paths (#3165 F-2)', () => {
	const named = [
		'src/hooks/guardrails/tool-before.ts',
		'src/hooks/guardrails/index.ts',
		'src/sandbox/linux/bubblewrap-executor.ts',
		'src/cli/index.ts',
		'src/tools/phase-complete.ts',
		'src/plan/ledger.ts',
		'src/utils/credentials.ts',
	];
	for (const p of named) {
		test(`isTier3Path('${p}') is true`, () => {
			expect(isTier3Path(p)).toBe(true);
		});
	}

	const controls = ['src/utils/logger.ts', 'src/tools/save-plan.ts'];
	for (const p of controls) {
		test(`negative control isTier3Path('${p}') stays false`, () => {
			expect(isTier3Path(p)).toBe(false);
		});
	}

	test('a bare index.ts from another directory stays non-Tier-3 (path-qualified rule)', () => {
		expect(isTier3Path('index.ts')).toBe(false);
		expect(isTier3Path('src/utils/index.ts')).toBe(false);
		expect(isTier3Path('packages/app/index.ts')).toBe(false);
	});

	test('credential family: singular and plural, bare and prefixed', () => {
		expect(isTier3Path('src/utils/credential.ts')).toBe(true);
		expect(isTier3Path('src/utils/credentials.ts')).toBe(true);
		expect(isTier3Path('src/auth/credential-helper.ts')).toBe(true);
		expect(isTier3Path('src/auth/credentials-helper.ts')).toBe(true);
		expect(isTier3Path('src/credentials-manager.ts')).toBe(true);
		// Near-miss: 'credentialsx' has no separator, not an exact name.
		expect(isTier3Path('src/utils/credentialsx.ts')).toBe(false);
	});
});

describe('normalizeTier3Path fail-closed matrix (#3165 F-2)', () => {
	const unprovable = [
		'',
		'   ',
		'\t',
		'/etc/passwd',
		'C:\\repo\\src\\util\\format.ts',
		'C:src/util/format.ts',
		'~/src/util/format.ts',
		'src/../src/util/format.ts',
		'../src/util/format.ts',
		// Windows absolute spellings that only surface AFTER backslash
		// conversion (plan-critic r4 executed probes — each bypassed when the
		// leading-'/' rejection ran before the conversion): UNC, rooted
		// backslash, and extended-length forms.
		'\\\\server\\share\\src\\util\\format.ts',
		'\\\\server\\share\\src\\cli\\index.ts',
		'\\src\\util\\format.ts',
		'\\\\?\\C:\\repo\\src\\util\\format.ts',
		// Directory-shaped (trailing-slash) entries — final-critic round 1:
		// `src/security/` classified Tier 3 at BASE and must stay Tier 3; the
		// same holds for the new guardrails/ and sandbox/ segments. Round 2:
		// terminal-dot spellings (`/.`, `/./.`) are the SAME declaration and
		// must fail closed identically.
		'src/security/',
		'src/sandbox/',
		'src/hooks/guardrails/',
		'src/security/.',
		'src/security/./.',
		'src/sandbox/.',
	];
	for (const input of unprovable) {
		test(`normalizeTier3Path(${JSON.stringify(input)}) -> null (Tier 3)`, () => {
			expect(normalizeTier3Path(input)).toBeNull();
			expect(isTier3Path(input)).toBe(true);
		});
	}

	const provable: Array<[string, string]> = [
		['./src/util/format.ts', 'src/util/format.ts'],
		['.//src//util//format.ts', 'src/util/format.ts'],
		['src/./util/./format.ts', 'src/util/format.ts'],
		['src\\util\\format.ts', 'src/util/format.ts'],
		[' src/util/format.ts ', 'src/util/format.ts'],
	];
	for (const [input, expected] of provable) {
		test(`normalizeTier3Path(${JSON.stringify(input)}) -> ${expected}`, () => {
			expect(normalizeTier3Path(input)).toBe(expected);
		});
	}

	test('case folding: mixed-case exact repo path matches', () => {
		expect(isTier3Path('SRC/CLI/INDEX.TS')).toBe(true);
		expect(isTier3Path('Src/Tools/Phase-Complete.ts')).toBe(true);
		expect(isTier3Path('SRC/HOOKS/GUARDRAILS/TOOL-BEFORE.TS')).toBe(true);
	});

	test('duplicate entries are idempotent under matchesTier3', () => {
		// Parallel review F-07/F-13: the original body never called
		// matchesTier3 (the name promised a consumer-level pin; the body
		// tested isTier3Path directly). The aggregation-level pin now runs,
		// plus one positive aggregation control.
		expect(matchesTier3(['src/util/format.ts'])).toBe(false);
		expect(matchesTier3(['src/util/format.ts', 'src/util/format.ts'])).toBe(
			false,
		);
		expect(
			matchesTier3(['src/util/format.ts', 'src/security/provider.ts']),
		).toBe(true);
	});

	test('directory-surface hardening: bare dirs, ancestors, terminal-dot files, colon spellings (PR #3705 review)', () => {
		const tier3 = [
			'src/security', // bare gate dir (F-001)
			'src/hooks/guardrails', // bare gate dir
			'src/sandbox', // bare gate dir
			'src', // ancestor of the exact trio (critic sharpening of F-001)
			'src/cli', // ancestor
			'src/tools', // ancestor
			'src/plan', // ancestor
			'src/cli/index.ts.', // terminal-dot FILE (F-003)
			'src/security./foo.ts', // interior-dot DIRECTORY segment (Stage-B round)
			'src/plan/ledger.ts:', // ADS/colon spelling (F-005)
			'src/cli/index.ts:stream', // colon suffix spelling
			'guardrails/x.ts', // gate directory segment in any position
		];
		for (const tier3Path of tier3) {
			expect(isTier3Path(tier3Path), tier3Path).toBe(true);
		}
		// Benign controls: not gate surface, not ancestors of the trio,
		// well-formed spellings (a terminal-dot benign spelling fails closed
		// by design — see the malformed-input row in the fail-closed matrix).
		const bypass = ['src/util/format.ts', 'src/render/canvas.ts', 'src/render'];
		for (const bypassPath of bypass) {
			expect(isTier3Path(bypassPath), bypassPath).toBe(false);
		}
	});
});

describe('save_plan normalization seam -> classifier chain (PR #3705 feedback FB-001)', () => {
	// FB-001 (parallel review F-03): raw-spelling fixtures bypass the
	// production seam — save_plan normalizes files_touched through
	// normalizeScopeFiles (src/scope/scope-binding.ts) BEFORE persistence
	// (src/tools/save-plan.ts:1226), so a rule that only matches raw
	// directory spellings never fires on real plans. These rows exercise
	// the REAL normalizer + the REAL consumer aggregation (matchesTier3)
	// so the hardening is proven on the PERSISTED form, not raw fixtures.
	test('every hardening spelling survives save_plan normalization and classifies Tier 3', () => {
		const spellings = [
			'src/security',
			'src/security/',
			'src/security/.',
			'src/security/./.',
			'src/sandbox',
			'src/hooks/guardrails',
			'src',
			'src/cli',
			'src/tools',
			'src/plan',
			'src/plan/ledger.ts:',
			'src/cli/index.ts.',
			'src/security./foo.ts', // interior-dot directory segment (Stage-B round)
			'src/cli/index.ts:stream',
		];
		for (const spelling of spellings) {
			const normalized = normalizeScopeFiles([spelling]);
			expect(normalized, spelling).not.toBeNull();
			expect(
				matchesTier3(normalized as string[]),
				`normalized ${JSON.stringify(spelling)} -> ${JSON.stringify(normalized)}`,
			).toBe(true);
		}
	});

	test('benign spellings keep Turbo bypass after normalization', () => {
		const benign = [
			'src/util/format.ts',
			'src/render/canvas.ts',
			'src/render',
			'index.ts',
		];
		for (const benignPath of benign) {
			const normalized = normalizeScopeFiles([benignPath]);
			expect(normalized, benignPath).not.toBeNull();
			expect(
				matchesTier3(normalized as string[]),
				`normalized benign ${JSON.stringify(benignPath)} must keep bypass`,
			).toBe(false);
		}
	});
});

describe('tier3 runtime census (#3165 F-2, PR #2224 anti-drop guard)', () => {
	const REPO_ROOT = path.resolve(__dirname, '../../../');

	function walk(dir: string, acc: string[]): void {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full, acc);
			} else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
				acc.push(path.relative(REPO_ROOT, full).replace(/\\/g, '/'));
			}
		}
	}

	test('every runtime file under the sensitive directories stays Tier 3', () => {
		const files: string[] = [];
		walk(path.join(REPO_ROOT, 'src'), files);
		expect(files.length).toBeGreaterThan(500); // census actually ran
		const sensitive = files.filter((f) =>
			/(^|\/)(auth|security|crypto|permission|secret|guardrails|sandbox)\//.test(
				f,
			),
		);
		expect(sensitive.length).toBeGreaterThan(20);
		const dropped = sensitive.filter((f) => !isTier3Path(f));
		expect(
			dropped,
			`known-sensitive files that stopped being Tier 3: ${dropped.join(', ')}`,
		).toEqual([]);
	});

	test('the three exact gate paths exist in the tree and classify', () => {
		for (const p of [
			'src/cli/index.ts',
			'src/tools/phase-complete.ts',
			'src/plan/ledger.ts',
		]) {
			expect(fs.existsSync(path.join(REPO_ROOT, p)), p).toBe(true);
			expect(isTier3Path(p)).toBe(true);
		}
	});
});

describe('architect QA-tier policy untouched by the Turbo rule change (#3165 F-2)', () => {
	// The architect prompt's QA-tier list (src/agents/architect.ts:490-505) is
	// a DELIBERATELY separate policy from the Turbo classifier
	// (docs/modes.md "this list differs"). This PR must not change it.
	test('src/agents/architect.ts still carries the original QA-tier line', () => {
		const source = readFileSync(
			path.resolve(__dirname, '../../../src/agents/architect.ts'),
			'utf-8',
		);
		expect(source).toContain(
			'Match: architect*.ts, delegation*.ts, guardrails*.ts, adversarial*.ts, sanitiz*.ts, auth*, permission*, crypto*, secret*, security files',
		);
	});
});
