import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	executeRulesSync,
	getRuleById,
	getRuleStats,
} from '../../../src/sast/rules/index';
import { sastScan } from '../../../src/tools/sast-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const CONFIRMED_EXEC = 'sast/js-command-injection';
const REVIEW_EXEC = 'sast/js-command-exec-review';
const REPO_ROOT = path.resolve(import.meta.dir, '../../..');

function jsFindings(source: string) {
	return executeRulesSync('fixture.ts', source, 'typescript');
}

function findingsFor(source: string, ...ruleIds: string[]) {
	return jsFindings(source).filter((finding) =>
		ruleIds.includes(finding.rule_id),
	);
}

function expectOnly(source: string, expected: string, excluded: string) {
	const findings = findingsFor(source, expected, excluded);
	expect(findings.map((finding) => finding.rule_id)).toEqual([expected]);
}

describe('issue #2300 JavaScript callee binding classification', () => {
	describe('child_process exec bindings', () => {
		const confirmedCases = [
			"import { exec } from 'child_process';\nexec(input);",
			"import { exec as run } from 'node:child_process';\nrun(input);",
			"import * as cp from 'node:child_process';\ncp.exec(input);",
			"import cp from 'node:child_process';\ncp.exec(input);",
			"const { exec } = require('child_process');\nexec(input);",
			"const { exec: run } = require('node:child_process');\nrun(input);",
			"const cp = require('child_process');\ncp.exec(input);",
			"const cp = require('node:child_process');\ncp?.exec(input);",
			"const cp = require('node:child_process');\ncp['exec'](input);",
			"const cp = require('node:child_process');\ncp.exec?.(input);",
			"const cp = await import('node:child_process');\ncp.exec(input);",
			"require('child_process').exec(input);",
			"import cp = require('node:child_process');\ncp.exec(input);",
			"const cp = require('child_process');\nconst run = cp.exec;\nrun(input);",
			"const cp = require('child_process');\nconst { exec: run } = cp;\nrun(input);",
			"import {\n exec as run\n} from 'node:child_process';\nrun(\n input\n);",
		];

		for (const [index, source] of confirmedCases.entries()) {
			test(`keeps confirmed binding form ${index + 1} critical`, () => {
				expectOnly(source, CONFIRMED_EXEC, REVIEW_EXEC);
				expect(findingsFor(source, CONFIRMED_EXEC)[0]?.severity).toBe(
					'critical',
				);
			});
		}

		test('does not treat RegExp.exec as command execution', () => {
			const sources = [
				'const matcher = /x/g; matcher.exec(input);',
				"const matcher = new RegExp('x'); matcher.exec(input);",
				'/x/.exec(input);',
			];
			for (const source of sources) {
				expect(findingsFor(source, CONFIRMED_EXEC, REVIEW_EXEC)).toEqual([]);
			}
		});

		test('suppresses exec on a receiver imported from another module', () => {
			const source =
				"import * as database from 'database'; database.exec(input);";
			expect(findingsFor(source, CONFIRMED_EXEC, REVIEW_EXEC)).toEqual([]);
		});

		test('downgrades unresolved bare and member calls to manual review', () => {
			for (const source of ['exec(input);', 'runner.exec(input);']) {
				expectOnly(source, REVIEW_EXEC, CONFIRMED_EXEC);
				expect(findingsFor(source, REVIEW_EXEC)[0]?.severity).toBe('low');
			}
		});

		test('downgrades shadowed, reassigned, or conflicting trusted bindings', () => {
			const sources = [
				"import { exec } from 'child_process'; function f(exec) { exec(input); }",
				"let cp = require('child_process'); cp = runner; cp.exec(input);",
				"const cp = require('child_process'); function f(cp) { cp.exec(input); }",
				"import { exec } from 'child_process'; const text = /x/; function f() { const exec = text.exec; exec(input); }",
			];
			for (const source of sources)
				expectOnly(source, REVIEW_EXEC, CONFIRMED_EXEC);
		});

		test('regression: unrelated same-name declarations do not hide top-level exec bindings (F-001)', () => {
			// Previous code compared the visible declaration count to a file-wide total,
			// so a disjoint helper-scope `exec`/`cp` shadow downgraded the real sink.
			const cases = [
				"import { exec } from 'child_process'; exec(input); function otherHelper() { function exec(cb) { cb(); } exec(() => {}); }",
				"const cp = require('child_process'); cp.exec(input); function otherHelper() { const cp = copy; cp.run(); }",
			];
			for (const source of cases) {
				const findings = findingsFor(source, CONFIRMED_EXEC, REVIEW_EXEC);
				expect(
					findings.some((finding) => finding.rule_id === CONFIRMED_EXEC),
				).toBe(true);
			}
		});

		test('does not extend trusted bindings outside lexical scope', () => {
			for (const source of [
				"{ const { exec } = require('child_process'); } exec(input);",
				"function init() { const cp = require('child_process'); } cp.exec(input);",
			])
				expectOnly(source, REVIEW_EXEC, CONFIRMED_EXEC);
		});

		test('downgrades a namespace whose exec member was replaced or deleted', () => {
			for (const source of [
				"const cp = require('child_process'); cp.exec = safe; cp.exec(input);",
				"const cp = require('child_process'); delete cp.exec; cp.exec(input);",
			])
				expectOnly(source, REVIEW_EXEC, CONFIRMED_EXEC);
		});

		test('does not create trusted bindings from comments or literals', () => {
			const sources = [
				"// import { exec } from 'child_process'\nexec(input);",
				'const text = "const { exec } = require(\'child_process\')"; exec(input);',
				"const text = `import * as cp from 'child_process'`; cp.exec(input);",
			];
			for (const source of sources)
				expectOnly(source, REVIEW_EXEC, CONFIRMED_EXEC);
		});

		test('treats a shadowed require and type-only import conservatively', () => {
			expectOnly(
				"const require = loader; const cp = require('child_process'); cp.exec(input);",
				REVIEW_EXEC,
				CONFIRMED_EXEC,
			);
			expectOnly(
				"import { type exec } from 'child_process'; exec(input);",
				REVIEW_EXEC,
				CONFIRMED_EXEC,
			);
		});

		test('does not silently suppress sensitive calls inside template expressions', () => {
			expectOnly(
				'const value = `${exec(input)}`;',
				REVIEW_EXEC,
				CONFIRMED_EXEC,
			);
		});

		test('classifies multiple same-name calls by their exact offsets', () => {
			const source =
				"const cp = require('child_process'); const re = /x/; cp.exec(input); re.exec(input);";
			const findings = findingsFor(source, CONFIRMED_EXEC, REVIEW_EXEC);
			expect(findings.map((finding) => finding.rule_id)).toEqual([
				CONFIRMED_EXEC,
			]);
		});

		test('regression: chained argument references are not treated as callees (F-002)', () => {
			// Previous parsing skipped any trailing `)` after the identifier, so
			// `foo(a, exec)(input)` and `foo(a, eval)(input)` were misread as direct
			// sink calls from the identifier argument itself.
			expect(
				findingsFor(
					"import { exec } from 'child_process'; foo(a, exec)(input);",
					CONFIRMED_EXEC,
					REVIEW_EXEC,
				),
			).toEqual([]);
			expect(
				findingsFor(
					'foo(a, eval)(input);',
					'sast/js-eval',
					'sast/js-eval-review',
				),
			).toEqual([]);
			expectOnly(
				"import { exec } from 'child_process'; promisify(exec)(input);",
				CONFIRMED_EXEC,
				REVIEW_EXEC,
			);
		});

		test('related regression: var-backed child_process bindings hoist to function scope', () => {
			expectOnly(
				"function run(input) { if (flag) { var cp = require('child_process'); } cp.exec(input); }",
				CONFIRMED_EXEC,
				REVIEW_EXEC,
			);
		});
	});

	describe('eval and sibling global API identities', () => {
		test('keeps genuine global eval high and object eval non-confirmed', () => {
			expectOnly('eval(input);', 'sast/js-eval', 'sast/js-eval-review');
			expectOnly('math.eval(input);', 'sast/js-eval-review', 'sast/js-eval');
			expect(
				findingsFor(
					"import * as math from 'mathjs'; math.eval(input);",
					'sast/js-eval',
					'sast/js-eval-review',
				),
			).toEqual([]);
		});

		test('recognizes parenthesized and indirect global eval calls', () => {
			for (const source of ['(eval)(input);', '(0, eval)(input);'])
				expectOnly(source, 'sast/js-eval', 'sast/js-eval-review');
		});

		test('does not let an unrelated nested shadow hide top-level global eval', () => {
			expectOnly(
				'function parse(eval) { return null; } eval(input);',
				'sast/js-eval',
				'sast/js-eval-review',
			);
		});

		test('downgrades a shadowed eval binding', () => {
			for (const source of [
				'function parse(eval) { return eval(input); }',
				'function parse(eval: unknown): unknown { return eval(input); }',
				'const parse = (eval: unknown): unknown => { return eval(input); };',
			])
				expectOnly(source, 'sast/js-eval-review', 'sast/js-eval');
		});

		test('distinguishes global and shadowed Function constructors', () => {
			expectOnly(
				'new Function(input);',
				'sast/js-dangerous-function',
				'sast/js-function-constructor-review',
			);
			expectOnly(
				'function build(Function) { return new Function(input); }',
				'sast/js-function-constructor-review',
				'sast/js-dangerous-function',
			);
		});

		test('distinguishes global timers from unrelated or shadowed timers', () => {
			expectOnly(
				"setTimeout('run()', 1);",
				'sast/js-set-timeout-string',
				'sast/js-timer-string-review',
			);
			expectOnly(
				"scheduler.setTimeout('run()', 1);",
				'sast/js-timer-string-review',
				'sast/js-set-timeout-string',
			);
			expectOnly(
				"function later(setTimeout) { setTimeout('run()', 1); }",
				'sast/js-timer-string-review',
				'sast/js-set-timeout-string',
			);
		});

		test('distinguishes global document.write from a shadowed document', () => {
			expectOnly(
				'document.write(input);',
				'sast/js-document-write',
				'sast/js-document-write-review',
			);
			expectOnly(
				'function render(document) { document.write(input); }',
				'sast/js-document-write-review',
				'sast/js-document-write',
			);
		});

		test('distinguishes global message listeners from unknown receivers', () => {
			expectOnly(
				"window.addEventListener('message', handler);",
				'sast/js-postmessage',
				'sast/js-postmessage-review',
			);
			expectOnly(
				"bus.addEventListener('message', handler);",
				'sast/js-postmessage-review',
				'sast/js-postmessage',
			);
		});

		test('classifies every hardened sibling inside template expressions', () => {
			const cases: Array<[string, string, string]> = [
				['`${eval(input)}`;', 'sast/js-eval', 'sast/js-eval-review'],
				[
					'`${new Function(input)}`;',
					'sast/js-dangerous-function',
					'sast/js-function-constructor-review',
				],
				[
					"`${setTimeout('x', 1)}`;",
					'sast/js-set-timeout-string',
					'sast/js-timer-string-review',
				],
				[
					'`${document.write(input)}`;',
					'sast/js-document-write',
					'sast/js-document-write-review',
				],
				[
					"`${window.addEventListener('message', handler)}`;",
					'sast/js-postmessage',
					'sast/js-postmessage-review',
				],
			];
			for (const [source, confirmed, review] of cases)
				expectOnly(source, confirmed, review);
		});
	});

	test('registers an explicit disposition for every JavaScript rule', () => {
		const expectedRuleIds = [
			'sast/js-eval',
			'sast/js-eval-review',
			'sast/js-dangerous-function',
			'sast/js-function-constructor-review',
			'sast/js-command-injection',
			'sast/js-command-exec-review',
			'sast/js-set-timeout-string',
			'sast/js-timer-string-review',
			'sast/js-innerhtml',
			'sast/js-document-write',
			'sast/js-document-write-review',
			'sast/js-postmessage',
			'sast/js-postmessage-review',
			'sast/js-hardcoded-secret',
		];
		for (const id of expectedRuleIds) expect(getRuleById(id)?.id).toBe(id);
		expect(getRuleStats().bySeverity.low).toBeGreaterThanOrEqual(6);
	});

	test('removes all reported command-injection false positives (F-006)', () => {
		// Previous code asserted only the critical rule and could miss its paired
		// low-severity review finding at the same location.
		for (const file of [
			'scripts/check-skill-assertions.ts',
			'scripts/drift-check.ts',
		]) {
			const content = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
			expect(
				executeRulesSync(file, content, 'typescript').filter(
					(finding) =>
						finding.rule_id === CONFIRMED_EXEC ||
						finding.rule_id === REVIEW_EXEC,
				),
			).toEqual([]);
		}
	});

	describe('public sastScan threshold wiring', () => {
		const dirs: string[] = [];
		afterEach(() => {
			for (const dir of dirs.splice(0))
				fs.rmSync(dir, { recursive: true, force: true });
		});

		test('manual-review findings pass at medium and fail at low', async () => {
			const dir = canonicalMkdtemp('sast-2300-');
			dirs.push(dir);
			const file = path.join(dir, 'fixture.ts');
			fs.writeFileSync(file, 'runner.exec(input);');
			const medium = await sastScan(
				{ changed_files: [file], offline_only: true },
				dir,
			);
			const low = await sastScan(
				{
					changed_files: [file],
					offline_only: true,
					severity_threshold: 'low',
				},
				dir,
			);
			expect(medium.findings.map((finding) => finding.rule_id)).toContain(
				REVIEW_EXEC,
			);
			expect(medium.verdict).toBe('pass');
			expect(low.verdict).toBe('fail');
		});

		test('baseline capture fingerprints the low-severity review rule', async () => {
			const dir = canonicalMkdtemp('sast-2300-baseline-');
			dirs.push(dir);
			const file = path.join(dir, 'fixture.ts');
			fs.writeFileSync(file, 'runner.exec(input);');
			const result = await sastScan(
				{
					changed_files: [file],
					offline_only: true,
					capture_baseline: true,
					phase: 1,
				},
				dir,
			);
			const baseline = JSON.parse(
				fs.readFileSync(
					path.join(dir, '.swarm', 'evidence', '1', 'sast-baseline.json'),
					'utf8',
				),
			) as { findings_snapshot: Array<{ rule_id: string; severity: string }> };
			expect(result.verdict).toBe('pass');
			expect(baseline.findings_snapshot).toEqual([
				expect.objectContaining({ rule_id: REVIEW_EXEC, severity: 'low' }),
			]);
		});
	});

	test('regression: near-limit single-line input stays analyzable (F-003)', () => {
		const calls = Array.from(
			{ length: 18_000 },
			(_, index) => `const a${index}=${index};`,
		).join('');
		const source = "import{exec}from'child_process';" + calls + 'exec(input);';
		const started = performance.now();
		const findings = findingsFor(source, CONFIRMED_EXEC, REVIEW_EXEC);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(findings.map((finding) => finding.rule_id)).toEqual([
			CONFIRMED_EXEC,
		]);
	});
});
