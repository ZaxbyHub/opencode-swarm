/**
 * Verification + Adversarial Tests for message-priority.ts
 *
 * Tests cover:
 * - 8 verification tests for normal functionality
 * - 4 adversarial tests for attack vector mitigation
 * - Issue #2068: real OpenCode SDK `ToolPart` shape
 *
 * Tool results use the real OpenCode SDK shape: a `ToolPart`
 * (`{ type: 'tool', tool, state: { status, output, ... } }`) inside an
 * assistant message's `parts[]` — NOT a separate `role:'tool'` message and NOT
 * a fictional `info.toolName` field.
 */

import { describe, expect, it } from 'bun:test';
import {
	classifyMessage,
	classifyMessages,
	containsPlanContent,
	getCompletedToolOutputs,
	getToolNames,
	getToolParts,
	isDuplicateToolRead,
	isStaleError,
	isToolResult,
	MessagePriority,
	type MessageWithParts,
} from '../../../src/hooks/message-priority';

/** Helper: build a real completed-tool assistant message. */
function toolMessage(
	tool: string,
	output: string,
	opts: { input?: Record<string, unknown> } = {},
): MessageWithParts {
	return {
		info: { role: 'assistant' },
		parts: [
			{
				type: 'tool',
				tool,
				state: {
					status: 'completed',
					input: opts.input ?? {},
					output,
					title: tool,
					metadata: {},
					time: { start: 0, end: 1 },
				},
			},
		],
	};
}

describe('Message Priority Classifier - Verification Tests', () => {
	/**
	 * Test 1: System message classified CRITICAL
	 */
	it('should classify system message as CRITICAL', () => {
		const message: MessageWithParts = {
			info: {
				role: 'system',
			},
		};

		const result = classifyMessage(message, 0, 100);

		expect(result).toBe(MessagePriority.CRITICAL);
		expect(result).toBe(0);
	});

	/**
	 * Test 2: User message classified HIGH
	 */
	it('should classify user message as HIGH', () => {
		const message: MessageWithParts = {
			info: {
				role: 'user',
			},
			parts: [
				{
					type: 'text',
					text: 'Hello, how are you?',
				},
			],
		};

		const result = classifyMessage(message, 0, 100);

		expect(result).toBe(MessagePriority.HIGH);
		expect(result).toBe(1);
	});

	/**
	 * Test 3: Recent assistant message (within last 10) classified MEDIUM
	 */
	it('should classify recent assistant message as MEDIUM', () => {
		const message: MessageWithParts = {
			info: {
				role: 'assistant',
			},
			parts: [
				{
					type: 'text',
					text: 'I will help you with that.',
				},
			],
		};

		// index=95, totalMessages=100 → positionFromEnd = 4 (within recent window of 10)
		const result = classifyMessage(message, 95, 100, 10);

		expect(result).toBe(MessagePriority.MEDIUM);
		expect(result).toBe(2);
	});

	/**
	 * Test 4: Old assistant message (outside recent window) classified LOW
	 */
	it('should classify old assistant message as LOW', () => {
		const message: MessageWithParts = {
			info: {
				role: 'assistant',
			},
			parts: [
				{
					type: 'text',
					text: 'This is an old response.',
				},
			],
		};

		// index=5, totalMessages=100 → positionFromEnd = 94 (outside recent window of 10)
		const result = classifyMessage(message, 5, 100, 10);

		expect(result).toBe(MessagePriority.LOW);
		expect(result).toBe(3);
	});

	/**
	 * Test 5: Message with plan.md content classified CRITICAL
	 */
	it('should classify plan.md content as CRITICAL regardless of role', () => {
		const message: MessageWithParts = {
			info: {
				role: 'assistant',
			},
			parts: [
				{
					type: 'text',
					text: 'Reading from .swarm/plan.md for task execution.',
				},
			],
		};

		const result = classifyMessage(message, 5, 100);

		expect(result).toBe(MessagePriority.CRITICAL);
		expect(result).toBe(0);
	});

	/**
	 * Test 6: Message with context.md content classified CRITICAL
	 */
	it('should classify context.md content as CRITICAL regardless of role', () => {
		const message: MessageWithParts = {
			info: {
				role: 'user',
			},
			parts: [
				{
					type: 'text',
					text: 'The .swarm/context.md contains important state.',
				},
			],
		};

		const result = classifyMessage(message, 50, 100);

		expect(result).toBe(MessagePriority.CRITICAL);
		expect(result).toBe(0);
	});

	/**
	 * Test 7: Consecutive duplicate tool reads marked DISPOSABLE (real ToolPart shape)
	 */
	it('should mark consecutive duplicate tool reads as DISPOSABLE', () => {
		const messages: MessageWithParts[] = [
			toolMessage('read_file', 'content', {
				input: { filePath: 'src/config.ts' },
			}),
			toolMessage('read_file', 'content', {
				input: { filePath: 'src/config.ts' },
			}),
		];

		const results = classifyMessages(messages, 10);

		// First (older) message should be demoted to DISPOSABLE
		expect(results[0]).toBe(MessagePriority.DISPOSABLE);
		expect(results[0]).toBe(4);
	});

	/**
	 * Test 8: Stale error (>6 turns old) classified DISPOSABLE
	 */
	it('should classify stale errors as DISPOSABLE', () => {
		const message = toolMessage(
			'bash',
			'Error: failed to execute command. Access denied.',
		);

		// index=89, totalMessages=100 → positionFromEnd = 10 (outside recent window, stale >6)
		const result = classifyMessage(message, 89, 100, 10);

		expect(result).toBe(MessagePriority.DISPOSABLE);
		expect(result).toBe(4);
	});
});

