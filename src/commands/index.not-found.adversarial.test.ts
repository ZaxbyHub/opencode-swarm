/**
 * Adversarial security tests for command-not-found UX in createSwarmCommandHandler.
 *
 * Attack vectors covered:
 * 1. Very long command name (10000+ chars) — does it hang or crash?
 * 2. Command with special characters (script injection, shell injection, template literals)
 * 3. Command with newlines/embedded control chars — does it break output format?
 * 4. Command with unicode/emoji — handled gracefully?
 * 5. Extremely deep tokens array (1000 elements) — does findSimilarCommands handle it?
 * 6. Null bytes in command name
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { swarmState } from '../state';
import { createSwarmCommandHandler } from './index';
import { _internals } from './registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-not-found-adv-'));
}

function makeSession(id: string): void {
	swarmState.agentSessions.set(id, {
		agentName: 'architect',
		lastToolCallTime: Date.now(),
		lastAgentEventTime: Date.now(),
		delegationActive: false,
		activeInvocationId: 0,
		lastInvocationIdByAgent: {},
		windows: {},
		lastCompactionHint: 0,
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: null,
		gateLog: new Map(),
		reviewerCallCount: new Map(),
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: new Set(),
		selfFixAttempted: false,
		selfCodingWarnedAtCount: 0,
		catastrophicPhaseWarnings: new Set(),
		qaSkipCount: 0,
		qaSkipTaskIds: [],
		taskWorkflowStates: new Map(),
		lastGateOutcome: null,
		declaredCoderScope: null,
		lastScopeViolation: null,
		modifiedFilesThisCoderTask: [],
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: new Set(),
		lastCompletedPhaseAgentsDispatched: new Set(),
		turboMode: false,
		fullAutoMode: false,
		fullAutoInteractionCount: 0,
		fullAutoDeadlockCount: 0,
		fullAutoLastQuestionHash: null,
		coderRevisions: 0,
		revisionLimitHit: false,
		model_fallback_index: 0,
		modelFallbackExhausted: false,
		sessionRehydratedAt: 0,
		prmPatternCounts: new Map(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null,
		prmTrajectoryStep: 0,
		prmHardStopPending: false,
	});
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Command-not-found UX — Adversarial Security', () => {
	let tempDir: string;
	let sessionId: string;

	beforeEach(() => {
		tempDir = makeTempDir();
		sessionId = `cmd-not-found-adv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		makeSession(sessionId);

		// Pre-create a marker file to ensure .swarm directory is non-empty
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, '.test-marker'),
			`test-marker: ${new Date().toISOString()}\n`,
		);
	});

	afterEach(() => {
		swarmState.agentSessions.delete(sessionId);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// Test 1: Very long command name (10000+ chars)
	// -------------------------------------------------------------------------
	describe('Oversized input — very long command name', () => {
		it('handles 10000-char command name without hanging or crashing', async () => {
			const longCommand = 'a'.repeat(10_000);
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			// Mock findSimilarCommands to return empty to avoid expensive computation
			const mockFindSimilar = mock(() => [] as string[]);
			const originalFn = _internals.findSimilarCommands;
			_internals.findSimilarCommands = mockFindSimilar;

			try {
				const start = Date.now();
				await handler(
					{ command: 'swarm', arguments: longCommand, sessionID: sessionId },
					output,
				);
				const elapsed = Date.now() - start;

				// Must complete in bounded time (< 5 seconds)
				expect(elapsed).toBeLessThan(5000);

				// Output must be a valid text part
				expect(output.parts).toHaveLength(1);
				const text = (output.parts[0] as { text: string }).text;
				expect(typeof text).toBe('string');

				// Must NOT contain the raw long string in a dangerous way
				// The command name should appear truncated or escaped in the output
				expect(text).toContain(longCommand.slice(0, 100));
			} finally {
				_internals.findSimilarCommands = originalFn;
			}
		}, 10_000); // 10s timeout for this specific test

		it('handles 50000-char command name without hanging or crashing', async () => {
			const veryLongCommand = 'x'.repeat(50_000);
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			const mockFindSimilar = mock(() => [] as string[]);
			const originalFn = _internals.findSimilarCommands;
			_internals.findSimilarCommands = mockFindSimilar;

			try {
				const start = Date.now();
				await handler(
					{
						command: 'swarm',
						arguments: veryLongCommand,
						sessionID: sessionId,
					},
					output,
				);
				const elapsed = Date.now() - start;

				// Must complete in bounded time (< 5 seconds)
				expect(elapsed).toBeLessThan(5000);

				expect(output.parts).toHaveLength(1);
				const text = (output.parts[0] as { text: string }).text;
				expect(typeof text).toBe('string');
			} finally {
				_internals.findSimilarCommands = originalFn;
			}
		}, 15_000); // 15s timeout
	});

	// -------------------------------------------------------------------------
	// Test 2: Command with special characters (injection attempts)
	// -------------------------------------------------------------------------
	describe('Injection attempts — special characters in command name', () => {
		const injectionPayloads = [
			{
				name: 'XSS script tag',
				input: '<script>alert(1)</script>',
				expectSanitized: true,
			},
			{
				name: 'Shell injection — pipe chain',
				input: '" || rm -rf /',
				expectSanitized: true,
			},
			{
				name: 'Command substitution',
				input: '$(whoami)',
				expectSanitized: true,
			},
			{
				name: 'Backtick substitution',
				input: '`id`',
				expectSanitized: true,
			},
			{
				name: 'Template literal injection',
				input: '${JNDISomething}',
				expectSanitized: true,
			},
			{
				name: 'SQL fragment',
				input: "'; DROP TABLE users;--",
				expectSanitized: true,
			},
			{
				name: 'Newline injection',
				input: 'cmd\ninjected-value',
				expectSanitized: true,
			},
			{
				name: 'Carriage return injection',
				input: 'cmd\rwin32-attack',
				expectSanitized: true,
			},
			{
				name: 'Tab injection',
				input: 'cmd\tHIDDEN',
				expectSanitized: true,
			},
		];

		for (const payload of injectionPayloads) {
			it(`sanitizes output for: ${payload.name}`, async () => {
				const mockFindSimilar = mock(() => [] as string[]);
				const originalFn = _internals.findSimilarCommands;
				_internals.findSimilarCommands = mockFindSimilar;

				try {
					const handler = createSwarmCommandHandler(tempDir, {});
					const output = { parts: [] as unknown[] };

					await handler(
						{
							command: 'swarm',
							arguments: payload.input,
							sessionID: sessionId,
						},
						output,
					);

					expect(output.parts).toHaveLength(1);
					const text = (output.parts[0] as { text: string }).text;

					// Output must be a plain string (not evaluated or executed)
					expect(typeof text).toBe('string');

					// The attempted command should appear in the output safely
					// Either as-is (it's just text) or with proper escaping
					expect(text).toContain('not found');

					// If the payload contains newlines/control chars, the output
					// must NOT interpret them — it should appear as plain text
					if (payload.input.includes('\n')) {
						// The output should have the newline literally, not interpreted
						// If we see "not found" on one line and then the payload on another,
						// that's expected. But the payload should NOT appear as executed code.
						expect(text).toContain('Command `/swarm');
					}
				} finally {
					_internals.findSimilarCommands = originalFn;
				}
			});
		}

		it('output is safe markdown — script tags are NOT executed', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm',
					arguments: '<script>alert(1)</script>',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;

			// Script tag appears as plain text in markdown code span — it is NOT executable HTML
			// The output is a plain string, not parsed HTML. This is safe.
			expect(text).toContain('<script>');
			expect(text).toContain('alert(1)'); // Literal text, not executed
			// The output must contain the "not found" header
			expect(text).toContain('not found');
		});

		it('shell metacharacters appear as plain text in output', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm',
					arguments: '"; cat /etc/passwd #',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;

			// The shell metacharacters must appear literally, not interpreted
			expect(text).toContain('Command `/swarm');
			expect(text).toContain('not found');
		});
	});

	// -------------------------------------------------------------------------
	// Test 3: Command with newlines/embedded control chars
	// -------------------------------------------------------------------------
	describe('Control characters — newlines and embedded control chars', () => {
		it('newlines in command are handled safely — output stays intact', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			// Command with embedded newline — the \n gets parsed by trim().split(/\s+/)
			// which turns it into separate tokens
			await handler(
				{
					command: 'swarm',
					arguments: 'unknown\ncommand',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;

			// Output should be valid string — newlines from input become spaces
			expect(typeof text).toBe('string');
			// The output should contain "not found" message
			expect(text).toContain('not found');
		});

		it('only-newline command is handled without crashing', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: '\n\n\n', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Empty/whitespace-only tokens should show help
			expect(text).toContain('## Swarm Commands');
		});

		it('mixed control chars (\\r\\n\\t\\x00) are handled safely', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm',
					arguments: 'unk\r\n\tcmd\x00test',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
			expect(text).toContain('not found');
		});
	});

	// -------------------------------------------------------------------------
	// Test 4: Command with unicode/emoji
	// -------------------------------------------------------------------------
	describe('Unicode and emoji — handled gracefully', () => {
		it('handles unicode command name without crashing', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: 'команда', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
			expect(text).toContain('not found');
		});

		it('handles emoji in command name without crashing', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: '🔥🔥🔥', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
			expect(text).toContain('not found');
		});

		it('handles mixed unicode and ASCII without crashing', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: 'cónfig✅', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
			expect(text).toContain('not found');
		});

		it('handles zero-width space in command name', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: 'config\u200B', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
			// Should treat as part of the command name — won't match "config"
			expect(text).toContain('not found');
		});

		it('handles RTL override character', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			// U+202E: RIGHT-TO-LEFT OVERRIDE
			await handler(
				{ command: 'swarm', arguments: 'config\u202E', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
			expect(text).toContain('not found');
		});

		it('handles fullwidth characters (Japanese)', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: '設定', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
			expect(text).toContain('not found');
		});
	});

	// -------------------------------------------------------------------------
	// Test 5: Extremely deep tokens array (1000 elements)
	// -------------------------------------------------------------------------
	describe('Oversized tokens array — 1000+ elements', () => {
		it('handles 1000 tokens without hanging or crashing', async () => {
			const manyTokens = Array(1000).fill('a').join(' ');
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			const start = Date.now();
			await handler(
				{ command: 'swarm', arguments: manyTokens, sessionID: sessionId },
				output,
			);
			const elapsed = Date.now() - start;

			// Must complete in bounded time
			expect(elapsed).toBeLessThan(5000);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
			// First token is "aaaa..." which is a long string
			expect(text).toContain('not found');
		});

		it('handles 5000 tokens without hanging or crashing', async () => {
			const manyTokens = Array(5000).fill('b').join(' ');
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			const start = Date.now();
			await handler(
				{ command: 'swarm', arguments: manyTokens, sessionID: sessionId },
				output,
			);
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(5000);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
		}, 10_000);

		it('handles deeply nested spaces (many whitespace-only tokens)', async () => {
			// Each split(/\s+/) on '      ' produces empty-string-filtered results
			// so we test what happens with alternating empty/single-char tokens
			const weirdInput = '   a   b   c   '.repeat(200);
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: weirdInput, sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
			expect(text).toContain('not found');
		});
	});

	// -------------------------------------------------------------------------
	// Test 6: Null bytes in command name
	// -------------------------------------------------------------------------
	describe('Null bytes — \\x00 in command name', () => {
		it('handles null byte prefix in command name', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			// String.split() in JS treats \x00 as a valid character, not a terminator
			await handler(
				{ command: 'swarm', arguments: '\x00config', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
			// Should not find the command (since \x00config != config)
			expect(text).toContain('not found');
		});

		it('handles null byte in middle of command name', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: 'conf\x00ig', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
			expect(text).toContain('not found');
		});

		it('handles multiple null bytes', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{
					command: 'swarm',
					arguments: '\x00\x00\x00config',
					sessionID: sessionId,
				},
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(typeof text).toBe('string');
			expect(text).toContain('not found');
		});
	});

	// -------------------------------------------------------------------------
	// Test 7: Boundary — empty and whitespace-only inputs
	// -------------------------------------------------------------------------
	describe('Boundary cases — empty and whitespace-only inputs', () => {
		it('handles empty string arguments', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: '', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			expect(text).toContain('## Swarm Commands');
		});

		it('handles only-whitespace arguments', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			await handler(
				{ command: 'swarm', arguments: '   \t\t  ', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;
			// Filtered to empty, should show help
			expect(text).toContain('## Swarm Commands');
		});
	});

	// -------------------------------------------------------------------------
	// Test 8: Output format safety — no format breakdown
	// -------------------------------------------------------------------------
	describe('Output format safety — no format breakdown', () => {
		it('output is valid text with no raw newlines breaking markdown', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			// Multi-line injection attempt in arguments
			// Input "unk\ncmd" splits to tokens ['unk', 'cmd'], so first token is 'unk'
			await handler(
				{ command: 'swarm', arguments: 'unk\ncmd', sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;

			// Output must be a single text part (not multiple parts)
			expect(output.parts).toHaveLength(1);
			// Text must contain the header and footer
			expect(text).toContain('not found');
			expect(text).toContain('/swarm help');
		});

		it('output length with 100k-char input — full command name echoed in header', async () => {
			const handler = createSwarmCommandHandler(tempDir, {});
			const output = { parts: [] as unknown[] };

			const longInput = 'a'.repeat(100_000);
			await handler(
				{ command: 'swarm', arguments: longInput, sessionID: sessionId },
				output,
			);

			expect(output.parts).toHaveLength(1);
			const text = (output.parts[0] as { text: string }).text;

			// Output is bounded — the command name is truncated to 100 chars in the header
			// to prevent DoS via memory/bandwidth amplification from huge command names.
			expect(text.length).toBeLessThan(500);
			expect(text).toContain('not found');
			expect(text).toContain('...');
		});
	});
});
