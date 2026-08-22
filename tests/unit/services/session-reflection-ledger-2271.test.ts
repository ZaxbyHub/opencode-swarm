/**
 * Session-report ledger rejections — issue #2271 bug 6.
 *
 * Gate denials throw in tool.execute.before and never fire toolAfter, so
 * ToolAggregate.failureCount structurally cannot count them. A session with
 * six ledger rejections used to close with "0 tool failures or gate
 * rejections recorded this session." Reflection now derives rejection counts
 * from .swarm/events.jsonl (live first — finalize runs before archive — with
 * the newest archived copy as fallback) and reports them.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	type SessionReflectionData,
} from '../../../src/services/session-reflection';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { buildDeterministicReport } = _internals;

function baseData(
	overrides: Partial<SessionReflectionData> = {},
): SessionReflectionData {
	return {
		// Fixed stamp — nothing under test reads it, and a constant keeps this
		// file off the real clock (check-test-clock).
		timestamp: '2026-08-21T12:00:00.000Z',
		totalToolCalls: 0,
		totalToolFailures: 0,
		toolProblems: [],
		agentDispatches: [],
		gateFailures: [],
		lessonsFromRetros: [],
		errorTaxonomy: {},
		skillViolations: [],
		contradictionCandidates: [],
		...overrides,
	};
}

function writeEvents(directory: string, lines: string[]): void {
	const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	fs.writeFileSync(eventsPath, `${lines.join('\n')}\n`, 'utf-8');
}

const REJECTION_EVENTS = [
	JSON.stringify({
		type: 'coder_retry_circuit_breaker',
		timestamp: '2026-08-21T10:00:00Z',
		taskId: '1.1',
	}),
	JSON.stringify({
		type: 'plan_critic_gate_manual_approval',
		timestamp: '2026-08-21T10:05:00Z',
	}),
	JSON.stringify({
		type: 'coder_retry_circuit_breaker',
		timestamp: '2026-08-21T10:10:00Z',
		taskId: '2.1',
	}),
	// prm hard-stop events are telemetry.jsonl-only (no events.jsonl writer),
	// so they are not part of the counted set — included here to prove it.
	JSON.stringify({ type: 'prm_hard_stop', timestamp: '2026-08-21T10:15:00Z' }),
	// Process events that must NOT count as failures.
	JSON.stringify({
		type: 'task_removed',
		timestamp: '2026-08-21T10:20:00Z',
	}),
	JSON.stringify({
		type: 'sounding_board_consulted',
		timestamp: '2026-08-21T10:25:00Z',
	}),
	// Malformed line must be skipped, not fatal.
	'{not json',
];

describe('issue #2271 bug 6 — session reflection counts ledger rejections', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('reflection-ledger-2271-');
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('gatherLedgerRejections counts rejection-class events and skips the rest', async () => {
		writeEvents(tempDir, REJECTION_EVENTS);
		const counts = await _internals.gatherLedgerRejections(tempDir);
		expect(counts).toEqual({
			coder_retry_circuit_breaker: 2,
			plan_critic_gate_manual_approval: 1,
		});
	});

	test('gatherLedgerRejections is fail-open with no ledger', async () => {
		expect(await _internals.gatherLedgerRejections(tempDir)).toEqual({});
	});

	test('gatherLedgerRejections scopes to a session when one is provided', async () => {
		writeEvents(tempDir, [
			// REAL writer shape: coder_retry_circuit_breaker carries NO session
			// field (src/hooks/delegation-gate.ts emitCoderRetryEscalation) —
			// it must still count in scoped mode or bug 6's undercount returns
			// in the standard close flow.
			JSON.stringify({
				type: 'coder_retry_circuit_breaker',
				timestamp: '2026-08-21T10:00:00Z',
				taskId: '1.1',
			}),
			// A sibling session's explicitly-attributed event is excluded.
			JSON.stringify({
				type: 'coder_retry_circuit_breaker',
				sessionId: 'session-b',
			}),
			// sessionID variant attributed to this session counts.
			JSON.stringify({
				type: 'prm-pattern-irrelevant',
				sessionID: 'session-a',
			}),
			JSON.stringify({
				type: 'plan_critic_gate_manual_approval',
				sessionID: 'session-a',
			}),
			// architect_loop_detected has no session field in its typed shape.
			JSON.stringify({ type: 'architect_loop_detected' }),
		]);
		const scoped = await _internals.gatherLedgerRejections(
			tempDir,
			'session-a',
		);
		expect(scoped).toEqual({
			coder_retry_circuit_breaker: 1,
			plan_critic_gate_manual_approval: 1,
			architect_loop_detected: 1,
		});
		const unscoped = await _internals.gatherLedgerRejections(tempDir);
		expect(unscoped).toEqual({
			coder_retry_circuit_breaker: 2,
			plan_critic_gate_manual_approval: 1,
			architect_loop_detected: 1,
		});
	});

	test('gatherLedgerRejections falls back to the newest archived copy', async () => {
		const archiveRoot = path.join(tempDir, '.swarm', 'archive');
		// Real archive dirs are swarm-<ISO-timestamp>-<suffix>, so plain
		// lexicographic sort is chronological.
		fs.mkdirSync(path.join(archiveRoot, 'swarm-2026-08-20T10-00-00-000-a'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(archiveRoot, 'swarm-2026-08-20T10-00-00-000-a', 'events.jsonl'),
			`${JSON.stringify({ type: 'architect_loop_detected' })}\n`,
		);
		fs.mkdirSync(path.join(archiveRoot, 'swarm-2026-08-21T10-00-00-000-b'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(archiveRoot, 'swarm-2026-08-21T10-00-00-000-b', 'events.jsonl'),
			`${JSON.stringify({ type: 'agent_conflict_detected' })}\n`,
		);
		const counts = await _internals.gatherLedgerRejections(tempDir);
		expect(counts).toEqual({ agent_conflict_detected: 1 });
	});

	test('report no longer claims zero failures when the ledger shows rejections', () => {
		const report = buildDeterministicReport(
			baseData({
				ledgerRejections: {
					coder_retry_circuit_breaker: 4,
					plan_critic_gate_manual_approval: 2,
				},
			}),
		);
		expect(report).not.toContain(
			'No tool failures or gate rejections recorded this session.',
		);
		expect(report).toContain(
			'6 rejection/circuit-breaker event(s) in the session ledger',
		);
		expect(report).toContain('- coder_retry_circuit_breaker: 4');
		expect(report).toContain('- plan_critic_gate_manual_approval: 2');
		expect(report).not.toContain('Session completed without notable issues.');
	});

	test('report keeps the clean-session claim when the ledger is empty', () => {
		const report = buildDeterministicReport(baseData());
		expect(report).toContain(
			'No tool failures or gate rejections recorded this session.',
		);
		expect(report).toContain('Session completed without notable issues.');
	});

	test('ledger rejections augment counted tool failures', () => {
		const report = buildDeterministicReport(
			baseData({
				totalToolCalls: 10,
				totalToolFailures: 2,
				ledgerRejections: { architect_loop_detected: 1 },
			}),
		);
		expect(report).toContain('2 tool failure(s) across 10 calls');
		expect(report).toContain(
			'1 rejection/circuit-breaker event(s) in the session ledger',
		);
		expect(report).toContain('- architect_loop_detected: 1');
	});
});
