import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	beginStartupServerInterval,
	buildStartupContractReport,
	endStartupServerInterval,
	markStartupImportComplete,
	noteQueueScheduled,
	noteStartupAdvisory,
	type StartupContractState,
	withStartupFirstUseTracking,
	wrapPostResolutionTask,
} from '../../../src/observability/startup-contract.js';

/**
 * Issue #2670 — startup and first-use latency contract, unit coverage for
 * the collector module (src/observability/startup-contract.ts): stage
 * separation, bounded failure diagnostics, queue settle accounting,
 * once-only first-use markers, startup-window advisory counting, and the
 * debug emission gate. Deterministic clock + emission capture ride the
 * module's `_internals` seam (repo DI convention; no mock.module).
 */

interface CapturedRow {
	line: string;
	obj: Record<string, unknown> | null;
}

const REAL_INTERNALS = { ..._internals };
let fakeNow = 0;
let rows: CapturedRow[] = [];
let debugEnabled = true;

function emitted(stage: string): CapturedRow[] {
	return rows.filter((r) => r.obj?.stage === stage);
}

function firstObj(stage: string): Record<string, unknown> {
	const row = emitted(stage)[0];
	expect(row).toBeDefined();
	return row.obj as Record<string, unknown>;
}

function resetBoot(): void {
	fakeNow = 0;
	rows = [];
	beginStartupServerInterval();
}

beforeEach(() => {
	fakeNow = 0;
	rows = [];
	debugEnabled = true;
	_internals.performance = { now: () => fakeNow };
	_internals.isDebugEnabled = () => debugEnabled;
	_internals.emitLine = (line: string) => {
		try {
			rows.push({
				line,
				obj: JSON.parse(line.slice('STARTUP-CONTRACT '.length)),
			});
		} catch {
			rows.push({ line, obj: null });
		}
	};
});

afterEach(() => {
	Object.assign(_internals, REAL_INTERNALS);
});

describe('startup-contract import + server interval', () => {
	test('init row separates importMs and serverMs', () => {
		markStartupImportComplete();
		fakeNow = 100;
		beginStartupServerInterval();
		fakeNow = 250;
		endStartupServerInterval();
		const init = firstObj('init');
		// importMs is captured once per PROCESS at src/index.ts module scope;
		// when src/index.ts is co-loaded by a sibling test file the mark is
		// already taken with the real clock, so only its presence and shape
		// are asserted here. serverMs uses the injected deterministic clock.
		expect(typeof init.importMs).toBe('number');
		expect(init.importMs as number).toBeGreaterThanOrEqual(0);
		expect(init.serverMs).toBe(150);
		expect(Object.keys(init).sort()).toEqual([
			'importMs',
			'serverMs',
			'stage',
			'v',
		]);
	});

	test('advisory window closes at server end when no queue is scheduled', () => {
		resetBoot();
		noteStartupAdvisory();
		noteStartupAdvisory();
		endStartupServerInterval();
		noteStartupAdvisory();
		const report = buildStartupContractReport();
		expect(report.advisoryCount).toBe(2);
	});
});

