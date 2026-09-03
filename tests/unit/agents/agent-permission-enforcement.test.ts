/**
 * Issue #2528 / audit HOST-1 — per-agent tool boundaries must be enforced by
 * the HOST, not just advertised.
 *
 * The old code serialized per-agent `tools` maps the pinned host
 * (@opencode-ai/plugin 1.18.3) provably never reads for plugin-injected
 * agents (2,388 intended denies, 0 enforced). The fix emits per-agent
 * `permission` blocks with enumerated denies; the host's Permission.disabled
 * gate (via resolveTools) hides denied tools from the LLM request.
 *
 * These tests drive the REAL getAgentConfigs output through a verbatim
 * transcription of the pinned host's permission machinery
 * (tests/helpers/opencode-permission-model.ts) — the repo's established
 * substrate for verifying emitted rules against real host semantics. No
 * opencode host binary is spawned (no precedent; needs an LLM). The
 * structural alias-list pins below are the tripwire against transcription
 * drift: if a future host release changes disabled()/defaults, re-extract
 * before "fixing" these tests.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { AgentDefinition } from '../../../src/agents/architect';
import {
	_internals as agentsInternals,
	getAgentConfigs,
} from '../../../src/agents/index';
import { SKILL_TOOL_NAMES } from '../../../src/config/constants';
import {
	PluginConfigSchema,
	stripKnownSwarmPrefix,
} from '../../../src/config/schema';
import { AGENT_TOOL_MAP, TOOL_NAMES } from '../../../src/tools/tool-metadata';
import {
	HOST_DISABLED_EDITS,
	HOST_DISABLED_READS,
	hostAgentRulesetForPluginAgent,
	hostDisabled,
	hostEvaluate,
	hostResolveTools,
} from '../../helpers/opencode-permission-model';

/** The host built-ins a plugin agent may need; none of them are plugin tools. */
const HOST_BUILTIN_TOOLS = [
	'read',
	'grep',
	'glob',
	'list',
	'bash',
	'task',
	'webfetch',
	'websearch',
	'todowrite',
	'edit',
	'write',
	'patch',
	'apply_patch',
	'create_file',
	'insert',
	'replace',
	'question',
] as const;

const TOOL_UNIVERSE = [...TOOL_NAMES, ...HOST_BUILTIN_TOOLS];

function configsFor(raw: Record<string, unknown> = {}) {
	return getAgentConfigs(PluginConfigSchema.parse(raw));
}

function denyEntries(permission: Record<string, unknown> | undefined) {
	return Object.entries(permission ?? {}).filter(
		([, v]) => v === 'deny',
	) as Array<[string, string]>;
}

/** Plugin-tool denies = deny entries whose name is a registered plugin tool. */
function deniedPluginTools(permission: Record<string, unknown> | undefined) {
	return denyEntries(permission)
		.map(([name]) => name)
		.filter((name) => (TOOL_NAMES as readonly string[]).includes(name));
}

/** The tools the host would keep in this agent's LLM request. */
function visibleFor(permission: Record<string, unknown> | undefined) {
	return hostResolveTools(
		TOOL_UNIVERSE,
		hostAgentRulesetForPluginAgent(undefined, permission ?? {}),
	);
}

