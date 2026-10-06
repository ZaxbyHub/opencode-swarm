/**
 * Tests for the /swarm epic slash command.
 * File: tests/unit/commands/epic.test.ts
 *
 * Covers:
 *  - Missing session context → friendly error.
 *  - Removed v1 `on` / `off` toggles fall to the usage text; bare form is
 *    status and never mutates the epic.
 *  - status renders the lifecycle record (waves, phases, divergence,
 *    orphan, config).
 *  - the removed `decide` / `last` subcommands answer with a pointer to
 *    status and mutate nothing; the renamed `calibration` points at
 *    `learning` / `prior` (their rendering: epic-learning.test.ts).
 * Lifecycle collaborators are replaced through `_internals` (AGENTS.md #7).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _internals, handleEpicCommand } from '../../../src/commands/epic';
import type { EpicInspection } from '../../../src/epic/lifecycle';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';

const realInternals = { ..._internals };

let startCalls = 0;
let closeCalls = 0;
let inspection: EpicInspection;

function emptyInspection(): EpicInspection {
	return {
		sentinelPresent: false,
		sentinel: null,
		record: null,
		rowKeys: [],
		unreadable: null,
		orphanReason: null,
		configEnabled: true,
	};
}

beforeEach(() => {
	startCalls = 0;
	closeCalls = 0;
	inspection = emptyInspection();
	_internals.inspectEpic = (() => inspection) as never;
	_internals.repairEpicSentinel = (() => 'none') as never;
	_internals.retireLegacyEpicSessionState = (() => ({
		rowsRemoved: 0,
		activeSessions: 0,
		fileArchivedTo: null,
		errors: [],
	})) as never;
	_internals.describeMergeFailuresForStatus = (() => []) as never;
	_internals.startEpic = (async () => {
		startCalls += 1;
		throw new Error('unexpected start');
	}) as never;
	_internals.closeEpic = (async () => {
		closeCalls += 1;
		throw new Error('unexpected close');
	}) as never;
	_internals.loadPluginConfigWithMeta = (() => ({
		config: { turbo: { epic: { mode: { enabled: true } } } },
		isUsingDefaults: false,
	})) as never;
	_internals.loadPlanJsonOnly = (async () => ({
		phases: [
			{
				id: 1,
				name: 'P1',
				tasks: [
					{
						id: '1.1',
						description: 'a',
						status: 'pending',
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	})) as never;
	_internals.resolvePlanMarkerScope = (async () => ({
		planKey: 'aaaaaaaaaaaaaaaa',
		rootTimestampMs: null,
	})) as never;
});

afterEach(() => {
	for (const k of Object.keys(realInternals)) {
		(_internals as never as Record<string, unknown>)[k] = (
			realInternals as never as Record<string, unknown>
		)[k];
	}
});

describe('handleEpicCommand — session validation', () => {
	test('rejects empty sessionID', async () => {
		const out = await handleEpicCommand('/fake', [], '');
		expect(out).toContain('No active session context');
	});
});

describe('handleEpicCommand — subcommand routing', () => {
	test.each([
		['on'],
		['off'],
	])('removed v1 toggle `%s` gets a migration hint and mutates nothing', async (arg) => {
		const out = await handleEpicCommand('/fake', [arg], 'sess-1');
		expect(out).toContain(`\`/swarm epic ${arg}\` was removed in Epic v2`);
		expect(out).toContain('Use `/swarm epic start`');
		expect(out).toContain(
			'/swarm epic start [--force] | close [--abandon] [--land squash|merge|none] | status [--repair-refs] | report [<key>|last] [--format json] | learning | prior [show|reset [--confirm=<token>]] | clear-merge-failure <taskId> [--confirm]',
		);
		expect(out).not.toMatch(/\bon \| off\b/);
		expect(startCalls).toBe(0);
		expect(closeCalls).toBe(0);
	});

	test('bare `/swarm epic` shows status and never starts or closes (anti-loop)', async () => {
		const out = await handleEpicCommand('/fake', [], 'sess-1');
		expect(out).toContain('Epic Mode — Status');
		await handleEpicCommand('/fake', [], 'sess-1');
		expect(startCalls).toBe(0);
		expect(closeCalls).toBe(0);
	});

	test.each([
		['decide'],
		['last'],
	])('removed `%s` points at status and the architect flow', async (arg) => {
		const out = await handleEpicCommand('/fake', [arg], 'sess-1');
		expect(out).toContain(`\`/swarm epic ${arg}\` was removed in Epic v2`);
		expect(out).toContain('`epic_next_wave` plans every wave');
		expect(out).toContain('`/swarm epic status`');
		expect(startCalls).toBe(0);
		expect(closeCalls).toBe(0);
	});

	test('empty-string subcommand is treated as unknown', async () => {
		const out = await handleEpicCommand('/fake', [''], 'sess-1');
		expect(out).toContain("Unknown subcommand ''");
		expect(startCalls).toBe(0);
	});
});

describe('handleEpicCommand — status', () => {
	test('no epic → says so and points at `/swarm epic start`', async () => {
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain('No epic is open. Run `/swarm epic start`');
	});

	test('unreadable lifecycle state is reported with the --abandon repair', async () => {
		inspection.unreadable = 'Epic lifecycle row is not valid JSON';
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain('**Epic lifecycle state is unreadable**');
		expect(out).toContain('`/swarm epic close --abandon`');
		expect(out).not.toContain('No epic is open');
	});

	test('renders the open epic with its waves, phases and divergence', async () => {
		inspection.record = stubEpicRecord({
			activeWaveSeq: 2,
			waves: [
				{
					seq: 1,
					phase: 1,
					kind: 'parallel',
					taskIds: ['1.1', '1.2'],
					files: { '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] },
					cochange: null,
					baseHead: null,
					issuedAt: '2026-01-01T00:00:00.000Z',
					closedAt: '2026-01-01T01:00:00.000Z',
					closeHead: null,
					status: 'closed',
					undeclared: ['src/stray.ts'],
				},
				{
					seq: 2,
					phase: 1,
					kind: 'exclusive',
					taskIds: ['1.3'],
					files: { '1.3': ['package.json'] },
					cochange: null,
					components: {
						byTask: { '1.3': '1.3', '1.4': '1.4', '1.5': '1.4', '1.6': '1.6' },
						modes: {
							'1.3': 'exclusive',
							'1.4': 'serial-component',
							'1.6': 'parallel',
						},
						density: { '1.3': 0, '1.4': 1, '1.6': 0 },
						exclusive: { '1.3': 'global-file' },
						threshold: 0.3,
						truncated: false,
					},
					baseHead: null,
					issuedAt: '2026-01-01T02:00:00.000Z',
					status: 'issued',
				},
			],
			tasks: {
				'1.1': {
					taskId: '1.1',
					phase: 1,
					waveSeq: 1,
					resolution: 'completed',
					resolvedAt: '2026-01-01T00:30:00.000Z',
					generation: 1,
					stageAFailures: 0,
					stageBFailures: 0,
					mergeFailure: null,
					declared: ['src/a.ts'],
					undeclared: ['src/c.ts'],
					attribution: 'session',
					reopened: 0,
					marker: null,
				},
			},
			phases: {
				'1': {
					status: 'active',
					reviewRuns: 1,
					verdicts: ['reviewer:NEEDS_REVISION critic:not-run'],
				},
			},
		});
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain(`Epic: \`${inspection.record.epicKey}\` — **open**`);
		expect(out).toContain('- 2 issued: 1 closed.');
		expect(out).toContain(
			'**Active:** wave 2 (phase 1, exclusive) — 1.3 — issued 2026-01-01T02:00:00.000Z',
		);
		expect(out).toContain(
			'Phase 1: active; 1 phase review run(s) (last: reviewer:NEEDS_REVISION critic:not-run)',
		);
		expect(out).toContain(
			'- Components when wave 2 was issued (density threshold 0.3;',
		);
		expect(out).toContain('  - `1.3` exclusive (global file): 1.3');
		expect(out).toContain(
			'  - `1.4` serial-component (2 task(s), density 1.00): 1.4, 1.5',
		);
		expect(out).toContain('  - `1.6` parallel (1 task(s), density 0.00): 1.6');
		expect(out).toContain('- 1.1 (wave 1): src/c.ts');
		expect(out).toContain('- wave 1 (unattributed): src/stray.ts');
		expect(out).not.toContain('activation decision');
	});

	test('an epic without waves says the architect issues the first one', async () => {
		inspection.record = stubEpicRecord();
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain('None issued yet');
		expect(out).not.toContain('Divergence');
	});

	test('orphaned epic and closed config gate are both explained', async () => {
		inspection.record = stubEpicRecord();
		inspection.orphanReason = 'plan-renamed-or-replaced';
		inspection.configEnabled = false;
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain('— **orphaned**');
		expect(out).toContain('the plan was renamed or replaced');
		expect(out).toContain('`/swarm epic close --abandon`');
		expect(out).toContain('`epic.mode.enabled` is not true');
	});

	test('reports a sentinel repair and the legacy v1 retirement', async () => {
		_internals.repairEpicSentinel = (() => 'removed-stale-sentinel') as never;
		_internals.retireLegacyEpicSessionState = (() => ({
			rowsRemoved: 2,
			activeSessions: 1,
			fileArchivedTo: '.swarm/epic-state.json.imported',
			errors: [],
		})) as never;
		const out = await handleEpicCommand('/fake', ['status'], 'sess-1');
		expect(out).toContain('Repaired: removed a stale sentinel');
		expect(out).toContain('Retired Epic v1 per-session state (2 row(s)');
		expect(out).toContain('1 session(s) had Epic v1 switched on');
		expect(out).toContain('run `/swarm epic start`');
	});
});

describe('handleEpicCommand — learning / prior routing (Epic v2 C6)', () => {
	test('`calibration` was renamed: it points at learning / prior and renders nothing', async () => {
		const out = await handleEpicCommand('/fake', ['calibration'], 'sess-1');
		expect(out).toContain('`/swarm epic calibration` was renamed in Epic v2');
		expect(out).toContain('`/swarm epic learning`');
		expect(out).toContain('`/swarm epic prior`');
		expect(out).not.toContain('Epic Mode — Learning');
	});

	test('`learning` renders the learning view; it takes no options', async () => {
		const out = await handleEpicCommand('/fake', ['learning'], 'sess-1');
		expect(out).toContain('## Epic Mode — Learning');
		expect(
			await handleEpicCommand('/fake', ['learning', '--x'], 'sess-1'),
		).toContain('`/swarm epic learning` takes no options.');
	});

	test('`prior` routes to the prior view; an unknown prior subcommand gets its usage', async () => {
		expect(await handleEpicCommand('/fake', ['prior'], 'sess-1')).toContain(
			'## Epic Mode — Project prior',
		);
		expect(
			await handleEpicCommand('/fake', ['prior', 'wipe'], 'sess-1'),
		).toContain(
			'Usage: /swarm epic prior [show] | /swarm epic prior reset [--confirm=<token>]',
		);
	});
});
