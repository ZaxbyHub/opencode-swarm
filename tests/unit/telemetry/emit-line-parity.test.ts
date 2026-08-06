/**
 * Byte-parity test for issue #2029's `emit()` wiring.
 *
 * ## What this proves
 *
 * `src/telemetry.ts:emit()` now builds a canonical observability envelope via
 * `_internals.createObservation` and projects it via
 * `_internals.toLegacyTelemetryLine` before writing to `.swarm/telemetry.jsonl`.
 * This test drives the REAL `emit()`/`telemetry.*` helpers — mirroring
 * `scripts/capture-telemetry-golden.ts`'s `emitAllHelpers()` and
 * `emitAllDirectCallSites()` call sequences EXACTLY (same args, same order) —
 * and asserts the bytes written match the golden corpus captured from the
 * UNMODIFIED tree at `e50386b9` (before the observability wiring landed).
 *
 * ## CRITICAL — DO NOT STUB THE WIRING SEAMS
 *
 * This test MUST NEVER stub `_internals.emit`, `_internals.createObservation`,
 * or `_internals.toLegacyTelemetryLine`. Doing so would make the test pass
 * vacuously — it would no longer exercise the real `createObservation` ->
 * `toLegacyTelemetryLine` composition that this issue wires into `emit()`.
 * Every line below is produced by calling the real, unmocked `telemetry.*`
 * helpers and the real `emit()`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	emit,
	initTelemetry,
	resetTelemetryForTesting,
	telemetry,
} from '../../../src/telemetry.js';
import golden from '../../fixtures/observability/telemetry-lines-golden.json' with {
	type: 'json',
};
import { freezeClock } from '../../helpers/test-clock.js';

/** Mirrors scripts/capture-telemetry-golden.ts emitAllHelpers() exactly. */
function emitAllHelpers(): void {
	telemetry.sessionStarted('sess-1', 'architect');
	telemetry.sessionEnded('sess-1', 'completed');
	telemetry.agentActivated('sess-1', 'coder', 'architect');
	telemetry.delegationBegin('sess-1', 'coder', '1.1');
	telemetry.delegationEnd('sess-1', 'coder', '1.1', 'success', {
		tokens_input: 100,
		tokens_output: 200,
		tokens_reasoning: 5,
		tokens_cache: 7,
		cost_usd: 0.0125,
		cost_source: 'reported',
		model: 'anthropic/claude-opus-5',
		gate: 'qa_gate',
		retry_index: 1,
	});
	telemetry.delegationEnd('sess-1', 'reviewer', '1.2', 'failure');
	telemetry.taskStateChanged('sess-1', '1.1', 'in_progress', 'pending');
	telemetry.gatePassed('sess-1', 'qa_gate', '1.1');
	telemetry.gateParseError('1.1', new Error('unparseable verdict'));
	telemetry.gateFailed('sess-1', 'qa_gate', '1.1', 'missing evidence');
	telemetry.reviewerGateDecision(
		'sess-1',
		'1.1',
		false,
		'durable_evidence_complete',
		'genuine',
	);
	telemetry.phaseChanged('sess-1', 1, 2);
	telemetry.budgetUpdated('sess-1', 42.5, 'architect');
	telemetry.modelFallback(
		'sess-1',
		'coder',
		'model-a',
		'model-b',
		'rate_limited',
	);
	telemetry.hardLimitHit('sess-1', 'coder', 'tokens', 100000);
	telemetry.revisionLimitHit('sess-1', 'coder');
	telemetry.loopDetected('sess-1', 'coder', 'debugging_spiral');
	telemetry.scopeViolation(
		'sess-1',
		'coder',
		'src/forbidden.ts',
		'outside declared scope',
	);
	telemetry.qaSkipViolation('sess-1', 'coder', 3);
	telemetry.heartbeat('sess-1');
	telemetry.turboModeChanged('sess-1', true, 'architect');
	telemetry.autoOversightEscalation('sess-1', 'deadlock', 4, 2, 3);
	telemetry.environmentDetected('sess-1', 'win32', 'powershell', 'gui');
	telemetry.prmPatternDetected('sess-1', 'thrash', 'high', 'edit_loop', [3, 9]);
	telemetry.prmCourseCorrectionInjected('sess-1', 'thrash', 2);
	telemetry.prmEscalationTriggered('sess-1', 'thrash', 3, 5);
	telemetry.prmHardStop('sess-1', 'thrash', 4, 7);
}

