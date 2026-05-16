import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	getActiveWindow,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

const TEST_DIR = os.tmpdir();

const defaultConfig: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 200,
	max_duration_minutes: 30,
	max_repetitions: 10,
	max_consecutive_errors: 5,
	max_transient_retries: 5,
	warning_threshold: 0.75,
	idle_timeout_minutes: 60,
	qa_gates: {
		required_tools: [
			'diff',
			'syntax_check',
			'placeholder_scan',
			'lint',
			'pre_check_batch',
		],
		require_reviewer_test_engineer: true,
	},
};

function makeTaskArgs(subagentType: string, prompt = 'Fix the bug') {
	return { subagent_type: subagentType, prompt };
}

/**
 * Sets up a subagent session with a window by calling toolBefore first.
 * Architect sessions never create windows (see state.ts getOrCreateWindow).
 */
async function setupSubagentSessionWithWindow(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	sessionId: string,
	agentName = 'coder',
) {
	ensureAgentSession(sessionId, agentName);
	swarmState.activeAgent.set(sessionId, agentName);

	// Call toolBefore to create the window (getOrCreateWindow is called in toolBefore)
	const input = { tool: 'Task', sessionID: sessionId, callID: 'call-init' };
	const output = { args: makeTaskArgs(agentName, 'Initial setup') };
	await hooks.toolBefore(input as any, output as any);

	return swarmState.agentSessions.get(sessionId)!;
}