describe('host permission machinery transcription pins (tripwire)', () => {
	test('disabled() alias lists match the pinned host v1.18.3 verbatim', () => {
		expect([...HOST_DISABLED_EDITS]).toEqual(['edit', 'write', 'apply_patch']);
		expect([...HOST_DISABLED_READS]).toEqual([
			'list_mcp_resources',
			'list_mcp_resource_templates',
			'read_mcp_resource',
		]);
		// Structural source pin — the alias list elements must appear in the
		// helper source itself (whitespace-normalized so formatting cannot
		// break the pin), catching accidental "cleanup" divergence.
		const helperSource = readFileSync(
			path.join(
				import.meta.dir,
				'..',
				'..',
				'helpers',
				'opencode-permission-model.ts',
			),
			'utf-8',
		).replace(/\s+/g, ' ');
		expect(helperSource).toContain("'edit', 'write', 'apply_patch'");
	});

	test('edit deny hides edit/write/apply_patch but NOT patch; patch needs its own rule', () => {
		const ruleset = hostAgentRulesetForPluginAgent(undefined, { edit: 'deny' });
		const hidden = hostDisabled([...HOST_BUILTIN_TOOLS], ruleset);
		expect(hidden.has('edit')).toBe(true);
		expect(hidden.has('write')).toBe(true);
		expect(hidden.has('apply_patch')).toBe(true);
		// patch is NOT in disabled()'s edits alias list (v1.18.3) — an
		// edit deny alone must not hide it…
		expect(hidden.has('patch')).toBe(false);
		// …but an explicit patch rule does.
		const withPatch = hostAgentRulesetForPluginAgent(undefined, {
			edit: 'deny',
			patch: 'deny',
		});
		expect(hostDisabled(['patch'], withPatch).has('patch')).toBe(true);
	});

	test('a plugin tool id is its own permission name — deny hides exactly it', () => {
		const ruleset = hostAgentRulesetForPluginAgent(undefined, {
			swarm_apply_patch: 'deny',
		});
		expect(
			hostDisabled(['swarm_apply_patch'], ruleset).has('swarm_apply_patch'),
		).toBe(true);
		expect(hostDisabled(['save_plan'], ruleset).has('save_plan')).toBe(false);
	});
});

describe('runtime replay — denied tools are hidden by the host gate (#2528)', () => {
	const agents = configsFor();

	test('reviewer: write/edit/apply_patch/patch refused by the host (exit gate)', () => {
		const visible = visibleFor(agents.reviewer.permission);
		// The exit gate of the issue: a reviewer agent's write call is
		// refused by the host, not by a plugin-side check.
		expect(visible.has('write')).toBe(false);
		expect(visible.has('edit')).toBe(false);
		expect(visible.has('apply_patch')).toBe(false);
		expect(visible.has('patch')).toBe(false);
		// …while an allowed read-side tool and an allowed plugin tool stay usable.
		expect(visible.has('read')).toBe(true);
		expect(visible.has('bash')).toBe(true);
		expect(visible.has('diff')).toBe(true); // reviewer's #1 allow-listed tool
	});

	test.each([
		['architect', 'primary/orchestrator'],
		['explorer', 'pipeline'],
		['coder', 'pipeline'],
		['test_engineer', 'pipeline'],
		['sme', 'advisory'],
		['researcher', 'advisory'],
		['docs', 'content'],
		['spec_writer', 'content'],
		['critic_sounding_board', 'critic-variant'],
		['curator_phase', 'curator-variant'],
	] as const)('%s (%s): allow-list enforced through host disabled()', (name) => {
		const permission = agents[name]?.permission;
		expect(permission).toBeDefined();
		const allow = new Set(AGENT_TOOL_MAP[name]);
		const visible = visibleFor(permission);
		// One denied plugin tool (first registered tool not in its map) is hidden…
		const deniedTool = TOOL_NAMES.find((t) => !allow.has(t));
		expect(deniedTool).toBeDefined();
		expect(visible.has(deniedTool as string)).toBe(false);
		// …one allowed plugin tool is visible…
		const allowedTool = TOOL_NAMES.find((t) => allow.has(t));
		expect(allowedTool).toBeDefined();
		expect(visible.has(allowedTool as string)).toBe(true);
		// …and host built-ins the roles rely on are untouched.
		expect(visible.has('read')).toBe(true);
		expect(visible.has('grep')).toBe(true);
		expect(visible.has('glob')).toBe(true);
		expect(visible.has('list')).toBe(true);
	});

	test('architect keeps delegation: task visible and allow is the LAST entry', () => {
		const permission = agents.architect.permission as Record<string, unknown>;
		expect(permission.task).toBe('allow');
		expect(Object.keys(permission).at(-1)).toBe('task');
		expect(visibleFor(permission).has('task')).toBe(true);
		expect(visibleFor(permission).has('save_plan')).toBe(true);
	});

	test('coder (write-capable role) keeps edit/write available', () => {
		const visible = visibleFor(agents.coder.permission);
		expect(visible.has('edit')).toBe(true);
		expect(visible.has('write')).toBe(true);
	});

	test('read-only roles by factory contract deny the write family', () => {
		for (const name of [
			'reviewer',
			'critic',
			'explorer',
			'sme',
			'researcher',
			'critic_oversight',
			'curator_init',
		]) {
			const visible = visibleFor(agents[name].permission);
			expect(visible.has('write')).toBe(false);
			expect(visible.has('edit')).toBe(false);
		}
		// researcher additionally denies the extended write family by name.
		const researcherVisible = visibleFor(agents.researcher.permission);
		expect(researcherVisible.has('swarm_apply_patch')).toBe(false);
		expect(researcherVisible.has('create_file')).toBe(false);
	});

	test('no emitted rule touches pattern-gated host permissions (lanes/user config preserved)', () => {
		for (const [name, cfg] of Object.entries(agents)) {
			const ruleset = hostAgentRulesetForPluginAgent(undefined, cfg.permission);
			// external_directory keeps the host default ask — our denies must
			// not resolve it (this is the lane-allowlist protection).
			expect(
				hostEvaluate('external_directory', 'C:/any/where/*', ruleset).action,
			).toBe('ask');
			// read keeps the host's .env asks — a bare read allow would flatten them.
			expect(hostEvaluate('read', 'x.env', ruleset).action).toBe('ask');
			expect(hostEvaluate('read', 'x.ts', ruleset).action).toBe('allow');
			expect(name).toBeDefined();
		}
	});

	test('plugin deny beats the host default allow (deny really denies)', () => {
		const ruleset = hostAgentRulesetForPluginAgent(
			undefined,
			agents.reviewer.permission,
		);
		// Host default is '*': allow' FIRST; our later deny must win.
		expect(hostDisabled(['save_plan'], ruleset).has('save_plan')).toBe(true);
	});

	test('user top-level config still governs tools we emit no entry for', () => {
		// A user deny of a tool we do not manage (bash) applies to our agents.
		const ruleset = hostAgentRulesetForPluginAgent(
			{ bash: 'deny' },
			agents.coder.permission,
		);
		expect(hostDisabled(['bash'], ruleset).has('bash')).toBe(true);
		// A user allow of a tool we do not deny also applies (spec_writer has
		// no write denial — the docs-writer role may write host-side).
		const allowedRuleset = hostAgentRulesetForPluginAgent(
			{ write: 'allow' },
			agents.spec_writer.permission,
		);
		expect(hostDisabled(['write'], allowedRuleset).has('write')).toBe(false);
	});
});

