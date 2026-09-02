#!/usr/bin/env bun
/**
 * Config artifact generator — issue #1663.
 *
 * Single schema-walk that produces BOTH derived artifacts of
 * `PluginConfigSchema` (src/config/schema.ts):
 *
 *   1. `opencode-swarm.schema.json` (repo root) — the JSON Schema shipped in
 *      the npm package so editors can validate/autocomplete user config files
 *      via a `$schema` reference.
 *   2. The marker-delimited "Top-level configuration keys" reference section
 *      inside `docs/configuration.md`.
 *
 * Drift enforcement: `scripts/drift-check.ts` imports the same functions
 * (`serializeConfigSchema`, `buildConfigDocsSection`) and fails when either
 * checked-in artifact no longer matches regeneration — so editing
 * `src/config/schema.ts` without rerunning this script is caught in CI.
 *
 * The build script reruns this generator (`bun run build` step 2) so the
 * shipped schema artifact always matches source even if a contributor forgot
 * to regenerate; the checked-in copies remain authoritative for the drift
 * gate. Nothing here runs on the plugin init path (AGENTS.md invariant 1).
 *
 * Usage: bun run scripts/generate-config-schema.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PluginConfigSchema } from '../src/config/schema';

export const CONFIG_SCHEMA_RELATIVE_PATH = 'opencode-swarm.schema.json';
export const CONFIG_DOCS_RELATIVE_PATH = 'docs/configuration.md';

// ASCII-only markers: the drift detector and the generator must byte-match
// them, so avoid anything an editor might "helpfully" transform.
export const CONFIG_DOCS_MARKER_BEGIN =
	'<!-- opencode-swarm: begin generated top-level-config-keys (regenerate: bun run scripts/generate-config-schema.ts) -->';
export const CONFIG_DOCS_MARKER_END =
	'<!-- opencode-swarm: end generated top-level-config-keys -->';

/**
 * Unversioned canonical URL of the published schema (any published version).
 * Used as the generated artifact's `$id` and in documentation. This is a
 * DIFFERENT convention from `CONFIG_SCHEMA_REF` in src/config/project-init.ts,
 * which writes a VERSION-pinned URL into user config files: a config file is
 * validated by the schema of the plugin version that authored it (no release
 * race), while this unversioned URL always resolves to the latest published
 * schema. Both resolve against the same file in every published package.
 */
export const CONFIG_SCHEMA_CANONICAL_URL =
	'https://unpkg.com/opencode-swarm/opencode-swarm.schema.json';

type JsonSchemaObject = {
	$schema?: string;
	$id?: string;
	title?: string;
	description?: string;
	type?: string | string[];
	properties?: Record<string, JsonSchemaProperty>;
	required?: string[];
	additionalProperties?: boolean | JsonSchemaProperty;
	[key: string]: unknown;
};

type JsonSchemaProperty = {
	type?: string | string[];
	enum?: unknown[];
	default?: unknown;
	description?: string;
	additionalProperties?: boolean | JsonSchemaProperty;
	propertyNames?: unknown;
	anyOf?: JsonSchemaProperty[];
	oneOf?: JsonSchemaProperty[];
	[key: string]: unknown;
};

function asSchemaRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Zod's JSON-schema emitter currently omits the closing tuple bounds for
 * `z.tuple([z.string(), z.string()])`. Restore those bounds in the shipped
 * authoring schema so editor validation remains aligned with runtime Zod.
 */
function restoreAdversarialPairTupleBounds(schema: JsonSchemaObject): void {
	const adversarial = asSchemaRecord(
		schema.properties?.adversarial_detection,
	);
	const properties = asSchemaRecord(adversarial?.properties);
	const pairs = asSchemaRecord(properties?.pairs);
	const pairItems = asSchemaRecord(pairs?.items);
	if (
		pairItems &&
		Array.isArray(pairItems.prefixItems) &&
		pairItems.prefixItems.length === 2
	) {
		pairItems.items = false;
		pairItems.minItems = 2;
		pairItems.maxItems = 2;
	}
}

