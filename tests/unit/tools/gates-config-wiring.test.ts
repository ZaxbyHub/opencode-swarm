/**
 * Issue #2524 — `gates.*` config wiring through the REGISTERED production
 * tool objects. Schema-driven loop: a section added to `GATE_SECTION_SCHEMAS`
 * without wiring fails here (default case throws). No mocks: real temp
 * project roots with a `.git` marker and a real config file; XDG redirected.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetConfigAdvisoryDedup } from '../../../src/config/loader';
import {
	GATE_SECTION_SCHEMAS,
	type GateSectionName,
} from '../../../src/config/schema';
import { clearDeferredWarnings } from '../../../src/services/warning-buffer';
import { build_check } from '../../../src/tools/build-check';
import { placeholder_scan } from '../../../src/tools/placeholder-scan';
import { pre_check_batch } from '../../../src/tools/pre-check-batch';
import { quality_budget } from '../../../src/tools/quality-budget';
import { sast_scan } from '../../../src/tools/sast-scan';
import { sbom_generate } from '../../../src/tools/sbom-generate';
import { syntax_check } from '../../../src/tools/syntax-check';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

// --- Fixture helpers ---

let xdgDir: { dir: string; cleanup: () => void } | undefined;
let originalXdg: string | undefined;

beforeAll(() => {
	xdgDir = createSafeTestDir('gates-wiring-xdg-');
	originalXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = xdgDir.dir;
});

afterAll(() => {
	if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdg;
	xdgDir?.cleanup();
});

let project: { dir: string; cleanup: () => void } | undefined;

beforeEach(() => {
	project = createSafeTestDir('gates-wiring-');
	// Module-level advisory state must reset so co-run shards cannot leak a
	// prior file's dedup signature or buffered warning into these assertions.
	clearDeferredWarnings();
	resetConfigAdvisoryDedup();
});

afterEach(() => {
	project?.cleanup();
	project = undefined;
	clearDeferredWarnings();
	resetConfigAdvisoryDedup();
});

function makeProject(
	gates: Record<string, unknown> | undefined,
	files: Record<string, string>,
): string {
	const { dir } = project ?? {};
	if (!dir) throw new Error('makeProject called outside a test body');
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	if (gates !== undefined) {
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ gates }, null, 2),
		);
	}
	for (const [rel, content] of Object.entries(files)) {
		const target = path.join(dir, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	return dir;
}

type GateTool = { execute: (args: never, ctx: never) => Promise<string> };

/** Invoke a registered tool object exactly the way the plugin host does. */
function invoke(tool: GateTool, args: unknown) {
	return (dir: string) =>
		tool
			.execute(
				args as never,
				{ directory: dir, sessionID: 'gates-wiring' } as never,
			)
			.then((out) => JSON.parse(out as string) as Record<string, unknown>);
}

const BAD_SYNTAX_JS = 'function broken( {\n\t// syntax error by design\n';
const TODO_JS = '// TODO: implement the real logic\nexport const a = 1;\n';
const CLEAN_JS = 'export const clean = true;\n';
const STUB_STRING_JS = 'export const label = "totally a stub here";\n';
const PACKAGE_WITH_DEP = JSON.stringify({
	name: 'gates-wiring-fixture',
	version: '1.0.0',
	dependencies: { leftpad: '1.0.0' },
});

/** Files + registered-tool invocation each section needs to prove it ran. */
const SECTION_PROBES: Record<
	GateSectionName,
	{
		files: Record<string, string>;
		run: (dir: string) => Promise<Record<string, unknown>>;
	}
> = {
	syntax_check: {
		files: { 'bad.js': BAD_SYNTAX_JS },
		run: invoke(syntax_check, {
			changed_files: [{ path: 'bad.js', additions: 5 }],
			mode: 'all',
		}),
	},
	placeholder_scan: {
		files: { 'todo.js': TODO_JS },
		run: invoke(placeholder_scan, { changed_files: ['todo.js'] }),
	},
	sast_scan: {
		files: { 'clean.js': CLEAN_JS },
		run: (dir) =>
			invoke(sast_scan, { directory: dir, changed_files: ['clean.js'] })(dir),
	},
	sbom_generate: {
		files: { 'package.json': PACKAGE_WITH_DEP },
		run: invoke(sbom_generate, { scope: 'all' }),
	},
	build_check: {
		files: {
			'package.json': JSON.stringify({
				name: 'gates-wiring-fixture',
				version: '1.0.0',
				scripts: { build: 'node -e "process.exit(1)"' },
			}),
		},
		run: invoke(build_check, { scope: 'all' }),
	},
	quality_budget: {
		files: {
			'src/qb.js':
				'export function f(a) {\n\tif (a) {\n\t\treturn 1;\n\t}\n\treturn 0;\n}\n',
		},
		run: invoke(quality_budget, { changed_files: ['src/qb.js'] }),
	},
};

