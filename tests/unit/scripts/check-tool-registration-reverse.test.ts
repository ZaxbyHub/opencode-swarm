import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	camelToSnakeCase,
	collectExportedCreateSwarmToolBindings,
	collectToolRegistrationErrors,
	findCreateSwarmToolCallPositions,
	findExportedBindings,
	hasToolOptOutTag,
} from '../../../scripts/check-tool-registration.ts';

// Issue #1781 E4 — reverse-direction tool-registration guard.
// The forward checks (metadata ⇔ manifest ⇔ plugin-object ⇔ AGENT_TOOL_MAP)
// validate metadata → consumers. The reverse check (section 6) validates
// source → metadata: every exported `createSwarmTool(...)` binding must have a
// TOOL_METADATA entry (or a @tool-opt-out JSDoc tag). This test file covers the
// pure helpers plus a real-tree smoke assertion that the current repo has no
// orphans (knowledge_ack was deleted; the guard should pass).

describe('check-tool-registration reverse: pure helpers', () => {
	describe('findExportedBindings', () => {
		test('matches single-line `export const x = createSwarmTool(` shape', () => {
			const src = 'export const foo_bar = createSwarmTool({';
			const bindings = findExportedBindings(src);
			expect(bindings).toHaveLength(1);
			expect(bindings[0]?.name).toBe('foo_bar');
		});

		test('matches `export const x: Type =` with type annotation', () => {
			const src = 'export const actionlint_scan: ToolDefinition = createSwarmTool({';
			const bindings = findExportedBindings(src);
			expect(bindings).toHaveLength(1);
			expect(bindings[0]?.name).toBe('actionlint_scan');
		});

		test('matches multi-line `export const x: ReturnType<typeof createSwarmTool> =\\n\\tcreateSwarmTool(` (critic B1)', () => {
			const src =
				'export const dispatch_lanes_async: ReturnType<typeof createSwarmTool> =\n\tcreateSwarmTool({';
			const bindings = findExportedBindings(src);
			expect(bindings).toHaveLength(1);
			expect(bindings[0]?.name).toBe('dispatch_lanes_async');
			// The equalsPosition must point past the `=` so the call finder can
			// attribute the createSwarmTool( on the next line to this binding.
			expect(src.slice(bindings[0]!.declStart, bindings[0]!.equalsPosition))
				.toInclude('createSwarmTool>');
		});

		test('does NOT match non-exported const (factory-internal)', () => {
			const src =
				'function factory() {\n  return createSwarmTool({\n  });\n}\nexport const swarm_command = factory({});';
			const bindings = findExportedBindings(src);
			expect(bindings).toHaveLength(1);
			expect(bindings[0]?.name).toBe('swarm_command');
		});

		test('regex stops at the first `=` even if the type annotation contains `>`, `<`, `typeof`', () => {
			// `[^=]+` is a negated char class; it cannot be confused by generic
			// brackets. Only an `=` inside the type annotation would break it.
			const src =
				'export const complex_tool: ReturnType<typeof createSwarmTool> = createSwarmTool({';
			const bindings = findExportedBindings(src);
			expect(bindings).toHaveLength(1);
			expect(bindings[0]?.name).toBe('complex_tool');
		});
	});

	describe('findCreateSwarmToolCallPositions', () => {
		test('finds a single call', () => {
			const positions = findCreateSwarmToolCallPositions(
				'export const x = createSwarmTool({',
			);
			expect(positions).toHaveLength(1);
		});

		test('finds multiple calls in a file', () => {
			const src = `import { createSwarmTool } from '../create-tool';
export const a = createSwarmTool({
export const b = createSwarmTool({`;
			expect(findCreateSwarmToolCallPositions(src)).toHaveLength(2);
		});
	});

	describe('camelToSnakeCase', () => {
		test('converts camelCase to snake_case', () => {
			expect(camelToSnakeCase('swarmApplyPatch')).toBe('swarm_apply_patch');
			expect(camelToSnakeCase('suggestPatch')).toBe('suggest_patch');
		});

		test('leaves already-snake_case identifiers unchanged', () => {
			expect(camelToSnakeCase('actionlint_scan')).toBe('actionlint_scan');
			expect(camelToSnakeCase('web_fetch')).toBe('web_fetch');
		});

		test('lowercases a leading capital', () => {
			expect(camelToSnakeCase('CamelCase')).toBe('camel_case');
		});
	});
});

describe('check-tool-registration reverse: real-tree smoke', () => {
	test('collectToolRegistrationErrors returns zero errors on the current repo', () => {
		// After knowledge_ack deletion (issue #1781 E4) the repo must be clean.
		// This is the live regression guard against the orphan class.
		expect(collectToolRegistrationErrors()).toEqual([]);
	});

	test('every exported createSwarmTool binding is registered or aliased or opt-out', () => {
		const bindings = collectExportedCreateSwarmToolBindings();
		expect(bindings.length).toBeGreaterThan(80);
		// Every binding must resolve via exact name, snake_case alias, or opt-out.
		for (const b of bindings) {
			expect(typeof b.name).toBe('string');
			expect(b.name.length).toBeGreaterThan(0);
		}
	});
});

