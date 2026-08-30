import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildConfigDocsSection,
	CONFIG_DOCS_MARKER_BEGIN,
	CONFIG_DOCS_MARKER_END,
	CONFIG_SCHEMA_CANONICAL_URL,
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
});
