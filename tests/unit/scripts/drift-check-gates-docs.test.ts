/**
 * Issue #2524 — tests for the gates docs↔schema↔reader drift detector
 * (scripts/drift-check-gates-docs.ts).
 *
 * Every one-way gap the issue calls out must FAIL the detector:
 *   - a documented gates key with no schema entry,
 *   - a schema key with no documentation,
 *   - a registry key that drifted from the schema,
 *   - a schema section with no registered reader / a missing reader file.
 * The parser must also ignore the unrelated `guardrails.qa_gates` JSON
 * examples that live outside the gates section.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DETECTORS } from '../../../scripts/drift-check';
import {
	compareRegistryWithSchema,
	detectGatesConfigDrift,
	extractDocumentedGateKeys,
	extractGatesDocsRegion,
	GATES_DOCS_RELATIVE_PATH,
} from '../../../scripts/drift-check-gates-docs';
import {
	GATE_CONFIG_READERS,
	GATE_SECTION_SCHEMAS,
} from '../../../src/config/schema';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const SECTION_NAMES = Object.keys(GATE_SECTION_SCHEMAS);

const REPO_DOCS = path.resolve(
	__dirname,
	'../../../',
	GATES_DOCS_RELATIVE_PATH,
);

let fixture: { dir: string; cleanup: () => void } | undefined;

beforeEach(() => {
	fixture = createSafeTestDir('gates-drift-test-');
});

afterEach(() => {
	fixture?.cleanup();
	fixture = undefined;
});

/** Build a fixture tree: a docs file (default: the real repo docs) under a temp root. */
function makeFixture(docsContent?: string): string {
	const { dir } = fixture ?? {};
	if (!dir) throw new Error('makeFixture called outside a test body');
	fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, GATES_DOCS_RELATIVE_PATH),
		docsContent ?? fs.readFileSync(REPO_DOCS, 'utf-8'),
	);
	return dir;
}

/** Materialize every registered reader file in the fixture (real content). */
function stubReaderFiles(root: string): void {
	for (const readers of Object.values(GATE_CONFIG_READERS)) {
		for (const reader of readers) {
			const absolute = path.resolve(__dirname, '../../../', reader);
			const target = path.join(root, reader);
			if (fs.existsSync(target)) continue;
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, fs.readFileSync(absolute, 'utf-8'));
		}
	}
}

describe('extractDocumentedGateKeys parsing rules', () => {
	test('collects section and section.field keys from JSON gates blocks and option tables', () => {
		const region = [
			'## Quality Gates Configuration (v6.9.0)',
			'```json',
			'{ "gates": { "syntax_check": { "enabled": false } } }',
			'```',
			'#### placeholder_scan',
			'| `deny_patterns` | string[] | defaults | custom patterns |',
			'| `enabled` | boolean | `true` | run |',
		].join('\n');
		const keys = extractDocumentedGateKeys(region, SECTION_NAMES);
		expect([...keys].sort()).toEqual([
			'placeholder_scan.deny_patterns',
			'placeholder_scan.enabled',
			'syntax_check',
			'syntax_check.enabled',
		]);
	});

	test('ignores JSON without a top-level gates wrapper (guardrails.qa_gates shape)', () => {
		const region = [
			'## Quality Gates Configuration (v6.9.0)',
			'```json',
			'{ "qa_gates": { "required_tools": ["diff"] } }',
			'```',
		].join('\n');
		expect(extractDocumentedGateKeys(region, SECTION_NAMES)).toEqual(new Set());
	});

	test('ignores table rows under unknown sub-headings and blockquote mentions', () => {
		const region = [
			'## Quality Gates Configuration (v6.9.0)',
			'#### some_other_section',
			'| `phantom_key` | string | x | not a gate |',
			'> Migration note: `patterns` and `block_on_empty_functions` were ghosts.',
		].join('\n');
		expect(extractDocumentedGateKeys(region, SECTION_NAMES)).toEqual(new Set());
	});

	test('extractGatesDocsRegion bounds at the next ## heading', () => {
		const doc = [
			'# Install',
			'## Guardrails Configuration',
			'qa_gates prose',
			'## Quality Gates Configuration (v6.9.0)',
			'gates prose',
			'### Sub',
			'## Slash Commands',
			'slash prose',
		].join('\n');
		const region = extractGatesDocsRegion(doc);
		expect(region).toContain('gates prose');
		expect(region).not.toContain('qa_gates prose');
		expect(region).not.toContain('slash prose');
	});
});