describe('Message Priority Classifier - Adversarial Tests', () => {
	/**
	 * Attack Vector 1: Can duplicate detection overwrite CRITICAL message?
	 */
	it('should NOT demote CRITICAL message to DISPOSABLE via duplicate detection', () => {
		const messages: MessageWithParts[] = [
			toolMessage('read_file', 'Reading .swarm/plan.md for task execution.', {
				input: { filePath: '.swarm/plan.md' },
			}),
			toolMessage('read_file', '', {
				input: { filePath: '.swarm/plan.md' },
			}),
		];

		const results = classifyMessages(messages, 10);

		// First message has plan content → CRITICAL (0)
		// CRITICAL < MEDIUM (2), so guard at results[i-1] >= MEDIUM should NOT demote it
		expect(results[0]).toBe(MessagePriority.CRITICAL);
		expect(results[0]).toBe(0);
	});

	/**
	 * Attack Vector 2: Similar tool calls with different args are NOT duplicates
	 */
	it('should NOT mark similar tool calls with different args as duplicate', () => {
		const messages: MessageWithParts[] = [
			toolMessage('read_file', 'content', {
				input: { filePath: 'src/important.ts' },
			}),
			toolMessage('read_file', 'content', {
				input: { filePath: 'src/other.ts' }, // Different first arg
			}),
		];

		const results = classifyMessages(messages, 10);

		// Different args → not duplicate → should not be DISPOSABLE
		expect(results[0]).not.toBe(MessagePriority.DISPOSABLE);
	});

	/**
	 * Additional test: Different tool names should not be marked as duplicate
	 */
	it('should NOT mark different tool names as duplicate even with same args', () => {
		const messages: MessageWithParts[] = [
			toolMessage('read_file', 'content', {
				input: { filePath: 'src/config.ts' },
			}),
			toolMessage('write_file', 'content', {
				input: { filePath: 'src/config.ts' }, // Same first arg
			}),
		];

		const results = classifyMessages(messages, 10);

		// Different tool → not duplicate → should not be DISPOSABLE
		expect(results[0]).not.toBe(MessagePriority.DISPOSABLE);
	});

	/**
	 * Attack Vector 3: Plan content always wins over other classifications
	 */
	it('should prioritize plan content classification over other rules', () => {
		// This is a recent tool message (would normally be MEDIUM)
		// But its output contains plan content (should be CRITICAL)
		const message = toolMessage(
			'read',
			'I checked .swarm/plan.md and will execute tasks.',
		);

		// Recent: index=95 of 100 → positionFromEnd = 4 (MEDIUM normally)
		const result = classifyMessage(message, 95, 100, 10);

		// Plan content check happens first, so CRITICAL wins
		expect(result).toBe(MessagePriority.CRITICAL);
		expect(result).toBe(0);
	});

	/**
	 * Additional test: Plan content wins even over system role
	 */
	it('should classify system message with plan content as CRITICAL', () => {
		const message: MessageWithParts = {
			info: {
				role: 'system',
			},
			parts: [
				{
					type: 'text',
					text: 'System prompt referencing .swarm/plan.md',
				},
			],
		};

		const result = classifyMessage(message, 0, 100);

		expect(result).toBe(MessagePriority.CRITICAL);
	});

	/**
	 * Attack Vector 4: Stale error boundary at 6 turns
	 */
	it('should correctly enforce stale error boundary at 6 turns', () => {
		const errorText = 'Error: failed to connect to database';

		expect(isStaleError(errorText, 6)).toBe(false);
		expect(isStaleError(errorText, 7)).toBe(true);
		expect(isStaleError(errorText, 0)).toBe(false);
		expect(isStaleError(errorText, 3)).toBe(false);
		expect(isStaleError(errorText, 10)).toBe(true);
		expect(isStaleError(errorText, 20)).toBe(true);
	});

	it('should NOT mark non-error messages as stale even if old', () => {
		const normalText = 'Operation completed successfully.';

		expect(isStaleError(normalText, 7)).toBe(false);
		expect(isStaleError(normalText, 20)).toBe(false);
	});

	it('should handle empty or null text gracefully', () => {
		expect(isStaleError('', 10)).toBe(false);
		expect(isStaleError(null as unknown as string, 10)).toBe(false);
		expect(isStaleError(undefined as unknown as string, 10)).toBe(false);
	});
});

