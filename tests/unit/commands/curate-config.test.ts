import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	type CurationSummary,
	handleCurateCommand,
} from '../../../src/commands/curate.js';
import type { KnowledgeConfig } from '../../../src/hooks/knowledge-types.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';

/**
 * `/swarm curate` must run against the USER's knowledge config, not schema
 * defaults (issue #1821 F-B).
 *
 * `handleCurateCommand` used to build its config with
 * `KnowledgeConfigSchema.parse({})` ("use default config for manual curation").
 * That was harmless while every knowledge setting merely tuned a threshold, but
 * #1821 added `promotion_require_actionable`, which DEFAULTS TRUE and BLOCKS
 * promotion of a lesson with no actionable directive. A user who set it `false`
 * in `opencode-swarm.json` opted out everywhere except here, where the parsed-
 * empty object silently reimposed the gate. `promote.ts` already loaded the real
 * config; `curate.ts` was the outlier.
 *
 * The loader reads BOTH the project config and the USER config dir, so every
 * test runs inside `createIsolatedTestEnv` — without it a developer's real
 * `~/.config/opencode/opencode-swarm.json` would decide the outcome and the
 * suite would pass or fail per machine.
 */

const EMPTY_SUMMARY: CurationSummary = {
	timestamp: '2026-01-01T00:00:00.000Z',
	new_promotions: 0,
	encounters_incremented: 0,
	advancements: 0,
	total_hive_entries: 0,
};

let env: ReturnType<typeof createIsolatedTestEnv>;
let directory: string;
let seenConfigs: KnowledgeConfig[];
const original = { ..._internals };

beforeEach(() => {
	env = createIsolatedTestEnv();
	directory = path.join(env.configDir, 'project');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });

	seenConfigs = [];
	// Capture exactly what the command hands the promoter. Everything else is
	// stubbed so the assertion is about config plumbing and nothing else.
	_internals.checkHivePromotions = (async (
		_entries: unknown,
		config: KnowledgeConfig,
	) => {
		seenConfigs.push(config);
		return { ...EMPTY_SUMMARY };
	}) as typeof _internals.checkHivePromotions;
	_internals.readKnowledge =
		(async () => []) as typeof _internals.readKnowledge;
});

afterEach(() => {
	Object.assign(_internals, original);
	env.cleanup();
});

/** Write a project-level plugin config (`.opencode/opencode-swarm.json`). */
function writeProjectConfig(config: Record<string, unknown>): void {
	const dir = path.join(directory, '.opencode');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'opencode-swarm.json'),
		JSON.stringify(config),
		'utf-8',
	);
}

describe('/swarm curate — user knowledge config', () => {
	test('promotion_require_actionable: false reaches checkHivePromotions', async () => {
		writeProjectConfig({
			knowledge: { promotion_require_actionable: false },
		});

		await handleCurateCommand(directory, []);

		expect(seenConfigs).toHaveLength(1);
		expect(seenConfigs[0].promotion_require_actionable).toBe(false);
	});

	test('the schema default still applies when the user set nothing', async () => {
		writeProjectConfig({ knowledge: {} });

		await handleCurateCommand(directory, []);

		// Not a tautology against the bug: the same assertion held before the fix
		// too. It is here so the fix cannot be "hardcode false".
		expect(seenConfigs[0].promotion_require_actionable).toBe(true);
	});

	test('non-gate knowledge settings are carried through as well', async () => {
		// Proves the whole user config object is loaded, not one special-cased key.
		writeProjectConfig({
			knowledge: {
				promotion_require_actionable: false,
				dedup_threshold: 0.85,
				swarm_max_entries: 7,
			},
		});

		await handleCurateCommand(directory, []);

		expect(seenConfigs[0].dedup_threshold).toBe(0.85);
		expect(seenConfigs[0].swarm_max_entries).toBe(7);
	});

	test('an unreadable config falls back to schema defaults instead of failing the command', async () => {
		// The fallback branch added with the loader call. A broken config must not
		// turn `/swarm curate` into an error message.
		_internals.loadPluginConfigWithMeta = (() => {
			throw new Error('config is not readable');
		}) as typeof _internals.loadPluginConfigWithMeta;

		const output = await handleCurateCommand(directory, []);

		expect(output).toContain('Curation complete');
		expect(seenConfigs).toHaveLength(1);
		expect(seenConfigs[0].promotion_require_actionable).toBe(true);
	});
});
