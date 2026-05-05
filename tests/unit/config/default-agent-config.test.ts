import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	getAgentConfigs,
	resolvePrimaryAgentNames,
} from '../../../src/agents/index';
import { PluginConfigSchema } from '../../../src/config/schema';

// Mock node:fs/promises to avoid the agent-tool snapshot writer touching disk.
const realFsPromises = await import('node:fs/promises');
const mockMkdir = mock(() => Promise.resolve());
const mockWriteFile = mock(() => Promise.resolve());
mock.module('node:fs/promises', () => ({
	...realFsPromises,
	mkdir: mockMkdir,
	writeFile: mockWriteFile,
}));

// ─── Helper: build a multi-swarm PluginConfig ──────────────────────────────
function multiSwarmConfig(extra: Record<string, unknown> = {}) {
	return {
		swarms: {
			local: { name: 'Local', agents: { coder: { model: 'm-local' } } },
			mega: { name: 'Mega', agents: { coder: { model: 'm-mega' } } },
			paid: { name: 'Paid', agents: { coder: { model: 'm-paid' } } },
			modelrelay: {
				name: 'Modelrelay',
				agents: { coder: { model: 'm-relay' } },
			},
		},
		...extra,
	} as Record<string, unknown>;
}

function multiSwarmWithDefaultConfig(extra: Record<string, unknown> = {}) {
	return {
		swarms: {
			default: {
				name: 'Default',
				agents: { coder: { model: 'm-default' } },
			},
			local: { name: 'Local', agents: { coder: { model: 'm-local' } } },
			mega: { name: 'Mega', agents: { coder: { model: 'm-mega' } } },
		},
		...extra,
	} as Record<string, unknown>;
}

// ─── Schema semantics ──────────────────────────────────────────────────────

describe('PluginConfigSchema — default_agent field (post-v7.3.5 semantics)', () => {
	test('omitted default_agent is preserved as undefined (no schema default)', () => {
		const result = PluginConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			// CRITICAL regression: previously schema applied .default("architect").
			// That default broke multi-swarm configs because no agent in those
			// configs is literally named "architect" — they are all prefixed.
			expect(result.data.default_agent).toBeUndefined();
		}
	});

	test('explicit "architect" is preserved (distinct from omitted)', () => {
		const result = PluginConfigSchema.safeParse({ default_agent: 'architect' });
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.default_agent).toBe('architect');
	});

	test('accepts base role names (coder, reviewer, explorer, test_engineer)', () => {
		for (const v of ['coder', 'reviewer', 'explorer', 'test_engineer']) {
			const r = PluginConfigSchema.safeParse({ default_agent: v });
			expect(r.success, `${v} should parse`).toBe(true);
			if (r.success) expect(r.data.default_agent).toBe(v);
		}
	});

	test('accepts prefixed/generated agent names (local_architect, paid_coder, modelrelay_reviewer)', () => {
		for (const v of [
			'local_architect',
			'mega_architect',
			'paid_coder',
			'modelrelay_reviewer',
		]) {
			const r = PluginConfigSchema.safeParse({ default_agent: v });
			expect(r.success, `${v} should parse`).toBe(true);
			if (r.success) expect(r.data.default_agent).toBe(v);
		}
	});

	test('does not reject arbitrary strings at parse time (semantic validation only)', () => {
		// Previously the schema rejected anything not in the enum, which made an
		// invalid default_agent invalidate the entire plugin config and trigger
		// the loader's safe-defaults fallback. Now the schema accepts arbitrary
		// strings and the resolver issues a warning + falls back at agent-gen.
		const r = PluginConfigSchema.safeParse({
			default_agent: 'not_a_real_agent',
		});
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.default_agent).toBe('not_a_real_agent');
	});

	test('treats whitespace-only / empty default_agent as omitted', () => {
		for (const v of ['', '   ', '\t', '\n']) {
			const r = PluginConfigSchema.safeParse({ default_agent: v });
			expect(r.success, `'${v}' should parse`).toBe(true);
			if (r.success) expect(r.data.default_agent).toBeUndefined();
		}
	});
});

// ─── Resolver: resolvePrimaryAgentNames ────────────────────────────────────

