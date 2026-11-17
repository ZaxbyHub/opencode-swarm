import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	findByCorrelationIdDetailed,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import {
	_test_exports,
	type DispatchLaneSpec,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

/**
 * #3710 D4 — async-lane launch-error TERMINAL contract redacts provider text.
 *
 * `appendAsyncLaneLaunchError` (src/tools/dispatch-lanes.ts) derives the
 * terminal quadruple (error / chars / truncated / digest) from ONE
 * sanitizeFailureEvidenceDisplay(message) value, so all four fields describe
 * the same sanitized body:
 *
 *   error     = sanitized.slice(0, MAX_ERROR_CHARS)   (MAX_ERROR_CHARS = 200)
 *   chars     = sanitized.length
 *   truncated = sanitized.length > MAX_ERROR_CHARS
 *   digest    = sha256(sanitized)
 *
 * Seam disclosure: `appendAsyncLaneLaunchError` itself is not exposed through
 * `_test_exports`. The drive uses the closest exported caller —
 * `_test_exports.startAsyncLanePrompt` with `mode: 'swarm-pr-review:base'`
 * and a structuredAdapter whose promptJsonSchema rejects with the raw
 * message — which reaches `appendAsyncLaneLaunchError` with
 * `formatError(error) === error.message` (an Error instance passes through
 * unbounded) BEFORE any registry/model gate. A pending delegation record is
 * seeded first via the exported `recordPendingDelegation` so the error lands
 * on the claim-settled terminal path (`settleDelegationTerminal`) instead of
 * the no-record bare transition that persists nothing; the settled record is
 * read back through the exported `findByCorrelationIdDetailed` coordination
 * store reader. No source-text assertions.
 *
 * Expected sanitized values are derived in-test by calling the REAL
 * `sanitizeFailureEvidenceDisplay` on the same raw message the module
 * receives, and the digest is re-derived as sha256 of that sanitized body
 * (the terminal contract in src/background/pending-delegations.ts). All
 * tokens below are synthetic.
 */

const SYNTH_TOKEN = 'sk-Synth0q9Xb2Lw4R5tY8uI1oP3sD6fG';
const SYNTH_OPENAI_PLACEHOLDER = '[REDACTED:openai]';
/** Terminal-contract bound pinned by src/tools/dispatch-lanes.ts. */
const MAX_ERROR_CHARS = 200;

interface TerminalResultShape {
	error?: string;
	chars?: number;
	truncated?: boolean;
	digest?: string;
	workflowLaneFailureClass?: string;
}

interface SettledRecordShape {
	status?: string;
	result?: TerminalResultShape;
	terminalResult?: { status?: string; result?: TerminalResultShape };
}

function sha256Hex(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

function sessionOps(): SessionOps {
	return {
		create: mock(async () => ({ data: { id: 'child-1' } })),
		prompt: mock(async () => ({})),
		promptAsync: mock(async () => ({})),
		delete: mock(async () => ({})),
		abort: mock(async () => ({})),
	};
}

const lane: DispatchLaneSpec = {
	id: 'base-correctness',
	agent: 'explorer',
	prompt: 'Review the correctness dimension and submit one structured result.',
	workflow_lane: 'base:correctness',
};

async function seedPendingRecord(directory: string, sessionId: string) {
	const pending = await recordPendingDelegation(directory, {
		correlationId: sessionId,
		jobId: null,
		subagentSessionId: sessionId,
		parentSessionId: 'parent-dispatch-redact-3710',
		callID: 'call-dispatch-redact-3710',
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		laneId: lane.id,
		mode: 'swarm-pr-review:base',
	});
	expect(pending, 'pending delegation record failed to seed').not.toBeNull();
}

/** Drive the async-launch error path; returns the settled terminal record. */
async function driveLaunchErrorAndReadBack(
	directory: string,
	sessionId: string,
	rawMessage: string,
): Promise<SettledRecordShape> {
	await seedPendingRecord(directory, sessionId);
	await _test_exports.startAsyncLanePrompt({
		session: sessionOps(),
		directory,
		sessionId,
		lane,
		timeoutMs: 5_000,
		mode: 'swarm-pr-review:base',
		structuredAdapter: {
			promptJsonSchema: async () => {
				throw new Error(rawMessage);
			},
		},
	});
	const read = findByCorrelationIdDetailed(directory, sessionId);
	expect(read.status, 'coordination store read was uncertain').toBe('ok');
	expect(read.value, 'settled terminal record missing').not.toBeNull();
	return (read.value ?? {}) as SettledRecordShape;
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('dispatch-lanes-redact-3710-');
});

afterEach(() => {
	// Best-effort release of any cached project-DB handle under the tmp root
	// (no-op when none was opened) before the retrying tree removal.
	closeProjectDb(tmpDir);
	removeTreeWithRetry(tmpDir);
});

describe('appendAsyncLaneLaunchError terminal quadruple coherence (#3710 D4)', () => {
	test('token + >600-byte filler: error/chars/truncated/digest all describe one sanitized value', async () => {
		// Token sits early so the placeholder lands inside the 200-char slice.
		const filler = Array.from(
			{ length: 40 },
			(_, i) => `filler segment ${i + 1} of the launch diagnostics batch;`,
		).join(' ');
		const rawMessage = `Provider authentication rejected: invalid API key ${SYNTH_TOKEN}. ${filler}`;
		expect(rawMessage.length).toBeGreaterThan(600);

		const record = await driveLaunchErrorAndReadBack(
			tmpDir,
			'lane-token-redact-3710',
			rawMessage,
		);

		expect(record.status).toBe('error');
		const sanitized = sanitizeFailureEvidenceDisplay(rawMessage);
		const result = record.result ?? {};
		// Coherence: every field derives from the SAME sanitized message.
		expect(result.error).toBe(sanitized.slice(0, MAX_ERROR_CHARS));
		expect(result.chars).toBe(sanitized.length);
		expect(result.truncated).toBe(sanitized.length > MAX_ERROR_CHARS);
		expect(result.digest).toBe(sha256Hex(sanitized));
		expect(result.workflowLaneFailureClass).toBe('resource');
		// Redaction: the persisted slice carries the placeholder, not cleartext.
		expect(result.error).toContain(SYNTH_OPENAI_PLACEHOLDER);
		expect(result.error?.includes(SYNTH_TOKEN)).toBe(false);
		// The typed terminal event carries the same terminal quadruple.
		expect(record.terminalResult?.status).toBe('error');
		expect(record.terminalResult?.result?.error).toBe(
			sanitized.slice(0, MAX_ERROR_CHARS),
		);
		expect(record.terminalResult?.result?.digest).toBe(sha256Hex(sanitized));
	}, 60_000);
});

describe('appendAsyncLaneLaunchError long-error bounding (#3710 D4)', () => {
	test('>600-byte raw message: truncated is TRUE and chars/digest describe the sanitized value', async () => {
		const filler = Array.from(
			{ length: 60 },
			(_, i) => `payload overflow detail ${i + 1} beyond the display budget;`,
		).join(' ');
		const rawMessage = `session.promptAsync launch failed: ${filler}`;
		expect(rawMessage.length).toBeGreaterThan(600);

		const record = await driveLaunchErrorAndReadBack(
			tmpDir,
			'lane-long-error-3710',
			rawMessage,
		);

		expect(record.status).toBe('error');
		const sanitized = sanitizeFailureEvidenceDisplay(rawMessage);
		const result = record.result ?? {};
		expect(sanitized.length).toBeGreaterThan(MAX_ERROR_CHARS);
		expect(result.truncated).toBe(true);
		expect(result.chars).toBe(sanitized.length);
		expect(result.digest).toBe(sha256Hex(sanitized));
		expect(result.error).toBe(sanitized.slice(0, MAX_ERROR_CHARS));
	}, 60_000);
});
