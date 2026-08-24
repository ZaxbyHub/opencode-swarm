#!/usr/bin/env bun
/**
 * CI enforcement for issue #507 — tool registration coherence.
 *
 * Belt-and-braces runtime check on top of the compile-time guarantees:
 *   - ToolMeta requires description + agents (a missing one is a TS error).
 *   - manifest.ts `satisfies Record<ToolName, () => ToolDefinition>` makes the
 *     handler set exhaustive vs the metadata keys (a missing handler is a TS error).
 * This script verifies the runtime-derived sets (plugin tool object, TOOL_NAMES,
 * descriptions, AGENT_TOOL_MAP) stay coherent with the metadata, and exits
 * non-zero on any drift.
 *
 * Issue #1781 E4 added a REVERSE-direction check (section 6): every exported
 * `createSwarmTool(...)` binding in `src/tools/**` must have a TOOL_METADATA
 * entry or declare a `@tool-opt-out` JSDoc tag. This catches the `knowledge_ack`
 * class — a fully built + tested tool that was never registered.
 *
 * Issue #1643 added the barrel-export check (section 7): every TOOL_NAMES
 * entry must resolve to a defined export of the src/tools/index.ts barrel.
 * Checks 1–6 never imported the barrel, so a tool missing its barrel export
 * (a surface still required by wiring/registration tests) passed this check.
 *
 * Usage: bun run scripts/check-tool-registration.ts
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_TOOL_MAP } from '../src/config/constants';
import { TOOL_MANIFEST } from '../src/tools/manifest';
import { buildPluginToolObject } from '../src/tools/plugin-registration';
import {
	TOOL_METADATA,
	TOOL_NAME_SET,
	TOOL_NAMES,
	type ToolName,
} from '../src/tools/tool-metadata';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);
const TOOLS_DIR = path.join(REPO_ROOT, 'src', 'tools');

/**
 * Options for {@link collectToolRegistrationErrors}. The barrel record is
 * injectable so the deliberately-missing-export regression test
 * (tests/unit/scripts/check-tool-registration-barrel.test.ts, issue #1643)
 * can exercise check 7 against a mutated copy of the real barrel without
 * touching the working tree.
 */
export interface ToolRegistrationCheckOptions {
	/** Stand-in for the src/tools/index.ts barrel namespace. */
	barrel?: Record<string, unknown>;
}

/**
 * Pure helper for check 7 (issue #1643): return every tool name that does not
 * resolve to a DEFINED export of the barrel. A key that is absent OR whose
 * value is `undefined` counts as missing (`export { x } from './x'` on a
 * module whose `x` binding is undefined must not pass as an export).
 */
export function findMissingBarrelExports(
	toolNames: readonly string[],
	barrel: Record<string, unknown>,
): string[] {
	return toolNames.filter(
		(name) => !(name in barrel) || barrel[name] === undefined,
	);
}

/**
 * Pure collector for tool-registration coherence violations. Returns the list
 * of human-readable error strings (empty when coherent). Exported so the CI
 * drift checker (scripts/drift-check.ts, issue #1497) can reuse the exact same
 * logic without triggering the CLI's `process.exit`.
 */