describe('resolvePrimaryAgentNames', () => {
	test('omitted ⇒ all architect-role agents are primary (multi-swarm)', () => {
		const names = [
			'local_architect',
			'mega_architect',
			'paid_coder',
			'local_coder',
		];
		const r = resolvePrimaryAgentNames(names);
		expect(r.reason).toBe('implicit-architects');
		expect([...r.primaryNames].sort()).toEqual([
			'local_architect',
			'mega_architect',
		]);
		expect(r.warning).toBeUndefined();
	});

	test('omitted with single legacy architect ⇒ that architect is primary', () => {
		const r = resolvePrimaryAgentNames(['architect', 'coder', 'reviewer']);
		expect(r.reason).toBe('implicit-architects');
		expect([...r.primaryNames]).toEqual(['architect']);
	});

	test('exact generated-name match wins over base role for prefixed names', () => {
		// "local_architect" is NOT a base role (not in ALL_AGENT_NAMES), so the
		// resolver hits the exact-match branch.
		const names = ['local_architect', 'mega_architect', 'paid_architect'];
		const r = resolvePrimaryAgentNames(names, 'local_architect');
		expect(r.reason).toBe('exact');
		expect([...r.primaryNames]).toEqual(['local_architect']);
	});

	test('base role "architect" beats exact match when both are present (default swarm + extras)', () => {
		// Subtle: when the user passes "architect" AND there is a literal
		// "architect" agent registered AND there are *_architect agents, the
		// spec requires ALL architect-role agents to be primary (not just the
		// unprefixed one). "architect" is in ALL_AGENT_NAMES, so the resolver
		// takes the base-role branch first.
		const names = ['architect', 'local_architect', 'mega_architect', 'coder'];
		const r = resolvePrimaryAgentNames(names, 'architect');
		expect(r.reason).toBe('base-role');
		expect([...r.primaryNames].sort()).toEqual([
			'architect',
			'local_architect',
			'mega_architect',
		]);
	});

	test('base role "architect" ⇒ all architect-role agents primary', () => {
		const names = [
			'local_architect',
			'mega_architect',
			'local_coder',
			'mega_coder',
		];
		const r = resolvePrimaryAgentNames(names, 'architect');
		expect(r.reason).toBe('base-role');
		expect([...r.primaryNames].sort()).toEqual([
			'local_architect',
			'mega_architect',
		]);
	});

	test('base role "coder" ⇒ all coder-role agents primary in multi-swarm', () => {
		const names = [
			'local_architect',
			'local_coder',
			'mega_coder',
			'paid_coder',
		];
		const r = resolvePrimaryAgentNames(names, 'coder');
		expect(r.reason).toBe('base-role');
		expect([...r.primaryNames].sort()).toEqual([
			'local_coder',
			'mega_coder',
			'paid_coder',
		]);
	});

	test('known base role with zero matching agents ⇒ falls through to architect fallback', () => {
		// Exercises the fall-through path at src/agents/index.ts:707-708:
		// ALL_AGENT_NAMES.includes('reviewer') is true, but no generated agent
		// has base role 'reviewer', so the base-role block finds nothing and
		// falls through. The exact-match check also misses ('reviewer' is not
		// a generated name), so the resolver falls back to architect-role primaries.
		const names = ['local_architect', 'mega_architect', 'mega_coder'];
		const r = resolvePrimaryAgentNames(names, 'reviewer');
		expect(r.reason).toBe('fallback-architects');
		expect(r.warning).toBeDefined();
		expect(r.warning).toMatch(/reviewer/);
		expect([...r.primaryNames].sort()).toEqual([
			'local_architect',
			'mega_architect',
		]);
	});

	test('arbitrary "not_an_architect" is NOT treated as base-role architect', () => {
		// Important matching detail from the spec: stripKnownSwarmPrefix returns
		// "architect" for a name ending in "_architect", but the literal user
		// value here is not in ALL_AGENT_NAMES, so it must fall back rather
		// than match the architect role.
		const names = ['local_architect', 'mega_architect', 'local_coder'];
		const r = resolvePrimaryAgentNames(names, 'not_an_architect');
		// Falls back to architect-role agents and emits a warning.
		expect(r.reason).toBe('fallback-architects');
		expect(r.warning).toBeDefined();
		expect([...r.primaryNames].sort()).toEqual([
			'local_architect',
			'mega_architect',
		]);
	});

	test('invalid default_agent ⇒ warns and falls back to architect-role primaries', () => {
		const names = ['local_architect', 'local_coder'];
		const r = resolvePrimaryAgentNames(names, 'totally_made_up_xyz');
		expect(r.reason).toBe('fallback-architects');
		expect(r.warning).toMatch(/totally_made_up_xyz/);
		expect([...r.primaryNames]).toEqual(['local_architect']);
	});

	test('no architects + invalid default_agent ⇒ first agent primary, warns', () => {
		const names = ['local_coder', 'mega_coder'];
		const r = resolvePrimaryAgentNames(names, 'totally_made_up');
		expect(r.reason).toBe('fallback-first');
		expect(r.warning).toMatch(/local_coder/);
		expect([...r.primaryNames]).toEqual(['local_coder']);
	});

	test('no architects + omitted default_agent ⇒ first agent primary, warns', () => {
		const r = resolvePrimaryAgentNames(['local_coder', 'mega_coder']);
		expect(r.reason).toBe('fallback-first');
		expect(r.warning).toMatch(/local_coder/);
		expect([...r.primaryNames]).toEqual(['local_coder']);
	});

	test('whitespace default_agent treated as omitted', () => {
		const r = resolvePrimaryAgentNames(
			['local_architect', 'local_coder'],
			'  ',
		);
		expect(r.reason).toBe('implicit-architects');
		expect([...r.primaryNames]).toEqual(['local_architect']);
	});

	test('empty agent list ⇒ empty primaries (no crash)', () => {
		const r = resolvePrimaryAgentNames([], 'architect');
		expect(r.primaryNames.size).toBe(0);
	});
});