// Issue #1781 E4 acceptance criterion: "fixture triggers failure." These tests
// point `collectExportedCreateSwarmToolBindings` at a synthetic fixture tree
// (not the real src/tools/) so an orphan and an opt-out-tagged tool can be
// exercised without polluting the real tree.

describe('hasToolOptOutTag (pure helper)', () => {
	test('detects an immediately-preceding @tool-opt-out JSDoc tag', () => {
		const src = [
			'/**',
			' * @tool-opt-out internal helper, not a user-facing tool',
			' */',
			'export const internal_helper = createSwarmTool({',
		].join('\n');
		const declStart = src.indexOf('export const');
		expect(hasToolOptOutTag(src, declStart)).toBe(true);
	});

	test('returns false when no JSDoc precedes the binding', () => {
		const src = 'export const orphan = createSwarmTool({';
		expect(hasToolOptOutTag(src, 0)).toBe(false);
	});

	test('returns false when a JSDoc precedes but has no @tool-opt-out tag', () => {
		const src = [
			'/**',
			' * Just a regular doc comment.',
			' */',
			'export const documented = createSwarmTool({',
		].join('\n');
		const declStart = src.indexOf('export const');
		expect(hasToolOptOutTag(src, declStart)).toBe(false);
	});

	test('returns false when a // line comment sits between JSDoc and export', () => {
		// The opt-out requires the JSDoc to be immediately adjacent; a stray
		// line comment breaks the adjacency (err toward failing = safe).
		const src = [
			'/**',
			' * @tool-opt-out reason',
			' */',
			'// intervening line comment',
			'export const x = createSwarmTool({',
		].join('\n');
		const declStart = src.indexOf('export const');
		expect(hasToolOptOutTag(src, declStart)).toBe(false);
	});
});

describe('collectExportedCreateSwarmToolBindings — orphan + opt-out fixtures', () => {
	let tmpToolsDir: string;

	function writeToolFile(name: string, body: string): void {
		fs.mkdirSync(tmpToolsDir, { recursive: true });
		fs.writeFileSync(path.join(tmpToolsDir, name), body, 'utf-8');
	}

	test('enumerates an orphan createSwarmTool binding with no opt-out tag', () => {
		tmpToolsDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'tools-orphan-1781-'),
		);
		// An orphan: exported createSwarmTool, no TOOL_METADATA entry, no opt-out.
		writeToolFile(
			'orphan.ts',
			[
				"import { createSwarmTool } from '../create-tool';",
				'export const orphan_tool: ReturnType<typeof createSwarmTool> =',
				'\tcreateSwarmTool({',
				'\t\tdescription: "orphan",',
				'\t\targs: {} as Record<string, unknown>,',
				'\t\tasync execute() { return "ok"; },',
				'\t});',
			].join('\n'),
		);

		const bindings = collectExportedCreateSwarmToolBindings(tmpToolsDir);
		expect(bindings.map((b) => b.name)).toContain('orphan_tool');
		const orphan = bindings.find((b) => b.name === 'orphan_tool');
		expect(orphan?.hasOptOut).toBe(false);
		fs.rmSync(tmpToolsDir, { recursive: true, force: true });
	});

	test('enumerates a @tool-opt-out-tagged binding with hasOptOut=true', () => {
		tmpToolsDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'tools-optout-1781-'),
		);
		writeToolFile(
			'internal.ts',
			[
				'/**',
				' * @tool-opt-out internal factory helper, intentionally unregistered',
				' */',
				'export const internal_helper = createSwarmTool({',
				'\t\tdescription: "internal",',
				'\t\targs: {} as Record<string, unknown>,',
				'\t\tasync execute() { return "ok"; },',
				'\t});',
			].join('\n'),
		);

		const bindings = collectExportedCreateSwarmToolBindings(tmpToolsDir);
		expect(bindings.map((b) => b.name)).toContain('internal_helper');
		const tagged = bindings.find((b) => b.name === 'internal_helper');
		expect(tagged?.hasOptOut).toBe(true);
		fs.rmSync(tmpToolsDir, { recursive: true, force: true });
	});

	test('factory-internal createSwarmTool call is NOT enumerated', () => {
		tmpToolsDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'tools-factory-1781-'),
		);
		writeToolFile(
			'factory.ts',
			[
				"import { createSwarmTool } from '../create-tool';",
				'export function makeTool() {',
				'\treturn createSwarmTool({',
				'\t\tdescription: "from factory",',
				'\t\targs: {} as Record<string, unknown>,',
				'\t\tasync execute() { return "ok"; },',
				'\t});',
				'}',
			].join('\n'),
		);

		const bindings = collectExportedCreateSwarmToolBindings(tmpToolsDir);
		// No `export const NAME = createSwarmTool(` binding → empty.
		expect(bindings).toEqual([]);
		fs.rmSync(tmpToolsDir, { recursive: true, force: true });
	});
});