// --- Schema-driven disabled-behavior matrix (the issue's exit gate) ---

describe('gates.*.enabled: false disables each gate through the registered tool', () => {
	for (const section of Object.keys(
		GATE_SECTION_SCHEMAS,
	) as GateSectionName[]) {
		test(`gates.${section}`, async () => {
			const probe = SECTION_PROBES[section];
			const dir = makeProject({ [section]: { enabled: false } }, probe.files);
			const result = await probe.run(dir);

			switch (section) {
				case 'syntax_check':
					expect(result.verdict).toBe('pass');
					expect(String(result.summary)).toContain('disabled by configuration');
					break;
				case 'placeholder_scan': {
					expect(result.verdict).toBe('pass');
					const summary = result.summary as Record<string, unknown>;
					expect(summary.findings_count).toBe(0);
					expect(String(summary.disabled_reason)).toContain(
						'disabled by configuration',
					);
					break;
				}
				case 'sast_scan': {
					expect(result.verdict).toBe('pass');
					const summary = result.summary as Record<string, unknown>;
					expect(summary.files_scanned).toBe(0);
					expect(String(summary.disabled_reason)).toContain(
						'disabled by configuration',
					);
					break;
				}
				case 'sbom_generate':
					expect(result.verdict).toBe('skip');
					expect(result.components_count).toBe(0);
					expect(String(result.disabled_reason)).toContain(
						'disabled by configuration',
					);
					break;
				case 'build_check': {
					expect(result.verdict).toBe('skip');
					const summary = result.summary as Record<string, unknown>;
					expect(String(summary.skipped_reason)).toContain(
						'build_check disabled by configuration',
					);
					expect(fs.existsSync(path.join(dir, '.swarm'))).toBe(false);
					break;
				}
				case 'quality_budget': {
					expect(result.verdict).toBe('pass');
					const metrics = result.metrics as {
						thresholds: { enabled: boolean };
					};
					expect(metrics.thresholds.enabled).toBe(false);
					break;
				}
				default:
					throw new Error(
						`gates.${section} exists in GATE_SECTION_SCHEMAS but has no disabled-behavior probe — wire the gate and extend SECTION_PROBES (issue #2524 closure contract)`,
					);
			}

			// Disabled paths return before any evidence write (same contract as
			// the pre-existing syntax_check/sast_scan disabled returns).
			expect(fs.existsSync(path.join(dir, '.swarm'))).toBe(false);
		});
	}
});

// ---
// Positive controls — the probes really detect their gate's signal when NOT
// disabled, so the disabled assertions above cannot pass vacuously.
// ---

describe('positive controls (no gates config → gates run)', () => {
	test('syntax_check fails a file with a syntax error', async () => {
		const dir = makeProject(undefined, { 'bad.js': BAD_SYNTAX_JS });
		const result = await SECTION_PROBES.syntax_check.run(dir);
		expect(result.verdict).toBe('fail');
	});

	test('placeholder_scan flags a TODO comment', async () => {
		const dir = makeProject(undefined, { 'todo.js': TODO_JS });
		const result = await SECTION_PROBES.placeholder_scan.run(dir);
		expect(result.verdict).toBe('fail');
	});

	test('sast_scan scans the supplied file', async () => {
		const dir = makeProject(undefined, { 'clean.js': CLEAN_JS });
		const result = await SECTION_PROBES.sast_scan.run(dir);
		const summary = result.summary as Record<string, number>;
		expect(summary.files_scanned).toBeGreaterThan(0);
	});

	test('sbom_generate counts manifest components', async () => {
		const dir = makeProject(undefined, { 'package.json': PACKAGE_WITH_DEP });
		const result = await SECTION_PROBES.sbom_generate.run(dir);
		expect(result.components_count).toBeGreaterThan(0);
	});
});

