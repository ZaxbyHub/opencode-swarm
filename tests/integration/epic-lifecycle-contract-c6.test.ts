/**
 * Epic v2 lifecycle CONTRACT v6 (commit C6 — learning across epics).
 *
 * Two epics on one real git repository (`epic-branch` policy), through the
 * production entry points:
 *
 * Epic 1 (plan "Contract V6 A"): 1.1 declares `src/a.ts` but its coder also
 * writes `src/b.ts` — the file 1.2 (which depends on 1.1) declares.
 *   `/swarm epic start` (neutral: no project prior yet)
 *   → wave 1 = [1.1, 1.3, 1.4, 1.5]; 1.1 lands a.ts + the undeclared b.ts
 *   → the wave close records `undeclared: ['src/b.ts']` for 1.1 and the
 *     epic's posterior learns it AT ONCE: the co-write a.ts → b.ts. One
 *     declarer's undeclared write is scope expansion, not heat (the
 *     strongest-co-writer discount, C8): b.ts is NOT hot, so 1.2 is not
 *     serialized needlessly — wave 2 = [1.2, 1.6], in parallel
 *   → `/swarm epic close --land merge` merges the posterior
 *     into the project prior (".swarm/epic-prior/learning.json"; "Project
 *     prior kept"): co-write a.ts → b.ts weight 1; b.ts no longer hot
 *     (1.2's clean exposure).
 *
 * Epic 2 (a NEW plan "Contract V6 B", no dependencies, started 59 days 23
 * hours later — the co-write keeps its full weight for a whole half-life): 1.1 declares
 * `src/a.ts`, 1.2 declares `src/b.ts`. Declared scopes are disjoint, but the
 * learned co-write expands 1.1's scope to b.ts, so 1.1 and 1.2 form one
 * serial component: wave 1 = [1.1, 1.3, 1.4, 1.5] (1.2 waits), wave 2 runs
 * 1.2 — serialized by what epic 1 taught. The dispatch gate still admits
 * 1.1 as a parallel coder (its verdict reads the frozen DECLARED scopes).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../src/commands/epic';
import type { Plan } from '../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../src/db/project-db';
import { resolveEpicDispatchPolicy } from '../../src/epic/gate-policy';
import { resolveEpicLearningSettings } from '../../src/epic/learning';
import {
	loadEpicLearningView,
	readEpicPosterior,
	readEpicPrior,
} from '../../src/epic/learning-store';
import { getOpenEpic } from '../../src/epic/lifecycle';
import { runEpicNextWave } from '../../src/epic/next-wave';
import { _internals as startInternals } from '../../src/epic/start';
import {
	loadPlanJsonOnly,
	savePlan,
	updateTaskStatus,
} from '../../src/plan/manager';
import {
	ensureAgentSession,
	recordModifiedFilesForTask,
	resetSwarmState,
} from '../../src/state';
import { executeDeclareScope } from '../../src/tools/declare-scope';
import { landEpicTaskForTest } from '../helpers/epic-landing';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { freezeClock, type Restore } from '../helpers/test-clock.js';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const SESSION = 'ses_contractV6';
const FROZEN_ISO = '2026-10-01T12:00:00.000Z';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const realStart = { ...startInternals };

let dir: string;
let isolatedEnv: { cleanup: () => void } | undefined;
let restoreClock: Restore | null = null;

function git(args: string[]): string {
	const r = spawnSync('git', args, {
		cwd: dir,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		env: { ...process.env, GIT_CONFIG_GLOBAL: NULL_DEVICE },
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

const IDS = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6'];

function scopeOf(id: string, epic: 'A' | 'B'): string[] {
	if (id === '1.1') return ['src/a.ts'];
	if (id === '1.2') return ['src/b.ts'];
	return [`src/${epic.toLowerCase()}${id.replace('.', '_')}.ts`];
}

function plan(epic: 'A' | 'B'): Plan {
	return {
		schema_version: '1.0.0',
		title: `Contract V6 ${epic}`,
		swarm: 'contract-swarm',
		current_phase: 1,
		migration_status: 'native',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: IDS.map((id) => ({
					id,
					phase: 1,
					status: 'pending' as const,
					size: 'small' as const,
					description: `implement ${id} (${epic})`,
					depends: epic === 'A' && id === '1.2' ? ['1.1'] : [],
					files_touched: scopeOf(id, epic),
				})),
			},
		],
	};
}

/** Land `files` for a task (its coder's worktree landing) and complete it. */
async function completeTask(id: string, files: string[]): Promise<void> {
	const content: Record<string, string> = {};
	for (const file of files) content[file] = `// ${id} wrote ${file}\n`;
	expect(await landEpicTaskForTest(dir, id, content)).toMatchObject({
		merged: true,
	});
	await updateTaskStatus(dir, id, 'completed');
}