describe('Message Priority Classifier - Edge Cases', () => {
	it('should handle messages with no parts', () => {
		const message: MessageWithParts = {
			info: {
				role: 'assistant',
			},
		};

		const result = classifyMessage(message, 50, 100);

		expect(result).toBe(MessagePriority.LOW);
	});

	it('should handle unknown role with default LOW priority', () => {
		const message: MessageWithParts = {
			info: {
				role: 'unknown',
			},
			parts: [
				{
					type: 'text',
					text: 'Some content from unknown role',
				},
			],
		};

		const result = classifyMessage(message, 50, 100);

		expect(result).toBe(MessagePriority.LOW);
	});

	it('should handle messages with no info', () => {
		const message: MessageWithParts = {
			parts: [
				{
					type: 'text',
					text: 'Some content',
				},
			],
		};

		const result = classifyMessage(message, 50, 100);

		expect(result).toBe(MessagePriority.LOW);
	});

	it('should handle empty messages array', () => {
		const results = classifyMessages([]);

		expect(results).toEqual([]);
	});

	it('should handle tool result at boundary of recent window', () => {
		const message = toolMessage('read_file', 'File content', {
			input: { filePath: 'test.txt' },
		});

		// Exactly at boundary: index=90 of 100 → positionFromEnd = 9 (within window of 10)
		const result = classifyMessage(message, 90, 100, 10);

		expect(result).toBe(MessagePriority.MEDIUM);
	});

	it('should handle tool result just outside boundary of recent window', () => {
		const message = toolMessage('read_file', 'File content', {
			input: { filePath: 'test.txt' },
		});

		// Just outside boundary: index=89 of 100 → positionFromEnd = 10 (outside window of 10)
		const result = classifyMessage(message, 89, 100, 10);

		expect(result).toBe(MessagePriority.LOW);
	});
});