// ---
// Raw-override semantics (plan-critic item 1): only user-written keys apply;
// schema defaults never masquerade as custom user intent.
// ---

function runPlaceholderScan(
	dir: string,
	changedFiles: string[],
	args: Record<string, unknown> = {},
) {
	return invoke(placeholder_scan, { changed_files: changedFiles, ...args })(
		dir,
	);
}

describe('placeholder_scan user-written config fields', () => {
	test('config with only enabled:true keeps built-in string/code scanning (no materialized deny_patterns)', async () => {
		const dir = makeProject(
			{ placeholder_scan: { enabled: true } },
			{ 'stub-string.js': STUB_STRING_JS },
		);
		const result = await runPlaceholderScan(dir, ['stub-string.js']);
		expect(result.verdict).toBe('fail');
		const findings = result.findings as Array<{ rule_id: string }>;
		expect(
			findings.some((f) => f.rule_id === 'placeholder/text-placeholder'),
		).toBe(true);
	});

	test('user-written deny_patterns replace the built-in pattern set', async () => {
		const dir = makeProject(
			{ placeholder_scan: { enabled: true, deny_patterns: ['REPROXYZ'] } },
			{
				'custom.js':
					'// REPROXYZ: custom deny pattern from gates config\nexport const b = 2;\n',
				'stub-string.js': STUB_STRING_JS,
			},
		);
		const result = await runPlaceholderScan(dir, [
			'custom.js',
			'stub-string.js',
		]);
		const findings = result.findings as Array<{
			rule_id: string;
			excerpt: string;
		}>;
		expect(findings.some((f) => f.excerpt.includes('REPROXYZ'))).toBe(true);
		// Custom patterns disable the built-in string/code scanners.
		expect(
			findings.some((f) => f.rule_id === 'placeholder/text-placeholder'),
		).toBe(false);
	});

	test('tool-args deny_patterns take precedence over config deny_patterns', async () => {
		const dir = makeProject(
			{ placeholder_scan: { enabled: true, deny_patterns: ['CFGPAT'] } },
			{
				'argpat.js': '// ARGPAT from tool args\nexport const c = 3;\n',
				'cfgpat.js': '// CFGPAT from config\nexport const d = 4;\n',
			},
		);
		const result = await invoke(placeholder_scan, {
			changed_files: ['argpat.js', 'cfgpat.js'],
			deny_patterns: ['ARGPAT'],
		})(dir);
		const findings = result.findings as Array<{ excerpt: string }>;
		expect(findings.some((f) => f.excerpt.includes('ARGPAT'))).toBe(true);
		expect(findings.some((f) => f.excerpt.includes('CFGPAT'))).toBe(false);
	});

	test('sentinel_allowlist suppresses matching findings only', async () => {
		const dir = makeProject(
			{
				placeholder_scan: {
					enabled: true,
					sentinel_allowlist: ['INTENTIONAL-TODO'],
				},
			},
			{
				'allowed.js':
					'// INTENTIONAL-TODO deliberate placeholder marker\nexport const e = 5;\n',
				'todo.js': TODO_JS,
			},
		);
		const result = await runPlaceholderScan(dir, ['allowed.js', 'todo.js']);
		expect(result.verdict).toBe('fail'); // todo.js still flagged
		const findings = result.findings as Array<{ excerpt: string }>;
		expect(findings).toHaveLength(1);
		expect(findings[0]?.excerpt).toContain('TODO: implement');
	});

	test('allow_globs from config skips matching files', async () => {
		const dir = makeProject(
			{ placeholder_scan: { enabled: true, allow_globs: ['skipped/**'] } },
			{ 'skipped/a.js': TODO_JS, 'todo.js': TODO_JS },
		);
		const result = await runPlaceholderScan(dir, ['skipped/a.js', 'todo.js']);
		const summary = result.summary as Record<string, number>;
		expect(summary.files_with_findings).toBe(1);
		const findings = result.findings as Array<{ path: string }>;
		expect(findings.every((f) => f.path === 'todo.js')).toBe(true);
	});

	test('explicit empty deny_patterns list is ignored; built-in defaults apply', async () => {
		const dir = makeProject(
			{ placeholder_scan: { enabled: true, deny_patterns: [] } },
			{ 'todo.js': TODO_JS, 'stub-string.js': STUB_STRING_JS },
		);
		const result = await runPlaceholderScan(dir, ['todo.js', 'stub-string.js']);
		expect(result.verdict).toBe('fail');
		const findings = result.findings as Array<{ rule_id: string }>;
		expect(findings.some((f) => f.rule_id === 'placeholder/comment-todo')).toBe(
			true,
		);
		expect(
			findings.some((f) => f.rule_id === 'placeholder/text-placeholder'),
		).toBe(true);
	});

	test('malformed allow_globs glob does not crash the scan (fail-closed)', async () => {
		const dir = makeProject(
			{ placeholder_scan: { enabled: true, allow_globs: ['[abc'] } },
			{ 'todo.js': TODO_JS },
		);
		const result = await runPlaceholderScan(dir, ['todo.js']);
		expect(result.verdict).toBe('fail');
		const summary = result.summary as Record<string, number>;
		expect(summary.files_scanned).toBe(1);
	});

	test('max_allowed_findings tolerates findings up to the budget', async () => {
		const files = { 'one.js': TODO_JS, 'two.js': TODO_JS };
		const atBudget = makeProject(
			{ placeholder_scan: { enabled: true, max_allowed_findings: 2 } },
			files,
		);
		const atBudgetResult = await runPlaceholderScan(atBudget, [
			'one.js',
			'two.js',
		]);
		expect(atBudgetResult.verdict).toBe('pass');
		const summary = atBudgetResult.summary as Record<string, number>;
		expect(summary.findings_count).toBe(2);

		const overBudget = makeProject(
			{ placeholder_scan: { enabled: true, max_allowed_findings: 1 } },
			files,
		);
		const overBudgetResult = await runPlaceholderScan(overBudget, [
			'one.js',
			'two.js',
		]);
		expect(overBudgetResult.verdict).toBe('fail');
	});
});