/** Mirrors scripts/capture-telemetry-golden.ts emitAllDirectCallSites() exactly. */
function emitAllDirectCallSites(callerIso: string): void {
	emit('evidence_lock_stale_recovered', {
		directory: '/proj',
		evidencePath: '/proj/.swarm/evidence/1.1.json',
		agent: 'coder',
		taskId: '1.1',
		attempt: 2,
	});
	emit('evidence_lock_acquired', {
		directory: '/proj',
		evidencePath: '/proj/.swarm/evidence/1.1.json',
		agent: 'coder',
		taskId: '1.1',
		attempt: 0,
	});
	emit('evidence_lock_contended', {
		directory: '/proj',
		evidencePath: '/proj/.swarm/evidence/1.1.json',
		agent: 'reviewer',
		taskId: '1.1',
		attempt: 1,
	});
	emit('snapshot_failed', {
		error: 'ENOSPC: no space left on device',
		retries: 3,
		source: 'savePlan',
	});
	emit('plan_ledger_cas_retry', {
		attempt: 1,
		expectedHashPrefix: 'deadbeef',
		delayMs: 37,
	});
	emit('plan_md_write_failed', {
		directory: '/proj',
		error: 'EACCES: permission denied',
		timestamp: callerIso,
	});
	emit('agent_conflict_detected' as Parameters<typeof emit>[0], {
		type: 'agent_conflict_detected',
		timestamp: callerIso,
		sessionId: 'sess-1',
		phase: 2,
		taskId: '1.1',
		sourceAgent: 'coder',
		targetAgent: 'reviewer',
		conflictType: 'verdict_disagreement',
		resolutionPath: 'escalate_critic',
		summary: 'reviewer rejected three cycles',
	});
}

/**
 * The write stream is async; `resetTelemetryForTesting()` calls `stream.end()`
 * which flushes asynchronously. Poll for a stable file size before reading,
 * mirroring `readFlushedLines` in scripts/capture-telemetry-golden.ts.
 */
async function readFlushedLines(tmpDir: string): Promise<string[]> {
	const file = path.join(tmpDir, '.swarm', 'telemetry.jsonl');
	const deadline = Date.now() + 10_000;
	let lastSize = -1;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) {
			const size = fs.statSync(file).size;
			if (size > 0 && size === lastSize) {
				const raw = fs.readFileSync(file, 'utf-8');
				return raw.split(/\r?\n/).filter((l) => l.trim() !== '');
			}
			lastSize = size;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`telemetry.jsonl never flushed at ${file}`);
}

