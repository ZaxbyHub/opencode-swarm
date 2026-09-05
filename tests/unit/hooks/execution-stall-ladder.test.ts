/**
 * Execution-stall detector — LADDER and deny set (issue #2063 B5).
 *
 * Two rungs: an advisory at `execution_stall_warn_calls` (default 30) and a
 * hard denial at `execution_stall_stop_calls` (default 60).
 *
 * The hard rung's safety property is that its deny set is a CLOSED ALLOWLIST of
 * denied tool names, never an exclusion list. `Task`, `update_task_status`, and
 * every plan/status/query/swarm tool therefore stay open by construction — a
 * lever that blocked the way out would convert a stall into a deadlock.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	_test_exports,
	DEFAULT_EXECUTION_STALL_STOP_CALLS,
	DEFAULT_EXECUTION_STALL_WARN_CALLS,
	EXECUTION_STALL_DENIED_TOOLS,
	enforceExecutionStallDenial,
	executionStallAdvisoryText,
	executionStallDenialText,
	observeExecutionStallToolCall,
	recordExecutionStallToolAfter,
} from '../../../src/hooks/guardrails/execution-stall';
import { resetSwarmState, swarmState } from '../../../src/state';
import {
	type TelemetryEvent,
	_internals as telemetryInternals,
} from '../../../src/telemetry';

const TEST_DIR = path.join(os.tmpdir(), 'stall-ladder-fixture');

const realNow = _internals.now;
const realCapture = _internals.captureWorkspaceSnapshotAsync;
const realChanged = _internals.changedFilesSinceSnapshotAsync;
const realEmit = telemetryInternals.emit;

let clock = 1_700_000_000_000;
let events: Array<{ event: TelemetryEvent; data: Record<string, unknown> }> =
	[];

beforeEach(() => {
	resetSwarmState();
	_test_exports.reset();
	clock = 1_700_000_000_000;
	events = [];
	_internals.now = () => clock;
	_internals.captureWorkspaceSnapshotAsync = mock(
		() => ({ gitHead: 'HEAD0', changedFiles: [] }) as never,
	) as never;
	_internals.changedFilesSinceSnapshotAsync = mock(async () => []) as never;
	telemetryInternals.emit = ((
		event: TelemetryEvent,
		data: Record<string, unknown>,
	) => {
		events.push({ event, data });
	}) as typeof telemetryInternals.emit;
});

afterEach(() => {
	_internals.now = realNow;
	_internals.captureWorkspaceSnapshotAsync = realCapture;
	_internals.changedFilesSinceSnapshotAsync = realChanged;
	telemetryInternals.emit = realEmit;
	_test_exports.reset();
	resetSwarmState();
});

function armed(sessionID: string): void {
	swarmState.activeAgent.set(sessionID, 'architect');
	observeExecutionStallToolCall({
		sessionID,
		tool: 'Task',
		args: { subagent_type: 'coder' },
		callID: 'arm-task',
	});
}

function nonProgress(sessionID: string, n: number): void {
	clock += 1_000;
	observeExecutionStallToolCall({
		sessionID,
		tool: 'read',
		args: { filePath: `/p/f-${n}.ts` },
		callID: `r-${n}`,
	});
}

/** Drive the counter to exactly `target` non-progress calls. */
function driveTo(sessionID: string, target: number): void {
	armed(sessionID);
	const current = _test_exports.peekState(sessionID)?.nonProgressCalls ?? 0;
	for (let i = current; i < target; i++) nonProgress(sessionID, i);
	expect(_test_exports.peekState(sessionID)?.nonProgressCalls).toBe(target);
}

function advisories(sessionID: string): string[] {
	return swarmState.agentSessions.get(sessionID)?.pendingAdvisoryMessages ?? [];
}

function stallAdvisories(sessionID: string): string[] {
	return advisories(sessionID).filter((m) => m.startsWith('EXECUTION STALL:'));
}