export function collectToolRegistrationErrors(
	options: ToolRegistrationCheckOptions = {},
): string[] {
	const errors: string[] = [];

	const metaKeys = Object.keys(TOOL_METADATA);
	const metaKeySet = new Set(metaKeys);
	const handlerKeys = new Set(Object.keys(TOOL_MANIFEST));

	// 1) Metadata and handler maps must cover exactly the same tools.
	for (const name of metaKeys) {
		if (!handlerKeys.has(name)) {
			errors.push(
				`Tool "${name}" has metadata but no handler in TOOL_MANIFEST.`,
			);
		}
	}
	for (const name of handlerKeys) {
		if (!metaKeySet.has(name)) {
			errors.push(`Tool "${name}" has a handler but no metadata entry.`);
		}
	}

	// 2) The plugin tool object must register exactly the manifest's tools.
	//    swarm_command's handler is dependency-injected at plugin init; we check
	//    key parity, not handler identity, for that key.
	const pluginKeys = new Set(Object.keys(buildPluginToolObject({})));
	for (const name of metaKeys) {
		if (!pluginKeys.has(name)) {
			errors.push(`Tool "${name}" is not in the plugin tool object.`);
		}
	}
	for (const name of pluginKeys) {
		if (!metaKeySet.has(name)) {
			errors.push(
				`Tool "${name}" is in the plugin tool object but has no metadata.`,
			);
		}
	}

	// 3) TOOL_NAMES / TOOL_NAME_SET must mirror the metadata keys exactly.
	if (TOOL_NAMES.length !== metaKeys.length) {
		errors.push(
			`TOOL_NAMES has ${TOOL_NAMES.length} entries but TOOL_METADATA has ${metaKeys.length}.`,
		);
	}
	for (const name of metaKeys) {
		if (!TOOL_NAME_SET.has(name as ToolName)) {
			errors.push(`Tool "${name}" is missing from TOOL_NAME_SET.`);
		}
	}

	// 4) Every entry has a non-empty description and a callable resolved handler.
	for (const [name, meta] of Object.entries(TOOL_METADATA)) {
		if (!meta.description || meta.description.trim().length === 0) {
			errors.push(`Tool "${name}" has an empty description.`);
		}
	}
	for (const [name, thunk] of Object.entries(TOOL_MANIFEST)) {
		if (typeof thunk !== 'function') {
			errors.push(`Tool "${name}" handler is not a thunk function.`);
		} else if (
			typeof (thunk() as { execute?: unknown }).execute !== 'function'
		) {
			errors.push(`Tool "${name}" handler() has no callable execute.`);
		}
	}

	// 5) AGENT_TOOL_MAP must be the EXACT inversion of TOOL_METADATA.agents —
	//    every assignment present, none stray, none dropped (catches a derivation
	//    regression in either direction, not just "assigned tool exists").
	const expectedAgentTools = new Map<string, Set<string>>();
	for (const [name, meta] of Object.entries(TOOL_METADATA)) {
		for (const agent of meta.agents) {
			let set = expectedAgentTools.get(agent);
			if (!set) {
				set = new Set();
				expectedAgentTools.set(agent, set);
			}
			set.add(name);
		}
	}
	for (const [agent, tools] of Object.entries(AGENT_TOOL_MAP)) {
		const expected = expectedAgentTools.get(agent) ?? new Set<string>();
		const actual = new Set(tools);
		for (const tool of actual) {
			if (!metaKeySet.has(tool)) {
				errors.push(
					`Agent "${agent}" references tool "${tool}" which has no metadata.`,
				);
			}
			if (!expected.has(tool)) {
				errors.push(
					`Agent "${agent}" lists tool "${tool}" not assigned to it in TOOL_METADATA.agents (stray assignment).`,
				);
			}
		}
		for (const tool of expected) {
			if (!actual.has(tool)) {
				errors.push(
					`Tool "${tool}" declares agent "${agent}" in TOOL_METADATA but is missing from AGENT_TOOL_MAP["${agent}"] (dropped assignment).`,
				);
			}
		}
	}

	// 6) REVERSE check (issue #1781 E4): every exported `createSwarmTool(...)`
	//    binding in src/tools/** must have a TOOL_METADATA entry or declare an
	//    explicit @tool-opt-out JSDoc tag. Catches the `knowledge_ack` class —
	//    a fully built + tested tool that was never registered. The forward
	//    checks above (1–5) validate metadata → consumers; this validates
	//    source → metadata, closing the reverse gap.
	//
	//    A small number of tools are exported with a camelCase binding name and
	//    registered under the snake_case alias declared in TOOL_MANIFEST (e.g.
	//    `swarmApplyPatch` is registered as `swarm_apply_patch`). We accept both
	//    the exact name and its camelCase→snake_case conversion so the legitimate
	//    alias pattern is not flagged.
	const exportedToolBindings = collectExportedCreateSwarmToolBindings();
	for (const { name, file, hasOptOut } of exportedToolBindings) {
		if (metaKeySet.has(name)) continue;
		const snakeCase = camelToSnakeCase(name);
		if (snakeCase !== name && metaKeySet.has(snakeCase)) continue;
		if (hasOptOut) continue;
		const relPath = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
		errors.push(
			`Tool "${name}" is built via createSwarmTool() in src/tools/${path.basename(relPath)} but has no TOOL_METADATA entry. ` +
				`Register it in src/tools/tool-metadata.ts, delete it, or add a /** @tool-opt-out <reason> */ JSDoc tag above its export const definition.`,
		);
	}

	// 7) Barrel-export check (issue #1643): every TOOL_NAMES entry must
	//    resolve to a DEFINED export of the src/tools/index.ts barrel.
	//    Checks 1–6 validate metadata ⇔ manifest ⇔ plugin object ⇔
	//    TOOL_NAMES ⇔ AGENT_TOOL_MAP plus the reverse source→metadata scan,
	//    but none of them import the barrel — a surface still required by
	//    wiring/registration tests (tests/unit/tools/wiring-adversarial.test.ts,
	//    tests/unit/tools/check-gate-status-export.test.ts,
	//    tests/integration/*-registration.test.ts). The barrel is loaded
	//    synchronously via createRequire (works under Bun for this ESM
	//    barrel) and is injectable for the regression test, which hands the
	//    collector a copy of the real barrel with one export deleted.
	const barrel: Record<string, unknown> =
		options.barrel ??
		(createRequire(import.meta.url)('../src/tools/index') as Record<
			string,
			unknown
		>);
	for (const name of findMissingBarrelExports(TOOL_NAMES, barrel)) {
		errors.push(
			`Tool "${name}" has no defined export in the src/tools/index.ts barrel. ` +
				`Add \`export { ${name} } from './<module>'\` (issue #1643: the barrel is still a required surface for wiring and registration tests).`,
		);
	}

	return errors;
}

