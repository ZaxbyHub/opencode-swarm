import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildConfigDocsSection,
	CONFIG_DOCS_MARKER_BEGIN,
	CONFIG_DOCS_MARKER_END,
	CONFIG_SCHEMA_CANONICAL_URL,
	escapeCell,
	refreshConfigArtifacts,
	replaceGeneratedDocsSection,
	serializeConfigSchema,
} from '../../../scripts/generate-config-schema';
import { PluginConfigSchema } from '../../../src/config/schema';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #1663 — the generator is the single schema-walk behind both derived
 * artifacts. These tests pin its contract: deterministic serialization, full
 * key coverage, marker-delimited docs refresh, and idempotency.
 */

describe('generate-config-schema — JSON Schema artifact', () => {
	test('serializes to parseable JSON with the draft 2020-12 envelope', () => {
		const parsed = JSON.parse(serializeConfigSchema()) as Record<
			string,
			unknown
		>;
		expect(parsed.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
		expect(parsed.$id).toBe(CONFIG_SCHEMA_CANONICAL_URL);
		expect(typeof parsed.title).toBe('string');
		expect(typeof parsed.description).toBe('string');
	});

	test('covers every PluginConfigSchema top-level key plus $schema', () => {
		const parsed = JSON.parse(serializeConfigSchema()) as {
			properties: Record<string, unknown>;
		};
		for (const key of Object.keys(PluginConfigSchema.shape)) {
			expect(parsed.properties[key], `key ${key}`).toBeDefined();
		}
	});

	test('flags unknown top-level keys (additionalProperties: false) as editor advice', () => {
		const parsed = JSON.parse(serializeConfigSchema()) as {
			additionalProperties: unknown;
		};
		expect(parsed.additionalProperties).toBe(false);
	});

	test('marks strict sections so editors flag nested typos', () => {
		const parsed = JSON.parse(serializeConfigSchema()) as {
			properties: Record<string, { additionalProperties?: unknown }>;
		};
		expect(
			parsed.properties.council?.additionalProperties,
			'council is a .strict() schema',
		).toBe(false);
	});

	test('preserves exact two-string tuple bounds for adversarial pairs', () => {
		const parsed = JSON.parse(serializeConfigSchema()) as {
			properties: {
				adversarial_detection?: {
					properties?: {
						pairs?: {
							items?: {
								items?: unknown;
								minItems?: number;
								maxItems?: number;
							};
						};
					};
				};
			};
		};
		const pairItems =
			parsed.properties.adversarial_detection?.properties?.pairs?.items;
		expect(pairItems?.items).toBe(false);
		expect(pairItems?.minItems).toBe(2);
		expect(pairItems?.maxItems).toBe(2);
	});

	test('deterministic: two serializations are byte-identical', () => {
		expect(serializeConfigSchema()).toBe(serializeConfigSchema());
	});
});

describe('generate-config-schema — docs section artifact', () => {
	test('section is marker-delimited and covers every top-level key', () => {
		const section = buildConfigDocsSection();
		expect(section.startsWith(CONFIG_DOCS_MARKER_BEGIN)).toBe(true);
		expect(section.endsWith(CONFIG_DOCS_MARKER_END)).toBe(true);
		expect(section).toContain('## Top-level configuration keys');
		for (const key of Object.keys(PluginConfigSchema.shape)) {
			expect(section.includes(`\`${key}\``), `key ${key}`).toBe(true);
		}
	});

	test('section marks strict sections and explains the failure mode', () => {
		const section = buildConfigDocsSection();
		expect(section).toContain('object (strict)');
		expect(section).toContain('`council`');
	});

	// Pins for summarizeType's rendered Type cells — without these, a
	// regression of the union/enum/record branches (e.g. back to the literal
	// word "unknown") passes every other test.
	test('Type cells render union, enum, and record shapes exactly', () => {
		const section = buildConfigDocsSection();
		expect(section).toContain('`auto_select_architect` | boolean \\| string |');
		expect(section).toContain(
			'`execution_mode` | enum(strict \\| balanced \\| fast) |',
		);
		expect(section).toContain('`agents` | record<string, object> |');
		expect(section).not.toContain('| unknown |');
	});

	test('$schema property keeps its plain string type in the emitted schema', () => {
		// `.catch(undefined)` must not distort the emitted editor-facing type.
		const parsed = JSON.parse(serializeConfigSchema()) as {
			properties: Record<string, { type?: string }>;
		};
		expect(parsed.properties.$schema?.type).toBe('string');
	});
});

describe('generate-config-schema — refresh + replace', () => {
	let root: string;

	beforeEach(() => {
		root = canonicalMkdtemp('config-schema-gen-');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function writeDocs(content: string): void {
		fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
		fs.writeFileSync(path.join(root, 'docs', 'configuration.md'), content);
	}

	test('replaceGeneratedDocsSection swaps only the marker-delimited span', () => {
		const doc = `# before\n${CONFIG_DOCS_MARKER_BEGIN}\nstale content\n${CONFIG_DOCS_MARKER_END}\n# after\n`;
		const next = replaceGeneratedDocsSection(doc);
		expect(next.startsWith('# before\n')).toBe(true);
		expect(next.endsWith('\n# after\n')).toBe(true);
		expect(next).not.toContain('stale content');
		expect(next).toContain('## Top-level configuration keys');
	});

	test('replaceGeneratedDocsSection throws when markers are missing', () => {
		expect(() => replaceGeneratedDocsSection('# no markers here\n')).toThrow(
			/markers/,
		);
	});

	test('refreshConfigArtifacts writes both artifacts and is idempotent', () => {
		writeDocs(
			`# Configuration\n\n${CONFIG_DOCS_MARKER_BEGIN}\n${CONFIG_DOCS_MARKER_END}\n`,
		);
		const first = refreshConfigArtifacts(root);
		expect(first.schemaChanged).toBe(true);
		expect(first.docsChanged).toBe(true);
		expect(
			fs.readFileSync(path.join(root, 'opencode-swarm.schema.json'), 'utf-8'),
		).toBe(serializeConfigSchema());

		const second = refreshConfigArtifacts(root);
		expect(second.schemaChanged).toBe(false);
		expect(second.docsChanged).toBe(false);
	});

	test('refreshConfigArtifacts throws when the docs source is missing', () => {
		expect(() => refreshConfigArtifacts(root)).toThrow(/configuration\.md/);
	});

	test('replaceGeneratedDocsSection pins first-BEGIN-to-first-END span on duplicated markers', () => {
		const doc =
			`# top\n${CONFIG_DOCS_MARKER_BEGIN}\nstale\n${CONFIG_DOCS_MARKER_END}\n` +
			`${CONFIG_DOCS_MARKER_BEGIN}\norphaned\n${CONFIG_DOCS_MARKER_END}\n`;
		const next = replaceGeneratedDocsSection(doc);
		// First span is swapped for the generated section; the second marker
		// pair is left verbatim for the drift detector to flag.
		expect(next).toContain('## Top-level configuration keys');
		expect(next).toContain('orphaned');
		expect(next.split(CONFIG_DOCS_MARKER_BEGIN).length - 1).toBe(2);
	});

	test('refreshConfigArtifacts normalizes a CRLF docs artifact (section becomes LF, rest preserved)', () => {
		writeDocs(
			`# Configuration\r\n\r\n${CONFIG_DOCS_MARKER_BEGIN}\r\n${CONFIG_DOCS_MARKER_END}\r\n`,
		);
		const first = refreshConfigArtifacts(root);
		expect(first.docsChanged).toBe(true);
		const after = fs.readFileSync(
			path.join(root, 'docs', 'configuration.md'),
			'utf-8',
		);
		// Generated span is LF; hand-written content outside the span keeps
		// the CRLF line endings it was checked out with.
		expect(after).toContain('## Top-level configuration keys');
		expect(after.includes(`${CONFIG_DOCS_MARKER_BEGIN}\r`)).toBe(false);
		expect(after.startsWith('# Configuration\r\n')).toBe(true);

		// Second run is idempotent — the LF section now matches expectation.
		const second = refreshConfigArtifacts(root);
		expect(second.docsChanged).toBe(false);
	});
});

describe('generate-config-schema — escapeCell', () => {
	test('escapes pipes and flattens newlines', () => {
		expect(escapeCell('a | b')).toBe('a \\| b');
		expect(escapeCell('line1\nline2')).toBe('line1 line2');
		expect(escapeCell('plain')).toBe('plain');
	});
});
