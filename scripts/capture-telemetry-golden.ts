#!/usr/bin/env bun
/**
 * Capture the golden telemetry-line corpus for issue #2029.
 *
 * WHY THIS EXISTS
 * ---------------
 * Issue #2029 routes `src/telemetry.ts:emit()` through a canonical observability
 * envelope. The compliance condition (issue item 5, arm (a)) is that the bytes
 * written to `.swarm/telemetry.jsonl` are **preserved exactly**.
 *
 * A parity test that compares the new code against a hand-copied
 * `{ timestamp, event, ...data }` literal proves nothing — it compares new code
 * to a fresh copy of old code. So this script drives the **real** `emit()` on the
 * **unmodified** tree and records the bytes it actually writes.
 *
 * CAPTURE ORDERING IS MANDATORY
 * -----------------------------
 * Run this on a clean tree at the PR's base SHA, BEFORE any edit to
 * `src/telemetry.ts`, and commit the fixture first. Regenerating it after the
 * change would make the parity test tautological.
 *
 *   bun run scripts/capture-telemetry-golden.ts
 *
 * The script refuses to run if `src/telemetry.ts` has uncommitted modifications.
 *
 * COVERAGE
 * --------
 * All 33 event kinds: the 26 `telemetry.*` convenience helpers, plus the 7 kinds
 * emitted by direct `emit(...)` calls elsewhere in `src/`, with their real payload
 * shapes (not synthesized ones):
 *   - src/evidence/lock.ts:86,94,129
 *   - src/plan/ledger.ts:681
 *   - src/plan/manager.ts:329,1696
 *   - src/hooks/conflict-resolution.ts:67
 *
 * Three of those payloads carry a caller-supplied key that COLLIDES with the
 * envelope (`timestamp`, and for the conflict event also `type`). Those cases are
 * the reason the projection must spread the caller's object last, and they use a
 * literal timestamp distinct from FIXED_ISO so the collision stays observable even
 * when the parity test freezes the clock.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { emit, initTelemetry, resetTelemetryForTesting, telemetry } from '../src/telemetry.js';

/** Stamp every envelope timestamp deterministically so bytes are comparable. */
const FIXED_ISO = '2026-01-15T12:00:00.000Z';

/**
 * A caller-supplied timestamp that is deliberately DIFFERENT from FIXED_ISO.
 * `plan_md_write_failed` and `agent_conflict_detected` both pass their own
 * `timestamp`, which must win on value while the envelope's key keeps position 1.
 * If this equalled FIXED_ISO the property would be invisible.
 */
const CALLER_ISO = '2020-01-02T03:04:05.678Z';

const OUT = path.join(
	import.meta.dir,
	'..',
	'tests',
	'fixtures',
	'observability',
	'telemetry-lines-golden.json',
);

function assertCleanTelemetrySource(): void {
	const res = spawnSync('git', ['status', '--porcelain', '--', 'src/telemetry.ts'], {
		cwd: path.join(import.meta.dir, '..'),
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 15_000,
	});
	if (res.status !== 0) {
		throw new Error(`git status failed: ${res.stderr}`);
	}
	if (res.stdout.trim() !== '') {
		throw new Error(
			'REFUSING TO CAPTURE: src/telemetry.ts has uncommitted changes.\n' +
				'The golden corpus must be captured from the unmodified tree, before the\n' +
				'observability wiring lands, or the parity test becomes tautological.\n' +
				'See the header of this file and issue #2029 plan blocker BL-5.',
		);
	}
}

/** Drive every convenience helper with representative, stable arguments. */
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
	// Second delegation_end with NO cost fields — exercises the `undefined`-valued
	// keys (`model`, `gate`, `retry_index`) that JSON.stringify elides. Any
	// projection that clones or normalizes the payload would resurrect them.
	telemetry.delegationEnd('sess-1', 'reviewer', '1.2', 'failure');
	telemetry.taskStateChanged('sess-1', '1.1', 'in_progress', 'pending');
	telemetry.gatePassed('sess-1', 'qa_gate', '1.1');
	telemetry.gateParseError('1.1', new Error('unparseable verdict'));
	telemetry.gateFailed('sess-1', 'qa_gate', '1.1', 'missing evidence');
	telemetry.reviewerGateDecision('sess-1', '1.1', false, 'durable_evidence_complete', 'genuine');
	telemetry.phaseChanged('sess-1', 1, 2);
	telemetry.budgetUpdated('sess-1', 42.5, 'architect');
	telemetry.modelFallback('sess-1', 'coder', 'model-a', 'model-b', 'rate_limited');
	telemetry.hardLimitHit('sess-1', 'coder', 'tokens', 100000);
	telemetry.revisionLimitHit('sess-1', 'coder');
	telemetry.loopDetected('sess-1', 'coder', 'debugging_spiral');
	telemetry.scopeViolation('sess-1', 'coder', 'src/forbidden.ts', 'outside declared scope');
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