/**
 * Convert a camelCase identifier to snake_case (e.g. `swarmApplyPatch` →
 * `swarm_apply_patch`). Used to resolve the legitimate camelCase-export →
 * snake_case-registration alias pattern so the reverse check does not flag
 * it as an orphan.
 */
export function camelToSnakeCase(name: string): string {
	return name.replace(/[A-Z]/g, (cap, offset) =>
		offset === 0 ? cap.toLowerCase() : `_${cap.toLowerCase()}`,
	);
}

// ---------------------------------------------------------------------------
// Reverse-direction enumeration helpers (issue #1781 E4)
// ---------------------------------------------------------------------------

export interface ExportedToolBinding {
	name: string;
	file: string;
	hasOptOut: boolean;
}

/**
 * Walk every `.ts` file under `src/tools/` (recursively, excluding tests and
 * the create-tool.ts factory) and enumerate every exported `createSwarmTool(...)`
 * binding. Uses two passes per file (critic B1): Pass A finds `export const
 * NAME =` binding spans; Pass B finds `createSwarmTool(` call positions; a
 * binding "owns" a call when the call is at or after the binding's `=` and
 * before the next binding. This correctly handles multi-line type annotations
 * like `export const x: ReturnType<typeof createSwarmTool> = createSwarmTool({`.
 */
export function collectExportedCreateSwarmToolBindings(
	dir: string = TOOLS_DIR,
): ExportedToolBinding[] {
	const bindings: ExportedToolBinding[] = [];
	const factoryFileName = 'create-tool.ts';
	for (const file of walkTsFiles(dir)) {
		if (file.endsWith('.test.ts')) continue;
		if (path.basename(file) === factoryFileName) continue;
		const source = fs.readFileSync(file, 'utf-8');
		const fileBindings = findExportedBindings(source);
		const callPositions = findCreateSwarmToolCallPositions(source);
		if (fileBindings.length === 0 || callPositions.length === 0) continue;
		for (const binding of fileBindings) {
			// A binding owns a call when the call is at/after the binding's `=`
			// and before the next sibling binding's `export` keyword. This
			// correctly attributes each `createSwarmTool(` to its enclosing
			// `export const` and skips factory-internal calls (e.g. a `return
			// createSwarmTool(...)` inside `createSwarmCommandTool`, which has
			// no preceding `export const ... =` on the same binding).
			const nextBinding = fileBindings
				.filter((b) => b.declStart > binding.declStart)
				.sort((a, b) => a.declStart - b.declStart)[0];
			const ownedCall = callPositions.find((pos) => {
				if (pos < binding.equalsPosition) return false;
				if (nextBinding && pos >= nextBinding.declStart) return false;
				return true;
			});
			if (ownedCall === undefined) continue;
			bindings.push({
				name: binding.name,
				file,
				hasOptOut: hasToolOptOutTag(source, binding.declStart),
			});
		}
	}
	return bindings;
}

