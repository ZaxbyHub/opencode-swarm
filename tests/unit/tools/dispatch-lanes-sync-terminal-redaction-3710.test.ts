/**
 * #3710 regression — the blocking (sync) dispatch-lanes path's terminal
 * `failureReason` sanitization must redact provider error text BEFORE it is
 * settled onto the durable delegation terminal.
 *
 * Sink (src/tools/dispatch-lanes.ts, runLane's outer catch on the
 * executeDispatchLanes blocking path): when a lane dispatch throws (here:
 * `session.prompt` REJECTS with a token-bearing Error — a transport-style
 * failure, so no `syncClassifiedReason` exists and the raw
 * `formatError(error)` message is the reason), the catch builds
 *   failureReason = sanitizeFailureEvidenceDisplay(formatError(error))
 * and settles it via `settleDelegationTerminal` with the #2045/#2349
 * triple semantics: error = failureReason.slice(0, MAX_ERROR_CHARS),
 * chars = failureReason.length, truncated = length > MAX_ERROR_CHARS,
 * digest = digestText(failureReason) — persisted on the record's
 * terminalResult and in `.swarm/background-delegations.jsonl`.
 *
 * The thrown-Error arm matters for mutation coverage: `formatError` returns
 * an Error's message UNBOUNDED and UNREDACTED, so the sink's sanitize call
 * is the ONLY redaction between the raw provider text and the durable
 * terminal. (The in-memory failedLane return deliberately keeps the raw
 * text per #2349 AC3 — only the persisted terminal is asserted here.)
 *
 * This drives the real exported `executeDispatchLanes` (the model-fallback
 * suite's stub pattern: `_internals.getSessionOps` returns a SessionOps
 * stub; the dispatcher, delegation store, and terminal claim all run REAL),
 * then reads the settled record back through the production
 * `findByCorrelationIdDetailed` read path.
 *
 * Mutation contract: removing the `sanitizeFailureEvidenceDisplay(...)` call
 * from the failureReason construction makes this suite RED (cleartext token
 * in the persisted terminal error and the delegations ledger). All tokens
 * are synthetic.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findByCorrelationIdDetailed } from '../../../src/background/pending-delegations';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import {
	_internals,
	executeDispatchLanes,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const SYNTH_TOKEN = 'sk-SynthAbCdEf12345678901234567890';
const SYNTH_OPENAI_PLACEHOLDER = '[REDACTED:openai]';
/** dispatch-lanes.ts MAX_ERROR_CHARS — the #2045/#2349 terminal slice bound. */
const MAX_ERROR_CHARS = 200;

/** The proven synthetic provider auth-failure wording (no transient/quota vocabulary). */
const SHORT_MESSAGE = `Invalid API key provided: ${SYNTH_TOKEN}. You can find your API key at https://platform.openai.example/account/api-keys.`;

/** >600-byte leg: same wording plus letter-only filler (no classifier vocabulary). */
const LONG_MESSAGE = `provider transport rejected the request after auth handshake failed: ${SYNTH_TOKEN} was declined by the remote gateway; ${'z'.repeat(700)}`;

interface TerminalResultShape {
	status?: string;
	error?: string;
	chars?: number;
	truncated?: boolean;
	digest?: string;
}

interface DelegationRecordShape {
	status?: string;
	terminalResult?: { status?: string; result?: TerminalResultShape };
}

function sha256Hex(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

function stubSessionOps(sessionId: string, rejectsWith: Error): SessionOps {
	return {
		create: mock(async () => ({
			data: { id: sessionId },
			error: undefined,
		})),
		prompt: mock(() => Promise.reject(rejectsWith)),
		delete: mock(async () => undefined),
	} as unknown as SessionOps;
}

/** Drive the blocking path with a rejecting prompt and read the settled terminal back. */
async function dispatchAndReadTerminal(
	directory: string,
	rejectsWith: Error,
): Promise<{ laneStatus: string; record: DelegationRecordShape }> {
	const sessionId = 'sess-sync-terminal-3710';
	const savedGetSessionOps = _internals.getSessionOps;
	const savedGetGeneratedAgentNames = _internals.getGeneratedAgentNames;
	_internals.getSessionOps = () => stubSessionOps(sessionId, rejectsWith);
	// Empty registry: 'reviewer' resolves as a bare canonical read-only role
	// and the host-registration check is skipped deterministically.
	_internals.getGeneratedAgentNames = () => [];
	try {
		const result = await executeDispatchLanes(
			{
				timeout_ms: 10_000,
				lanes: [{ id: 'r1', agent: 'reviewer', prompt: 'inspect this change' }],
			},
			directory,
		);
		const lane = result.lane_results[0];
		if (!lane) throw new Error('dispatch returned no lane result');

		const lookup = findByCorrelationIdDetailed(directory, sessionId);
		if (lookup.status !== 'ok' || !lookup.value) {
			throw new Error(
				`no durable delegation record for correlation ${sessionId} (status ${lookup.status})`,
			);
		}
		return {
			laneStatus: lane.status,
			record: lookup.value as DelegationRecordShape,
		};
	} finally {
		_internals.getSessionOps = savedGetSessionOps;
		_internals.getGeneratedAgentNames = savedGetGeneratedAgentNames;
	}
}

let tmpDir: string;
const savedGetSessionOps = _internals.getSessionOps;
const savedGetGeneratedAgentNames = _internals.getGeneratedAgentNames;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('sync-terminal-redact-3710-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	_internals.getSessionOps = savedGetSessionOps;
	_internals.getGeneratedAgentNames = savedGetGeneratedAgentNames;
	removeTreeWithRetry(tmpDir);
	mock.restore();
});

