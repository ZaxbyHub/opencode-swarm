/**
 * `/swarm epic start|close` rendering end-to-end over a real temp project
 * (real lifecycle, real plan ledger), plus: an epic is plan-scoped, so
 * `/swarm reset-session` neither closes it nor mentions it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { handleEpicCommand } from '../../../src/commands/epic';
import { handleResetSessionCommand } from '../../../src/commands/reset-session';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { isEpicOpenForProject } from '../../../src/epic/lifecycle';
import { _internals as startInternals } from '../../../src/epic/start';
import { resetSwarmState } from '../../../src/state';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import { createStartProject, sizedPlan } from '../epic/start-fixture';

const realStart = { ...startInternals };
let dir: string;
let restoreClock: Restore | null = null;

beforeEach(async () => {
	restoreClock = freezeClock({ isoNow: '2026-06-01T09:00:00.000Z' });
	resetSwarmState();
	startInternals.hasActiveTurboMode = () => false;
	startInternals.countTrackedWorktreeDispatches = () => 0;
	dir = await createStartProject('epic-cmd-life-', { git: true });
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(startInternals, realStart);
	resetSwarmState();
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('/swarm epic start', () => {
	test('opens an epic and reports sizing + execution', async () => {
		const out = await handleEpicCommand(dir, ['start'], 'ses_cmd');
		expect(out).toMatch(
			/^Epic `start-swarm-Start_Plan-[0-9a-f]{12}` opened for plan `start-swarm-Start_Plan`\./,
		);
		expect(out).toContain(
			'Sizing: 6 pending task(s), scope coverage 100%, 2 serial step(s)',
		);
		expect(out).toContain('git, up to 4 task(s) per wave');
		expect(out).toContain('per-task QA is never waived');
		expect(isEpicOpenForProject(dir)).toBe(true);
		const again = await handleEpicCommand(dir, ['start'], 'ses_cmd');
		expect(again).toContain('is already open for this plan — nothing changed');
	});

	test('non-git start does not mention commits or branches', async () => {
		closeAllProjectDbs();
		fs.rmSync(dir, { recursive: true, force: true });
		dir = await createStartProject('epic-cmd-life-', { git: false });
		const out = await handleEpicCommand(dir, ['start', '--force'], 'ses_cmd');
		expect(out).toContain(
			'Execution: non-git project — serial, one task per wave.',
		);
		expect(out).not.toMatch(/commit|branch/i);
	});

	test('not-epic-sized lists reasons and suggests Balanced / --force', async () => {
		closeAllProjectDbs();
		fs.rmSync(dir, { recursive: true, force: true });
		dir = await createStartProject('epic-cmd-life-', {
			git: true,
			plan: sizedPlan('Tiny', 2),
		});
		const out = await handleEpicCommand(dir, ['start'], 'ses_cmd');
		expect(out).toContain('Epic not started — **not-epic-sized**.');
		expect(out).toContain('- too-few-tasks: 2 pending task(s) < min_tasks 6');
		expect(out).toContain('run it in Balanced');
		expect(out).toContain('`/swarm epic start --force`');
		const forced = await handleEpicCommand(
			dir,
			['start', '--force'],
			'ses_cmd',
		);
		expect(forced).toContain('(**forced** — the plan is not epic-sized)');
	});

	test('refusal details are listed (turbo-active)', async () => {
		startInternals.hasActiveTurboMode = () => true;
		const out = await handleEpicCommand(dir, ['start'], 'ses_cmd');
		expect(out).toContain('Epic not started — **turbo-active**.');
		expect(out).toContain('- a session in this process has Turbo on');
	});
});

describe('/swarm epic start|close — option validation', () => {
	test('unknown flags are rejected before any lifecycle call', async () => {
		const start = await handleEpicCommand(dir, ['start', '--yes'], 'ses_cmd');
		expect(start).toContain('Unknown option(s) for `/swarm epic start`: --yes');
		const close = await handleEpicCommand(dir, ['close', '--force'], 'ses_cmd');
		expect(close).toContain(
			'Unknown option(s) for `/swarm epic close`: --force',
		);
		expect(isEpicOpenForProject(dir)).toBe(false);
	});
});

describe('/swarm epic close', () => {
	test('incomplete refuses; --abandon closes with a report path', async () => {
		await handleEpicCommand(dir, ['start'], 'ses_cmd');
		const refused = await handleEpicCommand(dir, ['close'], 'ses_cmd');
		expect(refused).toContain('Epic not closed — **epic-incomplete**.');
		const closed = await handleEpicCommand(
			dir,
			['close', '--abandon'],
			'ses_cmd',
		);
		expect(closed).toContain('closed (**abandoned**).');
		expect(closed).toContain('Tasks: 0 completed, 0 closed, 6 pending (of 6).');
		expect(closed).toContain('.swarm/epic-prior/reports/');
		expect(isEpicOpenForProject(dir)).toBe(false);
		expect(await handleEpicCommand(dir, ['close'], 'ses_cmd')).toBe(
			'No epic is open.',
		);
	});
});

describe('/swarm reset-session leaves the plan-scoped epic alone', () => {
	test('epic stays open and the reset output never mentions Epic', async () => {
		await handleEpicCommand(dir, ['start'], 'ses_cmd');
		const out = await handleResetSessionCommand(dir, [], 'ses_cmd');
		expect(out.toLowerCase()).not.toContain('epic');
		expect(isEpicOpenForProject(dir)).toBe(true);
	});
});