/**
 * Build the JSON Schema document for `opencode-swarm.json`.
 *
 * `io: 'input'` is mandatory: several fields (e.g. `default_agent`) use
 * `.transform()`, which zod cannot represent in output mode — the input shape
 * is also the correct authoring surface for a hand-edited file.
 *
 * One intentional divergence from runtime semantics: the runtime zod schema is
 * not strict at the root (unknown top-level keys are silently stripped by the
 * loader, which also warns — see loader.ts), but this artifact sets
 * `additionalProperties: false` so editors flag top-level typos at edit time.
 */
export function buildConfigJsonSchema(): JsonSchemaObject {
	const generated = z.toJSONSchema(PluginConfigSchema, {
		io: 'input',
	}) as JsonSchemaObject;
	restoreAdversarialPairTupleBounds(generated);
	generated.additionalProperties = false;
	return {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		$id: CONFIG_SCHEMA_CANONICAL_URL,
		title: 'opencode-swarm plugin configuration',
		description:
			'Configuration for the opencode-swarm plugin, validated from ~/.config/opencode/opencode-swarm.json and .opencode/opencode-swarm.json. Generated from PluginConfigSchema (src/config/schema.ts) by scripts/generate-config-schema.ts - do not hand-edit. Editor note: unknown top-level keys are flagged here as authoring advice; at runtime they are stripped with a warning. Sections with additionalProperties: false (strict) fail config load on unknown nested keys.',
		...generated,
	};
}

/** Canonical serialization of the generated schema (stable key order, LF, trailing newline). */
export function serializeConfigSchema(): string {
	return `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`;
}

/**
 * Plain type name for a union branch — no record/strict annotation, which is
 * noise when the top-level key is the union, not the branch.
 */
function summarizeBranchType(prop: JsonSchemaProperty): string {
	if (Array.isArray(prop.enum)) return prop.enum.map((v) => String(v)).join(' \\| ');
	const type = prop.type;
	if (Array.isArray(type)) return type.join(' \\| ');
	if (type === 'object') return 'object';
	return type ?? 'unknown';
}

function summarizeType(prop: JsonSchemaProperty): string {
	if (Array.isArray(prop.enum)) {
		return `enum(${prop.enum.map((v) => String(v)).join(' \\| ')})`;
	}
	const type = prop.type;
	if (Array.isArray(type)) return type.join(' \\| ');
	if (type === 'object') {
		const isRecord =
			prop.additionalProperties !== undefined &&
			prop.additionalProperties !== false;
		if (isRecord) return 'record<string, object>';
		if (prop.additionalProperties === false) return 'object (strict)';
		return 'object';
	}
	if (type !== undefined) return type;
	// Zod unions (z.union → anyOf, z.discriminatedUnion → oneOf) carry no
	// top-level `type`; summarize the branches instead of printing "unknown".
	const branches = Array.isArray(prop.anyOf)
		? prop.anyOf
		: Array.isArray(prop.oneOf)
			? prop.oneOf
			: undefined;
	if (branches) {
		const rendered = branches
			.map(summarizeBranchType)
			.filter((branch) => branch !== 'unknown');
		if (rendered.length > 0) return [...new Set(rendered)].join(' \\| ');
		return 'union';
	}
	return 'unknown';
}

