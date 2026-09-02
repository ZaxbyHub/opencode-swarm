/**
 * Gates docs↔schema↔reader drift detector — issue #2524.
 *
 * The `gates.*` config section was fully inert for years partly because three
 * one-way gaps had no tripwire: docs documented keys the schema never had, the
 * loader's known-key registry was a hand-maintained copy of the schema, and
 * schema sections had readers only in dead code. This detector closes all
 * three gaps:
 *
 *   1. registry↔schema  — GATE_CONFIG_KNOWN_SECTION_KEYS must equal the
 *                         GATE_SECTION_SCHEMAS map (both directions). Guards
 *                         against the registry being re-hardcoded (the
 *                         `placeholder_scan.sentinel_allowlist` false-strip
 *                         class).
 *   2. docs→schema      — every `gates.<section>[.<field>]` key documented in
 *                         docs/installation.md's Quality Gates section must
 *                         exist in the schema.
 *   3. schema→docs      — every schema section+field must be documented there.
 *   4. schema→reader    — GATE_CONFIG_READERS must cover every schema section
 *                         (error) and each registered reader file must exist
 *                         and mention its section token (error for a missing
 *                         file, warning tripwire for a missing token — the
 *                         dynamic wiring tests in
 *                         tests/unit/tools/gates-config-wiring.test.ts carry
 *                         the real proof that the readers run).
 *
 * Docs parsing rules (deliberately narrow so prose cannot false-positive):
 *   - The parsed region starts at the `## Quality Gates Configuration`
 *     heading and ends at the next `## ` heading.
 *   - JSON code blocks contribute keys only when the parsed object has a
 *     top-level `gates` wrapper (the unrelated `guardrails.qa_gates` examples
 *     elsewhere in the file do not match and sit outside the region anyway).
 *   - Option-table rows (`| \`key\` | …`) contribute keys only under
 *     `#### <section>` sub-headings whose name is a known schema section.
 *     Migration-note blockquotes and inline prose never match.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	GATE_CONFIG_KNOWN_SECTION_KEYS,
	GATE_CONFIG_READERS,
	GATE_SECTION_SCHEMAS,
} from '../src/config/schema';

type DriftSeverity = 'error' | 'warning' | 'notice';

interface DriftFinding {
	category: string;
	severity: DriftSeverity;
	message: string;
	file?: string;
}

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);

export const GATES_DOCS_RELATIVE_PATH = 'docs/installation.md';
const GATES_SECTION_HEADING = '## Quality Gates Configuration';

/** Schema-side sections and fields, from the single-source map. */
export function collectSchemaGateKeys(): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (const [section, schema] of Object.entries(GATE_SECTION_SCHEMAS)) {
		map.set(section, new Set(Object.keys(schema.shape)));
	}
	return map;
}

/**
 * Slice the Quality Gates configuration region out of installation.md:
 * from the `## Quality Gates Configuration` heading to the next `## `
 * heading (exclusive). Returns the raw region text, or undefined when the
 * heading is missing.
 */
export function extractGatesDocsRegion(doc: string): string | undefined {
	const lines = doc.split('\n');
	const start = lines.findIndex((line) =>
		line.startsWith(GATES_SECTION_HEADING),
	);
	if (start === -1) return undefined;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i].startsWith('## ')) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join('\n');
}

/**
 * Extract documented `section` and `section.field` keys from the gates docs
 * region. See the header comment for the parsing rules.
 */
export function extractDocumentedGateKeys(
	region: string,
	knownSections: readonly string[],
): Set<string> {
	const documented = new Set<string>();
	const known = new Set(knownSections);

	// JSON code blocks with a top-level `gates` wrapper.
	const jsonBlocks = region.match(/```json[\s\S]*?```/g) ?? [];
	for (const block of jsonBlocks) {
		const body = block.replace(/^```json\s*/, '').replace(/\s*```$/, '');
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			continue;
		}
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			continue;
		}
		const gates = (parsed as Record<string, unknown>).gates;
		if (typeof gates !== 'object' || gates === null || Array.isArray(gates)) {
			continue;
		}
		for (const [section, value] of Object.entries(
			gates as Record<string, unknown>,
		)) {
			documented.add(section);
			if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
				for (const field of Object.keys(value as Record<string, unknown>)) {
					documented.add(`${section}.${field}`);
				}
			}
		}
	}

	// Option-table rows under `#### <section>` sub-headings.
	let currentSection: string | null = null;
	for (const line of region.split('\n')) {
		if (line.startsWith('#### ')) {
			const name = line.slice(5).trim();
			currentSection = known.has(name) ? name : null;
			continue;
		}
		if (line.startsWith('### ')) {
			currentSection = null;
			continue;
		}
		const tableRow = line.match(/^\| `([a-z0-9_]+)` \|/);
		if (tableRow && currentSection) {
			documented.add(`${currentSection}.${tableRow[1]}`);
		}
	}

	return documented;
}

