import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	isTier3Path,
	normalizeTier3Path,
} from '../../../src/parallel/tier3-classifier';

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
		expect(
			['src/util/format.ts', 'src/util/format.ts'].every(
				(f) => !isTier3Path(f),
			),
		).toBe(true);
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