describe('no orphaned tools maps; permission parity with the allow-lists', () => {
	test('default config: no agent ships a tools map; every agent ships a permission block', () => {
		const agents = configsFor();
		// Exact default-roster size: a new/renamed agent must be a conscious
		// change, not something this file silently absorbs.
		expect(Object.keys(agents).length).toBe(21);
		for (const [name, cfg] of Object.entries(agents)) {
			expect('tools' in cfg).toBe(false);
			expect(cfg.permission).toBeDefined();
			expect(deniedPluginTools(cfg.permission).length).toBeGreaterThan(0);
		}
	});

	test('per-agent plugin-tool denies equal TOOL_NAMES minus the allow-list (audit parity)', () => {
		const agents = configsFor();
		let totalDenies = 0;
		let totalAllows = 0;
		for (const [name, cfg] of Object.entries(agents)) {
			const base = stripKnownSwarmPrefix(name);
			const allow = new Set(
				AGENT_TOOL_MAP[base as keyof typeof AGENT_TOOL_MAP] ?? [],
			);
			const denied = new Set(deniedPluginTools(cfg.permission));
			// deny set == universe minus allow-list, exactly.
			expect(denied.size).toBe(TOOL_NAMES.length - allow.size);
			for (const tool of TOOL_NAMES) {
				expect(denied.has(tool)).toBe(!allow.has(tool));
			}
			totalDenies += denied.size;
			totalAllows += allow.size;
		}
		// Total parity computed from the live role maps (no magic constant):
		// rosterSize × 129 − Σ allow-lists. For the default 21-agent roster
		// this is 2,387 — the audit's "2,388 intended denies" over the same
		// universe (±1 from the audit's counting detail). The point: every
		// intended deny is now an emitted, host-enforced deny.
		const rosterSize = Object.keys(agents).length;
		expect(totalDenies).toBe(rosterSize * TOOL_NAMES.length - totalAllows);
		expect(totalDenies).toBeGreaterThan(2300);
	});

	test('multi-swarm: prefixed agents get the same contract, no tools map', () => {
		const agents = configsFor({
			swarms: { local: { name: 'Local', agents: {} } },
		});
		expect(agents.local_reviewer).toBeDefined();
		expect('tools' in agents.local_reviewer).toBe(false);
		const visible = visibleFor(agents.local_reviewer.permission);
		expect(visible.has('write')).toBe(false);
		expect(visible.has('diff')).toBe(true);
	});

	test.each([
		[{ memory: { enabled: true } }, 'memory on'],
		[{ council: { enabled: true, general: { enabled: true } } }, 'council on'],
		[{ turbo: { strategy: 'standard' as const } }, 'turbo on'],
		[{ skills: { enabled: true } }, 'skills on'],
		[{ external_skills: { curation_enabled: true } }, 'external skills on'],
	])('feature flags (%s): still no tools map, denies track the gated allow-list', (raw) => {
		const agents = configsFor(raw as Record<string, unknown>);
		for (const cfg of Object.values(agents)) {
			expect('tools' in cfg).toBe(false);
			expect(cfg.permission).toBeDefined();
		}
		// Gated-on tools are NOT denied for the architect.
		const denied = new Set(deniedPluginTools(agents.architect.permission));
		expect(denied.has('swarm_memory_recall')).toBe(raw.memory ? false : true);
		expect(denied.has('submit_council_verdicts')).toBe(
			raw.council ? false : true,
		);
		expect(denied.has('lean_turbo_plan_lanes')).toBe(raw.turbo ? false : true);
		expect(denied.has('skill_generate')).toBe(raw.skills ? false : true);
		expect(denied.has('external_skill_discover')).toBe(
			raw.external_skills ? false : true,
		);
	});
});