// ---
// quality_budget precedence (D3): args > file > defaults, except the
// file-level enabled:false kill switch (the only gate exposing args.config).
// ---

describe('quality_budget config merge precedence', () => {
	test('file enabled:false wins over args config enabled:true (kill switch)', async () => {
		const dir = makeProject(
			{ quality_budget: { enabled: false } },
			SECTION_PROBES.quality_budget.files,
		);
		const result = await invoke(quality_budget, {
			changed_files: ['src/qb.js'],
			config: { enabled: true },
		})(dir);
		const metrics = result.metrics as { thresholds: { enabled: boolean } };
		expect(metrics.thresholds.enabled).toBe(false);
	});

	test('args config thresholds override file config per field', async () => {
		const dir = makeProject(
			{ quality_budget: { enabled: true, max_complexity_delta: 1 } },
			SECTION_PROBES.quality_budget.files,
		);
		const result = await invoke(quality_budget, {
			changed_files: ['src/qb.js'],
			config: { max_complexity_delta: 99 },
		})(dir);
		const metrics = result.metrics as {
			thresholds: { max_complexity_delta: number };
		};
		expect(metrics.thresholds.max_complexity_delta).toBe(99);
	});

	test('file config thresholds apply when args omit them', async () => {
		const dir = makeProject(
			{ quality_budget: { enabled: true, max_complexity_delta: 7 } },
			SECTION_PROBES.quality_budget.files,
		);
		const result = await SECTION_PROBES.quality_budget.run(dir);
		const metrics = result.metrics as {
			thresholds: { max_complexity_delta: number };
		};
		expect(metrics.thresholds.max_complexity_delta).toBe(7);
	});
});

// --- pre_check_batch: config-disabled gates take the unified skip shapes. ---

describe('pre_check_batch honors gates.sast_scan/quality_budget.enabled:false', () => {
	test('sast_scan.ran === false + sast_skipped; quality_budget returns the disabled result', async () => {
		const dir = makeProject(
			{ sast_scan: { enabled: false }, quality_budget: { enabled: false } },
			{ 'clean.js': CLEAN_JS },
		);
		const result = await invoke(pre_check_batch, {
			directory: dir,
			files: ['clean.js'],
		})(dir);
		expect(result.sast_skipped).toBe(true);
		expect((result.sast_scan as Record<string, unknown>).ran).toBe(false);
		expect(result.gates_passed).toBe(true);
		const qb = result.quality_budget as {
			ran: boolean;
			result?: { metrics?: { thresholds?: { enabled: boolean } } };
		};
		expect(qb.ran).toBe(true);
		expect(qb.result?.metrics?.thresholds?.enabled).toBe(false);
	});
});

