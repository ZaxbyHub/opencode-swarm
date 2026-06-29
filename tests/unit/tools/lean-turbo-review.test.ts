/**
 * Behavioral tests for the lean_turbo_review tool (FR-009).
 *
 * Tests the three observable outcomes of executeLeanTurboReview:
 * 1. Verdict reporting — reviewer verdict properly captured and returned
 * 2. Evidence writing — review verdict written to evidence file
 * 3. Escalation on REJECT — REJECTED verdict is returned with evidence path
 *    (escalation to architect/critic is the caller's responsibility;
 *    the tool surfaces the REJECTED verdict and writes it to the evidence file)
 *
 * Uses _internals DI seam on src/turbo/lean/reviewer to intercept
 * compileReviewPackage and dispatchReviewerAgent so the test can control
 * the reviewer outcome without needing full lane/phase evidence infrastructure.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
	LaneEvidence,
	PhaseEvidence,
} from '../../../src/turbo/lean/evidence';
import {
	type PhaseReviewerResult,
	_internals as reviewerInternals,
} from '../../../src/turbo/lean/reviewer';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkdtemp(): string {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), 'lean-turbo-review-tool-test-'),
	);
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence', '1', 'lean-turbo'), {
		recursive: true,
	});
	return dir;
}

function writeLaneEvidence(
	dir: string,
	phase: number,
	lane: LaneEvidence,
): void {
	const evidenceDir = path.join(
		dir,
		'.swarm',
		'evidence',
		String(phase),
		'lean-turbo',
	);
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, `${lane.laneId}.json`),
		JSON.stringify(lane),
		'utf-8',
	);
}

function writePhaseEvidence(
	dir: string,
	phase: number,
	evidence: PhaseEvidence,
): void {
	const evidenceDir = path.join(
		dir,
		'.swarm',
		'evidence',
		String(phase),
		'lean-turbo',
	);
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'lean-turbo-phase.json'),
		JSON.stringify(evidence),
		'utf-8',
	);
}

// ─── Original _internals references ─────────────────────────────────────────────

const _originalCompileReviewPackage = reviewerInternals.compileReviewPackage;
const _originalDispatchReviewerAgent = reviewerInternals.dispatchReviewerAgent;
const _originalWriteReviewerEvidence = reviewerInternals.writeReviewerEvidence;

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('executeLeanTurboReview — behavioral tests (FR-009)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtemp();

		// Set up minimal lane and phase evidence so compileReviewPackage succeeds
		writeLaneEvidence(tempDir, 1, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: ['src/a.ts'],
			status: 'completed',
			sessionId: 'test-session',
		});
		writePhaseEvidence(tempDir, 1, {
			phase: 1,
			planId: 'test-plan',
			lanes: [],
			degradedTasks: [],
			startedAt: new Date().toISOString(),
			status: 'completed',
			integratedDiffSummary: 'added: 10 lines, removed: 2 lines',
		});
	});

	afterEach(() => {
		// Restore original _internals
		reviewerInternals.compileReviewPackage = _originalCompileReviewPackage;
		reviewerInternals.dispatchReviewerAgent = _originalDispatchReviewerAgent;
		reviewerInternals.writeReviewerEvidence = _originalWriteReviewerEvidence;

		// Clean up temp dir
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	// ─── Outcome 1: Verdict reporting ────────────────────────────────────────

	test('APPROVED verdict is captured and returned with reason', async () => {
		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
			): Promise<string> => {
				return 'VERDICT: APPROVED\nREASON: all lanes completed successfully';
			},
		);

		const result = await executeLeanTurboReview({
			directory: tempDir,
			phase: 1,
			sessionID: 'test-session',
		});

		expect(result.success).toBe(true);
		expect(result.verdict).toBe('APPROVED');
		expect(result.reason).toBe('all lanes completed successfully');
		expect(result.errors).toBeUndefined();
	});

	test('NEEDS_REVISION verdict is captured and returned', async () => {
		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
			): Promise<string> => {
				return 'VERDICT: NEEDS_REVISION\nREASON: degraded tasks remain unresolved';
			},
		);

		const result = await executeLeanTurboReview({
			directory: tempDir,
			phase: 1,
			sessionID: 'test-session',
		});

		expect(result.success).toBe(true);
		expect(result.verdict).toBe('NEEDS_REVISION');
		expect(result.reason).toBe('degraded tasks remain unresolved');
	});

	test('REJECTED verdict is captured and returned', async () => {
		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
			): Promise<string> => {
				return 'VERDICT: REJECTED\nREASON: critical safety concerns detected';
			},
		);

		const result = await executeLeanTurboReview({
			directory: tempDir,
			phase: 1,
			sessionID: 'test-session',
		});

		expect(result.success).toBe(true);
		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toBe('critical safety concerns detected');
	});

	test('verdict without reason returns undefined reason', async () => {
		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
			): Promise<string> => {
				return 'VERDICT: APPROVED';
			},
		);

		const result = await executeLeanTurboReview({
			directory: tempDir,
			phase: 1,
			sessionID: 'test-session',
		});

		expect(result.success).toBe(true);
		expect(result.verdict).toBe('APPROVED');
		expect(result.reason).toBeUndefined();
	});

	// ─── Outcome 2: Evidence writing ──────────────────────────────────────────

	test('evidence file is written to .swarm/evidence/{phase}/lean-turbo-reviewer.json', async () => {
		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
			): Promise<string> => {
				return 'VERDICT: APPROVED\nREASON: all checks passed';
			},
		);

		const result = await executeLeanTurboReview({
			directory: tempDir,
			phase: 1,
			sessionID: 'test-session',
		});

		expect(result.success).toBe(true);
		expect(result.evidencePath).toBeDefined();
		expect(result.evidencePath).toMatch(
			/\.swarm[\\/]evidence[\\/]1[\\/]lean-turbo-reviewer\.json$/,
		);

		// Verify the file was actually written with correct content
		const content = fs.readFileSync(result.evidencePath!, 'utf-8');
		const parsed = JSON.parse(content);
		expect(parsed.verdict).toBe('APPROVED');
		expect(parsed.reason).toBe('all checks passed');
		expect(parsed.phase).toBe(1);
		expect(parsed.timestamp).toBeTruthy();
	});

	test('evidence file contains REJECTED verdict and reason for escalation', async () => {
		// Set up phase 2 evidence
		writeLaneEvidence(tempDir, 2, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'completed',
			sessionId: 'test-session',
		});
		writePhaseEvidence(tempDir, 2, {
			phase: 2,
			planId: 'test-plan',
			lanes: [],
			degradedTasks: [],
			startedAt: new Date().toISOString(),
			status: 'completed',
			integratedDiffSummary: 'added: 5 lines',
		});

		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
			): Promise<string> => {
				return 'VERDICT: REJECTED\nREASON: unresolvable file conflict';
			},
		);

		const result = await executeLeanTurboReview({
			directory: tempDir,
			phase: 2,
			sessionID: 'test-session',
		});

		expect(result.evidencePath).toMatch(
			/\.swarm[\\/]evidence[\\/]2[\\/]lean-turbo-reviewer\.json$/,
		);

		const content = fs.readFileSync(result.evidencePath!, 'utf-8');
		const parsed = JSON.parse(content);
		expect(parsed.verdict).toBe('REJECTED');
		expect(parsed.reason).toBe('unresolvable file conflict');
		expect(parsed.phase).toBe(2);
	});

	test('writeReviewerEvidence is called with correct verdict and reason', async () => {
		const writeSpy = mock(
			async (
				_dir: string,
				phase: number,
				verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED',
				reason?: string,
			): Promise<string> => {
				const evidenceDir = path.join(
					_dir,
					'.swarm',
					'evidence',
					String(phase),
				);
				const evidencePath = path.join(evidenceDir, 'lean-turbo-reviewer.json');
				return evidencePath;
			},
		);

		// Replace writeReviewerEvidence with spy
		reviewerInternals.writeReviewerEvidence = writeSpy;

		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
			): Promise<string> => {
				return 'VERDICT: APPROVED\nREASON: atomic write verified';
			},
		);

		const result = await executeLeanTurboReview({
			directory: tempDir,
			phase: 1,
			sessionID: 'test-session',
		});

		expect(result.success).toBe(true);
		expect(writeSpy).toHaveBeenCalled();
		expect(writeSpy).toHaveBeenCalledWith(
			tempDir,
			1,
			'APPROVED',
			'atomic write verified',
		);
	});

	// ─── Outcome 3: Escalation on REJECT ─────────────────────────────────────

	test('REJECTED verdict is returned so caller can escalate to architect/critic', async () => {
		// The tool surfaces the REJECTED verdict via result.verdict and writes it to
		// the evidence file. The caller (e.g. phase_complete) reads the evidence file
		// and escalates to architect/critic based on the REJECTED verdict.
		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
			): Promise<string> => {
				return 'VERDICT: REJECTED\nREASON: critical safety violations found';
			},
		);

		const result = await executeLeanTurboReview({
			directory: tempDir,
			phase: 1,
			sessionID: 'test-session',
		});

		// success=true because reviewer returned a verdict (not an error)
		expect(result.success).toBe(true);
		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toBe('critical safety violations found');
		expect(result.evidencePath).toBeDefined();

		// Evidence file has REJECTED so caller can read it for escalation
		const content = fs.readFileSync(result.evidencePath!, 'utf-8');
		const parsed = JSON.parse(content);
		expect(parsed.verdict).toBe('REJECTED');
	});

	test('dispatch failure returns REJECTED verdict in result for fail-closed escalation', async () => {
		// When dispatchReviewerAgent throws, dispatchPhaseReviewer catches it,
		// writes REJECTED to evidence file (fail-closed), and returns REJECTED verdict.
		// executeLeanTurboReview propagates this as success=true with verdict=REJECTED.
		// The caller reads the evidence file and escalates based on the REJECTED verdict.
		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
			): Promise<string> => {
				throw new Error('OpencodeClient not available');
			},
		);

		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		const result = await executeLeanTurboReview({
			directory: tempDir,
			phase: 1,
			sessionID: 'test-session',
		});

		// success=true because dispatchPhaseReviewer returned (it caught the error internally)
		expect(result.success).toBe(true);
		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toContain('Reviewer dispatch failed');
		expect(result.evidencePath).toBeDefined();

		// Evidence file has REJECTED so caller can escalate
		const content = fs.readFileSync(result.evidencePath!, 'utf-8');
		const parsed = JSON.parse(content);
		expect(parsed.verdict).toBe('REJECTED');
	});

	test('unparseable reviewer response → REJECTED verdict in result for escalation', async () => {
		// When the reviewer returns no VERDICT marker, dispatchPhaseReviewer writes
		// REJECTED to evidence (fail-closed) and returns REJECTED.
		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
			): Promise<string> => {
				return 'The reviewer declined to issue a verdict.';
			},
		);

		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		const result = await executeLeanTurboReview({
			directory: tempDir,
			phase: 1,
			sessionID: 'test-session',
		});

		// dispatchPhaseReviewer wrote REJECTED to evidence (fail-closed)
		expect(result.success).toBe(true);
		expect(result.verdict).toBe('REJECTED');
		expect(result.reason).toBe('Reviewer response could not be parsed');

		// Evidence file contains REJECTED for caller escalation
		const content = fs.readFileSync(result.evidencePath!, 'utf-8');
		const parsed = JSON.parse(content);
		expect(parsed.verdict).toBe('REJECTED');
	});

	// ─── Additional behavioral tests ───────────────────────────────────────────

	test('handles phase parameter correctly in evidence path', async () => {
		// Write phase 3 evidence
		writeLaneEvidence(tempDir, 3, {
			laneId: 'lane-1',
			taskIds: ['1.1'],
			files: [],
			status: 'completed',
			sessionId: 'test-session',
		});
		writePhaseEvidence(tempDir, 3, {
			phase: 3,
			planId: 'test-plan',
			lanes: [],
			degradedTasks: [],
			startedAt: new Date().toISOString(),
			status: 'completed',
			integratedDiffSummary: 'added: 10 lines',
		});

		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
			): Promise<string> => {
				return 'VERDICT: APPROVED\nREASON: phase 3 review complete';
			},
		);

		const result = await executeLeanTurboReview({
			directory: tempDir,
			phase: 3,
			sessionID: 'test-session',
		});

		expect(result.success).toBe(true);
		expect(result.evidencePath).toMatch(
			/\.swarm[\\/]evidence[\\/]3[\\/]lean-turbo-reviewer\.json$/,
		);

		const content = fs.readFileSync(result.evidencePath!, 'utf-8');
		const parsed = JSON.parse(content);
		expect(parsed.phase).toBe(3);
	});

	test('handles sessionID parameter correctly', async () => {
		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		let capturedSessionId: string | undefined;

		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
				parentSessionId?: string,
			): Promise<string> => {
				capturedSessionId = parentSessionId;
				return 'VERDICT: APPROVED\nREASON: session ID passed correctly';
			},
		);

		const result = await executeLeanTurboReview({
			directory: tempDir,
			phase: 1,
			sessionID: 'my-custom-session-123',
		});

		expect(result.success).toBe(true);
		expect(capturedSessionId).toBe('my-custom-session-123');
	});

	test('compileReviewPackage is called with requireDiffSummary=true by default', async () => {
		const compileSpy = mock(
			async (
				_dir: string,
				phase: number,
				sessionID: string,
				requireDiff: boolean,
			) => {
				// Delegate to real implementation to get a valid ReviewPackage
				return _originalCompileReviewPackage(
					_dir,
					phase,
					sessionID,
					requireDiff,
				);
			},
		);

		reviewerInternals.compileReviewPackage = compileSpy;

		const { executeLeanTurboReview } = await import(
			'../../../src/tools/lean-turbo-review'
		);

		reviewerInternals.dispatchReviewerAgent = mock(
			async (
				_dir: string,
				_pkg: unknown,
				_agent: string,
				_timeout: number,
			): Promise<string> => {
				return 'VERDICT: APPROVED\nREASON: compile package verified';
			},
		);

		await executeLeanTurboReview({
			directory: tempDir,
			phase: 1,
			sessionID: 'test-session',
		});

		expect(compileSpy).toHaveBeenCalled();
		// Verify requireDiffSummary=true was passed (the 4th argument)
		const lastCall = compileSpy.mock.calls[compileSpy.mock.calls.length - 1];
		expect(lastCall[3]).toBe(true); // requireDiffSummary = true
	});
});