function summarizeDefault(value: unknown): string {
	if (value === undefined) return '—';
	if (value === null) return 'null';
	if (typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return value.length === 0 ? '[]' : '[ … ]';
	return Object.keys(value).length === 0 ? '{}' : '{ … }';
}

/**
 * Escape a description for a markdown table cell (pipes and newlines).
 * Exported for tests — the pipe branch is dead until a future `.describe()`
 * contains a `|`, and this test pins the contract so that future description
 * cannot silently break the table.
 */
export function escapeCell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Build the generated docs section (including markers) for
 * docs/configuration.md. Derived from the same schema walk as the JSON
 * Schema so the two artifacts cannot disagree.
 */
export function buildConfigDocsSection(): string {
	const schema = buildConfigJsonSchema();
	const properties = schema.properties ?? {};
	const lines: string[] = [];
	lines.push(CONFIG_DOCS_MARKER_BEGIN);
	lines.push('');
	lines.push('## Top-level configuration keys');
	lines.push('');
	lines.push(
		'Generated from `PluginConfigSchema` (`src/config/schema.ts`) - do not edit inside the markers. Regenerate with `bun run scripts/generate-config-schema.ts`. See also the topic sections below and the shipped JSON Schema (`opencode-swarm.schema.json`, referenced via `$schema` for editor validation).',
	);
	lines.push('');
	lines.push('| Key | Type | Default | Description |');
	lines.push('| --- | ---- | ------- | ----------- |');
	for (const [key, prop] of Object.entries(properties)) {
		lines.push(
			`| \`${key}\` | ${summarizeType(prop)} | ${summarizeDefault(
				prop.default,
			)} | ${escapeCell(prop.description ?? '')} |`,
		);
	}
	lines.push('');
	lines.push(
		'Sections marked `(strict)` reject unknown nested keys at config load time - a typo there makes the loader fall back to safe defaults with a startup warning. All other sections silently ignore unknown nested keys.',
	);
	lines.push('');
	lines.push(CONFIG_DOCS_MARKER_END);
	return lines.join('\n');
}

/**
 * Replace the marker-delimited generated section inside a configuration.md
 * document. Throws when the markers are absent so callers cannot silently
 * drop the reference table.
 */
export function replaceGeneratedDocsSection(doc: string): string {
	const beginIndex = doc.indexOf(CONFIG_DOCS_MARKER_BEGIN);
	const endIndex = doc.indexOf(CONFIG_DOCS_MARKER_END);
	if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
		throw new Error(
			`docs/configuration.md is missing the generated config-keys markers (${CONFIG_DOCS_MARKER_BEGIN} / ${CONFIG_DOCS_MARKER_END})`,
		);
	}
	const section = buildConfigDocsSection();
	const afterEnd = endIndex + CONFIG_DOCS_MARKER_END.length;
	return doc.slice(0, beginIndex) + section + doc.slice(afterEnd);
}

export interface ConfigArtifactRefreshResult {
	schemaPath: string;
	docsPath: string;
	schemaChanged: boolean;
	docsChanged: boolean;
}

function readFileIfExists(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, 'utf-8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw err;
	}
}

/**
 * Regenerate both artifacts under `root` (repo root). Idempotent: when the
 * checked-in content already matches, nothing is written.
 *
 * Writes use plain `fs.writeFileSync` rather than the atomic-write helpers in
 * src/utils/atomic-write.ts on purpose: those are scoped to bounded
 * `.swarm/` production state (`atomicWriteSwarmFile` refuses non-.swarm
 * targets), while these artifacts are deterministic dev/build outputs that a
 * re-run regenerates byte-for-byte if a crash leaves one truncated.
 */
export function refreshConfigArtifacts(root: string): ConfigArtifactRefreshResult {
	const schemaPath = path.join(root, CONFIG_SCHEMA_RELATIVE_PATH);
	const docsPath = path.join(root, CONFIG_DOCS_RELATIVE_PATH);

	const schemaContent = serializeConfigSchema();
	const previousSchema = readFileIfExists(schemaPath);
	if (previousSchema !== schemaContent) {
		fs.writeFileSync(schemaPath, schemaContent, 'utf-8');
	}

	const previousDocs = readFileIfExists(docsPath);
	if (previousDocs === undefined) {
		throw new Error(`docs source not found at ${docsPath}`);
	}
	const nextDocs = replaceGeneratedDocsSection(previousDocs);
	if (nextDocs !== previousDocs) {
		fs.writeFileSync(docsPath, nextDocs, 'utf-8');
	}

	return {
		schemaPath,
		docsPath,
		schemaChanged: previousSchema !== schemaContent,
		docsChanged: nextDocs !== previousDocs,
	};
}

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);

if (import.meta.main) {
	const result = refreshConfigArtifacts(REPO_ROOT);
	console.log(
		`config schema: ${result.schemaChanged ? 'regenerated' : 'unchanged'} (${result.schemaPath})`,
	);
	console.log(
		`config docs:   ${result.docsChanged ? 'regenerated' : 'unchanged'} (${result.docsPath})`,
	);
}
