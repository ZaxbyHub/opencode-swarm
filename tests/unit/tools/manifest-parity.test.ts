/**
 * Coherence guard for issue #507 (single-source tool registration).
 *
 * Tool METADATA (names, descriptions, agents) lives in src/tools/tool-metadata.ts;
 * HANDLER thunks live in src/tools/manifest.ts. These tests prove the derived
 * registries (TOOL_NAMES, TOOL_DESCRIPTIONS, AGENT_TOOL_MAP, and the real plugin
 * tool object) are internally consistent and that metadata ↔ handlers agree — the
 * #507 acceptance criteria, with no behavior change vs the previous registration.
 */
import { describe, expect, test } from 'bun:test';
import {
	AGENT_TOOL_MAP,
	type AgentName,
	ALL_AGENT_NAMES,
	TOOL_DESCRIPTIONS,
} from '../../../src/config/constants';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import { buildPluginToolObject } from '../../../src/tools/plugin-registration';
import { TOOL_METADATA } from '../../../src/tools/tool-metadata';
import { TOOL_NAMES } from '../../../src/tools/tool-names';

const metaKeys = Object.keys(TOOL_METADATA);

describe('tool metadata <-> derived registries', () => {
	test('metadata keys == TOOL_NAMES (same set)', () => {
		expect(new Set(metaKeys)).toEqual(new Set(TOOL_NAMES));
		expect(metaKeys.length).toBe(TOOL_NAMES.length);
	});

	test('every metadata key has a handler thunk (and vice versa)', () => {
		expect(new Set(Object.keys(TOOL_MANIFEST))).toEqual(new Set(metaKeys));
		for (const thunk of Object.values(TOOL_MANIFEST)) {
			expect(typeof thunk).toBe('function');
		}
	});

	test('TOOL_DESCRIPTIONS mirrors metadata descriptions', () => {
		for (const [name, meta] of Object.entries(TOOL_METADATA)) {
			expect(TOOL_DESCRIPTIONS[name as keyof typeof TOOL_DESCRIPTIONS]).toBe(
				meta.description,
			);
			expect(meta.description.length).toBeGreaterThan(0);
		}
	});

	test('inverted metadata.agents == AGENT_TOOL_MAP membership (per agent)', () => {
		const derived = Object.fromEntries(
			ALL_AGENT_NAMES.map((a) => [a, new Set<string>()]),
		) as Record<AgentName, Set<string>>;
		for (const [name, meta] of Object.entries(TOOL_METADATA)) {
			for (const agent of meta.agents) derived[agent].add(name);
		}
		for (const agent of ALL_AGENT_NAMES) {
			const expected = new Set(AGENT_TOOL_MAP[agent] ?? []);
			expect(derived[agent]).toEqual(expected);
		}
	});

	test('every agent referenced by a tool is a real AgentName', () => {
		const valid = new Set<string>(ALL_AGENT_NAMES);
		for (const meta of Object.values(TOOL_METADATA)) {
			for (const agent of meta.agents) expect(valid.has(agent)).toBe(true);
		}
	});
});

describe('plugin tool object derives from the manifest (#507 acceptance)', () => {
	const toolObject = buildPluginToolObject({});
	const registered = new Set(Object.keys(toolObject));

	test('every TOOL_NAMES entry is registered with a callable execute', () => {
		const missing: string[] = [];
		for (const name of TOOL_NAMES) {
			const handler = toolObject[name] as { execute?: unknown } | undefined;
			if (!handler) missing.push(name);
			else if (typeof handler.execute !== 'function')
				throw new Error(`Tool '${name}' has no callable execute`);
		}
		expect(missing).toEqual([]);
	});

	test('no extra tools registered beyond TOOL_NAMES', () => {
		const extra = [...registered].filter(
			(k) => !(TOOL_NAMES as readonly string[]).includes(k),
		);
		expect(extra).toEqual([]);
	});

	test('registered count matches TOOL_NAMES count', () => {
		expect(registered.size).toBe(TOOL_NAMES.length);
	});

	test('every AGENT_TOOL_MAP tool is registered', () => {
		const missing: string[] = [];
		for (const tools of Object.values(AGENT_TOOL_MAP))
			for (const t of tools) if (!registered.has(t)) missing.push(t);
		expect(missing).toEqual([]);
	});
});