describe('guardrails transient error classification (toolAfter)', () => {
	let hooks: ReturnType<typeof createGuardrailsHooks>;

	beforeEach(() => {
		resetSwarmState();
		hooks = createGuardrailsHooks(TEST_DIR, defaultConfig);
	});

	afterEach(() => {
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// HTTP Status Code Classification Tests
	// Status codes are checked FIRST before keyword matching
	// -------------------------------------------------------------------------

	describe('HTTP status codes classified as transient', () => {
		test('HTTP 500 "Internal Server Error" → transient (does NOT increment consecutiveErrors)', async () => {
			const sessionId = 'session-500';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'Error 500: Internal Server Error',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});

		test('HTTP 502 "Bad Gateway" → transient', async () => {
			const sessionId = 'session-502';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'HTTP 502 Bad Gateway',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});

		test('HTTP 504 "Gateway Timeout" → transient', async () => {
			const sessionId = 'session-504';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'HTTP 504 Gateway Timeout',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});

		test('HTTP 529 "Service Unavailable" → transient', async () => {
			const sessionId = 'session-529';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'HTTP 529 The service is temporarily unavailable',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});

		test('HTTP 429 "Too Many Requests" → transient', async () => {
			const sessionId = 'session-429';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'Error 429: Too Many Requests',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});

		test('HTTP 408 "Request Timeout" → transient', async () => {
			const sessionId = 'session-408';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'Error 408: Request Timeout',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});

		test('HTTP 503 "Service Unavailable" → transient', async () => {
			const sessionId = 'session-503';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'HTTP 503 Service Unavailable',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// Keyword-based Classification Tests
	// These use TRANSIENT_MODEL_ERROR_PATTERN keyword matching
	// -------------------------------------------------------------------------

	describe('keyword patterns classified as transient', () => {
		test('"connection refused" → transient', async () => {
			const sessionId = 'session-conn-refused';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'Error: connection refused',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});

		test('"connection reset by peer" → transient', async () => {
			const sessionId = 'session-conn-reset';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'Error: connection reset by peer',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});

		test('"connection timeout" → transient', async () => {
			const sessionId = 'session-conn-timeout';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'Error: connection timeout',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});

		test('"bad gateway" → transient', async () => {
			const sessionId = 'session-bad-gateway';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'Error: bad gateway',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});

		test('"gateway timeout" → transient', async () => {
			const sessionId = 'session-gateway-timeout';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'gateway timeout',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});

		test('"internal server error" → transient', async () => {
			const sessionId = 'session-internal-error';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'internal server error',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});

		test('"service unavailable" → transient', async () => {
			const sessionId = 'session-svc-unavail';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'service unavailable',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// Status Code Extraction Tests
	// extractStatusCode uses /\b(408|429|500|502|503|504|529)\b/
	// Should extract known transient codes, NOT arbitrary 3-digit numbers
	// -------------------------------------------------------------------------

	describe('status code extraction from error messages', () => {
		test('"Error 500" → extracts 500', async () => {
			const sessionId = 'session-extract-500';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'Error 500',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			// 500 is a known transient status code
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
		});

		test('"HTTP 503 Service Unavailable" → extracts 503', async () => {
			const sessionId = 'session-extract-503';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'HTTP 503 Service Unavailable',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
		});

		test('"500 Internal Server Error" → extracts 500', async () => {
			const sessionId = 'session-extract-500-internal';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: '500 Internal Server Error',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
		});

		test('"300 seconds timeout" → NOT a transient code (300 is not in the list)', async () => {
			const sessionId = 'session-extract-300';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: '300 seconds timeout',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			// "timeout" keyword IS in the pattern, so this IS transient
			// The task says "300 seconds timeout" → returns null for the code extraction,
			// but "timeout" is a keyword match so it still becomes transient
			// Let's check: 300 is not in TRANSIENT_STATUS_CODES
			// But "timeout" IS in TRANSIENT_MODEL_ERROR_PATTERN
			// So this will be transient via keyword match, not status code match
			expect(window?.transientRetryCount).toBe(1);
			expect(window?.consecutiveErrors).toBe(0);
		});

		test('"200 OK" → NOT a transient code (200 is not in the list)', async () => {
			const sessionId = 'session-extract-200';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'Error 200 OK',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			// 200 is not a transient code, and "200 OK" doesn't contain timeout or other keywords
			// This should be classified as non-transient (permanent error)
			expect(window?.consecutiveErrors).toBe(1);
			expect(window?.transientRetryCount).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// Transient vs Permanent Error Classification
	// -------------------------------------------------------------------------

	describe('transient errors increment transientRetryCount, NOT consecutiveErrors', () => {
		test('multiple transient errors accumulate in transientRetryCount', async () => {
			const sessionId = 'session-multi-transient';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			for (let i = 1; i <= 3; i++) {
				const input = {
					tool: 'bash',
					sessionID: sessionId,
					callID: `call-${i}`,
				};
				const output = {
					title: 'bash',
					output: null,
					error: `Error 500: attempt ${i}`,
					metadata: {},
				};
				await hooks.toolAfter(input as any, output as any);
			}

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(3);
		});

		test('transient error does NOT increment consecutiveErrors', async () => {
			const sessionId = 'session-no-consecutive';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'HTTP 502 Bad Gateway',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
		});

		test('OpenRouter 502 object payload â†’ transient with fallback accounting', async () => {
			const sessionId = 'session-openrouter-object-502';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: {
					code: 502,
					message: 'Network connection lost.',
					metadata: { error_type: 'provider_unavailable' },
				},
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(1);
			expect(session.model_fallback_index).toBe(1);
		});
	});

	describe('permanent errors increment consecutiveErrors', () => {
		test('"unauthorized" → permanent (increments consecutiveErrors)', async () => {
			const sessionId = 'session-unauthorized';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'unauthorized: invalid API key',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(1);
			expect(window?.transientRetryCount).toBe(0);
		});

		test('"invalid key" → permanent (increments consecutiveErrors)', async () => {
			const sessionId = 'session-invalid-key';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'invalid key provided',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(1);
			expect(window?.transientRetryCount).toBe(0);
		});

		test('"TypeError: Cannot read property" → permanent (increments consecutiveErrors)', async () => {
			const sessionId = 'session-typeerror';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: "TypeError: Cannot read property 'foo' of undefined",
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(1);
			expect(window?.transientRetryCount).toBe(0);
		});

		test('"file not found" → permanent (increments consecutiveErrors)', async () => {
			const sessionId = 'session-file-not-found';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'file not found at /path/to/file',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(1);
			expect(window?.transientRetryCount).toBe(0);
		});

		test('non-transient object payload â†’ permanent', async () => {
			const sessionId = 'session-object-auth-error';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: {
					code: 401,
					message: 'unauthorized: invalid API key',
					metadata: { error_type: 'invalid_key' },
				},
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(1);
			expect(window?.transientRetryCount).toBe(0);
		});

		test('structured type server_error with non-transient status remains permanent', async () => {
			const sessionId = 'session-object-auth-server-error-type';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: {
					code: 401,
					type: 'server_error',
					message: 'invalid credentials',
				},
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(1);
			expect(window?.transientRetryCount).toBe(0);
		});

		test('transient-looking unrelated object fields are ignored', async () => {
			const sessionId = 'session-object-unrelated-transient-looking-fields';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: {
					message: 'validation failed',
					phase: 502,
					details: 'retry after timeout',
				},
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(1);
			expect(window?.transientRetryCount).toBe(0);
		});

		test('cyclic object payload does not throw and remains permanent without provider signal', async () => {
			const sessionId = 'session-object-cyclic';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const cyclic: Record<string, unknown> = { message: 'validation failed' };
			cyclic.self = cyclic;

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: cyclic,
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(1);
			expect(window?.transientRetryCount).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// Transient Retry Limit Behavior
	// After max_transient_retries exceeded, transient errors start incrementing
	// consecutiveErrors
	// -------------------------------------------------------------------------

	describe('transient retry limit behavior', () => {
		test('after max_transient_retries exceeded, transient errors increment consecutiveErrors', async () => {
			const sessionId = 'session-exceed-limit';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			// max_transient_retries = 5, so we make 5 transient errors
			// that should all go to transientRetryCount
			for (let i = 1; i <= 5; i++) {
				const input = {
					tool: 'bash',
					sessionID: sessionId,
					callID: `call-${i}`,
				};
				const output = {
					title: 'bash',
					output: null,
					error: 'Error 500: Internal Server Error',
					metadata: {},
				};
				await hooks.toolAfter(input as any, output as any);
			}

			const windowAfter5 = getActiveWindow(sessionId);
			expect(windowAfter5?.transientRetryCount).toBe(5);
			expect(windowAfter5?.consecutiveErrors).toBe(0);

			// The 6th transient error should start incrementing consecutiveErrors
			const input6 = { tool: 'bash', sessionID: sessionId, callID: 'call-6' };
			const output6 = {
				title: 'bash',
				output: null,
				error: 'Error 500: Internal Server Error',
				metadata: {},
			};
			await hooks.toolAfter(input6 as any, output6 as any);

			const windowAfter6 = getActiveWindow(sessionId);
			// After exceeding max_transient_retries, consecutiveErrors starts incrementing
			expect(windowAfter6?.consecutiveErrors).toBe(1);
			expect(windowAfter6?.transientRetryCount).toBe(5); // stays at max
		});

		test('transientRetryCount is capped at max_transient_retries', async () => {
			const sessionId = 'session-cap-test';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			// Make 10 transient errors (more than max_transient_retries=5)
			for (let i = 1; i <= 10; i++) {
				const input = {
					tool: 'bash',
					sessionID: sessionId,
					callID: `call-${i}`,
				};
				const output = {
					title: 'bash',
					output: null,
					error: 'HTTP 503 Service Unavailable',
					metadata: {},
				};
				await hooks.toolAfter(input as any, output as any);
			}

			const window = getActiveWindow(sessionId);
			// transientRetryCount should be capped at max_transient_retries (5)
			expect(window?.transientRetryCount).toBe(5);
			// consecutiveErrors should be 5 (after the first 5 exceeded)
			expect(window?.consecutiveErrors).toBe(5);
		});

		test('success resets both consecutiveErrors and transientRetryCount', async () => {
			const sessionId = 'session-reset';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			// Make some transient errors
			for (let i = 1; i <= 3; i++) {
				const input = {
					tool: 'bash',
					sessionID: sessionId,
					callID: `call-${i}`,
				};
				const output = {
					title: 'bash',
					output: null,
					error: 'Error 500',
					metadata: {},
				};
				await hooks.toolAfter(input as any, output as any);
			}

			// Now a success
			const successInput = {
				tool: 'bash',
				sessionID: sessionId,
				callID: 'call-success',
			};
			const successOutput = {
				title: 'bash',
				output: 'success',
				metadata: {},
			};
			await hooks.toolAfter(successInput as any, successOutput as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// DEGRADED Error Classification Tests
	// Degraded errors (context-length, token-limit, content-filter) bypass both
	// counters and trigger model fallback if available, without incrementing
	// consecutiveErrors or transientRetryCount
	// -------------------------------------------------------------------------

	describe('DEGRADED error classification', () => {
		test('"context length exceeded" → degraded (consecutiveErrors stays 0, transientRetryCount stays 0)', async () => {
			const sessionId = 'session-context-length';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'context length exceeded',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(0);
			// model_fallback_index increments when degraded error detected (fallback available by default)
			expect(session.model_fallback_index).toBe(1);
		});

		test('"token limit exceeded" → degraded', async () => {
			const sessionId = 'session-token-limit';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'token limit exceeded for this model',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(0);
			expect(session.model_fallback_index).toBe(1);
		});

		test('"input too long for this model" → degraded', async () => {
			const sessionId = 'session-input-too-long';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'input too long for this model',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(0);
			expect(session.model_fallback_index).toBe(1);
		});

		test('"prompt too long" → degraded', async () => {
			const sessionId = 'session-prompt-too-long';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'prompt too long for context window',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(0);
			expect(session.model_fallback_index).toBe(1);
		});

		test('"max tokens exceeded" → degraded', async () => {
			const sessionId = 'session-max-tokens';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'max tokens exceeded',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(0);
			expect(session.model_fallback_index).toBe(1);
		});

		test('degraded error does NOT increment consecutiveErrors', async () => {
			const sessionId = 'session-no-consecutive-degraded';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'context length exceeded',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(0);
		});

		test('degraded error does NOT increment transientRetryCount', async () => {
			const sessionId = 'session-no-transient-degraded';
			await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'token limit exceeded',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.transientRetryCount).toBe(0);
			expect(window?.consecutiveErrors).toBe(0);
		});

		test('degraded error with fallback available → model_fallback_index increments', async () => {
			const sessionId = 'session-degraded-fallback';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'context length exceeded',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			// model_fallback_index should increment from 0 to 1
			expect(session.model_fallback_index).toBe(1);
			// Advisory message should be pushed
			expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
			expect(session.pendingAdvisoryMessages?.[0]).toContain('DEGRADED');
		});

		test('degraded error without fallback → advisory message still emitted, no crash', async () => {
			const sessionId = 'session-degraded-no-fallback';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			// Set modelFallbackExhausted to true to simulate no fallback available
			session.modelFallbackExhausted = true;

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'context length exceeded',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			// model_fallback_index should NOT increment when no fallback available
			expect(session.model_fallback_index).toBe(0);
			// Advisory message should still be pushed
			expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
			expect(session.pendingAdvisoryMessages?.[0]).toContain('DEGRADED');
			// Counters should still be 0
			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(0);
		});

		test('error containing both "500" (transient) and "context length" (degraded) → classified as transient (transient wins)', async () => {
			const sessionId = 'session-both-transient-degraded';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: '500 context length exceeded',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			// Should be treated as transient (HTTP 500 is checked first)
			const window = getActiveWindow(sessionId);
			expect(window?.transientRetryCount).toBe(1);
			expect(window?.consecutiveErrors).toBe(0);
			// Model fallback should be triggered via transient path
			expect(session.model_fallback_index).toBe(1);
		});

		test('"content filter triggered" → degraded', async () => {
			const sessionId = 'session-content-filter';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'content filter triggered',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(0);
			expect(session.model_fallback_index).toBe(1);
		});

		test('object-shaped content-filter error is degraded', async () => {
			const sessionId = 'session-object-content-filter';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: {
					message: 'content filter triggered',
					metadata: { error_type: 'policy_violation' },
				},
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(0);
			expect(session.model_fallback_index).toBe(1);
		});

		test('content-filter error advisory mentions policy violation, not input size', async () => {
			const sessionId = 'session-content-filter-advisory';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'content filter triggered',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			// Advisory should mention policy violation
			expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
			const advisory = session.pendingAdvisoryMessages?.[0] ?? '';
			expect(advisory).toContain('policy violation');
			expect(advisory).toContain('content filter');
			// Should NOT mention reducing input size (that advice is for size errors)
			expect(advisory).not.toContain('reducing input size');
		});

		test('context-length error advisory mentions reducing input size', async () => {
			const sessionId = 'session-context-length-advisory';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'context length exceeded',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			// Advisory should mention reducing input size
			expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
			const advisory = session.pendingAdvisoryMessages?.[0] ?? '';
			expect(advisory).toContain('reducing input size');
		});

		test('degraded error sets modelFallbackExhausted when fallback models exhausted', async () => {
			await mock.module('../../../src/agents/index', () => ({
				getSwarmAgents: () => ({ coder: { fallback_models: ['model-a'] } }),
				resolveFallbackModel: () => 'model-a',
			}));

			const sessionId = 'session-degraded-exhausted';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			// Simulate having 1 fallback model already used (index at 1)
			session.model_fallback_index = 1;
			session.modelFallbackExhausted = false;

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'context length exceeded',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			// After increment, index becomes 2 which exceeds length 1
			expect(session.model_fallback_index).toBe(2);
			expect(session.modelFallbackExhausted).toBe(true);

			mock.restore();
		});

		test('degraded error advisory includes fallback index and total count', async () => {
			await mock.module('../../../src/agents/index', () => ({
				getSwarmAgents: () => ({
					coder: { fallback_models: ['model-a', 'model-b'] },
				}),
				resolveFallbackModel: () => 'model-a',
			}));

			const sessionId = 'session-degraded-index-count';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			// Pre-set fallback index to 0, so after increment it becomes 1
			session.model_fallback_index = 0;

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'context length exceeded',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			// After increment, index becomes 1
			expect(session.model_fallback_index).toBe(1);
			expect(session.modelFallbackExhausted).toBe(false);

			// Advisory should contain "1/2" format (current index / total fallbacks)
			expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
			const advisory = session.pendingAdvisoryMessages?.[0] ?? '';
			expect(advisory).toContain('1/2');
			expect(advisory).toContain('considered');

			mock.restore();
		});

		// -------------------------------------------------------------------------
		// F-001 adversarial tests: degraded fallback gap fixes
		// -------------------------------------------------------------------------

		test('F-001: no fallback_models configured → modelFallbackExhausted=true on first degraded error', async () => {
			// When fallback_models is undefined, exhaustion is set immediately
			// on the first degraded error (no models were ever available to try)
			await mock.module('../../../src/agents/index', () => ({
				getSwarmAgents: () => ({ coder: {} }), // no fallback_models key at all
				resolveFallbackModel: () => null,
			}));

			const sessionId = 'session-no-fallback-models';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);

			// Ensure state is clean before the error
			expect(session.modelFallbackExhausted).toBe(false);
			expect(session.model_fallback_index).toBe(0);

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'context length exceeded',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			// Exhaustion flag must be set immediately because no fallback models exist
			expect(session.modelFallbackExhausted).toBe(true);
			// model_fallback_index increments to 1 first, then exhaustion is computed.
			expect(session.model_fallback_index).toBe(1);
			// The advisory is "Fallback model 1/0 considered" on the first call (exhaustion is
			// detected after the index increment, so the "N/0" advisory is still pushed).
			// Subsequent calls will show "No fallback models available" via the exhausted branch.
			expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
			const advisory = session.pendingAdvisoryMessages?.[0] ?? '';
			expect(advisory).toContain('Fallback model');
			expect(advisory).toContain('considered');

			mock.restore();
		});

		test('F-001: consecutive degraded errors increment index and exhaust fallback models', async () => {
			// With 2 fallback models, 3 consecutive degraded errors should:
			//   1st: index=1, exhausted=false, "1/2" pushed
			//   2nd: index=2, exhausted=false, "2/2" pushed
			//   3rd: index=3, exhausted=true (3 > 2), "3/2" still pushed on this call
			//        (exhaustion is detected after increment, so the advisory still fires)
			//   4th: exhausted=true, "No fallback models available" via exhausted branch
			await mock.module('../../../src/agents/index', () => ({
				getSwarmAgents: () => ({
					coder: { fallback_models: ['model-a', 'model-b'] },
				}),
				resolveFallbackModel: () => 'model-a',
			}));

			const sessionId = 'session-consecutive-degraded';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);
			session.model_fallback_index = 0;
			session.modelFallbackExhausted = false;

			const errorOutput = {
				title: 'bash',
				output: null,
				error: 'context length exceeded',
				metadata: {},
			};

			// First degraded error
			await hooks.toolAfter(
				{ tool: 'bash', sessionID: sessionId, callID: 'call-1' } as any,
				errorOutput as any,
			);
			expect(session.model_fallback_index).toBe(1);
			expect(session.modelFallbackExhausted).toBe(false);
			expect(session.pendingAdvisoryMessages?.[0]).toContain('1/2');

			// Second degraded error
			await hooks.toolAfter(
				{ tool: 'bash', sessionID: sessionId, callID: 'call-2' } as any,
				errorOutput as any,
			);
			expect(session.model_fallback_index).toBe(2);
			expect(session.modelFallbackExhausted).toBe(false);
			expect(session.pendingAdvisoryMessages?.[1]).toContain('2/2');

			// Third degraded error — exhaustion detected (index > length)
			await hooks.toolAfter(
				{ tool: 'bash', sessionID: sessionId, callID: 'call-3' } as any,
				errorOutput as any,
			);
			expect(session.model_fallback_index).toBe(3);
			expect(session.modelFallbackExhausted).toBe(true);
			// The "3/2" advisory is still pushed because exhaustion is detected after increment
			expect(session.pendingAdvisoryMessages?.length).toBe(3);
			expect(session.pendingAdvisoryMessages?.[2]).toContain('3/2');

			// Fourth call — exhausted branch triggers
			await hooks.toolAfter(
				{ tool: 'bash', sessionID: sessionId, callID: 'call-4' } as any,
				errorOutput as any,
			);
			expect(session.pendingAdvisoryMessages?.length).toBe(4);
			expect(session.pendingAdvisoryMessages?.[3]).toContain(
				'No fallback models available',
			);

			mock.restore();
		});

		test('F-001: degraded error advisory uses "Fallback model N/M considered", NOT "Attempting fallback"', async () => {
			// The old misleading text was "Attempting fallback model" — verify it is gone
			await mock.module('../../../src/agents/index', () => ({
				getSwarmAgents: () => ({
					coder: { fallback_models: ['model-a'] },
				}),
				resolveFallbackModel: () => 'model-a',
			}));

			const sessionId = 'session-no-attempting-fallback';
			const session = await setupSubagentSessionWithWindow(hooks, sessionId);
			session.model_fallback_index = 0;

			const input = { tool: 'bash', sessionID: sessionId, callID: 'call-1' };
			const output = {
				title: 'bash',
				output: null,
				error: 'context length exceeded',
				metadata: {},
			};

			await hooks.toolAfter(input as any, output as any);

			expect(session.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
			const advisory = session.pendingAdvisoryMessages?.[0] ?? '';
			// New correct text
			expect(advisory).toContain('Fallback model');
			expect(advisory).toContain('considered');
			// Old misleading text must NOT appear
			expect(advisory).not.toContain('Attempting fallback');
			expect(advisory).not.toContain('attempting fallback');

			mock.restore();
		});
	});

	// -------------------------------------------------------------------------
	// Regression tests for issue #756
	// Provider errors were stopping swarm loop due to incorrect classification
	// -------------------------------------------------------------------------

	describe('issue #756 regression: provider errors stopping swarm loop', () => {
		test('multiple HTTP 500 errors do not trip circuit breaker within retry limit', async () => {
			const sessionId = 'session-756';
			const configWithLowLimit = {
				...defaultConfig,
				max_consecutive_errors: 3,
			};
			const hooksLocal = createGuardrailsHooks(TEST_DIR, configWithLowLimit);
			await setupSubagentSessionWithWindow(hooksLocal, sessionId);

			// Make 4 transient 500 errors (max_transient_retries=5)
			for (let i = 1; i <= 4; i++) {
				const input = {
					tool: 'bash',
					sessionID: sessionId,
					callID: `call-${i}`,
				};
				const output = {
					title: 'bash',
					output: null,
					error: 'Error 500: Internal Server Error',
					metadata: {},
				};
				await hooksLocal.toolAfter(input as any, output as any);
			}

			const window = getActiveWindow(sessionId);
			// Should NOT have tripped circuit breaker (consecutiveErrors should be 0)
			expect(window?.consecutiveErrors).toBe(0);
			// Should be in transient retry mode
			expect(window?.transientRetryCount).toBe(4);
		});

		test('connection errors do not trip circuit breaker within retry limit', async () => {
			const sessionId = 'session-conn-756';
			const configWithLowLimit = {
				...defaultConfig,
				max_consecutive_errors: 3,
			};
			const hooksLocal = createGuardrailsHooks(TEST_DIR, configWithLowLimit);
			await setupSubagentSessionWithWindow(hooksLocal, sessionId);

			const connectionErrors = [
				'connection refused',
				'connection reset by peer',
				'connection timeout',
				'bad gateway',
			];

			for (let i = 0; i < connectionErrors.length; i++) {
				const input = {
					tool: 'bash',
					sessionID: sessionId,
					callID: `call-${i}`,
				};
				const output = {
					title: 'bash',
					output: null,
					error: connectionErrors[i],
					metadata: {},
				};
				await hooksLocal.toolAfter(input as any, output as any);
			}

			const window = getActiveWindow(sessionId);
			expect(window?.consecutiveErrors).toBe(0);
			expect(window?.transientRetryCount).toBe(4);
		});
	});
});