describe('#2063 B5 — advisory rung', () => {
	test('fires exactly once at execution_stall_warn_calls, with the specified text', () => {
		const sessionID = 'warn-rung';
		driveTo(sessionID, DEFAULT_EXECUTION_STALL_WARN_CALLS - 1);
		expect(stallAdvisories(sessionID)).toHaveLength(0);

		nonProgress(sessionID, 1000);
		const fired = stallAdvisories(sessionID);
		expect(fired).toHaveLength(1);
		// Pinned against the module's own builder AND against the literal spec
		// text, so neither can drift from the other unnoticed.
		expect(fired[0]).toBe(
			executionStallAdvisoryText(DEFAULT_EXECUTION_STALL_WARN_CALLS),
		);
		expect(fired[0]).toBe(
			`EXECUTION STALL: ${DEFAULT_EXECUTION_STALL_WARN_CALLS} tool calls with no delegation completion, no file changes, and no status update. STOP investigating; delegate the work or report BLOCKED to the user.`,
		);

		// Latched: 20 further non-progress calls add no second advisory.
		for (let i = 0; i < 20; i++) nonProgress(sessionID, 2000 + i);
		expect(stallAdvisories(sessionID)).toHaveLength(1);
	});

	test('emits execution_stall_warning telemetry once per streak', () => {
		const sessionID = 'warn-telemetry';
		driveTo(sessionID, DEFAULT_EXECUTION_STALL_WARN_CALLS);

		const warnings = events.filter(
			(e) => e.event === 'execution_stall_warning',
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].data.count).toBe(DEFAULT_EXECUTION_STALL_WARN_CALLS);
		expect(warnings[0].data.threshold).toBe(DEFAULT_EXECUTION_STALL_WARN_CALLS);
	});

	test('does not deny at the advisory rung', () => {
		const sessionID = 'warn-no-deny';
		driveTo(sessionID, DEFAULT_EXECUTION_STALL_WARN_CALLS + 5);
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'read' }),
		).not.toThrow();
	});
});

describe('#2063 B5 — hard rung', () => {
	test('denies at execution_stall_stop_calls and not one call earlier', () => {
		const sessionID = 'stop-rung';
		driveTo(sessionID, DEFAULT_EXECUTION_STALL_STOP_CALLS - 1);
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'read' }),
		).not.toThrow();

		nonProgress(sessionID, 5000);
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'read' }),
		).toThrow(/^EXECUTION_STALL:/);
	});

	test('the denial states the counts, names the open avenues, and says DELEGATE', () => {
		const sessionID = 'stop-message';
		driveTo(sessionID, DEFAULT_EXECUTION_STALL_STOP_CALLS);

		let message = '';
		try {
			enforceExecutionStallDenial({ sessionID, tool: 'bash' });
		} catch (err) {
			message = (err as Error).message;
		}

		expect(message).toBe(
			executionStallDenialText(DEFAULT_EXECUTION_STALL_STOP_CALLS, 'bash'),
		);
		// (i) counts
		expect(message).toContain(
			`${DEFAULT_EXECUTION_STALL_STOP_CALLS} tool calls`,
		);
		// (ii) productive avenues remain open
		expect(message).toContain('Productive avenues remain OPEN');
		// (iii) the explicit delegation / status / report instruction
		expect(message).toContain('DELEGATE');
		expect(message).toContain('`Task`');
		expect(message).toContain('`update_task_status`');
		expect(message).toContain('report the blocker to the user');
		// The hard rung blocks direct bash test runs, so the message must name
		// the delegation path that replaces them (round-3 advisory).
		expect(message).toContain('run builds and tests');
	});

	test('the leading token is the EXECUTION_STALL code B1 keys its streak on', async () => {
		const { deriveGateDenialCode } = await import(
			'../../../src/hooks/gate-denial-tracker'
		);
		const sessionID = 'stop-code';
		driveTo(sessionID, DEFAULT_EXECUTION_STALL_STOP_CALLS);

		let message = '';
		try {
			enforceExecutionStallDenial({ sessionID, tool: 'grep' });
		} catch (err) {
			message = (err as Error).message;
		}
		expect(deriveGateDenialCode(message)).toBe('EXECUTION_STALL');
	});

	test('denies every non-productive tool in the deny set', () => {
		const sessionID = 'deny-set';
		driveTo(sessionID, DEFAULT_EXECUTION_STALL_STOP_CALLS);

		// Driven from the production set, so a name added there without a
		// matching allow-set review cannot slip past this file.
		expect([...EXECUTION_STALL_DENIED_TOOLS].sort()).toEqual([
			'bash',
			'glob',
			'grep',
			'read',
			'shell',
		]);
		for (const tool of EXECUTION_STALL_DENIED_TOOLS) {
			expect(() => enforceExecutionStallDenial({ sessionID, tool })).toThrow(
				/^EXECUTION_STALL:/,
			);
		}
		// Namespaced forms normalize to the same names.
		for (const tool of ['opencode:read', 'opencode.bash', 'mega:grep']) {
			expect(() => enforceExecutionStallDenial({ sessionID, tool })).toThrow(
				/^EXECUTION_STALL:/,
			);
		}
	});

	test('NEVER denies the tools that are the way out', () => {
		const sessionID = 'allow-set';
		driveTo(sessionID, DEFAULT_EXECUTION_STALL_STOP_CALLS + 25);

		const mustPass = [
			'Task',
			'task',
			'update_task_status',
			'save_plan',
			'get_approved_plan',
			'phase_complete',
			'lean_turbo_run_phase',
			'dispatch_lanes_async',
			'declare_scope',
			'write',
			'edit',
			'todowrite',
			'question',
		];
		for (const tool of mustPass) {
			// Absence from the PRODUCTION deny set is the property under test —
			// the literal list is only the sample that exercises it.
			expect(EXECUTION_STALL_DENIED_TOOLS.has(tool.toLowerCase())).toBe(false);
			expect(() =>
				enforceExecutionStallDenial({ sessionID, tool }),
			).not.toThrow();
		}
	});

	test('emits execution_stall_denied telemetry once per streak', () => {
		const sessionID = 'deny-telemetry';
		driveTo(sessionID, DEFAULT_EXECUTION_STALL_STOP_CALLS);

		for (let i = 0; i < 4; i++) {
			expect(() =>
				enforceExecutionStallDenial({ sessionID, tool: 'read' }),
			).toThrow();
		}
		const denials = events.filter((e) => e.event === 'execution_stall_denied');
		expect(denials).toHaveLength(1);
		expect(denials[0].data.tool).toBe('read');
		expect(denials[0].data.threshold).toBe(DEFAULT_EXECUTION_STALL_STOP_CALLS);
	});

	test('honours configured warn/stop thresholds', () => {
		const sessionID = 'configured-rungs';
		const options = { warnCalls: 3, stopCalls: 5 };
		swarmState.activeAgent.set(sessionID, 'architect');
		observeExecutionStallToolCall({
			sessionID,
			tool: 'Task',
			args: { subagent_type: 'coder' },
			callID: 'arm',
			options,
		});
		for (let i = 0; i < 4; i++) {
			observeExecutionStallToolCall({
				sessionID,
				tool: 'read',
				args: { filePath: `/p/${i}.ts` },
				callID: `r-${i}`,
				options,
			});
		}
		expect(stallAdvisories(sessionID)).toHaveLength(1);
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'read', options }),
		).toThrow(/^EXECUTION_STALL:/);
	});
});