/** Registry↔schema comparison over injectable inputs (tests pass fakes). */
export function compareRegistryWithSchema(
	registry: Record<string, readonly string[]>,
	schemaKeys: Map<string, Set<string>>,
): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const category = 'gates-docs';
	for (const [section, fields] of schemaKeys) {
		const registryFields = registry[section];
		if (!registryFields) {
			findings.push({
				category,
				severity: 'error',
				file: 'src/config/schema.ts',
				message: `GATE_CONFIG_KNOWN_SECTION_KEYS is missing the schema section "${section}" — the loader would strip every key under gates.${section} as unknown`,
			});
			continue;
		}
		for (const field of fields) {
			if (!registryFields.includes(field)) {
				findings.push({
					category,
					severity: 'error',
					file: 'src/config/schema.ts',
					message: `GATE_CONFIG_KNOWN_SECTION_KEYS is missing the schema key "gates.${section}.${field}" — the loader would strip it as unknown`,
				});
			}
		}
	}
	for (const section of Object.keys(registry)) {
		if (!schemaKeys.has(section)) {
			findings.push({
				category,
				severity: 'error',
				file: 'src/config/schema.ts',
				message: `GATE_CONFIG_KNOWN_SECTION_KEYS lists section "${section}" that does not exist in GATE_SECTION_SCHEMAS`,
			});
			continue;
		}
		for (const field of registry[section]) {
			if (!schemaKeys.get(section)?.has(field)) {
				findings.push({
					category,
					severity: 'error',
					file: 'src/config/schema.ts',
					message: `GATE_CONFIG_KNOWN_SECTION_KEYS lists key "gates.${section}.${field}" that does not exist in the schema`,
				});
			}
		}
	}
	return findings;
}

/** Reader-registry checks. Reader paths are repo-relative. */
export function collectReaderFindings(
	root: string,
	schemaKeys: Map<string, Set<string>>,
): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const category = 'gates-docs';

	for (const section of schemaKeys.keys()) {
		const readers = GATE_CONFIG_READERS[section];
		if (!readers) {
			findings.push({
				category,
				severity: 'error',
				file: 'src/config/schema.ts',
				message: `GATE_CONFIG_READERS has no entry for schema section "${section}" — a gates.${section} key with no registered reader is the #2524 defect restated`,
			});
		}
	}
	for (const [section, readers] of Object.entries(GATE_CONFIG_READERS)) {
		if (!schemaKeys.has(section)) {
			findings.push({
				category,
				severity: 'error',
				file: 'src/config/schema.ts',
				message: `GATE_CONFIG_READERS lists section "${section}" that does not exist in the schema`,
			});
			continue;
		}
		for (const readerPath of readers) {
			const absolute = path.join(root, readerPath);
			let content: string;
			try {
				content = fs.readFileSync(absolute, 'utf-8');
			} catch {
				findings.push({
					category,
					severity: 'error',
					file: readerPath,
					message: `registered gates.${section} reader ${readerPath} does not exist`,
				});
				continue;
			}
			// Tripwire only (warning): the schema-driven wiring tests prove the
			// readers actually consult the config; this just catches wholesale
			// deletion of the access from the registered module. The section
			// token plus the config seam name is the signal — requiring a
			// literal "gates" substring would false-positive on modules wired
			// through loadGateOverrides().
			if (
				!content.includes(section) ||
				!(content.includes('gates') || content.includes('loadGateOverrides'))
			) {
				findings.push({
					category,
					severity: 'warning',
					file: readerPath,
					message: `registered gates.${section} reader ${readerPath} no longer mentions "${section}"/gate-config access — verify the wiring (see tests/unit/tools/gates-config-wiring.test.ts)`,
				});
			}
		}
	}
	return findings;
}

export function detectGatesConfigDrift(
	root: string = REPO_ROOT,
): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const category = 'gates-docs';
	const docsPath = path.join(root, GATES_DOCS_RELATIVE_PATH);
	const schemaKeys = collectSchemaGateKeys();

	// 1. registry ↔ schema
	findings.push(
		...compareRegistryWithSchema(
			GATE_CONFIG_KNOWN_SECTION_KEYS as Record<string, readonly string[]>,
			schemaKeys,
		),
	);

	// 2 + 3. docs ↔ schema
	let doc: string;
	try {
		doc = fs.readFileSync(docsPath, 'utf-8');
	} catch {
		findings.push({
			category,
			severity: 'error',
			file: GATES_DOCS_RELATIVE_PATH,
			message: `${GATES_DOCS_RELATIVE_PATH} not found — cannot verify the gates docs↔schema triangle`,
		});
		return findings;
	}
	const region = extractGatesDocsRegion(doc);
	if (region === undefined) {
		findings.push({
			category,
			severity: 'error',
			file: GATES_DOCS_RELATIVE_PATH,
			message: `"${GATES_SECTION_HEADING}" heading not found in ${GATES_DOCS_RELATIVE_PATH} — the gates docs section must stay under that heading for drift detection`,
		});
		return findings;
	}
	const documented = extractDocumentedGateKeys(region, [
		...schemaKeys.keys(),
	]);
	const schemaKeySet = new Set<string>();
	for (const [section, fields] of schemaKeys) {
		schemaKeySet.add(section);
		for (const field of fields) schemaKeySet.add(`${section}.${field}`);
	}

	for (const key of [...documented].sort()) {
		if (!schemaKeySet.has(key)) {
			findings.push({
				category,
				severity: 'error',
				file: GATES_DOCS_RELATIVE_PATH,
				message: `documented gates key "${key}" does not exist in the schema — remove it from the docs or add it to GATE_SECTION_SCHEMAS (issue #2524)`,
			});
		}
	}
	for (const key of [...schemaKeySet].sort()) {
		if (!documented.has(key)) {
			findings.push({
				category,
				severity: 'error',
				file: GATES_DOCS_RELATIVE_PATH,
				message: `schema gates key "${key}" is not documented in ${GATES_DOCS_RELATIVE_PATH}'s Quality Gates section — document it or remove it from the schema`,
			});
		}
	}

	// 4. schema → reader
	findings.push(...collectReaderFindings(root, schemaKeys));

	return findings;
}
