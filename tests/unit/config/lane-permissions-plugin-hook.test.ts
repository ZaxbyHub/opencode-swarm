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
 * instance is left byte-identical.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type LaneContext,
	_internals as laneContextInternals,
} from '../../../src/config/lane-context';
import OpenCodeSwarm from '../../../src/index';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let dir: string;
let cleanup: () => void;
const realStat = laneContextInternals.statSync;
const realRead = laneContextInternals.readFileSync;
const realClear = laneContextInternals.clearCache;

beforeEach(() => {
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

describe('plugin config hook — real invocation', () => {
	test('an ordinary instance is left byte-identical', async () => {
		const hook = await loadConfigHook();
		const config: Record<string, unknown> = {
			permission: { task: 'allow' },
			agent: { coder: { permission: { external_directory: 'ask' } } },
		};
		const beforePermission = structuredClone(config.permission);
		const beforeAgent = structuredClone(config.agent);

		await hook(config);

		// The hook legitimately adds agents/commands; what must NOT change is the
		// permission surface.
		expect(config.permission).toEqual(beforePermission);
		expect(
			(config.agent as Record<string, Record<string, unknown>>).coder,
		).toEqual((beforeAgent as Record<string, Record<string, unknown>>).coder);
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
			agent: { coder: { permission: { external_directory: 'ask' } } },
		};

		await hook(config);

		expect(
			(
				(config.agent as Record<string, Record<string, unknown>>).coder
					.permission as Record<string, unknown>
			).external_directory,
		).toBe('deny');
	});
});