describe('#2063 B5 — composite lock (round-2 rev6)', () => {
	test('with the hard rung active AND another gate denying Task, update_task_status and advisory surfacing still pass', async () => {
		const sessionID = 'composite';
		driveTo(sessionID, DEFAULT_EXECUTION_STALL_STOP_CALLS);

		// Another gate (delegation-gate) keeps rejecting the Task dispatch.
		const simulateOtherGateDenyingTask = () => {
			observeExecutionStallToolCall({
				sessionID,
				tool: 'Task',
				args: { subagent_type: 'coder' },
				callID: 'blocked-task',
			});
			// B5 itself never denies Task.
			enforceExecutionStallDenial({ sessionID, tool: 'Task' });
			throw new Error('ACCEPTANCE_FIELD_REQUIRED: task 1.1 needs ACCEPTANCE');
		};
		expect(simulateOtherGateDenyingTask).toThrow('ACCEPTANCE_FIELD_REQUIRED');

		// The status path stays open …
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'update_task_status' }),
		).not.toThrow();
		// … and it is a progress event, which clears the hard rung so the session
		// is not deadlocked between two gates.
		await recordExecutionStallToolAfter({
			sessionID,
			tool: 'update_task_status',
			callID: 'uts-1',
			args: { task_id: '1.1', status: 'blocked' },
			output: {
				title: 'update_task_status',
				output: JSON.stringify({ success: true, new_status: 'blocked' }),
				metadata: {},
			},
			directory: TEST_DIR,
		});
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'read' }),
		).not.toThrow();

		// The advisory the architect needs to surface the blocker survived.
		expect(stallAdvisories(sessionID).length).toBeGreaterThanOrEqual(1);
	});
});