describe('emission order is precedence (host findLast pins)', () => {
	test('deny keys appear in TOOL_NAMES order, then factory-floor names', () => {
		const permission = configsFor().reviewer.permission as Record<
			string,
			unknown
		>;
		const keys = Object.keys(permission);
		const pluginKeys = keys.filter((k) =>
			(TOOL_NAMES as readonly string[]).includes(k),
		);
		const toolOrder = TOOL_NAMES as readonly string[];
		const ranks = pluginKeys.map((k) => toolOrder.indexOf(k));
		expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
		// The factory floor (edit/patch) trails the entire plugin enumeration:
		// the last two keys are the floor, in emission order.
		expect(keys.at(-2)).toBe('edit');
		expect(keys.at(-1)).toBe('patch');
		expect(keys.indexOf('edit')).toBeGreaterThan(
			pluginKeys.reduce((max, k) => Math.max(max, keys.indexOf(k)), -1),
		);
		expect(permission.edit).toBe('deny');
		expect(permission.patch).toBe('deny');
	});

	test('emitted blocks contain no allow entries except task on primaries', () => {
		const agents = configsFor();
		for (const [name, cfg] of Object.entries(agents)) {
			for (const [key, value] of Object.entries(cfg.permission ?? {})) {
				if (value === 'allow') {
					expect(key).toBe('task');
				}
			}
			const isPrimary = cfg.mode === 'primary';
			expect((cfg.permission as Record<string, unknown>).task === 'allow').toBe(
				isPrimary,
			);
			expect(name).toBeDefined();
		}
	});
});