/**
 * Reproduce the 7 direct `emit(...)` call sites verbatim. These payload shapes are
 * produced by NO convenience helper, so a corpus built only from `telemetry.*`
 * would silently under-cover them.
 */
function emitAllDirectCallSites(): void {
	// src/evidence/lock.ts:86
	emit('evidence_lock_stale_recovered', {
		directory: '/proj',
		evidencePath: '/proj/.swarm/evidence/1.1.json',
		agent: 'coder',
		taskId: '1.1',
		attempt: 2,
	});
	// src/evidence/lock.ts:94
	emit('evidence_lock_acquired', {
		directory: '/proj',
		evidencePath: '/proj/.swarm/evidence/1.1.json',
		agent: 'coder',
		taskId: '1.1',
		attempt: 0,
	});
	// src/evidence/lock.ts:129
	emit('evidence_lock_contended', {
		directory: '/proj',
		evidencePath: '/proj/.swarm/evidence/1.1.json',
		agent: 'reviewer',
		taskId: '1.1',
		attempt: 1,
	});
	// src/plan/ledger.ts:681
	emit('snapshot_failed', {
		error: 'ENOSPC: no space left on device',
		retries: 3,
		source: 'savePlan',
	});
	// src/plan/manager.ts:329
	emit('plan_ledger_cas_retry', {
		attempt: 1,
		expectedHashPrefix: 'deadbeef',
		delayMs: 37,
	});
	// src/plan/manager.ts:1696 — caller supplies its OWN `timestamp`, which must
	// win on value while the envelope key keeps position 1.
	emit('plan_md_write_failed', {
		directory: '/proj',
		error: 'EACCES: permission denied',
		timestamp: CALLER_ISO,
	});
	// src/hooks/conflict-resolution.ts:67 — caller supplies BOTH `type` and
	// `timestamp`. On the unmodified tree this kind is force-cast past the type
	// system and is absent from the `TelemetryEvent` union; issue #2029 adds it.
	emit('agent_conflict_detected' as Parameters<typeof emit>[0], {
		type: 'agent_conflict_detected',
		timestamp: CALLER_ISO,
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
 * `telemetry.emit()` writes through an async stream and `resetTelemetryForTesting()`
 * calls `stream.end()`, which flushes asynchronously. Reading the file immediately
 * afterwards races the flush, so poll for the fully-written file rather than
 * assuming it is there.
 */
async function readFlushedLines(tmpDir: string): Promise<string[]> {
	const file = path.join(tmpDir, '.swarm', 'telemetry.jsonl');
	const deadline = Date.now() + 10_000;
	let lastSize = -1;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) {
			const size = fs.statSync(file).size;
			// Stable size across two polls => flush complete.
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

async function main(): Promise<void> {
	assertCleanTelemetrySource();

	const realToISOString = Date.prototype.toISOString;
	// Freeze only the envelope's clock read. Caller-supplied literal timestamps
	// (CALLER_ISO) are plain strings and are unaffected.
	// biome-ignore lint/complexity/useArrowFunction: needs `this` binding semantics of the original.
	Date.prototype.toISOString = function (this: Date): string {
		return FIXED_ISO;
	};

	const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-golden-')));
	let lines: string[];
	try {
		resetTelemetryForTesting();
		initTelemetry(tmpDir);

		emitAllHelpers();
		emitAllDirectCallSites();

		// The write stream is async; end it, then wait for the flush to settle.
		resetTelemetryForTesting();
		lines = await readFlushedLines(tmpDir);
	} finally {
		Date.prototype.toISOString = realToISOString;
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}

	// Array-form, explicit cwd, stdin ignored, bounded timeout — AGENTS.md
	// invariant 3. This script is developer-only (never on the plugin init or
	// runtime path), but the invariant applies to subprocesses generally and a
	// never-closed inherited stdin can block a child from exiting under Bun on
	// Windows, so it is honoured here too rather than claimed as an exemption.
	const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], {
		cwd: path.join(import.meta.dir, '..'),
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 15_000,
	}).stdout.trim();

	const fixture = {
		$comment:
			'GOLDEN CORPUS — captured from the UNMODIFIED tree by scripts/capture-telemetry-golden.ts. ' +
			'Do NOT hand-edit and do NOT regenerate after the observability wiring lands: ' +
			'that would make tests/unit/telemetry/emit-line-parity.test.ts tautological (issue #2029, BL-5).',
		capturedFromSha: baseSha,
		fixedIso: FIXED_ISO,
		callerIso: CALLER_ISO,
		lineCount: lines.length,
		// Stored as raw strings, not parsed objects: key ORDER is the property under
		// test, and JSON.parse -> JSON.stringify would not necessarily preserve it.
		lines,
	};

	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.writeFileSync(OUT, `${JSON.stringify(fixture, null, '\t')}\n`, 'utf-8');

	console.log(`captured ${lines.length} golden telemetry lines from ${baseSha}`);
	console.log(`wrote ${OUT}`);
}

await main();
