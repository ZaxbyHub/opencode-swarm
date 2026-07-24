/**
 * Shared temp-project scaffolding for the knowledge dedup-sweep suites
 * (issue #1821 Lane A):
 *  - `knowledge-dedup-sweep.test.ts`        — sweep behavior
 *  - `knowledge-dedup-sweep-wiring.test.ts` — planner units + curator wiring
 *
 * `sweepActiveNearDuplicates` reads its own config through
 * `loadPluginConfigWithMeta`, which reads BOTH the project config and the USER
 * config dir. Every suite therefore needs the full env redirect
 * (`createIsolatedTestEnv`), not just a temp project dir — without it a
 * developer's real `~/.config/opencode/opencode-swarm.json` would decide
 * whether the sweep is enabled and the tests would pass or fail per machine.
 *
 * Not a `.test.ts` file, so the runner never collects it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KnowledgeEntryBase } from '../../../src/hooks/knowledge-types.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';

export interface DedupSweepHarness {
	/** Project root the sweep is called with. */
	directory: string;
	/** `<directory>/.swarm/knowledge.jsonl`. */
	knowledgePath: string;
	cleanup: () => void;
}

/**
 * Create an isolated project root under the redirected temp HOME. The project
 * lives INSIDE the isolated env dir so a single cleanup removes both.
 */
export function makeHarness(): DedupSweepHarness {
	const env = createIsolatedTestEnv();
	const directory = path.join(env.configDir, 'project');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	return {
		directory,
		knowledgePath: path.join(directory, '.swarm', 'knowledge.jsonl'),
		cleanup: env.cleanup,
	};
}

/** Write a project-level plugin config (`.opencode/opencode-swarm.json`). */
export function writeProjectConfig(
	directory: string,
	config: Record<string, unknown>,
): void {
	const dir = path.join(directory, '.opencode');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'opencode-swarm.json'),
		JSON.stringify(config),
		'utf-8',
	);
}

/** Serialize entries to the swarm knowledge JSONL. */
export function writeEntries(
	knowledgePath: string,
	entries: KnowledgeEntryBase[],
): void {
	fs.mkdirSync(path.dirname(knowledgePath), { recursive: true });
	fs.writeFileSync(
		knowledgePath,
		`${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
		'utf-8',
	);
}

/** Read the swarm knowledge JSONL back as parsed entries. */
export function readEntries(knowledgePath: string): KnowledgeEntryBase[] {
	if (!fs.existsSync(knowledgePath)) return [];
	return fs
		.readFileSync(knowledgePath, 'utf-8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as KnowledgeEntryBase);
}

/** Read a JSONL audit log under `<directory>/.swarm/`, tolerating absence. */
export function readSwarmJsonl<T>(directory: string, filename: string): T[] {
	const filePath = path.join(directory, '.swarm', filename);
	if (!fs.existsSync(filePath)) return [];
	return fs
		.readFileSync(filePath, 'utf-8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T);
}

let nextId = 0;

/**
 * Build a knowledge entry. Ids default to a monotonically increasing
 * `entry-NN` so bucket ordering (which the sweep sorts by id) is explicit and
 * stable; pass `id` when a test depends on the exact order.
 */
export function makeEntry(
	over: Partial<KnowledgeEntryBase> & Record<string, unknown> = {},
): KnowledgeEntryBase {
	nextId += 1;
	return {
		id: `entry-${String(nextId).padStart(2, '0')}`,
		tier: 'swarm',
		lesson: 'always run focused unit tests before claiming a task is done',
		category: 'testing',
		tags: [],
		scope: 'global',
		confidence: 0.5,
		status: 'candidate',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 3,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		...over,
	} as KnowledgeEntryBase;
}

/** A lesson that is NOT a near-duplicate of `makeEntry`'s default. */
export const UNRELATED_LESSON =
	'never hardcode absolute filesystem paths in cross platform shell scripts';

/** Actionability fields that make `validateActionability` return true. */
export const ACTIONABLE_FIELDS = {
	required_actions: ['run bun test on the touched file'],
	applies_to_agents: ['coder'],
};