describe('blocking dispatch-lanes terminal failureReason redaction (#3710)', () => {
	test('settled error terminal carries the redacted reason with the #2045/#2349 triple semantics', async () => {
		const { laneStatus, record } = await dispatchAndReadTerminal(
			tmpDir,
			new Error(SHORT_MESSAGE),
		);

		// Posture unchanged: a throwing prompt fails the lane and settles an
		// error terminal on the durable record.
		expect(laneStatus).toBe('failed');
		expect(record.status).toBe('error');

		const terminal = record.terminalResult?.result;
		expect(terminal).toBeDefined();

		// The exact sanitized reason this seam must have produced.
		const expected = sanitizeFailureEvidenceDisplay(SHORT_MESSAGE);

		expect(terminal?.error).toContain(SYNTH_OPENAI_PLACEHOLDER);
		expect(
			terminal?.error?.includes(SYNTH_TOKEN),
			`settled terminal error carries token cleartext: ${terminal?.error}`,
		).toBe(false);
		// Triple semantics: error = slice(0, MAX_ERROR_CHARS) of the
		// sanitized reason; chars = sanitized length; truncated flag;
		// digest = digestText(sanitized).
		expect(terminal?.error).toBe(expected.slice(0, MAX_ERROR_CHARS));
		expect(terminal?.chars).toBe(expected.length);
		expect(terminal?.truncated).toBe(false);
		expect(terminal?.digest).toBe(sha256Hex(expected));

		// The durable ledger itself carries no cleartext.
		const ledgerPath = path.join(
			tmpDir,
			'.swarm',
			'background-delegations.jsonl',
		);
		expect(fs.existsSync(ledgerPath)).toBe(true);
		const ledger = fs.readFileSync(ledgerPath, 'utf-8');
		expect(
			ledger.includes(SYNTH_TOKEN),
			'background-delegations.jsonl carries token cleartext',
		).toBe(false);
	}, 60_000);

	test('>600-byte provider error settles truncated with the full sanitized length and digest', async () => {
		const rawMessage = new Error(LONG_MESSAGE);
		expect(Buffer.byteLength(LONG_MESSAGE, 'utf-8')).toBeGreaterThan(600);

		const { record } = await dispatchAndReadTerminal(tmpDir, rawMessage);
		expect(record.status).toBe('error');

		const terminal = record.terminalResult?.result;
		const expected = sanitizeFailureEvidenceDisplay(LONG_MESSAGE);
		// The sanitizer's own 512-byte display bound keeps the sanitized
		// reason well over MAX_ERROR_CHARS but bounded.
		expect(expected.length).toBeGreaterThan(MAX_ERROR_CHARS);

		// Long-error leg: the slice truncates, the flag is set, and the
		// chars/digest still describe the FULL sanitized reason.
		expect(terminal?.truncated).toBe(true);
		expect(terminal?.error?.length).toBe(MAX_ERROR_CHARS);
		expect(terminal?.error).toBe(expected.slice(0, MAX_ERROR_CHARS));
		expect(terminal?.chars).toBe(expected.length);
		expect(terminal?.digest).toBe(sha256Hex(expected));
		expect(
			terminal?.error?.includes(SYNTH_TOKEN),
			`settled terminal error carries token cleartext: ${terminal?.error}`,
		).toBe(false);
		expect(terminal?.error).toContain(SYNTH_OPENAI_PLACEHOLDER);
	}, 60_000);
});