export interface BindingSpan {
	name: string;
	/** Index of the `export` keyword. */
	declStart: number;
	/** Index of the `=` after the optional type annotation. */
	equalsPosition: number;
}

/**
 * Pass A: find all `export const NAME =` / `export const NAME: Type =` bindings.
 * The `[^=]+` between the name and `=` is non-greedy on `=` by construction
 * (negated char class), so it stops at the first `=` (the assignment) and
 * correctly spans multi-line type annotations. `[^=]+` cannot be confused by
 * `<`, `>`, `typeof`, or newlines (none of which is `=`).
 */
export function findExportedBindings(source: string): BindingSpan[] {
	const bindings: BindingSpan[] = [];
	const re = /\bexport\s+const\s+(\w+)\s*(?::[^=]+)?=/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		bindings.push({
			name: m[1],
			declStart: m.index,
			equalsPosition: m.index + m[0].length,
		});
	}
	return bindings;
}

/**
 * Pass B: find all `createSwarmTool(` call positions (index of the `c`).
 */
export function findCreateSwarmToolCallPositions(source: string): number[] {
	const positions: number[] = [];
	const re = /\bcreateSwarmTool\s*\(/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		positions.push(m.index);
	}
	return positions;
}

/**
 * Check whether the binding at `declStart` has a `@tool-opt-out` JSDoc tag in
 * the immediately preceding block comment. We scan backwards from `declStart`
 * past whitespace to the end of a block comment close, then locate the matching
 * open, and test the block text for the `@tool-opt-out` tag.
 */
export function hasToolOptOutTag(source: string, declStart: number): boolean {
	// Skip whitespace/newlines backwards from declStart to find `*/`.
	let i = declStart - 1;
	while (i >= 0 && /\s/.test(source[i] ?? '')) i--;
	// `source[i]` should now be `/` (the close of `*/`).
	if (source[i] !== '/' || source[i - 1] !== '*') return false;
	const closeEnd = i + 1; // position just after `*/`
	const closeStart = i - 1; // position of `*` in `*/`
	// Find the matching `/**` open by scanning backwards.
	const openIdx = source.lastIndexOf('/**', closeStart);
	if (openIdx === -1 || openIdx >= closeStart) return false;
	const block = source.slice(openIdx, closeEnd);
	return /@tool-opt-out\b/.test(block);
}

/**
 * Recursively yield every `.ts` file under `dir` (excludes `node_modules`,
 * `dist`).
 */
function* walkTsFiles(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkTsFiles(full);
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			yield full;
		}
	}
}

function main(): void {
	const errors = collectToolRegistrationErrors();
	if (errors.length > 0) {
		console.error('Tool registration check FAILED:\n');
		for (const e of errors) console.error(`  - ${e}`);
		console.error(
			`\n${errors.length} violation(s). Every tool needs a TOOL_METADATA entry (src/tools/tool-metadata.ts) and a handler (src/tools/manifest.ts).`,
		);
		process.exit(1);
	}

	console.log(
		`Tool registration check passed: ${Object.keys(TOOL_METADATA).length} tools, coherent across metadata, handlers, the plugin object, TOOL_NAMES, AGENT_TOOL_MAP, and the src/tools/index.ts barrel.`,
	);
}

if (import.meta.main) {
	main();
}