describe('compareRegistryWithSchema', () => {
	const schema = new Map([
		['syntax_check', new Set(['enabled'])],
		['placeholder_scan', new Set(['enabled', 'deny_patterns'])],
	]);

	test('clean registry produces no findings', () => {
		expect(
			compareRegistryWithSchema(
				{
					syntax_check: ['enabled'],
					placeholder_scan: ['enabled', 'deny_patterns'],
				},
				schema,
			),
		).toEqual([]);
	});

	test('missing section, missing field, and extra registry key each fail', () => {
		const findings = compareRegistryWithSchema(
			{ placeholder_scan: ['enabled'], ghost_section: ['enabled'] },
			schema,
		);
		expect(findings).toHaveLength(3);
		expect(findings.every((f) => f.severity === 'error')).toBe(true);
		expect(
			findings.some((f) =>
				f.message.includes('missing the schema section "syntax_check"'),
			),
		).toBe(true);
		expect(
			findings.some((f) =>
				f.message.includes('"gates.placeholder_scan.deny_patterns"'),
			),
		).toBe(true);
		expect(findings.some((f) => f.message.includes('"ghost_section"'))).toBe(
			true,
		);
	});
});

describe('detectGatesConfigDrift on fixture trees', () => {
	test('the real (edited) installation.md is clean', () => {
		const root = makeFixture();
		stubReaderFiles(root);
		expect(detectGatesConfigDrift(root)).toEqual([]);
	});

	test('documented key with no schema entry fails', () => {
		const real = fs.readFileSync(REPO_DOCS, 'utf-8');
		const sabotaged = real.replace(
			'"max_allowed_findings": 1',
			'"max_allowed_findings": 1, "patterns": ["TODO"]',
		);
		const root = makeFixture(sabotaged);
		stubReaderFiles(root);
		const findings = detectGatesConfigDrift(root);
		expect(
			findings.some(
				(f) =>
					f.severity === 'error' &&
					f.message.includes(
						'"placeholder_scan.patterns" does not exist in the schema',
					),
			),
		).toBe(true);
	});

	test('schema key missing from docs fails', () => {
		const real = fs.readFileSync(REPO_DOCS, 'utf-8');
		const sabotaged = real
			.split('\n')
			.filter(
				(line) =>
					!line.includes('`sentinel_allowlist`') &&
					!line.includes('"sentinel_allowlist"'),
			)
			.join('\n');
		const root = makeFixture(sabotaged);
		stubReaderFiles(root);
		expect(
			detectGatesConfigDrift(root).some(
				(f) =>
					f.severity === 'error' &&
					f.message.includes(
						'"placeholder_scan.sentinel_allowlist" is not documented',
					),
			),
		).toBe(true);
	});

	test('missing reader file fails with an error', () => {
		const root = makeFixture();
		stubReaderFiles(root);
		fs.rmSync(path.join(root, 'src/tools/sbom-generate.ts'));
		expect(
			detectGatesConfigDrift(root).some(
				(f) =>
					f.severity === 'error' &&
					f.message.includes('gates.sbom_generate reader') &&
					f.message.includes('does not exist'),
			),
		).toBe(true);
	});

	test('reader file stripped of its section token trips the warning tripwire', () => {
		const root = makeFixture();
		stubReaderFiles(root);
		const target = path.join(root, 'src/tools/sbom-generate.ts');
		fs.writeFileSync(target, 'export const orphan = 1;\n');
		const findings = detectGatesConfigDrift(root);
		expect(
			findings.some(
				(f) =>
					f.severity === 'warning' &&
					f.message.includes('gates.sbom_generate reader'),
			),
		).toBe(true);
		// The tripwire is advisory only — no error-severity findings.
		expect(findings.some((f) => f.severity === 'error')).toBe(false);
	});

	test('missing gates section heading fails', () => {
		const root = makeFixture('# No gates heading here\n');
		stubReaderFiles(root);
		expect(
			detectGatesConfigDrift(root).some(
				(f) =>
					f.severity === 'error' && f.message.includes('heading not found'),
			),
		).toBe(true);
	});
});

describe('DETECTORS registration', () => {
	test('gates-docs is registered in the drift-check detector list', () => {
		const categories = DETECTORS.map(([name]) => name);
		expect(categories).toContain('gates-docs');
	});

	test('on the real repo tree the detector is clean', () => {
		expect(detectGatesConfigDrift()).toEqual([]);
	});
});
