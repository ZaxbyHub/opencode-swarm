/**
 * Tests for knowledge_ack tool.
 *
 * Covers:
 * - Parameter validation: invalid id, invalid result
 * - Happy path: successful acknowledgment recording
 * - Dedup: duplicate ack detection
 * - Missing sessionID: generates random UUID (warn logger)
 * - Optional fields passed through to recordAcknowledgment
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Module-level mocks — must be before the tool import so the mocked
// dependencies are resolved at module load time.
const mockBuildAckDedupKey = mock(() => 'dedup-key-test');
const mockRecordAcknowledgment = mock(async () => undefined);
const mockAddKnowledgeAckDedup = mock(() => undefined);
const mockWarn = mock(() => {});

const dedupSet = new Set<string>();

mock.module('../../../src/hooks/knowledge-application.js', () => ({
	buildAckDedupKey: mockBuildAckDedupKey,
	recordAcknowledgment: mockRecordAcknowledgment,
}));

mock.module('../../../src/state.js', () => ({
	swarmState: { knowledgeAckDedup: dedupSet },
	addKnowledgeAckDedup: mockAddKnowledgeAckDedup,
}));

mock.module('../../../src/utils/logger.js', () => ({
	warn: mockWarn,
	info: mock(() => {}),
	debug: mock(() => {}),
	error: mock(() => {}),
}));

// Import AFTER mock.module so the tool resolves mocked deps
import { _internals } from '../../../src/tools/knowledge-ack';

const { knowledge_ack } = _internals;

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
	// Reset mock state but keep the module mocks active
	mockBuildAckDedupKey.mockClear();
	mockRecordAcknowledgment.mockClear();
	mockAddKnowledgeAckDedup.mockClear();
	mockWarn.mockClear();
	dedupSet.clear();

	tmp = await fs.realpath(
		await fs.mkdtemp(path.join(tmpdir(), 'knowledge-ack-test-')),
	);
	originalCwd = process.cwd();
	process.chdir(tmp);
});

afterEach(async () => {
	process.chdir(originalCwd);
	try {
		await fs.rm(tmp, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

describe('knowledge_ack tool', () => {
	describe('parameter validation', () => {
		it('returns error for missing id', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute({ result: 'applied' }, tmp, {}),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid id');
		});

		it('returns error for id shorter than 8 chars', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 'short', result: 'applied' },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid id');
		});

		it('returns error for empty string id', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute({ id: '', result: 'applied' }, tmp, {}),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid id');
		});

		it('returns error for non-string id', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 12345 as unknown as string, result: 'applied' },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid id');
		});

		it('returns error for invalid result value', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 'abcdefgh', result: 'maybe' as any },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid result');
		});

		it('returns error for missing result', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute({ id: 'abcdefgh' }, tmp, {}),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid result');
		});
	});

	describe('dedup detection', () => {
		it('returns duplicate_ack when dedup key already exists', async () => {
			dedupSet.add('dedup-key-test');

			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 'abcdefgh', result: 'applied' },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(false);
			expect(result.reason).toBe('duplicate_ack');
			expect(result.id).toBe('abcdefgh');
			expect(result.result).toBe('applied');
		});
	});

	describe('happy path', () => {
		it('records acknowledgment and returns success', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 'abcdefgh', result: 'applied', reason: 'test reason' },
					{ directory: tmp, sessionID: 'session-123' } as any,
				),
			);
			expect(result.recorded).toBe(true);
			expect(result.id).toBe('abcdefgh');
			expect(result.result).toBe('applied');
			expect(mockBuildAckDedupKey).toHaveBeenCalled();
			expect(mockAddKnowledgeAckDedup).toHaveBeenCalledWith('dedup-key-test');
			expect(mockRecordAcknowledgment).toHaveBeenCalled();
		});

		it('passes optional fields to recordAcknowledgment', async () => {
			// The outer execute is (args, ctx?) where ctx has .directory and .sessionID
			await knowledge_ack.execute(
				{
					id: 'abcdefgh',
					result: 'ignored',
					phase: '1',
					task_id: '1.1',
					action: 'applied',
					tool: 'skill-generate',
					target_agent: 'coder',
				},
				{ directory: tmp, sessionID: 'session-456' } as any,
			);

			const callArgs = mockRecordAcknowledgment.mock.calls[0];
			expect(callArgs[0]).toBe(tmp);
			expect(callArgs[1].id).toBe('abcdefgh');
			expect(callArgs[1].result).toBe('ignored');
			expect(callArgs[2]).toEqual(
				expect.objectContaining({
					phase: '1',
					taskId: '1.1',
					action: 'applied',
					tool: 'skill-generate',
					targetAgent: 'coder',
					sessionId: 'session-456',
				}),
			);
		});

		it('works with result "violated"', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute({ id: 'abcdefgh', result: 'violated' }, {
					directory: tmp,
					sessionID: 'session-789',
				} as any),
			);
			expect(result.recorded).toBe(true);
			expect(result.result).toBe('violated');
		});

		it('generates random UUID when sessionID is missing', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 'abcdefgh', result: 'applied' },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(true);
			expect(mockBuildAckDedupKey).toHaveBeenCalled();
			expect(mockWarn).toHaveBeenCalled();
		});

		it('handles null args gracefully', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute(null as any, tmp, {}),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid id');
		});
	});

	describe('_internals seam', () => {
		it('exposes knowledge_ack via _internals', () => {
			expect(_internals.knowledge_ack).toBeDefined();
			expect(typeof _internals.knowledge_ack.execute).toBe('function');
		});
	});

	describe('ADVERSARIAL: malformed inputs and boundary violations', () => {
		// VULNERABILITY: id has no max length validation — accepts arbitrarily long strings
		it('accepts id exceeding 128 characters (no max length validation)', async () => {
			const longId = 'a'.repeat(129);
			const result = JSON.parse(
				await knowledge_ack.execute({ id: longId, result: 'applied' }, tmp, {}),
			);
			expect(result.recorded).toBe(true);
		});

		// VULNERABILITY: no sanitization of control characters in id
		it('accepts id with null byte injection', async () => {
			const maliciousId = 'abcdefgh\x00<script>alert(1)</script>';
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: maliciousId, result: 'applied' },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(true);
		});

		// VULNERABILITY: no sanitization of Unicode override characters in id
		it('accepts id with Unicode RTL override characters', async () => {
			const rtlId = 'abcdefgh\u202e';
			const result = JSON.parse(
				await knowledge_ack.execute({ id: rtlId, result: 'applied' }, tmp, {}),
			);
			expect(result.recorded).toBe(true);
		});

		// VULNERABILITY: reason has no max length validation (schema says 280 but not enforced in execute)
		it('accepts reason exceeding 280 characters', async () => {
			const longReason = 'a'.repeat(281);
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 'abcdefgh', result: 'applied', reason: longReason },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(true);
		});

		// VULNERABILITY: reason not sanitized for HTML/script content
		it('accepts reason with HTML/script injection', async () => {
			const maliciousReason =
				'<script>alert(document.cookie)</script><img src=x onerror=alert(1)>';
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 'abcdefgh', result: 'applied', reason: maliciousReason },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(true);
		});

		// VULNERABILITY: reason not sanitized for SQL fragment content
		it('accepts reason with SQL fragment injection', async () => {
			const sqlReason = "'; DROP TABLE knowledge;--";
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 'abcdefgh', result: 'applied', reason: sqlReason },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(true);
		});

		// VULNERABILITY: reason not sanitized for template literal injection
		it('accepts reason with template literal injection', async () => {
			const templateReason = '${process.exit(1)}';
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 'abcdefgh', result: 'applied', reason: templateReason },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(true);
		});

		// VULNERABILITY: __proto__ pollution not blocked by manual validation
		it('accepts args with __proto__ pollution', async () => {
			const protoPollution = {
				__proto__: { admin: true },
				id: 'abcdefgh',
				result: 'applied',
			};
			const result = JSON.parse(
				await knowledge_ack.execute(protoPollution as any, tmp, {}),
			);
			expect(result.recorded).toBe(true);
		});

		// VULNERABILITY: constructor.prototype pollution not blocked by manual validation
		it('accepts args with constructor.prototype pollution', async () => {
			const ctorPollution = {
				constructor: { prototype: { admin: true } },
				id: 'abcdefgh',
				result: 'applied',
			};
			const result = JSON.parse(
				await knowledge_ack.execute(ctorPollution as any, tmp, {}),
			);
			expect(result.recorded).toBe(true);
		});

		it('rejects undefined result', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 'abcdefgh', result: undefined } as any,
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid result');
		});

		it('rejects result with wrong type (number)', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 'abcdefgh', result: 123 as any },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid result');
		});

		it('handles concurrent dedup race: both calls recorded if first not yet persisted', async () => {
			// Simulate race: dedup check passes for both because neither has added yet
			// Both should succeed in recording (the dedup is per-session in-memory)
			const p1 = knowledge_ack.execute(
				{ id: 'race-id1', result: 'applied' },
				tmp,
				{ sessionID: 'race-session' },
			);
			const p2 = knowledge_ack.execute(
				{ id: 'race-id1', result: 'applied' },
				tmp,
				{ sessionID: 'race-session' },
			);
			const [r1, r2] = await Promise.all([p1, p2]);
			const result1 = JSON.parse(r1);
			const result2 = JSON.parse(r2);
			// Both may succeed if dedup hasn't propagated between calls
			expect(result1.recorded === true || result2.recorded === true).toBe(true);
		});

		// VULNERABILITY: no emoji sanitization in id
		it('accepts emoji in id', async () => {
			const emojiId = 'abcdefgh🔥';
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: emojiId, result: 'applied' },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(true);
		});

		it('rejects empty-object args when id is missing', async () => {
			const result = JSON.parse(await knowledge_ack.execute({}, tmp, {}));
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid id');
		});

		it('rejects boolean true as id', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: true, result: 'applied' } as any,
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid id');
		});

		it('rejects array as id', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: ['a', 'b'] as any, result: 'applied' },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid id');
		});

		it('rejects object as id', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: { foo: 'bar' } as any, result: 'applied' },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid id');
		});

		it('rejects very large numeric id', async () => {
			const result = JSON.parse(
				await knowledge_ack.execute(
					{ id: 1e20 as any, result: 'applied' },
					tmp,
					{},
				),
			);
			expect(result.recorded).toBe(false);
			expect(result.error).toBe('invalid id');
		});
	});
});
