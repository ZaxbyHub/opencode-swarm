/**
 * `dispatchEphemeralAgent` surfaces a provider error recorded on the
 * assistant message (`info.error`).
 *
 * OpenCode returns HTTP 200 from `session.prompt` even when the provider
 * refused the request: the refusal is recorded on the assistant message as
 * `info.error` and the message has no text parts. Live run (OpenCode Zen free
 * tier): every `bash:false` review dispatch came back as
 * `info.error = { name: 'APIError', data: { statusCode: 403, ... } }`, and
 * the dispatcher reported it as a `completed` dispatch with empty text, so
 * callers saw "the reviewer said nothing" instead of the provider's refusal.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	DEFAULT_READ_ONLY_TOOLS,
	dispatchEphemeralAgent,
} from '../../../src/evaluation/ephemeral-agent-dispatcher.js';

const originalLog = _internals.log;
afterEach(() => {
	_internals.log = originalLog;
});

function clientReturning(info: Record<string, unknown>, parts: unknown[]) {
	return {
		session: {
			create: async () => ({ data: { id: 'ephemeral-1' } }),
			prompt: async () => ({
				data: {
					info: {
						id: 'msg-1',
						sessionID: 'ephemeral-1',
						role: 'assistant',
						time: { created: 1 },
						providerID: 'opencode',
						modelID: 'free-model',
						mode: 'reviewer',
						...info,
					},
					parts,
				},
			}),
			abort: async () => ({ data: true }),
			delete: async () => ({}),
		},
	} as never;
}

function dispatch(client: never) {
	return dispatchEphemeralAgent({
		client,
		directory: '/repo',
		agentName: 'reviewer',
		prompt: 'review this',
		readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
		timeoutMs: 5_000,
	});
}

describe('dispatchEphemeralAgent — provider error on the assistant message', () => {
	test('a provider refusal (APIError 403) is an error, not an empty completion', async () => {
		_internals.log = mock(() => {});
		const result = await dispatch(
			clientReturning(
				{
					error: {
						name: 'APIError',
						data: {
							message: 'Forbidden: tool configuration not allowed',
							statusCode: 403,
							isRetryable: false,
						},
					},
				},
				[],
			),
		);
		expect(result.status).toBe('error');
		expect(result.text).toBe('');
		expect(result.error).toContain('APIError');
		expect(result.error).toContain('403');
		expect(result.error).toContain('Forbidden: tool configuration not allowed');
		expect(result.providerError).toEqual({
			name: 'APIError',
			statusCode: 403,
			message: 'Forbidden: tool configuration not allowed',
		});
	});

	test('non-API provider errors are surfaced the same way', async () => {
		_internals.log = mock(() => {});
		const result = await dispatch(
			clientReturning(
				{
					error: {
						name: 'ProviderAuthError',
						data: { providerID: 'opencode', message: 'invalid api key' },
					},
				},
				[{ type: 'text', text: '' }],
			),
		);
		expect(result.status).toBe('error');
		expect(result.error).toContain('ProviderAuthError');
		expect(result.error).toContain('invalid api key');
		expect(result.providerError).toEqual({
			name: 'ProviderAuthError',
			message: 'invalid api key',
		});
	});

	test('a message without info.error is unchanged', async () => {
		_internals.log = mock(() => {});
		const result = await dispatch(
			clientReturning({ time: { created: 1, completed: 2 } }, [
				{ type: 'text', text: 'VERDICT: APPROVED' },
			]),
		);
		expect(result.status).toBe('completed');
		expect(result.text).toBe('VERDICT: APPROVED');
		expect(result.providerError).toBeUndefined();
	});
});