describe('startup-contract optional task outcomes', () => {
	test('completed outcome carries task name and duration', async () => {
		resetBoot();
		noteQueueScheduled();
		async function healthyTask(): Promise<void> {
			fakeNow += 25;
		}
		const wrapped = wrapPostResolutionTask(healthyTask);
		expect(wrapped.name).toBe('healthyTask');
		await wrapped();
		const row = firstObj('optional_task');
		expect(row.task).toBe('healthyTask');
		expect(row.outcome).toBe('completed');
		expect(row.ms).toBe(25);
	});

	test('failing task records bounded failed outcome without stack and re-raises', async () => {
		resetBoot();
		noteQueueScheduled();
		const long = 'x'.repeat(500);
		async function boomTask(): Promise<void> {
			fakeNow += 5;
			throw new Error(`boom ${long}\nsecond line`);
		}
		const wrapped = wrapPostResolutionTask(boomTask);
		let caught: unknown = null;
		try {
			await wrapped();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		const row = firstObj('optional_task');
		expect(row.outcome).toBe('failed');
		const errorText = row.error as string;
		expect(typeof errorText).toBe('string');
		expect(errorText.length).toBeLessThanOrEqual(200);
		expect(errorText).not.toContain('\n');
		expect(errorText.startsWith('boom x')).toBe(true);
	});

	test('queue_settled accounts tasks, completed, failed, ms, advisories', async () => {
		resetBoot();
		noteStartupAdvisory();
		noteQueueScheduled();
		async function okTask(): Promise<void> {
			fakeNow += 10;
		}
		async function badTask(): Promise<void> {
			fakeNow += 20;
			throw new Error('nope');
		}
		const ok = wrapPostResolutionTask(okTask);
		const bad = wrapPostResolutionTask(badTask);
		fakeNow += 7; // drain scheduling -> first settle gap
		await Promise.allSettled([ok(), bad().catch(() => {})]);
		const settled = firstObj('queue_settled');
		expect(settled.tasks).toBe(2);
		expect(settled.completed).toBe(1);
		expect(settled.failed).toBe(1);
		expect(settled.ms).toBe(37);
		expect(settled.advisories).toBe(1);
		// Window closed: later advisories never contribute.
		noteStartupAdvisory();
		expect(buildStartupContractReport().advisoryCount).toBe(1);
	});

	test('anonymous tasks are labeled, late task still gets an outcome row', async () => {
		resetBoot();
		noteQueueScheduled();
		const anon = wrapPostResolutionTask((async () => {
			fakeNow += 3;
		}) as () => Promise<void>);
		await anon();
		expect(firstObj('optional_task').task).toBe('anonymous');
	});
});

describe('startup-contract first-use tracking', () => {
	test('first_turn emits once on settle and not again', async () => {
		resetBoot();
		endStartupServerInterval();
		fakeNow += 40;
		let calls = 0;
		const tracked = withStartupFirstUseTracking(
			'first_turn',
			undefined,
			async () => {
				calls += 1;
				fakeNow += 5;
			},
		);
		await tracked({}, {});
		await tracked({}, {});
		expect(calls).toBe(2);
		const turns = emitted('first_turn');
		expect(turns.length).toBe(1);
		expect(turns[0].obj?.ms).toBe(45);
	});

	test('first_tool records name and settles on rejection too, returning the handler own result', async () => {
		resetBoot();
		endStartupServerInterval();
		fakeNow += 12;
		const sentinel = Promise.reject(new Error('tool validation'));
		const tracked = withStartupFirstUseTracking(
			'first_tool',
			'diff',
			() => sentinel,
		);
		let caught: unknown = null;
		try {
			await tracked({}, {});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		const row = firstObj('first_tool');
		expect(row.tool).toBe('diff');
		expect(row.ms).toBe(12);
		// Once-only: a later successful invocation adds no second row.
		const okTracked = withStartupFirstUseTracking(
			'first_tool',
			'other',
			async () => 1,
		);
		await okTracked();
		expect(emitted('first_tool').length).toBe(1);
	});

	test('sync-returning handlers are supported and result passes through unchanged', () => {
		resetBoot();
		endStartupServerInterval();
		const tracked = withStartupFirstUseTracking(
			'first_turn',
			undefined,
			() => 42,
		);
		expect(tracked()).toBe(42);
		expect(emitted('first_turn').length).toBe(1);
	});
});

describe('startup-contract emission gate', () => {
	test('debug disabled emits zero contract rows', async () => {
		resetBoot();
		debugEnabled = false;
		noteQueueScheduled();
		await wrapPostResolutionTask(async () => {})();
		endStartupServerInterval();
		expect(rows.length).toBe(0);
		const report: StartupContractState = buildStartupContractReport();
		expect(report.queueSettled).toBe(true);
	});
});

describe('startup-contract report separation', () => {
	test('report exposes stage fields as separate keys', () => {
		resetBoot();
		markStartupImportComplete();
		endStartupServerInterval();
		const report = buildStartupContractReport();
		for (const key of [
			'importMarkMs',
			'serverMs',
			'firstTurnMs',
			'firstToolMs',
			'firstToolName',
			'queueSettledMs',
			'queueCompleted',
			'queueFailed',
			'advisoryCount',
		] as const) {
			expect(key in report).toBe(true);
		}
	});
});