async function declareAll(epic: 'A' | 'B'): Promise<void> {
	for (const id of IDS) {
		const declared = await executeDeclareScope(
			{
				taskId: id,
				files: scopeOf(id, epic),
				working_directory: dir,
				// Epic 1's bindings for the same task ids are still live.
				...(epic === 'B' ? { replace_existing: true } : {}),
			},
			dir,
			{ sessionID: SESSION, messageID: `m-${epic}-${id}` },
		);
		expect(declared).toMatchObject({ success: true });
	}
}

beforeEach(async () => {
	restoreClock = freezeClock({
		isoNow: FROZEN_ISO,
		fixedNow: Date.parse(FROZEN_ISO),
	});
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	startInternals.countTrackedWorktreeDispatches = () => 0;
	dir = canonicalMkdtemp('epic-contract-c6-');
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test User']);
	git(['config', 'commit.gpgsign', 'false']);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			epic: { mode: { enabled: true } },
		}),
	);
	fs.writeFileSync(path.join(dir, '.gitignore'), '.swarm/\n');
	git(['add', '.']);
	git(['commit', '-q', '-m', 'seed']);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(startInternals, realStart);
	resetSwarmState();
	closeAllProjectDbs();
	isolatedEnv?.cleanup();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Epic lifecycle contract v6 — a learned co-write serializes the next epic', () => {
	test('epic 1 learns an undeclared co-write; epic 2 (new plan) serializes on it', async () => {
		// ── Epic 1 ──────────────────────────────────────────────────────────
		await savePlan(dir, plan('A'));
		const session = ensureAgentSession(SESSION, 'architect', dir);
		const started = await handleEpicCommand(dir, ['start'], SESSION);
		expect(started).toContain('opened for plan');
		expect(started).toContain('Learning: no project prior yet');
		await declareAll('A');

		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 1, kind: 'parallel', taskIds: ['1.1', '1.3', '1.4', '1.5'] },
		});
		// 1.1's coder also writes src/b.ts — outside its declared scope.
		expect(
			recordModifiedFilesForTask(session, '1.1', ['src/a.ts', 'src/b.ts'], dir),
		).toBe(true);
		await completeTask('1.1', ['src/a.ts', 'src/b.ts']);
		for (const id of ['1.3', '1.4', '1.5']) {
			await completeTask(id, scopeOf(id, 'A'));
		}

		// The close records the divergence; the posterior learns the co-write
		// at once. One declarer's undeclared write is expansion, not heat: b.ts
		// is not hot, so 1.2 (declaring it) is not serialized needlessly.
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			closedWave: { seq: 1 },
			wave: { seq: 2, kind: 'parallel', taskIds: ['1.2', '1.6'] },
		});
		const epic1 = getOpenEpic(dir);
		expect(epic1?.tasks['1.1']).toMatchObject({
			undeclared: ['src/b.ts'],
			attribution: 'session',
		});
		expect(epic1?.waves[1].components?.exclusive).toEqual({});
		const posterior = readEpicPosterior(dir);
		expect(posterior).toMatchObject({
			epicKey: epic1?.epicKey,
			lastAppliedWaveSeq: 1,
		});
		expect(posterior?.increments.edges.get('src/a.ts')?.get('src/b.ts')).toBe(
			1,
		);
		await completeTask('1.2', ['src/b.ts']);
		await completeTask('1.6', scopeOf('1.6', 'A'));
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'phase-ready-for-review',
			closedWave: { seq: 2 },
		});

		const closed = await handleEpicCommand(
			dir,
			['close', '--land', 'merge'],
			SESSION,
		);
		expect(closed).toContain('closed (**completed**)');
		expect(closed).toContain('Learning: merged');
		expect(closed).toContain('Project prior kept');
		const prior = readEpicPrior(dir);
		if (prior.status !== 'ok') throw new Error(`prior ${prior.status}`);
		expect(prior.prior.stats.edges.get('src/a.ts')?.get('src/b.ts')).toBe(1);
		// 1 incident + 1 clean exposure: no excess evidence any more.
		expect(prior.prior.stats.files.get('src/b.ts')).toEqual({
			alpha: 1,
			beta: 1,
		});
		expect(readEpicPosterior(dir)).toBeNull();

		// ── Epic 2: a new plan, 59 days and 23 hours later ─────────────────
		// Real elapsed time between the epics: age decay counts WHOLE
		// half-lives (60 days), so the single learned co-write keeps its full
		// weight; one more half-life would halve it below the expansion
		// threshold.
		restoreClock?.();
		const later = Date.parse(FROZEN_ISO) + (59 * 24 + 23) * 60 * 60 * 1000;
		restoreClock = freezeClock({
			isoNow: new Date(later).toISOString(),
			fixedNow: later,
		});
		const settings = resolveEpicLearningSettings(undefined);
		expect(
			loadEpicLearningView(dir, null, settings, later)
				.stats.edges.get('src/a.ts')
				?.get('src/b.ts'),
		).toBe(1);
		expect(
			loadEpicLearningView(dir, null, settings, later + 2 * 24 * 60 * 60 * 1000)
				.stats.edges.get('src/a.ts')
				?.get('src/b.ts'),
		).toBe(0.5);
		// A new plan replaces the finished one (same task ids, all pending;
		// the prior surviving `/swarm close` itself is pinned in
		// tests/unit/commands/close-finalizer-clean.test.ts).
		await savePlan(dir, plan('B'), { preserveCompletedStatuses: false });
		const started2 = await handleEpicCommand(dir, ['start'], SESSION);
		expect(started2).toContain('opened for plan');
		expect(started2).toContain('Learning: inherited the project prior');
		const epic2 = getOpenEpic(dir);
		expect(epic2?.epicKey).not.toBe(epic1?.epicKey);
		expect(epic2?.priorDigest).toMatch(/^[0-9a-f]{64}$/);
		await declareAll('B');

		// Declared scopes are disjoint, but 1.1's learned co-write of b.ts
		// puts 1.1 and 1.2 in one serial component: 1.2 waits.
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			wave: { seq: 1, kind: 'parallel', taskIds: ['1.1', '1.3', '1.4', '1.5'] },
		});
		const wave1 = getOpenEpic(dir)?.waves[0];
		expect(wave1?.components?.byTask['1.2']).toBe('1.1');
		expect(wave1?.components?.modes['1.1']).toBe('serial-component');
		expect(wave1?.components?.exclusive).toEqual({});
		// The gate's verdict reads the frozen DECLARED scopes and agrees.
		const current = await loadPlanJsonOnly(dir);
		if (!current) throw new Error('plan not saved');
		expect(
			resolveEpicDispatchPolicy(dir, current, '1.1', scopeOf('1.1', 'B')),
		).toMatchObject({ kind: 'allow', parallel: true, isolate: true });
		for (const id of ['1.1', '1.3', '1.4', '1.5']) {
			await completeTask(id, scopeOf(id, 'B'));
		}
		expect(await runEpicNextWave(dir, SESSION)).toMatchObject({
			status: 'dispatch',
			closedWave: { seq: 1 },
			wave: { seq: 2, taskIds: ['1.6', '1.2'] },
		});
	});
});
