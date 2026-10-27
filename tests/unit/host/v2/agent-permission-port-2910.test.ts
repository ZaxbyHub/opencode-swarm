/**
 * Issue #2910 residual scope item 3 — the v2 opt-in tool-map / permission
 * port. DISCRIMINATING at base. AMENDED (check-author round): the mapping
 * assertions were re-derived from the REAL v2 permission contract instead of
 * an invented `{ action: 'tool', resource: <name> }` shape.
 *
 * HOST SOURCE OF TRUTH (fetched + read for this amendment):
 *   https://raw.githubusercontent.com/sst/opencode/v2.0.29/packages/core/src/v1/config/migrate.ts
 *   (local mirror: .agents/issue-traces/2910-v2-dual-host-plugin-port/probe-v2sdk/migrate-v2.0.29.ts)
 *
 * The host's own v1->v2 permission migration is EXACTLY:
 *
 *   function permissions(info?: ConfigPermissionV1.Info) {
 *     const rules = (info ?? []).flatMap(([key, rule]) => {
 *       const action = normalizeAction(key)
 *       if (typeof rule === "string") return [{ action, resource: "*", effect: rule }]
 *       return rule.map(([resource, effect]) => ({ action, resource, effect }))
 *     })
 *     return rules.length ? rules : undefined
 *   }
 *   export function normalizeAction(action: string) {
 *     if (action === "write" || action === "patch") return "edit"
 *     if (action === "task") return "subagent"
 *     if (action === "bash") return "shell"
 *     return action
 *   }
 *
 * Frozen mapping contract for `mapV1AgentToV2`
 * (src/host/v2/agents-commands.ts):
 *  - The plugin's v1 `sdkConfig.permission` block (src/agents/index.ts
 *    buildPermissionBlock) is an OBJECT mapping name -> 'allow'|'deny'|'ask'
 *    (string effects only). Per the host migration a STRING effect maps to
 *    resource '*': rule = { action: normalizeAction(name), resource: '*',
 *    effect } — the tool name is NEVER the resource for a string effect.
 *  - normalizeAction EXACTLY as the host: `write` -> `edit`, `patch` ->
 *    `edit`, `task` -> `subagent`, `bash` -> `shell`, and EVERYTHING ELSE
 *    passes through VERBATIM as the action — `edit` stays `edit`,
 *    `apply_patch` stays `apply_patch` (migrate.ts has NO rewrite for it;
 *    only `write` and `patch` collapse to `edit`), and plugin tool names
 *    like `swarm_memory_recall` stay themselves. There is NO 'tool'
 *    catch-all literal anywhere in the host migration.
 *  - Nested per-resource OBJECTS (name -> { [resourceGlob]: effect }) — the
 *    REAL shape our builder emits, demonstrated at
 *    tests/unit/agents/getAgentConfigs-task-permission.test.ts:226-244
 *    (`external_directory: { 'C:/foo/*': 'allow' }` flowing out of the REAL
 *    getAgentConfigs). A mapper receiving one must mirror the host's nested
 *    expansion — { action: normalizeAction(name), resource, effect } per
 *    pair, migrate-v2.0.29.ts `permissions()` at
 *    .agents/issue-traces/2910-v2-dual-host-plugin-port/probe-v2sdk/migrate-v2.0.29.ts
 *    — but over OBJECT entries: nested objects expand via Object.entries IN
 *    INSERTION ORDER, each entry -> { action: normalizeAction(name),
 *    resource: <the nested key>, effect: <the nested value> }.
 *  - Preserve-and-append: the host-shaped v2 agent object handed to the
 *    agent editor's update(id, fn) may ALREADY carry default permission
 *    rules; the mapper must PRESERVE those and APPEND the migrated v1 rules
 *    AFTER them (v2 is last-match-wins — later rules override, so the
 *    migrated policy wins over the host defaults).
 *  - Effects 'deny' / 'allow' / 'ask' are preserved verbatim.
 *
 * The v1 permission block is the ONLY enforceable tool-gating channel
 * (src/agents/index.ts deletes `sdkConfig.tools` at the emit site — issue
 * #2528 — and writes deny/allow into `sdkConfig.permission`). The v1
 * `config` hook merges that table into `opencodeConfig.agent`, so the v2
 * adapter's synthetic config-hook run (`registerV2AgentsAndCommands`)
 * RECEIVES agent entries carrying `permission` blocks — but
 * `mapV1AgentToV2` never reads `config.permission` (it only maps a legacy
 * `tools` field), so every v2 agent ships `permissions: undefined` and NONE
 * of the intended denies are enforced on an OpenCode 2 host.
 *
 * The memory opt-in (`memory.enabled`) flips the REAL `getAgentConfigs` deny
 * computation exactly as on v1: DISABLED -> the architect denies
 * `swarm_memory_recall`; ENABLED -> no mapped rule denies it (ground truth
 * probed at base: deny count 39 disabled / 36 enabled, `task: 'allow'`
 * both ways, architect carries NO `tools` field).
 *
 * Base behavior (recorded): every `permissions` assertion fails — the
 * mapping is absent, not partial.
 *
 * Fakes only (no mock.module): the v2 ctx is a plain recording object whose
 * agent transform captures editor.update payloads; agent tables come from
 * the REAL getAgentConfigs where the task requires it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { getAgentConfigs } from '../../../../src/agents';
import type { PluginConfig } from '../../../../src/config';
import { registerV2AgentsAndCommands } from '../../../../src/host/v2/agents-commands';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

/** A mapped v2 Agent.Info as captured from the agent editor. */
interface CapturedAgent {
	id: string;
	permissions?: Array<{
		action: string;
		resource: string;
		effect: string;
	}>;
	[key: string]: unknown;
}

