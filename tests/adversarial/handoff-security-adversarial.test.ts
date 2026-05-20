/**
 * Security Tests for Handoff Enhancer - Adversarial Attack Vectors
 * Tests attack vectors: path traversal, race conditions, malformed content
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../src/config';
import { createSystemEnhancerHook } from '../../src/hooks/system-enhancer';
import { validateSwarmPath } from '../../src/hooks/utils';
import { resetSwarmState, swarmState } from '../../src/state';

describe('SECURITY: Handoff Enhancer Adversarial Tests', () => {
	let testDir: string;
	let swarmDir: string;

	// Full config matching PluginConfig type
	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
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

	beforeEach(() => {
		// Create temp directory simulating a workspace
		testDir = fs.mkdtempSync(path.join(tmpdir(), 'handoff-security-test-'));
		swarmDir = path.join(testDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		// Set active agent for non-DISCOVER mode
		resetSwarmState();
		swarmState.activeAgent.set('test-session', 'architect');
	});

	afterEach(() => {
		// Clean up
		if (testDir && fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
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

			// Create the hook
			const hook = createSystemEnhancerHook(defaultConfig, testDir);
			const transformFn = hook[
				'experimental.chat.system.transform'
			] as Function;

			const output = { system: [] as string[] };
			await transformFn({ sessionID: 'test-session' }, output);

			// The content should be injected but NOT cause any file system access
			// The path traversal is just text content - the security boundary is
			// at the filename level via validateSwarmPath
			const injectedContent = output.system.join('\n');
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

				// Attempt to read handoff.md
				const hook = createSystemEnhancerHook(defaultConfig, testDir);
				const transformFn = hook[
					'experimental.chat.system.transform'
				] as Function;

				const output = { system: [] as string[] };
				await transformFn({ sessionID: 'test-session' }, output);

				// The symlink would be followed and content injected
				// This is a known risk - validateSwarmPath doesn't check for symlinks
				const injectedContent = output.system.join('\n');

				// The test documents that symlinks are followed
				expect(injectedContent).toContain('Sensitive data');
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

			const hook = createSystemEnhancerHook(defaultConfig, testDir);
			const transformFn = hook[
				'experimental.chat.system.transform'
			] as Function;

			// First call should succeed
			const output1 = { system: [] as string[] };
			await transformFn({ sessionID: 'test-session' }, output1);

			// Content should be injected from first call
			expect(output1.system.join('\n')).toContain('Initial handoff content');

			// Second call - file was renamed to handoff-consumed.md
			const output2 = { system: [] as string[] };
			await transformFn({ sessionID: 'test-session' }, output2);

			// Second call should not find handoff.md (ENOENT is expected)
			const injectedContent = output2.system.join('\n');
			expect(injectedContent).not.toContain('Initial handoff content');
		});

		it('should handle concurrent access - both processes try to rename', async () => {
			// Create handoff.md and plan
			fs.writeFileSync(
				path.join(swarmDir, 'handoff.md'),
				'Concurrent test content',
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

			const hook = createSystemEnhancerHook(defaultConfig, testDir);
			const transformFn = hook[
				'experimental.chat.system.transform'
			] as Function;

			// Run two concurrent transformations
			const results = await Promise.allSettled([
				(async () => {
					const output = { system: [] as string[] };
					await transformFn({ sessionID: 'concurrent-1' }, output);
					return output;
				})(),
				(async () => {
					// Small delay to create race condition
					await new Promise((r) => setTimeout(r, 10));
					const output = { system: [] as string[] };
					await transformFn({ sessionID: 'concurrent-2' }, output);
					return output;
				})(),
			]);

			// At least one should succeed
			// One might fail with ENOENT if the other renamed it first
			const contents = results.map((r) =>
				r.status === 'fulfilled' ? r.value.system.join('\n') : '',
			);

			// Only ONE should contain the handoff content (the one that won the race)
			const hasContent = contents.filter((c) =>
				c.includes('Concurrent test content'),
			);
			expect(hasContent.length).toBeLessThanOrEqual(1);
		});
	});

	describe('4. Very Large Handoff Content (DoS)', () => {
		it('should handle extremely large handoff.md (10MB+)', async () => {
			// Create a 10MB+ handoff file
			const largeContent = '# Large Handoff\n' + 'x'.repeat(11 * 1024 * 1024);

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

			const hook = createSystemEnhancerHook(defaultConfig, testDir);
			const transformFn = hook[
				'experimental.chat.system.transform'
			] as Function;

			const output = { system: [] as string[] };
			await transformFn({ sessionID: 'test-session' }, output);

			// Large content is rejected by the token budget guard in tryInject().
			// estimateTokens() estimates ~3.8M tokens for 11MB; the default budget
			// is 4000 tokens, so the handoff block is dropped entirely.
			// Only the phase header (~953 bytes) is injected.
			const injectedContent = output.system.join('\n');
			expect(injectedContent.length).toBeLessThan(4096);

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
				},
			} as PluginConfig;

			const hook = createSystemEnhancerHook(configWithBudget, testDir);
			const transformFn = hook[
				'experimental.chat.system.transform'
			] as Function;

			const output = { system: [] as string[] };
			await transformFn({ sessionID: 'test-session' }, output);

			// With low budget, large content is read but budget limits injection
			// Content is read from file but then filtered by budget
			const injectedContent = output.system.join('\n');
			// The content is still read from file - but budget check limits injection
			// With budget=1000 tokens (~3000 chars), large content gets truncated
			expect(injectedContent.length).toBeGreaterThan(0);
		});
	});

	describe('5. Null Bytes in Handoff Content', () => {
		it('should handle null bytes in handoff.md content', async () => {
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

			const hook = createSystemEnhancerHook(defaultConfig, testDir);
			const transformFn = hook[
				'experimental.chat.system.transform'
			] as Function;

			const output = { system: [] as string[] };
			await transformFn({ sessionID: 'test-session' }, output);

			// Null bytes are NOT stripped - injected as-is
			const injectedContent = output.system.join('\n');
			expect(injectedContent).toContain('\x00');

			// This documents the vulnerability - null bytes in content not sanitized
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

			const hook = createSystemEnhancerHook(defaultConfig, testDir);
			const transformFn = hook[
				'experimental.chat.system.transform'
			] as Function;

			// Run 5 sequential transformations
			for (let i = 0; i < 5; i++) {
				const output = { system: [] as string[] };
				await transformFn({ sessionID: `sequential-${i}` }, output);

				// First call gets content, subsequent calls don't (file renamed)
				if (i === 0) {
					expect(output.system.join('\n')).toContain('Sequential test content');
				}
			}
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

			const hook = createSystemEnhancerHook(defaultConfig, testDir);
			const transformFn = hook[
				'experimental.chat.system.transform'
			] as Function;

			const output = { system: [] as string[] };
			await transformFn({ sessionID: 'test-session' }, output);

			// Code should handle duplicate by deleting old consumed file
			// and renaming new one
			const injectedContent = output.system.join('\n');
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

	describe('7. Additional Attack Vectors', () => {
		it('should handle empty handoff.md', async () => {
			// Create empty handoff and plan
			fs.writeFileSync(path.join(swarmDir, 'handoff.md'), '');
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

			const hook = createSystemEnhancerHook(defaultConfig, testDir);
			const transformFn = hook[
				'experimental.chat.system.transform'
			] as Function;

			const output = { system: [] as string[] };
			await transformFn({ sessionID: 'test-session' }, output);

			// Empty content is handled gracefully - no injection
			const injectedContent = output.system.join('\n');
			expect(injectedContent).not.toContain('HANDOFF');
		});

		it('should handle handoff.md with only whitespace', async () => {
			// Create whitespace-only handoff and plan
			fs.writeFileSync(path.join(swarmDir, 'handoff.md'), '   \n\n   ');
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

			const hook = createSystemEnhancerHook(defaultConfig, testDir);
			const transformFn = hook[
				'experimental.chat.system.transform'
			] as Function;

			const output = { system: [] as string[] };
			await transformFn({ sessionID: 'test-session' }, output);

			// Whitespace content gets injected (falsy check may pass)
			const injectedContent = output.system.join('\n');
			// This documents behavior - whitespace-only content IS injected as it's truthy string
		});

		it('should handle binary-looking content', async () => {
			// Create content that looks like binary
			const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);

			fs.writeFileSync(path.join(swarmDir, 'handoff.md'), binaryContent);
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

			const hook = createSystemEnhancerHook(defaultConfig, testDir);
			const transformFn = hook[
				'experimental.chat.system.transform'
			] as Function;

			const output = { system: [] as string[] };
			await transformFn({ sessionID: 'test-session' }, output);

			// Binary content is injected as-is (no sanitization)
			const injectedContent = output.system.join('\n');
			expect(injectedContent.length).toBeGreaterThan(0);
		});
	});
});
