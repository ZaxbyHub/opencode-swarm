import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../src/db/project-db.js';
import OpenCodeSwarm, {
	overrideIndexInternalsForTest,
	schedulePostResolutionTasksForTest,
} from '../../src/index';
import {
	buildStartupContractReport,
	_internals as contractInternals,
} from '../../src/observability/startup-contract.js';
import { resetSwarmState } from '../../src/state';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../helpers/tmpdir';

/**
 * Issue #2670 — deterministic init-path evidence for the startup latency
 * contract:
 *  - structural: NO optional post-resolution work runs before the manifest
 *    is returned (the captured scheduler is the only task-execution path and
 *    it never ran during server());
 *  - drain-time: the REAL scheduler records per-task outcomes — a failing
 *    task produces a bounded typed failed outcome and does not crash the
 *    drain; the queue_settled accounting completes;
 *  - first-use: driving the real messages.transform handler and a real tool
 *    execute flips the once-only first-turn/first-tool markers.
 *
 * Every boot uses the sanctioned server-boot isolation (env isolation via
 * createIsolatedTestEnv + a project config written before boot; the
 * 2669-test precedent). Emissions are captured through the contract
 * module's `_internals` seam (no console noise, no mock.module).
 */

interface CapturedTask {
	name?: string;
	run: () => void | Promise<void>;
}

const REAL_EMIT = contractInternals.emitLine;
const REAL_IS_DEBUG = contractInternals.isDebugEnabled;
let contractRows: string[] = [];
let emitEnabled = false;

let restoreEnv: (() => void) | null = null;
let directory: string | null = null;

beforeEach(() => {
	contractRows = [];
	emitEnabled = false;
	contractInternals.emitLine = (line: string) => {
		if (line.startsWith('STARTUP-CONTRACT ')) contractRows.push(line);
	};
	contractInternals.isDebugEnabled = () => emitEnabled;
});

afterEach(async () => {
	contractInternals.emitLine = REAL_EMIT;
	contractInternals.isDebugEnabled = REAL_IS_DEBUG;
	restoreEnv?.();
	restoreEnv = null;
	if (directory) {
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				fs.rmSync(directory, { recursive: true, force: true });
				break;
			} catch {
				await Bun.sleep(50);
			}
		}
		directory = null;
	}
	await closeAllProjectDbs();
	resetSwarmState();
});

function contractRowsByStage(stage: string): Record<string, unknown>[] {
	const parsed: Record<string, unknown>[] = [];
	for (const line of contractRows) {
		try {
			const obj = JSON.parse(line.slice('STARTUP-CONTRACT '.length));
			if (obj?.stage === stage) parsed.push(obj);
		} catch {
			/* skip malformed */
		}
	}
	return parsed;
}

async function bootWithCapturedTasks(dir: string): Promise<{
	serverResult: Awaited<ReturnType<typeof OpenCodeSwarm.server>>;
	scheduledTasks: CapturedTask[];
}> {
	const scheduledTasks: CapturedTask[] = [];
	const restore = overrideIndexInternalsForTest({
		schedulePostResolutionTasks: (tasks) => {
			for (const task of tasks) {
				scheduledTasks.push({
					name: (task as { name?: string }).name,
					run: task,
				});
			}
		},
	});
	try {
		const serverResult = await OpenCodeSwarm.server({
			client: {} as never,
			project: {} as never,
			directory: dir,
			worktree: dir,
			serverUrl: new URL('http://localhost:3000'),
			$: {} as never,
		});
		return { serverResult, scheduledTasks };
	} finally {
		restore();
	}
}

function makeWorkspace(): string {
	directory = canonicalMkdtemp('swarm-2670-outcomes-');
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ quiet: true, version_check: false }),
	);
	const isolated = createIsolatedTestEnv();
	restoreEnv = isolated.restore;
	return directory;
}