interface CapturedPermissionRule {
	action: string;
	resource: string;
	effect: string;
}

/**
 * Default permission rules a HOST-SHAPED v2 agent already carries when the
 * agent editor's update(id, fn) hands it to the mapper: the LITERAL
 * `Agent.Info.default(id)` permissions array of the pinned host, used
 * VERBATIM (fetched for this amendment from
 * https://raw.githubusercontent.com/sst/opencode/v2.0.29/packages/schema/src/agent.ts
 * — Info statics: `default: (id) => ({ ... permissions: [
 *   { action: "*", resource: "*", effect: "allow" },
 *   { action: "read", resource: "*.env", effect: "ask" },
 *   { action: "read", resource: "*.env.*", effect: "ask" },
 *   { action: "read", resource: "*.env.example", effect: "allow" },
 * ] })`). They are PRE-EXISTING host rules: the mapper must preserve them
 * and append the migrated v1 rules AFTER them.
 */
const HOST_AGENT_DEFAULT_PERMISSIONS: CapturedPermissionRule[] = [
	{ action: '*', resource: '*', effect: 'allow' },
	{ action: 'read', resource: '*.env', effect: 'ask' },
	{ action: 'read', resource: '*.env.*', effect: 'ask' },
	{ action: 'read', resource: '*.env.example', effect: 'allow' },
];

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

interface RecordingCtx {
	ctx: unknown;
	agentUpdates: CapturedAgent[];
	removedAgents: string[];
}

/**
 * Fake v2 ctx whose agent domain records editor payloads. update(id, fn)
 * seeds a HOST-SHAPED agent already carrying default permission rules (see
 * HOST_AGENT_DEFAULT_PERMISSIONS) — exactly what a real v2 host passes when
 * updating a built-in agent.
 */
function recordingCtx(): RecordingCtx {
	const agentUpdates: CapturedAgent[] = [];
	const removedAgents: string[] = [];
	const registration = { dispose: async () => {} };
	const ctx = {
		agent: {
			transform: async (
				cb: (editor: {
					update(id: string, fn: (agent: CapturedAgent) => void): void;
					remove(id: string): void;
					list(): CapturedAgent[];
					get(id: string): CapturedAgent | undefined;
					default(id: string | undefined): void;
				}) => void,
			) => {
				cb({
					update(id, fn) {
						const record: CapturedAgent = {
							id,
							permissions: HOST_AGENT_DEFAULT_PERMISSIONS.map((rule) => ({
								...rule,
							})),
						};
						fn(record);
						agentUpdates.push(record);
					},
					remove(id) {
						removedAgents.push(id);
					},
					list: () => [],
					get: () => undefined,
					default: () => {},
				});
				return registration;
			},
			reload: async () => {},
		},
		command: {
			transform: async (
				cb: (editor: { add(definition: unknown): void }) => void,
			) => {
				cb({ add: () => {} });
				return registration;
			},
			reload: async () => {},
		},
		session: {
			hook: async () => registration,
			prompt: async () => {},
		},
	};
	return { ctx, agentUpdates, removedAgents };
}

