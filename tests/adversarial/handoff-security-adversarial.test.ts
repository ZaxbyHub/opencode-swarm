/**
 * Security Tests for Handoff Enhancer - Adversarial Attack Vectors
 * Tests attack vectors: path traversal, race conditions, malformed content
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../src/config';
import {
	isGuidanceCarrier,
	messageTextOf,
} from '../../src/hooks/system-guidance-carrier';
import { validateSwarmPath } from '../../src/hooks/utils';
import { resetSwarmState, swarmState } from '../../src/state';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';
import { safeRmRecursive } from '../helpers/safe-test-dir';

describe('SECURITY: Handoff Enhancer Adversarial Tests', () => {
	let testDir: string;
	let swarmDir: string;
	let host: Awaited<ReturnType<typeof bootSwarmPluginHost>>;

	// Full config matching PluginConfig type
	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		context_budget: { scoring: { enabled: false } },
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: false,
			delegation_max_chars: 1000,
		},
	};

	beforeEach(async () => {
		// Create temp directory simulating a workspace
		testDir = createPluginHostProject('handoff-security-test');
		swarmDir = path.join(testDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		host = await bootSwarmPluginHost(testDir, defaultConfig);

		// Set active agent for non-DISCOVER mode
		resetSwarmState();
		swarmState.activeAgent.set('test-session', 'architect');
	});

	async function invokeRegisteredMessages(
		sessionID = 'test-session',
		config: PluginConfig = defaultConfig,
	) {
		host = await bootSwarmPluginHost(testDir, config);
		const messages = [
			{
				info: {
					id: `handoff-user-${sessionID}`,
					role: 'user' as const,
					sessionID,
					agent: 'architect',
				},
				parts: [{ type: 'text', text: 'Continue the current swarm task.' }],
			},
		];
		await host.hooks['experimental.chat.messages.transform']({}, { messages });
		return messages;
	}

	function deliveredText(messages: Array<{ info: unknown; parts: unknown[] }>) {
		return messages
			.filter((message) => isGuidanceCarrier(message))
			.map((message) => messageTextOf(message as never))
			.join('\n');
	}

	function countOccurrences(text: string, needle: string): number {
		return text.split(needle).length - 1;
	}

	afterEach(() => {
		// Clean up
		if (testDir && fs.existsSync(testDir)) {
			try {
				safeRmRecursive(testDir);
			} catch {
				// Best-effort cleanup; registered host workers can briefly hold handles.
			}
		}
		resetSwarmState();
	});

	describe('1. Path Traversal in Handoff Content', () => {
		it('should safely handle path traversal sequences in handoff.md content', async () => {
			// Create handoff.md with path traversal content (not filename - content)
			const maliciousContent = `## Important files
Please check ../etc/passwd for user list
Also review ../../root/.ssh/id_rsa
And C:\\Windows\\System32\\config\\sam for Windows

The path ../../../etc/shadow contains sensitive data.`;

			fs.writeFileSync(path.join(swarmDir, 'handoff.md'), maliciousContent);

			// Need a plan file to trigger non-DISCOVER mode
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test',
					swarm: 'test',
					current_phase: 1,
					phases: [
						{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
					],
				}),
			);

			const messages = await invokeRegisteredMessages();

			// The content should be injected but NOT cause any file system access
			// The path traversal is just text content - the security boundary is
			// at the filename level via validateSwarmPath
			const injectedContent = deliveredText(messages);
			expect(injectedContent).toContain('../etc/passwd');
			expect(injectedContent).toContain('C:\\Windows');
		});

		it('should reject path traversal in handoff FILENAME (not content)', () => {
			// This tests the validateSwarmPath function directly
			// which is the first line of defense
			expect(() => {
				validateSwarmPath(testDir, '../etc/passwd');
			}).toThrow();

			expect(() => {
				validateSwarmPath(testDir, 'handoff.md/../../../etc/passwd');
			}).toThrow();

			expect(() => {
				validateSwarmPath(testDir, '..\\windows\\system32\\config\\sam');
			}).toThrow();
		});
	});

	describe('2. Symlink Attacks', () => {
		it('should handle symlink to absolute path', async () => {
			// Create a real file in a temp location
			const targetDir = fs.mkdtempSync(path.join(tmpdir(), 'symlink-target-'));
			const targetFile = path.join(targetDir, 'secret.txt');
			fs.writeFileSync(targetFile, 'Sensitive data from symlink target');

			try {
				// Need a plan file to trigger non-DISCOVER mode
				fs.writeFileSync(
					path.join(swarmDir, 'plan.json'),
					JSON.stringify({
						schema_version: '1.0.0',
						title: 'Test',
						swarm: 'test',
						current_phase: 1,
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				// Create symlink in .swarm directory pointing to external file
				const symlinkPath = path.join(swarmDir, 'handoff.md');

				if (process.platform === 'win32') {
					// Windows requires admin privileges for symlinks usually
					// Skip this specific test on Windows - copy file instead
					fs.copyFileSync(targetFile, symlinkPath);
				} else {
					fs.symlinkSync(targetFile, symlinkPath);
				}

				// Attempt to read handoff.md through the registered message boundary.
				const messages = await invokeRegisteredMessages();
				const injectedContent = deliveredText(messages);

				if (process.platform === 'win32') {
					// Windows branch copied the file INTO .swarm (a real, in-directory
					// handoff, not a symlink), which is legitimate and is injected as
					// normal handoff content.
					expect(injectedContent).toContain('Sensitive data');
				} else {
					// SECURITY: on POSIX, handoff.md is a symlink whose target lives
					// OUTSIDE .swarm. validateSwarmPath (invoked by readSwarmFileAsync)
					// resolves the real path and rejects it because it escapes the
					// .swarm directory, so the symlink is NOT followed and its target
					// content is never injected. The symlink-escape attack is blocked.
					expect(injectedContent).not.toContain('Sensitive data');
				}
			} finally {
				// Cleanup
				fs.rmSync(targetDir, { recursive: true, force: true });
			}
		});
	});

	describe('3. Race Condition: TOCTOU between read and rename', () => {
		it('should handle handoff.md deleted between read and rename', async () => {
			// Create initial handoff.md and plan
			fs.writeFileSync(
				path.join(swarmDir, 'handoff.md'),
				'Initial handoff content',
			);
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test',
					swarm: 'test',
					current_phase: 1,
					phases: [
						{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
					],
				}),
			);

			// First call should succeed
			const messages1 = await invokeRegisteredMessages();

			// Content should be injected from first call
			expect(deliveredText(messages1)).toContain('Initial handoff content');

			// Second call - file was renamed to handoff-consumed.md
			const messages2 = await invokeRegisteredMessages();

			// Second call should not find handoff.md (ENOENT is expected)
			const injectedContent = deliveredText(messages2);
			expect(injectedContent).not.toContain('Initial handoff content');
		});

		it('should handle concurrent access - both processes try to rename', async () => {
			// Create handoff.md and plan
			fs.writeFileSync(
				path.join(swarmDir, 'handoff.md'),
				'Concurrent-HANDOFF-PAYLOAD',
			);
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test',
					swarm: 'test',
					current_phase: 1,
					phases: [
						{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
					],
				}),
			);

			// Run two concurrent transformations
			const results = await Promise.allSettled([
				(async () => {
					const messages = await invokeRegisteredMessages('concurrent-1');
					return deliveredText(messages);
				})(),
				(async () => {
					// Small delay to create race condition
					await new Promise((r) => setTimeout(r, 10));
					const messages = await invokeRegisteredMessages('concurrent-2');
					return deliveredText(messages);
				})(),
			]);

			// Both registered transforms fail open when the other wins the rename;
			// exactly one host-visible carrier may contain the payload.
			expect(results.every((result) => result.status === 'fulfilled')).toBe(
				true,
			);
			const contents = results.map((r) =>
				r.status === 'fulfilled' ? r.value : '',
			);
			const payloadCount = contents.reduce(
				(total, content) =>
					total + countOccurrences(content, 'Concurrent-HANDOFF-PAYLOAD'),
				0,
			);
			expect(payloadCount).toBe(1);
		});
	});

	describe('4. Very Large Handoff Content (DoS)', () => {
		it('should handle extremely large handoff.md (10MB+)', async () => {
			// Create a 10MB+ handoff file
			const largeContent =
				'# Large Handoff OVERSIZED-HANDOFF-PAYLOAD\n' +
				'x'.repeat(11 * 1024 * 1024);

			fs.writeFileSync(path.join(swarmDir, 'handoff.md'), largeContent);
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test',
					swarm: 'test',
					current_phase: 1,
					phases: [
						{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
					],
				}),
			);

			const messages = await invokeRegisteredMessages();

			// Large content is rejected by the token budget guard in tryInject().
			// estimateTokens() estimates ~3.8M tokens for 11MB; the default budget
			// is 4000 tokens, so the handoff block is dropped entirely.
			// Only the phase header (~953 bytes) is injected.
			const injectedContent = deliveredText(messages);
			expect(injectedContent.length).toBeLessThan(4096);
			expect(injectedContent).not.toContain('OVERSIZED-HANDOFF-PAYLOAD');
			expect(injectedContent).toContain('[SWARM CONTEXT] Phase:');

			// This documents that the DoS vulnerability is mitigated: content is
			// budget-gated via token estimation in tryInject() (system-enhancer.ts).
		}, 30000); // Increase timeout for large file handling

		it('should handle moderately large content with context budget', async () => {
			// Create 1MB content
			const moderateContent = '# Handoff\n' + 'y'.repeat(1 * 1024 * 1024);

			fs.writeFileSync(path.join(swarmDir, 'handoff.md'), moderateContent);
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test',
					swarm: 'test',
					current_phase: 1,
					phases: [
						{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
					],
				}),
			);

			// Config with strict token budget - use type assertion to bypass strict schema
			const configWithBudget = {
				...defaultConfig,
				context_budget: {
					max_injection_tokens: 1000, // Very low budget
					scoring: { enabled: false },
				},
			} as PluginConfig;

			const messages = await invokeRegisteredMessages(
				'test-session',
				configWithBudget,
			);

			// With low budget, large content is read but budget limits injection
			// Content is read from file but then filtered by budget
			const injectedContent = deliveredText(messages);
			// The content is still read from file - but budget check limits injection
			// With budget=1000 tokens (~3000 chars), large content gets truncated
			expect(injectedContent.length).toBeGreaterThan(0);
		});
	});

	describe('5. Null Bytes in Handoff Content', () => {
		it('should strip null bytes from handoff.md content (M10 sanitization)', async () => {
			// Create content with null bytes
			const contentWithNulls = 'Before null\x00After null\x00End';

			fs.writeFileSync(path.join(swarmDir, 'handoff.md'), contentWithNulls);
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test',
					swarm: 'test',
					current_phase: 1,
					phases: [
						{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
					],
				}),
			);

			const messages = await invokeRegisteredMessages();

			// sanitizeContextText (issue #1779 M10) now wraps every raw
			// learned-content injection site, including the handoff body. It
			// filters control characters other than tab/LF/CR (charCode > 31),
			// which strips null bytes (charCode 0) — this used to be a
			// documented vulnerability (null bytes injected as-is into the
			// system message); it is now closed. The surrounding readable text
			// still reaches the injected context.
			const injectedContent = deliveredText(messages);
			expect(injectedContent).not.toContain('\x00');
			expect(injectedContent).toContain('Before null');
			expect(injectedContent).toContain('After null');
		});

		it('should reject null bytes in FILENAME (via validateSwarmPath)', () => {
			// validateSwarmPath DOES reject null bytes in filename
			expect(() => {
				validateSwarmPath(testDir, 'handoff\x00.md');
			}).toThrow();

			expect(() => {
				validateSwarmPath(testDir, 'hand\x00off.md');
			}).toThrow();
		});
	});

	describe('6. Concurrent Handoff Processing', () => {
		it('should handle rapid sequential handoff processing', async () => {
			// Create handoff.md and plan
			fs.writeFileSync(
				path.join(swarmDir, 'handoff.md'),
				'Sequential test content',
			);
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test',
					swarm: 'test',
					current_phase: 1,
					phases: [
						{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
					],
				}),
			);

			const deliveries: string[] = [];
			// Run 5 sequential transformations
			for (let i = 0; i < 5; i++) {
				const messages = await invokeRegisteredMessages(`sequential-${i}`);
				deliveries.push(deliveredText(messages));

				// First call gets content, subsequent calls don't (file renamed)
				if (i === 0) {
					expect(deliveries[i]).toContain('Sequential test content');
				}
			}
			expect(
				deliveries.map((content) =>
					countOccurrences(content, 'Sequential test content'),
				),
			).toEqual([1, 0, 0, 0, 0]);
		});

		it('should handle duplicate handoff-consumed.md gracefully', async () => {
			// Pre-create handoff-consumed.md (edge case)
			fs.writeFileSync(
				path.join(swarmDir, 'handoff-consumed.md'),
				'Old consumed content',
			);

			// Create handoff.md and plan
			fs.writeFileSync(
				path.join(swarmDir, 'handoff.md'),
				'New handoff content',
			);
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test',
					swarm: 'test',
					current_phase: 1,
					phases: [
						{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
					],
				}),
			);

			const messages = await invokeRegisteredMessages();

			// Code should handle duplicate by deleting old consumed file
			// and renaming new one
			const injectedContent = deliveredText(messages);
			expect(injectedContent).toContain('New handoff content');

			// Verify old consumed was removed and new one exists
			expect(fs.existsSync(path.join(swarmDir, 'handoff-consumed.md'))).toBe(
				true,
			);
			const consumedContent = fs.readFileSync(
				path.join(swarmDir, 'handoff-consumed.md'),
				'utf-8',
			);
			expect(consumedContent).toBe('New handoff content');
		});
	});
});
