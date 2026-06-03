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
 * Usage: bun run scripts/check-tool-registration.ts
 */

import { AGENT_TOOL_MAP } from '../src/config/constants';
import { TOOL_MANIFEST } from '../src/tools/manifest';
import { buildPluginToolObject } from '../src/tools/plugin-registration';
import {
	TOOL_METADATA,
	TOOL_NAME_SET,
	TOOL_NAMES,
	type ToolName,
} from '../src/tools/tool-metadata';

const errors: string[] = [];

const metaKeys = Object.keys(TOOL_METADATA);
const metaKeySet = new Set(metaKeys);
const handlerKeys = new Set(Object.keys(TOOL_MANIFEST));

// 1) Metadata and handler maps must cover exactly the same tools.
for (const name of metaKeys) {
	if (!handlerKeys.has(name)) {
		errors.push(`Tool "${name}" has metadata but no handler in TOOL_MANIFEST.`);
	}
}
for (const name of handlerKeys) {
	if (!metaKeySet.has(name)) {
		errors.push(`Tool "${name}" has a handler but no metadata entry.`);
	}
}

// 2) The plugin tool object must register exactly the manifest's tools.
//    swarm_command's handler is dependency-injected at plugin init; we check key
//    parity, not handler identity, for that key.
const pluginKeys = new Set(Object.keys(buildPluginToolObject({})));
for (const name of metaKeys) {
	if (!pluginKeys.has(name)) {
		errors.push(`Tool "${name}" is not in the plugin tool object.`);
	}
}
for (const name of pluginKeys) {
	if (!metaKeySet.has(name)) {
		errors.push(`Tool "${name}" is in the plugin tool object but has no metadata.`);
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
	} else if (typeof (thunk() as { execute?: unknown }).execute !== 'function') {
		errors.push(`Tool "${name}" handler() has no callable execute.`);
	}
}

// 5) AGENT_TOOL_MAP must be the EXACT inversion of TOOL_METADATA.agents — every
//    assignment present, none stray, none dropped (catches a derivation
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
			errors.push(`Agent "${agent}" references tool "${tool}" which has no metadata.`);
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

if (errors.length > 0) {
	console.error('Tool registration check FAILED:\n');
	for (const e of errors) console.error(`  - ${e}`);
	console.error(
		`\n${errors.length} violation(s). Every tool needs a TOOL_METADATA entry (src/tools/tool-metadata.ts) and a handler (src/tools/manifest.ts).`,
	);
	process.exit(1);
}

console.log(
	`Tool registration check passed: ${metaKeys.length} tools, coherent across metadata, handlers, the plugin object, TOOL_NAMES, and AGENT_TOOL_MAP.`,
);