/** Register one agent table through the REAL registerV2AgentsAndCommands. */
async function registerAgentTable(
	table: Record<string, Record<string, unknown>>,
): Promise<RecordingCtx> {
	const recording = recordingCtx();
	const hooks = {
		config: async (cfg: Record<string, unknown>) => {
			cfg.agent = table;
		},
	} as V1HooksSubset;
	await registerV2AgentsAndCommands(
		recording.ctx as never,
		hooks,
		trackedMkdtemp('swarm-2910-perm-'),
		[],
	);
	return recording;
}

function findAgent(
	recording: RecordingCtx,
	suffix: string,
): CapturedAgent | undefined {
	return (
		recording.agentUpdates.find((a) => a.id === suffix) ??
		recording.agentUpdates.find((a) => a.id.endsWith(`_${suffix}`))
	);
}

/** Mapped rules addressing one v1 permission key (by ACTION per the host
 * migration — the v1 key becomes the action, the resource is '*'). */
function rulesForAction(
	agent: CapturedAgent,
	action: string,
): CapturedPermissionRule[] {
	return (agent.permissions ?? []).filter((rule) => rule.action === action);
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await removeTreeWithRetry(dir);
	}
});

describe('v2 agent permission port (issue #2910 residual scope item 3)', () => {
	test('mapV1AgentToV2 port: host-default rules preserved, migrated v1 rules appended after them with the host normalizeAction table', async () => {
		const recording = await registerAgentTable({
			reviewer_2910: {
				mode: 'subagent',
				prompt: 'You review code.',
				description: 'read-only reviewer',
				permission: {
					// plugin tool name -> action VERBATIM (no 'tool' catch-all)
					swarm_memory_recall: 'deny',
					// host rewrites: write -> edit, edit -> edit (identity)
					write: 'deny',
					edit: 'deny',
					// apply_patch: migrate.ts has NO rewrite — stays VERBATIM
					apply_patch: 'deny',
					// bash -> shell, task -> subagent
					bash: 'allow',
					task: 'allow',
					// unknown key verbatim + the 'ask' effect preserved
					web_fetch: 'ask',
					// nested per-resource OBJECT — the REAL builder shape
					// (getAgentConfigs-task-permission.test.ts:226-244) —
					// expands over Object.entries IN INSERTION ORDER
					external_directory: {
						'C:/secret/**': 'deny',
						'C:/public/**': 'allow',
					},
				},
			},
		});
		const reviewer = recording.agentUpdates.find(
			(a) => a.id === 'reviewer_2910',
		);
		expect(reviewer).toBeDefined();
		// BASE DEFECT: mapV1AgentToV2 never reads config.permission, so the
		// mapped v2 agent keeps only the host defaults and no migrated rule
		// exists.
		expect(reviewer?.permissions).toBeDefined();
		const permissions = reviewer?.permissions ?? [];

		// (a) PRESERVE: the host-shaped agent's pre-existing default rules
		// survive the mapping, in their leading positions...
		expect(permissions.slice(0, HOST_AGENT_DEFAULT_PERMISSIONS.length)).toEqual(
			HOST_AGENT_DEFAULT_PERMISSIONS,
		);
		// ...and (APPEND AFTER) every migrated rule lands after them — the
		// seeded defaults plus exactly the 9 migrated rules of the fixture
		// (7 string effects + 2 nested pairs). v2 is last-match-wins, so the
		// migrated policy must be the LATER, overriding half.
		expect(permissions.length).toBe(HOST_AGENT_DEFAULT_PERMISSIONS.length + 9);

		// (b) normalization table — the host's migrate.ts, verbatim.
		// String effect -> resource '*' (never the tool name as resource).
		expect(permissions).toContainEqual({
			action: 'swarm_memory_recall',
			resource: '*',
			effect: 'deny',
		});
		expect(permissions).toContainEqual({
			action: 'edit',
			resource: '*',
			effect: 'deny',
		});
		expect(permissions).toContainEqual({
			action: 'apply_patch',
			resource: '*',
			effect: 'deny',
		});
		expect(permissions).toContainEqual({
			action: 'shell',
			resource: '*',
			effect: 'allow',
		});
		expect(permissions).toContainEqual({
			action: 'subagent',
			resource: '*',
			effect: 'allow',
		});
		// (c) 'deny' / 'allow' / 'ask' effects preserved verbatim.
		expect(permissions).toContainEqual({
			action: 'web_fetch',
			resource: '*',
			effect: 'ask',
		});
		// Nested per-resource OBJECTS mirror the host's nested expansion over
		// Object.entries, and INSERTION ORDER is preserved (deny before allow).
		expect(permissions).toContainEqual({
			action: 'external_directory',
			resource: 'C:/secret/**',
			effect: 'deny',
		});
		expect(permissions).toContainEqual({
			action: 'external_directory',
			resource: 'C:/public/**',
			effect: 'allow',
		});
		expect(
			permissions
				.filter((rule) => rule.action === 'external_directory')
				.map((rule) => rule.resource),
		).toEqual(['C:/secret/**', 'C:/public/**']);
		// The host migration has NO 'tool' catch-all literal — none may appear.
		expect(permissions.some((rule) => rule.action === 'tool')).toBe(false);
	});

	test('memory DISABLED: the REAL getAgentConfigs deny set flows through the mapper — swarm_memory_recall denied for the architect', async () => {
		const table = getAgentConfigs({
			memory: { enabled: false },
		} as PluginConfig) as unknown as Record<string, Record<string, unknown>>;
		// Ground truth on the v1 channel (the enforceable surface): the deny
		// exists in the emitted permission block.
		const architectEntry =
			table.architect ??
			Object.entries(table).find(([name]) => name.endsWith('_architect'))?.[1];
		expect(architectEntry?.permission?.swarm_memory_recall).toBe('deny');

		const recording = await registerAgentTable(table);
		const architect = findAgent(recording, 'architect');
		expect(architect).toBeDefined();
		expect(architect?.permissions).toBeDefined();
		// Denied via the MAPPED rule's effect for that tool: per the host
		// migration a denied plugin tool is { action: 'swarm_memory_recall',
		// resource: '*', effect: 'deny' }.
		expect(architect?.permissions).toContainEqual({
			action: 'swarm_memory_recall',
			resource: '*',
			effect: 'deny',
		});
	});

	test('memory ENABLED: the opt-in removes the swarm_memory_recall deny from the mapped rules', async () => {
		const table = getAgentConfigs({
			memory: { enabled: true },
		} as PluginConfig) as unknown as Record<string, Record<string, unknown>>;
		const architectEntry =
			table.architect ??
			Object.entries(table).find(([name]) => name.endsWith('_architect'))?.[1];
		expect(architectEntry?.permission?.swarm_memory_recall).not.toBe('deny');

		const recording = await registerAgentTable(table);
		const architect = findAgent(recording, 'architect');
		expect(architect).toBeDefined();
		expect(architect?.permissions).toBeDefined();
		// NOT denied when opted in — no mapped rule denies that action.
		expect(
			rulesForAction(architect!, 'swarm_memory_recall').some(
				(rule) => rule.effect === 'deny',
			),
		).toBe(false);
		// Tool filtering itself stays active in both modes (probed ground
		// truth: 36 denies for the memory-enabled architect): the mapped deny
		// set is still substantial.
		expect(
			(architect?.permissions ?? []).filter((rule) => rule.effect === 'deny')
				.length,
		).toBeGreaterThan(10);
		// The primary delegation win is present in both modes — v1
		// `task: 'allow'` migrates to action 'subagent'.
		expect(
			rulesForAction(architect!, 'subagent').some(
				(rule) => rule.effect === 'allow',
			),
		).toBe(true);
	});
});
