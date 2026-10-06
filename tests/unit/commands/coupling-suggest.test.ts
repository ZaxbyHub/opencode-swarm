/**
 * `/swarm coupling --suggest` (Epic v2 C7): the coupling report plus the
 * plan-shaping advisory for the whole plan — the same ranked suggestions
 * save_plan returns as `epic_shaping`, rendered as markdown or embedded in
 * the JSON envelope. Read-only (no iteration counter, no write).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	handleCouplingCommand,
} from '../../../src/commands/coupling';
import type { ConfigLoadResult } from '../../../src/config/loader';
import type { Plan } from '../../../src/config/plan-schema';
import { PluginConfigSchema } from '../../../src/config/schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { savePlan } from '../../../src/plan/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realInternals = { ..._internals };
let dir: string;
let coChangeCalls = 0;

function hubPlan(): Plan {
	const files = [
		...Array.from({ length: 6 }, (_, i) => ['src/registry.ts', `src/f${i}.ts`]),
		['src/solo-1.ts'],
		['src/solo-2.ts'],
	];
	return {
		schema_version: '1.0.0',
		title: 'Coupling Suggest',
		swarm: 'coupling-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: files.map((touched, i) => ({
					id: `1.${i + 1}`,
					phase: 1,
					status: 'pending' as const,
					size: 'small' as const,
					description: `task ${i + 1}`,
					depends: [],
					files_touched: touched,
				})),
			},
		],
	};
}

function useConfig(raw: Record<string, unknown>): void {
	_internals.loadPluginConfigWithMeta = (() =>
		({
			config: PluginConfigSchema.parse(raw),
		}) as unknown as ConfigLoadResult) as typeof _internals.loadPluginConfigWithMeta;
}

beforeEach(async () => {
	dir = canonicalMkdtemp('coupling-suggest-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	await savePlan(dir, hubPlan());
	coChangeCalls = 0;
	_internals.isGitRepo = () => true;
	_internals.getCoChangePairs = async () => [];
	_internals.getCoChangeData = async () => {
		coChangeCalls += 1;
		return { pairs: [], commitsObserved: 0 };
	};
	useConfig({});
});

afterEach(() => {
	Object.assign(_internals, realInternals);
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('/swarm coupling --suggest', () => {
	test('markdown: the shaping section with the ranked patch', async () => {
		const out = await handleCouplingCommand(dir, ['--suggest']);
		expect(out).toContain('## Plan shaping (whole plan)');
		expect(out).toContain('Plan shaping: **improvable**');
		expect(out).toContain(
			'1. [extract-prerequisite] Extract hub-file src/registry.ts',
		);
		expect(out).toContain('Patch: add task 1.9 to phase 1');
	});

	test('read-only: the project tree is byte-identical before and after', async () => {
		const snapshot = () =>
			(fs.readdirSync(dir, { recursive: true }) as string[])
				.map(String)
				.filter((rel) => !rel.includes('swarm.db'))
				.sort()
				.map((rel) => {
					const full = path.join(dir, rel);
					return fs.statSync(full).isFile()
						? `${rel}:${fs.readFileSync(full, 'utf-8')}`
						: `${rel}/`;
				});
		const before = snapshot();
		await handleCouplingCommand(dir, ['--suggest']);
		await handleCouplingCommand(dir, ['--suggest', '--format', 'json']);
		expect(snapshot()).toEqual(before);
		expect(before.some((entry) => entry.startsWith('.swarm/epic'))).toBe(false);
	});

	test('without --suggest: no shaping section (report unchanged)', async () => {
		const out = await handleCouplingCommand(dir, []);
		expect(out).not.toContain('Plan shaping');
		const json = JSON.parse(
			await handleCouplingCommand(dir, ['--format', 'json']),
		);
		expect(json).not.toHaveProperty('shaping');
	});

	test('json: the report embeds the shaping report', async () => {
		const json = JSON.parse(
			await handleCouplingCommand(dir, ['--suggest', '--format', 'json']),
		);
		expect(json.shaping).toMatchObject({
			verdict: 'improvable',
			sizing: { epicSized: false, pendingTasks: 8 },
			suggestions: [{ type: 'extract-prerequisite', file: 'src/registry.ts' }],
		});
	});

	test('co-change enabled: shaping reads fresh co-change data', async () => {
		useConfig({
			epic: { mode: { enabled: true }, cochange: { enabled: true } },
		});
		await handleCouplingCommand(dir, ['--suggest']);
		expect(coChangeCalls).toBe(1);
	});

	test('a non-git project shapes for a serial epic (width 1)', async () => {
		_internals.isGitRepo = () => false;
		const json = JSON.parse(
			await handleCouplingCommand(dir, ['--suggest', '--format', 'json']),
		);
		expect(json.shaping.verdict).toBe('not-epic-sized');
	});

	test('usage lists --suggest', async () => {
		expect(await handleCouplingCommand(dir, ['--bogus'])).toContain(
			'[--suggest]',
		);
	});
});