describe('Message Priority Classifier - Helper Functions', () => {
	describe('containsPlanContent', () => {
		it('should detect .swarm/plan references', () => {
			expect(containsPlanContent('Reading .swarm/plan.md')).toBe(true);
		});

		it('should detect .swarm/context references', () => {
			expect(containsPlanContent('Checking .swarm/context.md')).toBe(true);
		});

		it('should detect swarm/plan.md references', () => {
			expect(containsPlanContent('swarm/plan.md contains tasks')).toBe(true);
		});

		it('should detect swarm/context.md references', () => {
			expect(containsPlanContent('swarm/context.md updated')).toBe(true);
		});

		it('should be case-insensitive', () => {
			expect(containsPlanContent('READING .SWARM/PLAN.MD')).toBe(true);
		});

		it('should return false for normal text', () => {
			expect(containsPlanContent('This is normal message content')).toBe(false);
		});

		it('should handle empty string', () => {
			expect(containsPlanContent('')).toBe(false);
		});

		it('should handle null input', () => {
			expect(containsPlanContent(null as unknown as string)).toBe(false);
		});
	});

	describe('isToolResult (real ToolPart shape)', () => {
		it('should return true for assistant message with a ToolPart', () => {
			const message = toolMessage('read_file', 'content');

			expect(isToolResult(message)).toBe(true);
		});

		it('should return false for plain assistant message with no tool part', () => {
			const message: MessageWithParts = {
				info: { role: 'assistant' },
				parts: [{ type: 'text', text: 'hello' }],
			};

			expect(isToolResult(message)).toBe(false);
		});

		it('should return false for message with no parts', () => {
			const message: MessageWithParts = {
				info: { role: 'assistant' },
			};

			expect(isToolResult(message)).toBe(false);
		});

		it('should return false for message without info', () => {
			const message: MessageWithParts = {
				parts: [],
			};

			expect(isToolResult(message)).toBe(false);
		});

		it('should return true when multiple tool parts are present', () => {
			const message: MessageWithParts = {
				info: { role: 'assistant' },
				parts: [
					{
						type: 'tool',
						tool: 'a',
						state: { status: 'completed', output: '1' },
					},
					{
						type: 'tool',
						tool: 'b',
						state: { status: 'completed', output: '2' },
					},
				],
			};

			expect(isToolResult(message)).toBe(true);
			expect(getToolParts(message)).toHaveLength(2);
			expect(getToolNames(message)).toEqual(['a', 'b']);
		});
	});

	describe('getCompletedToolOutputs', () => {
		it('returns completed outputs only', () => {
			const message: MessageWithParts = {
				info: { role: 'assistant' },
				parts: [
					{
						type: 'tool',
						tool: 'a',
						state: { status: 'completed', output: 'out-a' },
					},
					{ type: 'tool', tool: 'b', state: { status: 'pending', input: {} } },
					{
						type: 'tool',
						tool: 'c',
						state: { status: 'error', error: 'boom' },
					},
					{ type: 'tool', tool: 'd', state: { status: 'running', input: {} } },
				],
			};

			const outs = getCompletedToolOutputs(message);
			expect(outs).toHaveLength(1);
			expect(outs[0].output).toBe('out-a');
		});

		it('returns empty for non-tool messages', () => {
			const message: MessageWithParts = {
				info: { role: 'user' },
				parts: [{ type: 'text', text: 'hi' }],
			};

			expect(getCompletedToolOutputs(message)).toEqual([]);
		});
	});

	describe('isDuplicateToolRead', () => {
		it('should return true for identical read tool calls', () => {
			const current = toolMessage('read_file', 'x', {
				input: { filePath: 'test.txt' },
			});
			const previous = toolMessage('read_file', 'x', {
				input: { filePath: 'test.txt' },
			});

			expect(isDuplicateToolRead(current, previous)).toBe(true);
		});

		it('should return false for different tool names', () => {
			const current = toolMessage('read_file', 'x', {
				input: { filePath: 'test.txt' },
			});
			const previous = toolMessage('write_file', 'x', {
				input: { filePath: 'test.txt' },
			});

			expect(isDuplicateToolRead(current, previous)).toBe(false);
		});

		it('should return false for different first args', () => {
			const current = toolMessage('read_file', 'x', {
				input: { filePath: 'test.txt' },
			});
			const previous = toolMessage('read_file', 'x', {
				input: { filePath: 'other.txt' },
			});

			expect(isDuplicateToolRead(current, previous)).toBe(false);
		});

		it('should return false for non-read tools', () => {
			const current = toolMessage('bash', 'x', { input: { command: 'ls' } });
			const previous = toolMessage('bash', 'x', { input: { command: 'ls' } });

			expect(isDuplicateToolRead(current, previous)).toBe(false);
		});

		it('should return false when tool state input is missing', () => {
			const current: MessageWithParts = {
				info: { role: 'assistant' },
				parts: [
					{
						type: 'tool',
						tool: 'read_file',
						state: { status: 'completed', output: 'x' },
					},
				],
			};
			const previous: MessageWithParts = {
				info: { role: 'assistant' },
				parts: [
					{
						type: 'tool',
						tool: 'read_file',
						state: { status: 'completed', output: 'x' },
					},
				],
			};

			expect(isDuplicateToolRead(current, previous)).toBe(false);
		});

		it('should return false when messages have no tool parts', () => {
			const current: MessageWithParts = {};
			const previous: MessageWithParts = {};

			expect(isDuplicateToolRead(current, previous)).toBe(false);
		});
	});

	describe('isStaleError', () => {
		it('should detect various error patterns', () => {
			expect(isStaleError('Error: something went wrong', 10)).toBe(true);
			expect(isStaleError('Failed to connect', 10)).toBe(true);
			expect(isStaleError('Could not find file', 10)).toBe(true);
			expect(isStaleError('Unable to process', 10)).toBe(true);
			expect(isStaleError('Exception occurred', 10)).toBe(true);
			expect(isStaleError('Errno 42', 10)).toBe(true);
			expect(isStaleError('Cannot read file', 10)).toBe(true);
			expect(isStaleError('Not found', 10)).toBe(true);
			expect(isStaleError('Access denied', 10)).toBe(true);
			expect(isStaleError('Timeout error', 10)).toBe(true);
		});

		it('should be case-insensitive for error detection', () => {
			expect(isStaleError('ERROR: FAILED TO CONNECT', 10)).toBe(true);
			expect(isStaleError('Error: failed to connect', 10)).toBe(true);
		});

		it('should not mark non-error text as stale', () => {
			expect(isStaleError('Success! Operation completed.', 10)).toBe(false);
			expect(isStaleError('All tests passed.', 10)).toBe(false);
		});
	});
});
