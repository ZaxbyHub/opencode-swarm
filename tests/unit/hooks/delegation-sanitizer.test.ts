/**
 * Tests for delegation-sanitizer.ts - Verifying Task 4d.1 fixes
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
	createDelegationSanitizerHook,
	isGateAgentMessage,
	SANITIZATION_PATTERNS,
	sanitizeMessage,
} from '../../../src/hooks/delegation-sanitizer';

describe('delegation-sanitizer - Task 4d.1 fixes verification', () => {
	let testDir: string;
	let eventsPath: string;

	beforeEach(async () => {
		testDir = await mkdtemp(path.join(tmpdir(), 'delegation-test-'));
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
		eventsPath = path.join(testDir, '.swarm', 'events.jsonl');
	});

	afterEach(async () => {
		if (testDir) {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	describe('Requirement 1: sanitizeMessage accepts patterns parameter', () => {
		it('should accept patterns parameter with default value', () => {
			const testText = 'This is the 5th attempt';
			const result = sanitizeMessage(testText);
			expect(result.sanitized).toBe('This is the');
			expect(result.modified).toBe(true);
			expect(result.stripped).toContain('5th attempt');
		});

		it('should accept custom patterns parameter', () => {
			const testText = 'Hello world foo bar';
			const customPatterns = [/foo/g, /bar/g];
			const result = sanitizeMessage(testText, customPatterns);
			expect(result.sanitized).toBe('Hello world');
			expect(result.stripped).toContain('foo');
			expect(result.stripped).toContain('bar');
		});

		it('should work with empty patterns array', () => {
			const testText = 'This is the 5th attempt';
			const result = sanitizeMessage(testText, []);
			expect(result.sanitized).toBe(testText);
			expect(result.modified).toBe(false);
			expect(result.stripped).toEqual([]);
		});
	});

	describe('Requirement 2: isGateAgentMessage exported', () => {
		it('should be exported as a function', () => {
			expect(typeof isGateAgentMessage).toBe('function');
		});

		it('should identify reviewer as gate agent', () => {
			expect(isGateAgentMessage('reviewer')).toBe(true);
			expect(isGateAgentMessage('Reviewer')).toBe(true);
			expect(isGateAgentMessage('REVIEWER')).toBe(true);
		});

		it('should identify test_engineer as gate agent', () => {
			expect(isGateAgentMessage('test_engineer')).toBe(true);
			expect(isGateAgentMessage('Test_Engineer')).toBe(true);
			expect(isGateAgentMessage('test-engineer')).toBe(true);
		});

		it('should identify critic as gate agent', () => {
			expect(isGateAgentMessage('critic')).toBe(true);
			expect(isGateAgentMessage('Critic')).toBe(true);
		});

		it('should reject non-gate agents', () => {
			expect(isGateAgentMessage('coder')).toBe(false);
			expect(isGateAgentMessage('architect')).toBe(false);
			expect(isGateAgentMessage('designer')).toBe(false);
			expect(isGateAgentMessage('user')).toBe(false);
		});
	});

	describe('Requirement 3: Hook implementation sanitizes messages', () => {
		it('should check for gate agents (reviewer, test_engineer, critic)', async () => {
			const hook = createDelegationSanitizerHook(testDir);

			const output = {
				messages: [
					{
						info: { role: 'assistant', agent: 'reviewer' },
						parts: [{ type: 'text', text: 'This is the 5th attempt' }],
					},
					{
						info: { role: 'assistant', agent: 'test_engineer' },
						parts: [{ type: 'text', text: 'we are behind schedule' }],
					},
					{
						info: { role: 'assistant', agent: 'critic' },
						parts: [{ type: 'text', text: 'or I will stop everything' }],
					},
				],
			};

			await hook({}, output);

			// All three messages should be sanitized
			expect(output.messages[0].parts[0].text).toBe('This is the');
			expect(output.messages[1].parts[0].text).toBe('schedule');
			expect(output.messages[2].parts[0].text).toBe('everything');
		});

		it('should not sanitize messages to non-gate agents', async () => {
			const hook = createDelegationSanitizerHook(testDir);

			const originalText = 'This is the 5th attempt and we are late';
			const output = {
				messages: [
					{
						info: { role: 'assistant', agent: 'coder' },
						parts: [{ type: 'text', text: originalText }],
					},
				],
			};

			await hook({}, output);

			// Message should not be modified
			expect(output.messages[0].parts[0].text).toBe(originalText);
		});

		it('should call sanitizeMessage on gate agent messages', async () => {
			const hook = createDelegationSanitizerHook(testDir);

			const output = {
				messages: [
					{
						info: { role: 'assistant', agent: 'reviewer' },
						parts: [{ type: 'text', text: 'Attempt 5/10 or all work stops' }],
					},
				],
			};

			await hook({}, output);

			// Verify sanitization occurred - both patterns should be stripped
			const sanitized = output.messages[0].parts[0].text;
			expect(sanitized).toBe('');
		});

		it('should handle messages without info gracefully', async () => {
			const hook = createDelegationSanitizerHook(testDir);

			const output = {
				messages: [{ parts: [{ type: 'text', text: 'test' }] }],
			};

			await hook({}, output);

			// Should not crash
			expect(output.messages[0].parts[0].text).toBe('test');
		});

		it('should handle messages without agent gracefully', async () => {
			const hook = createDelegationSanitizerHook(testDir);

			const output = {
				messages: [
					{
						info: { role: 'assistant' },
						parts: [{ type: 'text', text: 'test' }],
					},
				],
			};

			await hook({}, output);

			// Should not crash
			expect(output.messages[0].parts[0].text).toBe('test');
		});
	});

	describe('Requirement 4: Event logging to events.jsonl', () => {
		it('should log sanitization events to events.jsonl', async () => {
			const hook = createDelegationSanitizerHook(testDir);

			const output = {
				messages: [
					{
						info: { role: 'assistant', agent: 'reviewer' },
						parts: [{ type: 'text', text: 'This is the 5th attempt' }],
					},
				],
			};

			await hook({}, output);

			// Verify events.jsonl was created
			expect(fs.existsSync(eventsPath)).toBe(true);

			// Read and parse events (#2039: skip the manifest header line —
			// only EVENT lines count).
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const lines = eventsContent
				.trim()
				.split('\n')
				.filter((line) => {
					try {
						return (
							(JSON.parse(line) as { type?: unknown }).type !==
							'swarm-events-manifest'
						);
					} catch {
						return true;
					}
				});
			expect(lines.length).toBe(1);

			const event = JSON.parse(lines[0]);
			expect(event.event).toBe('message_sanitized');
			expect(event.agent).toBe('reviewer');
			expect(event.original_length).toBeGreaterThan(0);
			expect(event.stripped_count).toBeGreaterThan(0);
			expect(Array.isArray(event.stripped_patterns)).toBe(true);
			expect(event.timestamp).toBeDefined();
		});

		it('should log multiple sanitization events', async () => {
			const hook = createDelegationSanitizerHook(testDir);

			const output = {
				messages: [
					{
						info: { role: 'assistant', agent: 'reviewer' },
						parts: [{ type: 'text', text: 'This is the 5th attempt' }],
					},
					{
						info: { role: 'assistant', agent: 'test_engineer' },
						parts: [{ type: 'text', text: 'we are behind schedule' }],
					},
				],
			};

			await hook({}, output);

			// Verify events.jsonl has 2 events (#2039: skip the manifest
			// header line — only EVENT lines count).
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const lines = eventsContent
				.trim()
				.split('\n')
				.filter((line) => {
					try {
						return (
							(JSON.parse(line) as { type?: unknown }).type !==
							'swarm-events-manifest'
						);
					} catch {
						return true;
					}
				});
			expect(lines.length).toBe(2);
		});

		it('should not log events when no sanitization occurs', async () => {
			const hook = createDelegationSanitizerHook(testDir);

			const output = {
				messages: [
					{
						info: { role: 'assistant', agent: 'reviewer' },
						parts: [{ type: 'text', text: 'This is a normal message' }],
					},
				],
			};

			await hook({}, output);

			// events.jsonl should not be created
			expect(fs.existsSync(eventsPath)).toBe(false);
		});

		it('should append to existing events.jsonl', async () => {
			// Create existing events.jsonl
			await writeFile(
				eventsPath,
				JSON.stringify({ event: 'existing_event' }) + '\n',
				'utf-8',
			);

			const hook = createDelegationSanitizerHook(testDir);

			const output = {
				messages: [
					{
						info: { role: 'assistant', agent: 'reviewer' },
						parts: [{ type: 'text', text: 'This is the 5th attempt' }],
					},
				],
			};

			await hook({}, output);

			// Verify both events exist
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const lines = eventsContent.trim().split('\n');
			expect(lines.length).toBe(2);

			const event1 = JSON.parse(lines[0]);
			const event2 = JSON.parse(lines[1]);

			expect(event1.event).toBe('existing_event');
			expect(event2.event).toBe('message_sanitized');
		});
	});

	describe('Requirement 5: No overly broad patterns', () => {
		it('should not strip "please help" text', () => {
			const testText = 'please help me with this task';
			const result = sanitizeMessage(testText);

			expect(result.sanitized).toBe(testText);
			expect(result.modified).toBe(false);
			expect(result.stripped).toEqual([]);
		});

		it('should not strip common polite phrases', () => {
			const politePhrases = [
				'please review my code',
				'can you help me',
				'thank you for your help',
				'I would appreciate assistance',
				'could you please check',
				'please let me know',
			];

			for (const phrase of politePhrases) {
				const result = sanitizeMessage(phrase);
				expect(result.modified).toBe(false);
			}
		});

		it('should only match specific manipulation patterns', () => {
			const legitimateText = 'The 5th chapter is interesting';
			const result = sanitizeMessage(legitimateText);

			// Should not strip "5th" when not followed by "attempt"
			expect(result.sanitized).toBe(legitimateText);
			expect(result.modified).toBe(false);
		});

		it('should use word boundaries correctly', () => {
			const testText = 'attempting to fix the issue';
			const result = sanitizeMessage(testText);

			// Should not strip "attempting" (different word)
			expect(result.sanitized).toBe(testText);
			expect(result.modified).toBe(false);
		});

		it('should handle case-insensitive matching correctly', () => {
			const testText = 'THIS IS THE 5TH ATTEMPT';
			const result = sanitizeMessage(testText);

			expect(result.sanitized).toBe('THIS IS THE');
			expect(result.modified).toBe(true);
		});
	});

	describe('Hook integration tests', () => {
		it('should handle complex message structures', async () => {
			const hook = createDelegationSanitizerHook(testDir);

			const output = {
				messages: [
					{
						info: {
							role: 'assistant',
							agent: 'reviewer',
							sessionID: 'session123',
						},
						parts: [
							{ type: 'text', text: 'This is the 5th attempt' },
							{ type: 'image', url: 'http://example.com/image.png' },
							{ type: 'text', text: 'or all work stops' },
						],
					},
				],
			};

			await hook({}, output);

			// Both text parts should be sanitized, image unchanged
			expect(output.messages[0].parts[0].text).toBe('This is the');
			expect(output.messages[0].parts[1].url).toBe(
				'http://example.com/image.png',
			);
			expect(output.messages[0].parts[2].text).toBe('');
		});

		it('should handle empty messages array', async () => {
			const hook = createDelegationSanitizerHook(testDir);
			const output = { messages: [] };

			await hook({}, output);

			expect(output.messages).toEqual([]);
		});

		it('should handle messages without parts array', async () => {
			const hook = createDelegationSanitizerHook(testDir);

			const output = {
				messages: [{ info: { role: 'assistant', agent: 'reviewer' } }],
			};

			await hook({}, output);

			// Should not crash
			expect(output.messages[0].info.agent).toBe('reviewer');
		});
	});
});
