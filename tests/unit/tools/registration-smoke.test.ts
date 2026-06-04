/**
 * Smoke test: tool registration completeness
 *
 * Regression guard for tools added to TOOL_MANIFEST but somehow not surfaced in
 * the plugin tool object. As of #507 the plugin tool object is DERIVED from the
 * manifest by buildPluginToolObject(), so this asserts against the real object
 * (not a regex parse of src/index.ts source text). The bug class it still
 * guards: a manifest entry whose handler is missing/non-callable, or a count
 * mismatch between TOOL_NAMES and the registered tool object.
 */

import { describe, expect, test } from 'bun:test';
import { buildPluginToolObject } from '../../../src/tools/plugin-registration';
import { TOOL_NAMES } from '../../../src/tools/tool-names';

describe('tool registration smoke test', () => {
	// The real plugin tool object. swarm_command's DI instance is not needed to
	// enumerate keys/handlers, so an empty agent map is fine here.
	const toolObject = buildPluginToolObject({});
	const registeredToolKeys = new Set(Object.keys(toolObject));

	test('every TOOL_NAMES entry is registered in the plugin tool object', () => {
		const missing: string[] = [];
		for (const toolName of TOOL_NAMES) {
			if (!registeredToolKeys.has(toolName)) {
				missing.push(toolName);
			}
		}
		if (missing.length > 0) {
			throw new Error(
				`The following tools are in TOOL_NAMES but not in the plugin tool object derived from TOOL_MANIFEST:\n  - ${missing.join('\n  - ')}\n\nAdd a TOOL_MANIFEST entry for them.`,
			);
		}
		expect(missing).toEqual([]);
	});

	test('no extra tools are registered that are not in TOOL_NAMES', () => {
		const extra: string[] = [];
		for (const key of registeredToolKeys) {
			if (!TOOL_NAMES.includes(key as (typeof TOOL_NAMES)[number])) {
				extra.push(key);
			}
		}
		if (extra.length > 0) {
			throw new Error(
				`The following tools are in the plugin tool object but not in TOOL_NAMES:\n  - ${extra.join('\n  - ')}`,
			);
		}
		expect(extra).toEqual([]);
	});

	test('registered tool count matches TOOL_NAMES count', () => {
		expect(registeredToolKeys.size).toBe(TOOL_NAMES.length);
	});

	test('each registered tool has a callable execute function', () => {
		for (const toolName of TOOL_NAMES) {
			const tool = (toolObject as Record<string, unknown>)[toolName];
			if (!tool) {
				throw new Error(
					`Tool '${toolName}' is in TOOL_NAMES but absent from the derived tool object`,
				);
			}
			if (typeof (tool as { execute?: unknown }).execute !== 'function') {
				throw new Error(
					`Tool '${toolName}' is registered but has no callable execute function`,
				);
			}
		}
	});

	test('TOOL_NAMES has no duplicates', () => {
		const seen = new Set<string>();
		const duplicates: string[] = [];
		for (const name of TOOL_NAMES) {
			if (seen.has(name)) {
				duplicates.push(name);
			}
			seen.add(name);
		}
		expect(duplicates).toEqual([]);
	});
});