describe('emit() line parity — issue #2029 observability wiring', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-parity-')),
		);
		resetTelemetryForTesting();
	});

	afterEach(() => {
		resetTelemetryForTesting();
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	test('produces byte-identical lines to the golden corpus, in order', async () => {
		expect(golden.lines.length).toBe(34);
		expect(golden.lineCount).toBe(golden.lines.length);

		// Freeze the clock so `observedAt`/`toISOString()` bytes are comparable to
		// the golden corpus. `isoNow` covers `new Date().toISOString()`, which is
		// what `createObservation` uses to stamp `observedAt`.
		const restore = freezeClock({ isoNow: golden.fixedIso });
		let lines: string[];
		try {
			initTelemetry(tmpDir);

			// Drive the REAL emit()/telemetry.* helpers — no stubbing of any
			// wiring seam. See module header.
			emitAllHelpers();
			emitAllDirectCallSites(golden.callerIso);

			resetTelemetryForTesting();
			lines = await readFlushedLines(tmpDir);
		} finally {
			restore();
		}

		expect(lines.length).toBe(golden.lines.length);
		for (let i = 0; i < golden.lines.length; i++) {
			expect(lines[i]).toBe(golden.lines[i]);
		}
	});

	test('(a) caller-supplied timestamp wins on value while staying first key — plan_md_write_failed', async () => {
		const restore = freezeClock({ isoNow: golden.fixedIso });
		let lines: string[];
		try {
			initTelemetry(tmpDir);
			emitAllHelpers();
			emitAllDirectCallSites(golden.callerIso);
			resetTelemetryForTesting();
			lines = await readFlushedLines(tmpDir);
		} finally {
			restore();
		}

		const planLine = lines.find((l) => l.includes('"plan_md_write_failed"'));
		expect(planLine).toBeDefined();
		const parsed = JSON.parse(planLine as string);
		expect(parsed.timestamp).toBe(golden.callerIso);
		expect(parsed.timestamp).not.toBe(golden.fixedIso);
		// timestamp must be the FIRST key in the serialized line.
		expect(Object.keys(parsed)[0]).toBe('timestamp');
		expect((planLine as string).indexOf('"timestamp"')).toBeLessThan(
			(planLine as string).indexOf('"event"'),
		);
	});

	test('(a) caller-supplied timestamp wins on value while staying first key — agent_conflict_detected', async () => {
		const restore = freezeClock({ isoNow: golden.fixedIso });
		let lines: string[];
		try {
			initTelemetry(tmpDir);
			emitAllHelpers();
			emitAllDirectCallSites(golden.callerIso);
			resetTelemetryForTesting();
			lines = await readFlushedLines(tmpDir);
		} finally {
			restore();
		}

		const conflictLine = lines.find((l) =>
			l.includes('"agent_conflict_detected"'),
		);
		expect(conflictLine).toBeDefined();
		const parsed = JSON.parse(conflictLine as string);
		expect(parsed.timestamp).toBe(golden.callerIso);
		expect(Object.keys(parsed)[0]).toBe('timestamp');

		// (b) BOTH `event` and `type` keys are retained (envelope key + caller key).
		expect(parsed.event).toBe('agent_conflict_detected');
		expect(parsed.type).toBe('agent_conflict_detected');
		expect(Object.hasOwn(parsed, 'event')).toBe(true);
		expect(Object.hasOwn(parsed, 'type')).toBe(true);
	});

	test('(c) second delegation_end (no cost fields) elides model/gate/retry_index', async () => {
		const restore = freezeClock({ isoNow: golden.fixedIso });
		let lines: string[];
		try {
			initTelemetry(tmpDir);
			emitAllHelpers();
			emitAllDirectCallSites(golden.callerIso);
			resetTelemetryForTesting();
			lines = await readFlushedLines(tmpDir);
		} finally {
			restore();
		}

		const delegationEndLines = lines.filter((l) =>
			l.includes('"delegation_end"'),
		);
		expect(delegationEndLines.length).toBe(2);
		const second = JSON.parse(delegationEndLines[1]);
		expect(second.agentName).toBe('reviewer');
		expect(Object.hasOwn(second, 'model')).toBe(false);
		expect(Object.hasOwn(second, 'gate')).toBe(false);
		expect(Object.hasOwn(second, 'retry_index')).toBe(false);
		// Confirm the raw serialized text has no stray key either (undefined
		// elision, not empty-string substitution).
		expect(delegationEndLines[1]).not.toContain('"model"');
		expect(delegationEndLines[1]).not.toContain('"gate"');
		expect(delegationEndLines[1]).not.toContain('"retry_index"');
	});

	test('unserializable payload (circular) still does not throw and writes nothing — matches src/telemetry.test.ts:137-162', () => {
		initTelemetry(tmpDir);

		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;

		expect(() =>
			emit('session_started', circular as Record<string, unknown>),
		).not.toThrow();

		const telemetryPath = path.join(tmpDir, '.swarm', 'telemetry.jsonl');
		// Either the file was never created, or it exists but is empty — no
		// partial/corrupt line was written for the circular payload.
		if (fs.existsSync(telemetryPath)) {
			const content = fs.readFileSync(telemetryPath, 'utf-8');
			expect(content.trim()).toBe('');
		}
	});
});