describe('tool_filter runtime observability and role floor', () => {
	test('overrides shrink the deny set at runtime (host-visible)', () => {
		const agents = configsFor({
			tool_filter: { overrides: { reviewer: ['diff', 'diff_summary'] } },
		});
		const denied = new Set(deniedPluginTools(agents.reviewer.permission));
		expect(denied.size).toBe(TOOL_NAMES.length - 2);
		// The override is genuinely observable: diff visible, others hidden.
		const visible = visibleFor(agents.reviewer.permission);
		expect(visible.has('diff')).toBe(true);
		expect(visible.has('save_plan')).toBe(false);
	});

	test('tool_filter.enabled=false keeps the factory write-family floor (no silent fail-open)', () => {
		const agents = configsFor({ tool_filter: { enabled: false } });
		for (const cfg of Object.values(agents)) {
			expect('tools' in cfg).toBe(false);
		}
		const reviewerPermission = agents.reviewer.permission as Record<
			string,
			unknown
		>;
		// Role contract still enforced…
		expect(reviewerPermission.edit).toBe('deny');
		expect(reviewerPermission.patch).toBe('deny');
		// …while the plugin-tool surface is unrestricted (no plugin denies)…
		expect(deniedPluginTools(reviewerPermission)).toEqual([]);
		// …proven through the host gate.
		const visible = visibleFor(reviewerPermission);
		expect(visible.has('write')).toBe(false);
		expect(visible.has('save_plan')).toBe(true);
		// Primaries keep delegation in this mode too.
		expect((agents.architect.permission as Record<string, unknown>).task).toBe(
			'allow',
		);
	});
});

describe('FR-004: skills.enabled gating is genuine unreachability', () => {
	test('skills disabled: all 7 skill tools host-denied for every non-specialist agent', () => {
		const agents = configsFor();
		for (const [name, cfg] of Object.entries(agents)) {
			if (name === 'skill_improver') continue;
			const visible = visibleFor(cfg.permission);
			for (const tool of SKILL_TOOL_NAMES) {
				expect(visible.has(tool)).toBe(false);
			}
		}
	});

	test('override bypass closed: naming skill tools in an override still denies them', () => {
		const agents = configsFor({
			tool_filter: { overrides: { reviewer: ['skill_generate', 'diff'] } },
		});
		const visible = visibleFor(agents.reviewer.permission);
		expect(visible.has('skill_generate')).toBe(false);
		expect(visible.has('diff')).toBe(true);
	});

	test('skill_improver (the designed specialist) retains its skill tools', () => {
		const agents = configsFor();
		const visible = visibleFor(agents.skill_improver.permission);
		expect(visible.has('skill_generate')).toBe(true);
		expect(visible.has('skill_list')).toBe(true);
		expect(visible.has('skill_inspect')).toBe(true);
		expect(visible.has('skill_improve')).toBe(true);
		// …but not the architect-only apply/regenerate/retire trio.
		expect(visible.has('skill_apply')).toBe(false);
		expect(visible.has('skill_regenerate')).toBe(false);
	});

	test('skills enabled: architect gains all 7, genuinely allowed', () => {
		const agents = configsFor({ skills: { enabled: true } });
		const visible = visibleFor(agents.architect.permission);
		for (const tool of SKILL_TOOL_NAMES) {
			expect(visible.has(tool)).toBe(true);
		}
	});
});

describe('fail-closed fallback for unknown agent names (audit HOST-2)', () => {
	test('an agent with no allow-list entry denies the entire plugin surface', () => {
		const original = agentsInternals.createAgents;
		const synthetic: AgentDefinition[] = [
			{
				name: 'mystery_agent',
				description: 'synthetic unknown-role agent',
				config: { prompt: 'x', tools: { write: false, edit: false } },
			} as unknown as AgentDefinition,
		];
		agentsInternals.createAgents = () => synthetic;
		try {
			const agents = getAgentConfigs(PluginConfigSchema.parse({}));
			const permission = agents.mystery_agent.permission as Record<
				string,
				unknown
			>;
			expect(deniedPluginTools(permission)).toEqual([...TOOL_NAMES]);
			// The old fallback emitted an inert {write:false, edit:false} map;
			// the floor is now a real deny.
			expect(permission.edit).toBe('deny');
			const visible = visibleFor(permission);
			expect(visible.has('write')).toBe(false);
			expect(visible.has('save_plan')).toBe(false);
			expect(visible.has('read')).toBe(true);
		} finally {
			agentsInternals.createAgents = original;
		}
	});
});
