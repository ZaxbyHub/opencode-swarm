/**
 * End-to-end wiring: the REAL plugin `config` hook applies lane permissions.
 *
 * The guardrail's other wiring check is a source regex over `src/index.ts`,
 * which would still pass if the `applyLanePermissions` call moved behind an
 * early return, was wrapped in a disabled branch, or ran after the hook had
 * already returned. This test invokes `OpenCodeSwarm.server(...)` and then the
 * returned `config` hook itself, so only real behaviour can satisfy it.
 *
 * Both directions are asserted: a lane instance gets rules, and an ordinary
 * instance's permission surface is unchanged.
 *
 * The environment is ISOLATED (`createIsolatedTestEnv`). Without it the plugin
 * loads the developer's real global `opencode-swarm.json`, so the generated
 * agent set — and therefore this test's outcome — differs between a dev box and
 * CI. That is exactly how the PR #2015 failure hid: a local `swarms` block
 * prefixed every agent name, so the fixture agent was never clobbered.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentConfigs } from '../../../src/agents';
import {
	type LaneContext,
	_internals as laneContextInternals,
} from '../../../src/config/lane-context';
import { PluginConfigSchema } from '../../../src/config/schema';
import OpenCodeSwarm from '../../../src/index';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let dir: string;
let cleanup: () => void;
let envCleanup: () => void;
const realStat = laneContextInternals.statSync;
const realRead = laneContextInternals.readFileSync;
const realClear = laneContextInternals.clearCache;

beforeEach(() => {
	// Isolate XDG/HOME/APPDATA so the plugin cannot read the developer's real
	// global config; without this the generated agent set is machine-dependent.
	({ cleanup: envCleanup } = createIsolatedTestEnv());
	({ dir, cleanup } = createSafeTestDir('lane-hook-'));
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ quiet: true }),
		'utf-8',
	);
	realClear();
});

afterEach(() => {
	laneContextInternals.statSync = realStat;
	laneContextInternals.readFileSync = realRead;
	realClear();
	cleanup();
	envCleanup();
});

/** Runs the real plugin server() and returns its `config` hook. */
async function loadConfigHook(): Promise<
	(cfg: Record<string, unknown>) => Promise<void> | void
> {
	const hooks = await OpenCodeSwarm.server({
		client: {} as Record<string, unknown>,
		project: {} as Record<string, unknown>,
		directory: dir,
		worktree: dir,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as Record<string, unknown>,
	} as never);
	const hook = (hooks as Record<string, unknown>).config;
	expect(typeof hook).toBe('function');
	return hook as (cfg: Record<string, unknown>) => Promise<void> | void;
}

/** Forces lane detection to report `dir` as a lane, without a real git tree. */
function forceLane(): LaneContext {
	const lane: LaneContext = {
		lanePath: path.resolve(dir),
		parentProjectPath: path.resolve(path.join(dir, '..', 'parent-project')),
	};
	laneContextInternals.statSync = ((p: string) =>
		p === path.join(path.resolve(dir), '.git')
			? { isFile: () => true }
			: realStat(p)) as typeof laneContextInternals.statSync;
	laneContextInternals.readFileSync = ((p: string, enc: BufferEncoding) => {
		const gitDir = path.join(lane.parentProjectPath, '.git', 'worktrees', 'l1');
		if (p === path.join(path.resolve(dir), '.git')) {
			return `gitdir: ${gitDir.split(path.sep).join('/')}\n`;
		}
		if (p === path.join(gitDir, 'HEAD')) {
			return 'ref: refs/heads/swarm/lane/ses_0410b724cffeApmZIOs5VH9XsN/1.1\n';
		}
		if (p === path.join(gitDir, 'commondir')) return '../..\n';
		return realRead(p, enc);
	}) as typeof laneContextInternals.readFileSync;
	realClear();
	return lane;
}

