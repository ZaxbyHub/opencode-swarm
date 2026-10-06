import { describe, expect, test } from 'bun:test';
import {
	buildMcpToolRegistry,
	WRITE_TOOL_NAME_PATTERN,
} from '../../../src/mcp/registry';
import { TOOL_METADATA } from '../../../src/tools/tool-metadata';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('MCP tool registry (#2499)', () => {
	const root = canonicalMkdtemp('mcp-registry-2499-');

	test('registers at least six tools covering the six capability areas', () => {
		const registry = buildMcpToolRegistry({ root });
		expect(registry.tools.length).toBeGreaterThanOrEqual(6);
		const text = registry.tools
			.map((t) => `${t.name} ${t.description}`)
			.join('\n');
		expect(text).toMatch(/knowledge|memory/);
		expect(text).toMatch(/evidence/);
		expect(text).toMatch(/syntax/);
		expect(text).toMatch(/sast/);
		expect(text).toMatch(/quality/);
		expect(text).toMatch(/scope/);
	});

	test('every tool name is a TOOL_METADATA key with exact description parity', () => {
		const registry = buildMcpToolRegistry({ root });
		for (const tool of registry.tools) {
			const metadata = TOOL_METADATA[tool.name as keyof typeof TOOL_METADATA];
			expect(metadata).toBeDefined();
			expect(tool.description).toBe(metadata.description.trim());
		}
	});

	test('read-only default: zero write-capable tools, with AND without allowWrite', () => {
		for (const allowWrite of [undefined, true]) {
			const registry = buildMcpToolRegistry({ root, allowWrite });
			const writeTools = registry.tools.filter((t) =>
				WRITE_TOOL_NAME_PATTERN.test(t.name),
			);
			expect(writeTools).toEqual([]);
			expect(registry.tools.every((t) => t.kind === 'read')).toBe(true);
		}
	});

	test('the `directory` option is a synonym for `root`', () => {
		const registry = buildMcpToolRegistry({ root, directory: root });
		expect(registry.tools.length).toBeGreaterThan(0);
	});

	test('directory-only invocation also resolves the root', () => {
		const registry = buildMcpToolRegistry({ directory: root });
		expect(registry.tools.length).toBeGreaterThan(0);
	});

	test('write-boundary denylist matches known write tool names', () => {
		for (const name of [
			'save_plan',
			'update_task_status',
			'declare_scope',
			'knowledge_add',
			'swarm_memory_propose',
			'phase_complete',
			'swarm_command',
		]) {
			expect(WRITE_TOOL_NAME_PATTERN.test(name)).toBe(true);
		}
	});

	test('write-boundary denylist covers every Epic Mode tool via the epic_ prefix', () => {
		// Epic Mode tools mutate Epic lifecycle/evidence state or dispatch
		// agents, so the whole `epic_` family is denied by one prefix rule
		// rather than an explicit list that drifts as tools are added/removed.
		const epicTools = Object.keys(TOOL_METADATA).filter((name) =>
			name.startsWith('epic_'),
		);
		expect(epicTools.length).toBeGreaterThan(0);
		for (const name of [...epicTools, 'epic_some_future_tool']) {
			expect(WRITE_TOOL_NAME_PATTERN.test(name)).toBe(true);
		}
		// The rule is a PREFIX: a name merely containing `epic_` elsewhere is
		// not swept in, and read-only neighbours stay off the denylist.
		expect(WRITE_TOOL_NAME_PATTERN.test('lean_turbo_status')).toBe(false);
		expect(WRITE_TOOL_NAME_PATTERN.test('repo_epic_summary')).toBe(false);
		// No currently registered MCP tool is Epic-family.
		const registry = buildMcpToolRegistry({ root, allowWrite: true });
		expect(registry.tools.some((t) => t.name.startsWith('epic_'))).toBe(false);
	});

	test('a missing root fails closed', () => {
		expect(() =>
			buildMcpToolRegistry({ root: '' } as { root: string }),
		).toThrow(/root is required/);
	});
});
