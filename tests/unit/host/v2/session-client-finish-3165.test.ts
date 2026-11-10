/**
 * #3165 G.8 — the v2 session-client shim carries the OpenCode 2 assistant
 * entry's `finish` onto the translated v1 `info`, so the shared provider-error
 * reader (`readProviderMessageError`) fails a reply the host ended early
 * (`length`, `content-filter`) closed on v2 exactly as it does on v1.
 *
 * Entry shape: `SessionMessageAssistant` from `@opencode/client` 2.0.26 and
 * 2.2.7 (`finish?: "stop" | "length" | "tool-calls" | "content-filter" |
 * "error" | "unknown"`). Fakes only; no mock.module, no clock reads.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	clearV2SessionClientState,
	createV2SessionClient,
	recordV2SessionErrorFromEnvelope,
} from '../../../../src/host/v2/session-client';
import type { V2PluginContext } from '../../../../src/host/v2/types';
import { createReviewModelDispatcher } from '../../../../src/review/contracts';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

function makeFakeDomain(
	directory: string,
	contextEntries: unknown[],
	onWait?: () => void,
): unknown {
	let nextId = 0;
	return {
		async hook() {
			return { dispose: async () => {} };
		},
		async create(input: { location?: { directory: string } }) {
			nextId += 1;
			return {
				id: `ses_real_${nextId}`,
				location: input.location ?? { directory },
			};
		},
		async get({ sessionID }: { sessionID: string }) {
			return { id: sessionID, location: { directory } };
		},
		async remove() {},
		async prompt() {
			return {};
		},
		async wait() {
			// The real event pump records a failure envelope while the wait is in
			// flight; mirror that ordering (see session-client-errors-lifecycle).
			onWait?.();
		},
		async context() {
			return contextEntries;
		},
		async interrupt() {},
		async switchAgent() {},
	};
}

function makeFakeCtx(directory: string, domain: unknown): V2PluginContext {
	return {
		app: { name: 'opencode', version: 'test', channel: 'test' },
		location: { directory, workspaceID: 'w' },
		options: {},
		tool: {},
		agent: {},
		command: {},
		session: domain,
		event: {},
	} as never;
}

const MODEL = { id: 'm', providerID: 'p' };

function assistant(text: string, finish?: string) {
	return {
		type: 'assistant',
		model: MODEL,
		content: [{ type: 'text', text }],
		...(finish === undefined ? {} : { finish }),
	};
}

async function dispatchWith(entries: unknown[], onWait?: () => void) {
	const directory = canonicalMkdtemp('swarm-v2-finish-');
	try {
		const client = createV2SessionClient(
			makeFakeCtx(directory, makeFakeDomain(directory, entries, onWait)),
		)!;
		return await createReviewModelDispatcher(client as never).dispatch({
			directory,
			agentName: 'mega_reviewer',
			system: 's',
			prompt: 'p',
			timeoutMs: 5_000,
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

// Entry shapes follow the published `SessionMessageUser` /
// `SessionMessageAssistant` (`type` discriminator only, no `role`).
const USER = { type: 'user', text: 'p' };
const IDLE_OK = { type: 'idle', outcome: 'succeeded' };

afterEach(() => {
	resetSwarmState();
	clearV2SessionClientState();
});

describe('v2 session-client — regression: assistant finish was dropped on v2 (#3165 G.8)', () => {
	test('a reply truncated after VERDICT: APPROVED fails closed as MessageOutputLengthError', async () => {
		// Previous code built the translated info from the model ids only, so a
		// `finish: "length"` reply reached the reader as a clean success and a
		// truncated `VERDICT: APPROVED` could pass every consumer on OpenCode 2.
		const result = await dispatchWith([
			USER,
			assistant('VERDICT: APPROVED\nThe change looks', 'length'),
			IDLE_OK,
		]);
		expect(result.status).toBe('error');
		expect(result.providerError?.name).toBe('MessageOutputLengthError');
		expect(result.providerError?.category).toBe('provider.output_length');
	});

	test('a content-filtered reply fails closed as MessageContentFilterError', async () => {
		const result = await dispatchWith([
			USER,
			assistant('VERDICT: APPROVED', 'content-filter'),
			IDLE_OK,
		]);
		expect(result.status).toBe('error');
		expect(result.providerError?.name).toBe('MessageContentFilterError');
		expect(result.providerError?.category).toBe('provider.content_filter');
	});

	test('a TEXTLESS length reply under a succeeded idle fails closed, not as the empty-refusal signal', async () => {
		// The shape behind the Epic phase-review claim: an empty reply cut off by
		// the output limit is a failed dispatch (status error), so it never reads
		// as the completed-empty provider-refusal signal the bash retry keys on.
		const result = await dispatchWith([
			USER,
			{ type: 'assistant', model: MODEL, content: [], finish: 'length' },
			IDLE_OK,
		]);
		expect(result.status).toBe('error');
		expect(result.providerError?.name).toBe('MessageOutputLengthError');
		expect(result.providerError?.category).toBe('provider.output_length');
	});
});

describe('v2 session-client finish passthrough — negative controls (#3165 G.8)', () => {
	test('finish "stop" stays a completed reply with its text', async () => {
		const result = await dispatchWith([
			USER,
			assistant('VERDICT: APPROVED', 'stop'),
			IDLE_OK,
		]);
		expect(result.status).toBe('completed');
		expect(result.text).toBe('VERDICT: APPROVED');
		expect(result.providerError).toBeUndefined();
	});

	test('only the LAST final-turn assistant entry decides: an earlier length step then stop completes', async () => {
		// The finish rule follows v1, where the reply's info.finish is the last
		// step's finish; an implementation that scanned every final-turn entry
		// would fail here. The joined text is NOT a v1 parity claim: it is the
		// shim's existing join over all final-turn entries, pinned as-is.
		const result = await dispatchWith([
			USER,
			assistant('checking', 'length'),
			assistant('done', 'stop'),
			IDLE_OK,
		]);
		expect(result.status).toBe('completed');
		expect(result.text).toBe('checking\ndone');
		expect(result.providerError).toBeUndefined();
	});

	test("a final turn with NO assistant entry ignores an earlier turn's length finish", async () => {
		// Pins the final-turn slice for finish: reading the last assistant entry
		// of the WHOLE list would pick the earlier turn's `length` entry and fail
		// this empty-but-succeeded turn as MessageOutputLengthError.
		const result = await dispatchWith([
			USER,
			assistant('old partial', 'length'),
			IDLE_OK,
			USER,
			IDLE_OK,
		]);
		expect(result.status).toBe('completed');
		expect(result.text).toBe('');
		expect(result.providerError).toBeUndefined();
	});

	test('a truncated reply in an EARLIER turn does not fail the final turn', async () => {
		const result = await dispatchWith([
			USER,
			assistant('old partial', 'length'),
			IDLE_OK,
			USER,
			assistant('new answer', 'stop'),
			IDLE_OK,
		]);
		expect(result.status).toBe('completed');
		expect(result.text).toBe('new answer');
	});

	test('finish "tool-calls", "error" or "unknown" with empty text keeps the completed-empty bash-retry signal', async () => {
		// The Epic phase-review bash retry (src/epic/phase-readiness.ts) treats a
		// completed reply with no text as a provider refusal; the reader ignores
		// these finish values, so this passthrough must carry them unchanged
		// (e.g. never map `tool-calls` onto `length`).
		// Pre-existing gap, not endorsed here: an errored entry under a succeeded
		// idle with no recorded error still reads as completed (v1 would carry
		// info.error); this test only pins that the passthrough adds no change.
		for (const finish of ['tool-calls', 'error', 'unknown']) {
			const result = await dispatchWith([
				USER,
				{
					type: 'assistant',
					model: MODEL,
					content: [],
					finish,
				},
				IDLE_OK,
			]);
			expect(result.status).toBe('completed');
			expect(result.text).toBe('');
			expect(result.providerError).toBeUndefined();
		}
	});

	test.each([
		['length', 'failed'],
		['content-filter', 'failed'],
		['length', 'succeeded'],
		['content-filter', 'succeeded'],
	])('a recorded provider error still wins over finish "%s" under a %s idle (error branch unchanged)', async (finish, outcome) => {
		// The succeeded rows reach the error branch only through the recorded
		// error (a failed idle takes it whatever the finish is).
		const result = await dispatchWith(
			[USER, assistant('partial', finish), { type: 'idle', outcome }],
			() =>
				recordV2SessionErrorFromEnvelope({
					type: 'session.execution.failed',
					data: {
						sessionID: 'ses_real_1',
						error: {
							name: 'APIError',
							data: { message: 'Forbidden', statusCode: 403 },
						},
					},
				}),
		);
		expect(result.status).toBe('error');
		expect(result.providerError?.name).toBe('APIError');
		expect(result.providerError?.statusCode).toBe(403);
	});

	test('a failed idle with text and a length finish but no recorded error fails closed generically, finish dropped', async () => {
		// Documented limit: a failed idle always takes the error branch, so the
		// reply fails closed as the generic ProviderError, not under the
		// finish-derived name the Lean runner's exemption keys on.
		const result = await dispatchWith([
			USER,
			assistant('partial', 'length'),
			{ type: 'idle', outcome: 'failed' },
		]);
		expect(result.status).toBe('error');
		expect(result.providerError?.name).toBe('ProviderError');
		expect(result.providerError?.message).toContain(
			'v2 session failed without recorded error detail',
		);
	});

	test('an assistant entry with no finish field is unchanged (pre-passthrough shape)', async () => {
		const result = await dispatchWith([USER, assistant('reply'), IDLE_OK]);
		expect(result.status).toBe('completed');
		expect(result.text).toBe('reply');
	});
});