/**
 * An agent name the plugin does NOT generate.
 *
 * FOUND BY CI (PR #2015). These tests originally used `coder`, which the plugin
 * DOES generate — `Object.assign(agentConfig, agents)` in the config hook
 * therefore replaced the fixture wholesale, dropping its `permission` key and
 * adding the generated prompt (hence the "SKILLS HANDLING" text in the CI diff)
 * and, because generated `coder` is a SUBAGENT, leaving no `permission` key at
 * all (hence the TypeError).
 *
 * It passed locally purely by accident of the developer's global config, which
 * declares a `swarms` block — multi-swarm configs PREFIX every agent name
 * (`mega_coder`, `local_coder`, ...), so no plain `coder` was generated and the
 * fixture survived. CI has no such config, so plain `coder` is generated.
 *
 * The guard below asserts the chosen name really is un-generated, so this
 * cannot silently rot if the agent set ever grows.
 */
const USER_AGENT_NAME = 'custom_user_agent';

describe('plugin config hook — real invocation', () => {
	test('the fixture agent name is one the plugin never generates', () => {
		const generated = getAgentConfigs(PluginConfigSchema.parse({}));
		expect(Object.hasOwn(generated, USER_AGENT_NAME)).toBe(false);
		// Sanity: the plugin really does generate agents, so this is a live check
		// rather than one that passes because the set is empty.
		expect(Object.keys(generated).length).toBeGreaterThan(5);
		// And pin the trap that caused the CI failure.
		expect(Object.hasOwn(generated, 'coder')).toBe(true);
	});

	test('an ordinary instance keeps its permission surface unchanged', async () => {
		const hook = await loadConfigHook();
		const config: Record<string, unknown> = {
			permission: { task: 'allow' },
			agent: {
				[USER_AGENT_NAME]: { permission: { external_directory: 'ask' } },
			},
		};
		const beforePermission = structuredClone(config.permission);
		const beforeAgent = structuredClone(
			(config.agent as Record<string, unknown>)[USER_AGENT_NAME],
		);

		await hook(config);

		// The hook legitimately ADDS its own agents and a /swarm command, so
		// whole-config equality was never the right claim. What must not change
		// outside a lane is the PERMISSION SURFACE:
		//  - the top-level permission block, and
		//  - the permission of an agent the plugin does not own.
		expect(config.permission).toEqual(beforePermission);
		expect(
			(config.agent as Record<string, Record<string, unknown>>)[
				USER_AGENT_NAME
			],
		).toEqual(beforeAgent as Record<string, unknown>);
		// Specifically: an ordinary session must NOT get external_directory rules.
		expect(
			Object.hasOwn(config.permission as object, 'external_directory'),
		).toBe(false);
		// And the user's own `ask` must survive untouched outside a lane.
		expect(
			(
				(config.agent as Record<string, Record<string, unknown>>)[
					USER_AGENT_NAME
				].permission as Record<string, unknown>
			).external_directory,
		).toBe('ask');
	});

	test('a lane instance gets external_directory rules with the catch-all deny', async () => {
		const lane = forceLane();
		const hook = await loadConfigHook();
		const config: Record<string, unknown> = { permission: { task: 'allow' } };

		await hook(config);

		const permission = config.permission as Record<string, unknown>;
		const rules = permission.external_directory as Record<string, string>;
		expect(rules).toBeDefined();
		expect(Object.keys(rules)[0]).toBe('*');
		expect(rules['*']).toBe('deny');
		// The parent project must be granted, canonicalised the way the host asks.
		const parentPattern = Object.keys(rules).find((k) =>
			k.toLowerCase().startsWith(lane.parentProjectPath.toLowerCase()),
		);
		expect(parentPattern).toBeDefined();
		expect(rules[parentPattern as string]).toBe('allow');
		// Unrelated keys survive.
		expect(permission.task).toBe('allow');
	});

	test('a lane instance downgrades a per-agent external_directory ask', async () => {
		forceLane();
		const hook = await loadConfigHook();
		const config: Record<string, unknown> = {
			agent: {
				[USER_AGENT_NAME]: { permission: { external_directory: 'ask' } },
			},
		};

		await hook(config);

		expect(
			(
				(config.agent as Record<string, Record<string, unknown>>)[
					USER_AGENT_NAME
				].permission as Record<string, unknown>
			).external_directory,
		).toBe('deny');
	});
});