// ─── getAgentConfigs end-to-end ────────────────────────────────────────────

describe('getAgentConfigs — primary mode resolution', () => {
	beforeEach(() => {
		mockMkdir.mockClear();
		mockWriteFile.mockClear();
	});

	describe('legacy single-swarm', () => {
		test('undefined config ⇒ unprefixed architect primary', () => {
			const r = getAgentConfigs(undefined);
			expect(r['architect'].mode).toBe('primary');
			expect(r['coder'].mode).toBe('subagent');
			expect(r['reviewer'].mode).toBe('subagent');
			expect(r['test_engineer'].mode).toBe('subagent');
		});

		test('empty config ⇒ unprefixed architect primary', () => {
			expect(getAgentConfigs({} as never)['architect'].mode).toBe('primary');
		});

		test('legacy config with agents only ⇒ architect primary', () => {
			const cfg = {
				agents: { coder: { model: 'opencode/gpt-5' } },
				max_iterations: 5,
				execution_mode: 'balanced',
			} as never;
			const r = getAgentConfigs(cfg);
			expect(r['architect'].mode).toBe('primary');
			expect(r['coder'].mode).toBe('subagent');
		});

		test('default_agent: "coder" ⇒ coder primary', () => {
			const r = getAgentConfigs({ default_agent: 'coder' } as never);
			expect(r['architect'].mode).toBe('subagent');
			expect(r['coder'].mode).toBe('primary');
			expect(r['coder'].permission).toEqual({ task: 'allow' });
		});

		test('default_agent: "reviewer" ⇒ reviewer primary', () => {
			const r = getAgentConfigs({ default_agent: 'reviewer' } as never);
			expect(r['architect'].mode).toBe('subagent');
			expect(r['reviewer'].mode).toBe('primary');
		});
	});

	describe('multi-swarm (the bug surface)', () => {
		test('only prefixed swarms, no default_agent ⇒ every *_architect is primary', () => {
			const r = getAgentConfigs(multiSwarmConfig() as never);
			// Each swarm registers its own architect under a prefix.
			expect(r['local_architect'].mode).toBe('primary');
			expect(r['mega_architect'].mode).toBe('primary');
			expect(r['paid_architect'].mode).toBe('primary');
			expect(r['modelrelay_architect'].mode).toBe('primary');
			// Coders are subagents.
			expect(r['local_coder'].mode).toBe('subagent');
			expect(r['mega_coder'].mode).toBe('subagent');
			// There is no unprefixed architect agent in this config.
			expect(r['architect']).toBeUndefined();
		});

		test('regression: at least one primary agent exists when only prefixed swarms (no default)', () => {
			const r = getAgentConfigs(multiSwarmConfig() as never);
			const primaries = Object.entries(r).filter(
				([, v]) => v.mode === 'primary',
			);
			// Previous v7.3.x bug zeroed this out — no agent was primary because
			// PluginConfigSchema defaulted default_agent to "architect" and no
			// agent literally named "architect" existed.
			expect(primaries.length).toBeGreaterThan(0);
		});

		test('default swarm + extra swarms, no default_agent ⇒ architect AND every *_architect primary', () => {
			const r = getAgentConfigs(multiSwarmWithDefaultConfig() as never);
			expect(r['architect'].mode).toBe('primary');
			expect(r['local_architect'].mode).toBe('primary');
			expect(r['mega_architect'].mode).toBe('primary');
			expect(r['local_coder'].mode).toBe('subagent');
		});

		test('default_agent: "local_architect" ⇒ only local_architect primary', () => {
			const r = getAgentConfigs(
				multiSwarmConfig({ default_agent: 'local_architect' }) as never,
			);
			expect(r['local_architect'].mode).toBe('primary');
			expect(r['mega_architect'].mode).toBe('subagent');
			expect(r['paid_architect'].mode).toBe('subagent');
			expect(r['modelrelay_architect'].mode).toBe('subagent');
		});

		test('default_agent: "architect" ⇒ all generated architect-role agents primary', () => {
			const r = getAgentConfigs(
				multiSwarmConfig({ default_agent: 'architect' }) as never,
			);
			expect(r['local_architect'].mode).toBe('primary');
			expect(r['mega_architect'].mode).toBe('primary');
			expect(r['paid_architect'].mode).toBe('primary');
			expect(r['modelrelay_architect'].mode).toBe('primary');
			expect(r['local_coder'].mode).toBe('subagent');
		});

		test('default_agent: "architect" with default swarm + extras ⇒ unprefixed AND all *_architect primary', () => {
			// Tests the base-role-beats-exact-match ordering when both forms of
			// architect agent exist in the same plugin config.
			const r = getAgentConfigs(
				multiSwarmWithDefaultConfig({ default_agent: 'architect' }) as never,
			);
			expect(r['architect'].mode).toBe('primary');
			expect(r['local_architect'].mode).toBe('primary');
			expect(r['mega_architect'].mode).toBe('primary');
			expect(r['local_coder'].mode).toBe('subagent');
		});

		test('default_agent: "local_coder" ⇒ only local_coder primary', () => {
			const r = getAgentConfigs(
				multiSwarmConfig({ default_agent: 'local_coder' }) as never,
			);
			expect(r['local_coder'].mode).toBe('primary');
			expect(r['mega_coder'].mode).toBe('subagent');
			expect(r['local_architect'].mode).toBe('subagent');
		});

		test('default_agent: "coder" ⇒ all generated coder-role agents primary', () => {
			const r = getAgentConfigs(
				multiSwarmConfig({ default_agent: 'coder' }) as never,
			);
			expect(r['local_coder'].mode).toBe('primary');
			expect(r['mega_coder'].mode).toBe('primary');
			expect(r['paid_coder'].mode).toBe('primary');
			expect(r['modelrelay_coder'].mode).toBe('primary');
			expect(r['local_architect'].mode).toBe('subagent');
		});

		test('invalid default_agent in multi-swarm ⇒ falls back to architect-role agents', () => {
			const r = getAgentConfigs(
				multiSwarmConfig({ default_agent: 'totally_invalid_xyz' }) as never,
			);
			expect(r['local_architect'].mode).toBe('primary');
			expect(r['mega_architect'].mode).toBe('primary');
			expect(r['paid_architect'].mode).toBe('primary');
			expect(r['modelrelay_architect'].mode).toBe('primary');
			// Did not zero out primaries.
			const primaries = Object.values(r).filter((c) => c.mode === 'primary');
			expect(primaries.length).toBeGreaterThan(0);
		});

		test('all architects disabled + invalid default_agent ⇒ falls back to one primary, never zero', () => {
			const cfg = {
				swarms: {
					local: {
						name: 'Local',
						agents: {
							architect: { disabled: true },
							coder: { model: 'm' },
						},
					},
					mega: {
						name: 'Mega',
						agents: {
							architect: { disabled: true },
							coder: { model: 'm' },
						},
					},
				},
				default_agent: 'made_up_xyz',
			} as never;
			const r = getAgentConfigs(cfg);
			const primaries = Object.entries(r).filter(
				([, v]) => v.mode === 'primary',
			);
			expect(primaries.length).toBeGreaterThanOrEqual(1);
			expect(r['local_architect']).toBeUndefined();
			expect(r['mega_architect']).toBeUndefined();
		});
	});

	describe('primary agent permissions and model handling', () => {
		test('primary has task:allow and no model; subagents retain model', () => {
			const r = getAgentConfigs({ default_agent: 'coder' } as never);
			expect(r['coder'].permission).toEqual({ task: 'allow' });
			expect(r['coder'].model).toBeUndefined();
			// architect (subagent now) keeps its model field untouched
			expect(r['architect'].permission).toBeUndefined();
		});

		test('multi-swarm primary architects have permission set; subagent coders do not', () => {
			const r = getAgentConfigs(multiSwarmConfig() as never);
			expect(r['local_architect'].permission).toEqual({ task: 'allow' });
			expect(r['mega_architect'].permission).toEqual({ task: 'allow' });
			expect(r['local_coder'].permission).toBeUndefined();
		});
	});

	describe('integration: schema parse → resolver', () => {
		test('parsed schema flows to resolver, omitted default_agent stays undefined', () => {
			const parsed = PluginConfigSchema.safeParse(multiSwarmConfig());
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(parsed.data.default_agent).toBeUndefined();
				const r = getAgentConfigs(parsed.data);
				expect(r['local_architect'].mode).toBe('primary');
				expect(r['mega_architect'].mode).toBe('primary');
			}
		});
	});
});