describe('issue #2670 init-path contract', () => {
	test('no optional work runs before the manifest is returned', async () => {
		emitEnabled = true;
		const dir = makeWorkspace();
		const { serverResult } = await bootWithCapturedTasks(dir);
		// Mandatory manifest shape delivered.
		expect(Object.keys(serverResult?.tool ?? {}).length).toBeGreaterThanOrEqual(
			50,
		);
		expect(
			Object.keys(serverResult?.agent ?? {}).length,
		).toBeGreaterThanOrEqual(1);
		// Structural: the captured scheduler never ran, so the real drain
		// path (the ONLY path that wraps/starts tasks) never executed before
		// manifest delivery — no queue was even scheduled.
		const report = buildStartupContractReport();
		expect(report.queueScheduledAt).toBeNull();
		expect(report.queueTasks).toBe(0);
		expect(report.queuePending).toBe(0);
		expect(report.queueSettled).toBe(false);
		expect(report.queueCompleted).toBe(0);
		expect(report.queueFailed).toBe(0);
		expect(contractRowsByStage('optional_task').length).toBe(0);
		expect(contractRowsByStage('queue_settled').length).toBe(0);
		// The init row IS emitted at resolution (stage separation proof).
		expect(contractRowsByStage('init').length).toBe(1);
		expect(typeof contractRowsByStage('init')[0].serverMs).toBe('number');
	});

	test('real drain records typed outcomes; a failing task does not crash the queue', async () => {
		emitEnabled = true;
		const dir = makeWorkspace();
		await bootWithCapturedTasks(dir);
		let healthyRan = false;
		const tasks: Array<() => void | Promise<void>> = [
			async function healthyOutcomeTask(): Promise<void> {
				healthyRan = true;
			},
			async function failingOutcomeTask(): Promise<void> {
				throw new Error('synthetic drain failure');
			},
		];
		schedulePostResolutionTasksForTest(tasks);
		await Bun.sleep(100);
		expect(healthyRan).toBe(true);
		const report = buildStartupContractReport();
		expect(report.queueTasks).toBe(2);
		expect(report.queueCompleted).toBe(1);
		expect(report.queueFailed).toBe(1);
		expect(report.queueSettled).toBe(true);
		expect(report.queueSettledMs).not.toBeNull();
		const failedRows = contractRowsByStage('optional_task').filter(
			(r) => r.outcome === 'failed',
		);
		expect(failedRows.length).toBe(1);
		expect(failedRows[0].task).toBe('failingOutcomeTask');
		const errorText = failedRows[0].error as string;
		expect(typeof errorText).toBe('string');
		expect(errorText.length).toBeLessThanOrEqual(200);
		expect(errorText).toContain('synthetic drain failure');
		expect(errorText).not.toContain('\n');
		const settled = contractRowsByStage('queue_settled');
		expect(settled.length).toBe(1);
		expect(settled[0].tasks).toBe(2);
		expect(settled[0].completed).toBe(1);
		expect(settled[0].failed).toBe(1);
		expect(typeof settled[0].advisories).toBe('number');
	});

	test('driving the real transform + a real tool flips once-only first-use markers', async () => {
		emitEnabled = true;
		const dir = makeWorkspace();
		const { serverResult } = await bootWithCapturedTasks(dir);
		const transform = (serverResult as unknown as Record<string, unknown>)[
			'experimental.chat.messages.transform'
		] as ((input: unknown, output: unknown) => Promise<void>) | undefined;
		expect(typeof transform).toBe('function');
		const message = {
			info: { id: 'm1' },
			role: 'user',
			parts: [{ type: 'text', text: 'first turn probe' }],
		};
		const output = { messages: [message], system: '' };
		await transform(
			{ sessionID: 's-2670', agent: 'swarm_architect', messages: [message] },
			output,
		);
		// In-place mutation contract: the wrapper must not replace output.
		expect(output).toBeDefined();
		let report = buildStartupContractReport();
		expect(report.firstTurnDone).toBe(true);
		expect(report.firstTurnMs).not.toBeNull();
		expect(contractRowsByStage('first_turn').length).toBe(1);

		const toolMap = (serverResult?.tool ?? {}) as Record<
			string,
			{ execute?: (args: unknown, ctx?: unknown) => Promise<unknown> }
		>;
		const firstKey = Object.keys(toolMap).find(
			(k) => typeof toolMap[k]?.execute === 'function',
		);
		expect(firstKey).toBeDefined();
		// Negative-path first use still counts (settle-based), like the
		// harness child's first tool probe.
		await toolMap[firstKey as string]
			.execute({}, { directory: dir, worktree: dir })
			.catch(() => 'expected-error-path');
		report = buildStartupContractReport();
		expect(report.firstToolDone).toBe(true);
		expect(report.firstToolName).toBe(firstKey);
		expect(contractRowsByStage('first_tool').length).toBe(1);
	});

	test('emission is debug-gated end to end', async () => {
		emitEnabled = false;
		const dir = makeWorkspace();
		await bootWithCapturedTasks(dir);
		schedulePostResolutionTasksForTest([
			async function gatedOutcomeTask(): Promise<void> {},
		]);
		await Bun.sleep(50);
		expect(contractRows.length).toBe(0);
		const report = buildStartupContractReport();
		expect(report.queueSettled).toBe(true);
	});
});
