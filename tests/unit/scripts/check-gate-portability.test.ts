/**
 * Issue #2078 recurrence guardrail — tests for
 * scripts/check-gate-portability.ts.
 *
 * Direct-import unit tests of the pure functions (collectScriptRefs,
 * evaluatePortability), plus a "guardrail bites" integration-style test that
 * proves a newly added Bash-only gate is actually caught, and a real-repo
 * assertion that the current checked-in state passes.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	ACTIONS_DIR,
	type BaselineEntry,
	collectScriptRefs,
	DEFAULT_SCAN_ROOTS,
	evaluatePortability,
	formatScanRoots,
	type GateCategory,
	main,
	readBaseline,
	readWorkflowSources,
	WORKFLOW_DIR,
} from '../../../scripts/check-gate-portability';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('check-gate-portability — collectScriptRefs', () => {
	test('ignores lines whose first non-whitespace char is #', () => {
		const refs = collectScriptRefs([
			{
				file: '.github/workflows/x.yml',
				content: '  # mentions scripts/foo.sh in prose\n',
			},
		]);
		expect(refs.size).toBe(0);
	});

	test('collects from "run: bash scripts/x.sh"', () => {
		const refs = collectScriptRefs([
			{
				file: '.github/workflows/x.yml',
				content: '      run: bash scripts/x.sh\n',
			},
		]);
		expect([...refs.keys()]).toEqual(['scripts/x.sh']);
	});

	test('dedupes across multiple lines within the same file', () => {
		const refs = collectScriptRefs([
			{
				file: '.github/workflows/x.yml',
				content: 'run: bash scripts/x.sh\nrun: bash scripts/x.sh\n',
			},
		]);
		expect(refs.get('scripts/x.sh')).toEqual(['.github/workflows/x.yml']);
	});

	test('records every referencing file, not just the first', () => {
		const refs = collectScriptRefs([
			{ file: '.github/workflows/a.yml', content: 'run: bash scripts/x.sh\n' },
			{ file: '.github/workflows/b.yml', content: 'run: bash scripts/x.sh\n' },
		]);
		expect(refs.get('scripts/x.sh')).toEqual([
			'.github/workflows/a.yml',
			'.github/workflows/b.yml',
		]);
	});

	test('handles CRLF line endings without truncating the match', () => {
		const refs = collectScriptRefs([
			{
				file: '.github/workflows/x.yml',
				content: 'run: bash scripts/x.sh\r\n# scripts/y.sh comment\r\n',
			},
		]);
		expect([...refs.keys()]).toEqual(['scripts/x.sh']);
	});

	test('picks up nested paths like scripts/ci/foo.sh', () => {
		const refs = collectScriptRefs([
			{
				file: '.github/workflows/x.yml',
				content: 'run: bash scripts/ci/foo.sh\n',
			},
		]);
		expect([...refs.keys()]).toEqual(['scripts/ci/foo.sh']);
	});
});

function entry(overrides: Partial<BaselineEntry>): BaselineEntry {
	return {
		script: 'scripts/x.sh',
		category: 'legacy-bash-gate',
		reason: 'test fixture reason',
		...overrides,
	};
}

describe('check-gate-portability — evaluatePortability', () => {
	test('fully baselined -> exit 0 and success message', () => {
		const referenced = new Map([['scripts/x.sh', ['.github/workflows/x.yml']]]);
		const result = evaluatePortability(referenced, [entry({})]);
		expect(result.exitCode).toBe(0);
		expect(result.messages.join('\n')).toInclude(
			'All CI gate portability checks passed.',
		);
	});

	test('unbaselined referenced script -> exit 1, ERROR (new Bash-only gate)', () => {
		const referenced = new Map([
			['scripts/new-thing.sh', ['.github/workflows/x.yml']],
		]);
		const result = evaluatePortability(referenced, []);
		expect(result.exitCode).toBe(1);
		expect(result.unbaselined).toEqual(['scripts/new-thing.sh']);
		expect(result.messages.join('\n')).toInclude('ERROR (new Bash-only gate)');
	});

	test('baselined but unreferenced -> exit 1, ERROR (stale baseline)', () => {
		const result = evaluatePortability(new Map(), [entry({})]);
		expect(result.exitCode).toBe(1);
		expect(result.staleBaseline).toEqual(['scripts/x.sh']);
		expect(result.messages.join('\n')).toInclude('ERROR (stale baseline)');
	});

	test('bad category -> exit 1, ERROR (bad category)', () => {
		const referenced = new Map([['scripts/x.sh', ['.github/workflows/x.yml']]]);
		const result = evaluatePortability(
			referenced,
			// Deliberately invalid category to exercise the validation branch.
			[entry({ category: 'bogus-category' as GateCategory })],
		);
		expect(result.exitCode).toBe(1);
		expect(result.messages.join('\n')).toInclude('ERROR (bad category)');
	});

	test('empty/whitespace reason -> exit 1, ERROR (missing reason)', () => {
		const referenced = new Map([['scripts/x.sh', ['.github/workflows/x.yml']]]);
		const result = evaluatePortability(referenced, [entry({ reason: '   ' })]);
		expect(result.exitCode).toBe(1);
		expect(result.messages.join('\n')).toInclude('ERROR (missing reason)');
	});
});

describe('check-gate-portability — GUARDRAIL BITES (issue #2078 recurrence)', () => {
	test('a brand-new Bash-only gate referenced from a workflow is caught', () => {
		const tmpDir = canonicalMkdtemp('gate-portability-');
		try {
			fs.writeFileSync(
				path.join(tmpDir, 'new-gate.yml'),
				[
					'name: new-gate',
					'on: push',
					'jobs:',
					'  check:',
					'    runs-on: ubuntu-latest',
					'    steps:',
					'      - run: bash scripts/check-something-new.sh',
					'',
				].join('\n'),
			);

			const referenced = collectScriptRefs(
				readWorkflowSources([[tmpDir, '.github/workflows']]),
			);
			const result = evaluatePortability(referenced, readBaseline());

			expect(result.exitCode).toBe(1);
			expect(result.unbaselined).toContain('scripts/check-something-new.sh');
			expect(result.messages.join('\n')).toInclude(
				'scripts/check-something-new.sh',
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('a gate hidden in a nested composite action is still caught', () => {
		const tmpDir = canonicalMkdtemp('gate-portability-nested-');
		try {
			// Composite actions live at .github/actions/<name>/action.yml — one
			// level deeper than a workflow file, so a non-recursive scan would
			// miss them entirely. The actions root is a real scan root, not a
			// special case bolted onto the workflows root.
			const workflowsRoot = path.join(tmpDir, 'workflows');
			const actionsRoot = path.join(tmpDir, 'actions', 'my-action');
			fs.mkdirSync(workflowsRoot, { recursive: true });
			fs.mkdirSync(actionsRoot, { recursive: true });
			fs.writeFileSync(
				path.join(actionsRoot, 'action.yml'),
				[
					'runs:',
					'  steps:',
					'    - run: bash scripts/hidden-gate.sh',
					'',
				].join('\n'),
			);

			const sources = readWorkflowSources([
				[workflowsRoot, '.github/workflows'],
				[path.join(tmpDir, 'actions'), '.github/actions'],
			]);
			// The label must come from the actions root, proving that root was
			// the one that produced the hit.
			expect(sources.map((s) => s.file)).toEqual([
				'.github/actions/my-action/action.yml',
			]);

			const result = evaluatePortability(
				collectScriptRefs(sources),
				readBaseline(),
			);
			expect(result.exitCode).toBe(1);
			expect(result.unbaselined).toContain('scripts/hidden-gate.sh');
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('main() consults the actions root, not only the workflows root', () => {
		const tmpDir = canonicalMkdtemp('gate-portability-main-');
		const logged: string[] = [];
		const realLog = console.log;
		console.log = (line: string) => {
			logged.push(line);
		};
		try {
			const actionsRoot = path.join(tmpDir, 'actions', 'probe');
			fs.mkdirSync(actionsRoot, { recursive: true });
			fs.writeFileSync(
				path.join(actionsRoot, 'action.yml'),
				['runs:', '  steps:', '    - run: bash scripts/probe-gate.sh', ''].join(
					'\n',
				),
			);

			// Second root only. If main() ever stops threading its roots through
			// (e.g. someone hardcodes the workflows root again), this returns 0.
			const exitCode = main([
				[path.join(tmpDir, 'workflows'), '.github/workflows'],
				[path.join(tmpDir, 'actions'), '.github/actions'],
			]);
			expect(exitCode).toBe(1);
			expect(logged.join('\n')).toInclude('scripts/probe-gate.sh');
		} finally {
			console.log = realLog;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('formatScanRoots reports the roots it was given, not a fixed string', () => {
		// Guards the announcement the test below relies on: if this were
		// hardcoded, main() could narrow its scan while still claiming both
		// roots. Arbitrary labels make that impossible to fake.
		expect(formatScanRoots([])).toBe('Scan roots: ');
		expect(
			formatScanRoots([
				['/tmp/a', 'alpha'],
				['/tmp/b', 'beta'],
			]),
		).toBe('Scan roots: alpha, beta');
	});

	test('main() with NO arguments scans both default roots', () => {
		// The default binding is its own mutation site: narrowing it (e.g.
		// `= DEFAULT_SCAN_ROOTS.slice(0, 1)`) is invisible to every test that
		// passes roots explicitly, and invisible in production because
		// `.github/actions/` does not exist in this repo. Driving main() with no
		// arguments and reading back the roots it announced closes that seam.
		const logged: string[] = [];
		const realLog = console.log;
		console.log = (line: string) => {
			logged.push(line);
		};
		let exitCode: number;
		try {
			exitCode = main();
		} finally {
			console.log = realLog;
		}
		expect(exitCode).toBe(0);
		expect(logged[0]).toBe('Scan roots: .github/workflows, .github/actions');
	});

	test('DEFAULT_SCAN_ROOTS covers both .github/workflows and .github/actions', () => {
		expect(DEFAULT_SCAN_ROOTS.map(([, label]) => label)).toEqual([
			'.github/workflows',
			'.github/actions',
		]);
		expect(DEFAULT_SCAN_ROOTS.map(([dir]) => dir)).toEqual([
			WORKFLOW_DIR,
			ACTIONS_DIR,
		]);
	});

	test('the real repo state (checked-in workflows + baseline) passes', () => {
		const result = evaluatePortability(
			collectScriptRefs(readWorkflowSources()),
			readBaseline(),
		);
		expect(result.exitCode).toBe(0);
		expect(result.unbaselined).toEqual([]);
		expect(result.staleBaseline).toEqual([]);
		expect(result.invalidCategories).toEqual([]);
	});
});
