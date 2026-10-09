/**
 * A critic reply cut off by the output limit (`MessageOutputLengthError`) must
 * never be read as a real verdict. OpenCode answers HTTP 200 with the failure on
 * `info.error` and whatever text was produced so far; if the shared reader
 * ignored this error, a truncated `VERDICT: APPROVED` would pass the oversight
 * gate. Pinned against the shared reader and the oversight consumer.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	readProviderMessageError,
	throwIfProviderMessageError,
} from '../../../src/failures/provider-message-error';
import {
	dispatchFullAutoOversight,
	parseFullAutoCriticResponse,
} from '../../../src/full-auto/oversight';
import { startFullAutoRun } from '../../../src/full-auto/state';
import { _internals as stateInternals } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const APPROVED =
	'VERDICT: APPROVED\nREASONING: looks fine\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO';
const TRUNCATED = { error: { name: 'MessageOutputLengthError', data: {} } };
// The host also records an early end as `finish` alone, with no `info.error`.
const SHAPES: Array<[string, Record<string, unknown>]> = [
	['info.error', TRUNCATED],
	['finish length', { finish: 'length' }],
	['finish content-filter', { finish: 'content-filter' }],
];

let tmpDir: string;
let originalClient: unknown;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('oversight-output-length-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	originalClient = stateInternals.swarmState.opencodeClient;
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient =
		originalClient as typeof stateInternals.swarmState.opencodeClient;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('MessageOutputLengthError stays a provider error in the shared reader', () => {
	test('readProviderMessageError reports it and throwIfProviderMessageError throws', () => {
		const read = readProviderMessageError(TRUNCATED);
		expect(read).not.toBeNull();
		expect(read?.name).toBe('MessageOutputLengthError');
		expect(() => throwIfProviderMessageError('p', TRUNCATED)).toThrow(
			'MessageOutputLengthError',
		);
	});

	test('the verdict parser alone WOULD approve the same truncated text', () => {
		// This is why the reader must keep reporting the error: the parser has no
		// way to tell the reply was cut off.
		expect(parseFullAutoCriticResponse(APPROVED).verdict).toBe('APPROVED');
	});
});

describe('oversight does not approve a truncated critic reply', () => {
	for (const [label, info] of SHAPES) {
		test(`a truncated VERDICT: APPROVED is not approval (${label})`, async () => {
			startFullAutoRun(tmpDir, 'sess-output-length', { enabled: true });
			stateInternals.swarmState.opencodeClient = {
				session: {
					create: mock(async () => ({ data: { id: 'critic-1' }, error: null })),
					prompt: mock(async () => ({
						data: { info, parts: [{ type: 'text', text: APPROVED }] },
					})),
					delete: mock(async () => ({})),
				},
			} as unknown as typeof stateInternals.swarmState.opencodeClient;

			const result = await dispatchFullAutoOversight({
				directory: tmpDir,
				sessionID: 'sess-output-length',
				trigger: 'test',
				triggerSource: 'tool_action',
				criticModel: 'test-model',
				oversightAgentName: 'critic_oversight',
				fullAutoConfig: {
					max_dispatch_retries: 2,
					max_consecutive_dispatch_failures: 3,
				},
			} as unknown as Parameters<typeof dispatchFullAutoOversight>[0]);

			expect(result.verdict).not.toBe('APPROVED');
			expect(result.decision).not.toBe('allow');
		});
	}
});
