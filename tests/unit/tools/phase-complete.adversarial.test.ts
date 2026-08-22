import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

// Import the tool after setting up environment
const { phase_complete } = await import('../../../src/tools/phase-complete');

setDefaultTimeout(30_000);

/**
 * Helper to write a valid retro bundle so phase_complete gate passes in tests.
 */
function writeRetroBundle(directory: string, phaseNumber: number): void {
	const retroDir = path.join(
		directory,
		'.swarm',
		'evidence',
		`retro-${phaseNumber}`,
	);
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify(
			{
				schema_version: '1.0.0',
				task_id: `retro-${phaseNumber}`,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				entries: [
					{
						task_id: `retro-${phaseNumber}`,
						type: 'retrospective',
						timestamp: new Date().toISOString(),
						agent: 'architect',
						verdict: 'pass',
						summary: 'Phase retrospective',
						phase_number: phaseNumber,
						total_tool_calls: 10,
						coder_revisions: 0,
						reviewer_rejections: 0,
						test_failures: 0,
						security_findings: 0,
						integration_issues: 0,
						task_count: 1,
						task_complexity: 'simple',
						top_rejection_reasons: [],
						lessons_learned: ['test lesson'],
					},
				],
			},
			null,
			2,
		),
	);
}

/**
 * Helper function to write gate evidence files for Phase 4 mandatory gates
 */
function writeGateEvidence(directory: string, phase: number): void {
	const evidenceDir = path.join(directory, '.swarm', 'evidence', `${phase}`);
	fs.mkdirSync(evidenceDir, { recursive: true });

	// Write completion-verify.json
	const completionVerify = {
		status: 'passed',
		tasksChecked: 1,
		tasksPassed: 1,
		tasksBlocked: 0,
		reason: 'All task identifiers found in source files',
	};
	fs.writeFileSync(
		path.join(evidenceDir, 'completion-verify.json'),
		JSON.stringify(completionVerify, null, 2),
	);

	// Write drift-verifier.json
	const driftVerifier = {
		schema_version: '1.0.0',
		task_id: 'drift-verifier',
		entries: [
			{
				task_id: 'drift-verifier',
				type: 'drift_verification',
				timestamp: new Date().toISOString(),
				agent: 'critic',
				verdict: 'approved',
				summary: 'Drift check passed',
			},
		],
	};
	fs.writeFileSync(
		path.join(evidenceDir, 'drift-verifier.json'),
		JSON.stringify(driftVerifier, null, 2),
	);
}

describe('phase_complete tool - ADVERSARIAL SECURITY TESTS', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		// Reset state before each test
		resetSwarmState();

		// Create temp directory
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-adversarial-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory and permissive config for tests
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
		writeRetroBundle(tempDir, 1);
		writeGateEvidence(tempDir, 1);
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			}),
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		// Reset state after each test
		resetSwarmState();
	});

	describe('Path traversal and injection attempts', () => {
		test('handles path traversal in sessionID - ../../etc/passwd', async () => {
			// Path traversal shouldn't affect Map lookups, but should not crash
			ensureAgentSession('../../etc/passwd');
			recordPhaseAgentDispatch('../../etc/passwd', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: '../../etc/passwd',
			});
			const parsed = JSON.parse(result);

			// Should not crash - just use the literal string as sessionID
			expect(parsed.success).toBe(true);
			expect(parsed.sessionID).toBeUndefined(); // sessionID not returned in result
		});

		test('handles XSS-like injection in sessionID - <script>alert(1)</script>', async () => {
			ensureAgentSession('<script>alert(1)</script>');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: '<script>alert(1)</script>',
			});
			const parsed = JSON.parse(result);

			// Should not crash - XSS is not applicable server-side
			expect(parsed.success).toBe(true);
		});

		test('handles SQL injection pattern in sessionID', async () => {
			ensureAgentSession("'; DROP TABLE sessions; --");

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: "'; DROP TABLE sessions; --",
			});
			const parsed = JSON.parse(result);

			// Should not crash - SQL injection not applicable with Map lookups
			expect(parsed.success).toBe(true);
		});

		test('handles command injection pattern in summary', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
				summary: 'Test; rm -rf / #; && cat /etc/passwd',
			});
			const parsed = JSON.parse(result);

			// Should not execute commands
			expect(parsed.success).toBe(true);
			expect(parsed.message).toContain(
				'Test; rm -rf / #; && cat /etc/passwd'.slice(0, 500),
			);
		});
	});

	describe('Oversized payloads and boundary violations', () => {
		test('handles 100KB summary string - should truncate to 500 chars', async () => {
			ensureAgentSession('sess1');

			// Create a 100KB summary
			const hugeSummary = 'X'.repeat(100 * 1024);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
				summary: hugeSummary,
			});
			const parsed = JSON.parse(result);

			// Should not crash and should truncate
			expect(parsed.success).toBe(true);
			expect(parsed.message.length).toBeLessThanOrEqual(
				500 + 'Phase 1 completed: '.length,
			);
		});

		test('handles very long sessionID (10KB)', async () => {
			const longSessionID = 'A'.repeat(10 * 1024);
			ensureAgentSession(longSessionID);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: longSessionID,
			});
			const parsed = JSON.parse(result);

			// Should not crash
			expect(parsed.success).toBe(true);
		});

		test('handles empty string sessionID after ensuring session', async () => {
			ensureAgentSession('');

			const result = await phase_complete.execute({ phase: 1, sessionID: '' });
			const parsed = JSON.parse(result);

			// Empty string is falsy, so it should be rejected (SECURE: prevents empty session IDs)
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Session ID is required');
		});
	});

	describe('Phase number edge cases', () => {
		test('handles phase number as float (1.7)', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1.7,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// No retro bundle exists for phase 1.7 — fails gracefully (RETROSPECTIVE_MISSING)
			expect(parsed.success).toBe(false);
		});

		test('handles phase number as very large integer (MAX_SAFE_INTEGER)', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: Number.MAX_SAFE_INTEGER,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should fail gracefully — no retro bundle exists for this phase, but no crash
			expect(parsed.success).toBe(false);
			expect(parsed.reason ?? parsed.status).toBeTruthy(); // graceful failure with reason
		});

		test('handles phase number as zero after coercing to number', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 0,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should reject 0
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('handles phase number as string "1" - coerced to number', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: '1' as any,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should coerce '1' to 1
			expect(parsed.success).toBe(true);
			expect(parsed.phase).toBe(1);
		});

		test('handles phase number as string "1.5"', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: '1.5' as any,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Coerces '1.5' to 1.5 — no retro bundle exists for 1.5, fails gracefully
			expect(parsed.success).toBe(false);
			expect(parsed.reason ?? parsed.status).toBeTruthy();
		});

		test('handles phase number as negative float', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: -1.5,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should reject negative
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('handles phase number as string "NaN"', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 'NaN' as any,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should reject NaN
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});
	});

	describe('Special characters and encoding', () => {
		test('handles sessionID as explicit "null" string', async () => {
			ensureAgentSession('null');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'null',
			});
			const parsed = JSON.parse(result);

			// "null" is truthy string, should work
			expect(parsed.success).toBe(true);
		});

		test('handles sessionID as "undefined" string', async () => {
			ensureAgentSession('undefined');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'undefined',
			});
			const parsed = JSON.parse(result);

			// Should work
			expect(parsed.success).toBe(true);
		});

		test('handles summary with null bytes', async () => {
			ensureAgentSession('sess1');

			const summaryWithNullBytes = 'Test\x00\x00\x00Summary';

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
				summary: summaryWithNullBytes,
			});
			const parsed = JSON.parse(result);

			// Should not crash
			expect(parsed.success).toBe(true);
			// Null bytes should be preserved or handled gracefully
			expect(parsed.message).toContain('Test');
		});

		test('handles summary with Unicode emojis and special chars', async () => {
			ensureAgentSession('sess1');

			const summary =
				'Test 🎉💥 with emoji \u0000 and null byte \n newline \t tab';

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
				summary: summary,
			});
			const parsed = JSON.parse(result);

			// Should handle gracefully
			expect(parsed.success).toBe(true);
		});

		test('handles sessionID with Unicode characters', async () => {
			const unicodeSessionID = 'session-🎉-测试-テスト';
			ensureAgentSession(unicodeSessionID);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: unicodeSessionID,
			});
			const parsed = JSON.parse(result);

			// Should work
			expect(parsed.success).toBe(true);
		});
	});

	describe('Duplicate handling and deduplication', () => {
		test('handles required_agents with duplicate entries in config', async () => {
			// Create config with duplicate agents
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: [
							'coder',
							'coder',
							'coder',
							'reviewer',
							'reviewer',
						],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'reviewer');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should succeed with duplicates handled gracefully
			expect(parsed.success).toBe(true);
			expect(parsed.agentsMissing).toEqual([]);
		});

		test('handles duplicate agents in delegation chain', async () => {
			ensureAgentSession('sess1');

			// Add duplicate delegations
			swarmState.delegationChains.set('sess1', [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 5000 },
				{ from: 'coder', to: 'coder', timestamp: Date.now() - 4000 }, // Self-delegation
				{ from: 'coder', to: 'reviewer', timestamp: Date.now() - 3000 },
				{ from: 'reviewer', to: 'coder', timestamp: Date.now() - 2000 }, // Duplicate agent
			]);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should handle duplicates via Set deduplication
			expect(parsed.success).toBe(true);
			expect(parsed.agentsDispatched).toContain('coder');
			expect(parsed.agentsDispatched).toContain('reviewer');
		});

		test('handles duplicate agents via both delegation and phaseAgentsDispatched', async () => {
			ensureAgentSession('sess1');

			// Add via delegation chain
			swarmState.delegationChains.set('sess1', [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 5000 },
			]);

			// Also add via phaseAgentsDispatched (duplicate)
			recordPhaseAgentDispatch('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'coder'); // Duplicate again

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should deduplicate via Set
			expect(parsed.success).toBe(true);
			// coder should only appear once
			expect(
				parsed.agentsDispatched.filter((a: string) => a === 'coder').length,
			).toBe(1);
		});
	});

	describe('Concurrent access and race conditions', () => {
		test('handles rapid sequential calls with same sessionID', async () => {
			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			// Make multiple rapid calls
			const promises = [
				phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
				phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
				phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
			];

			const results = await Promise.all(promises);
			const parsed = results.map((r) => JSON.parse(r));

			// Concurrent same-session calls may contend on the phase-complete lock.
			// The safety contract is that every call returns structured JSON and at
			// least one call completes the phase.
			expect(parsed.some((p) => p.success === true)).toBe(true);
			parsed.forEach((p) => {
				expect(typeof p.success).toBe('boolean');
				expect(typeof p.message).toBe('string');
			});

			// Bun is single-threaded, so no true race condition, but ensure stability
		});

		test('handles interleaved calls with different sessions', async () => {
			ensureAgentSession('sess1');
			ensureAgentSession('sess2');
			recordPhaseAgentDispatch('sess1', 'coder');
			recordPhaseAgentDispatch('sess2', 'reviewer');

			// Interleaved operations
			const result1 = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed1 = JSON.parse(result1);

			// After sess1 completes, re-dispatch reviewer for sess2
			// (sess1's phase_complete resets all contributor sessions including sess2)
			recordPhaseAgentDispatch('sess2', 'reviewer');

			const result2 = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess2',
			});
			const parsed2 = JSON.parse(result2);

			// Both should succeed independently
			expect(parsed1.success).toBe(true);
			expect(parsed2.success).toBe(true);
			expect(parsed1.agentsDispatched).toContain('coder');
			expect(parsed2.agentsDispatched).toContain('reviewer');
		}, 30_000);
	});

	describe('Type coercion and validation bypass attempts', () => {
		test('handles phase as object that coerces to NaN', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: {} as any,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// {} coerces to NaN, should be rejected
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('handles phase as array that coerces to NaN or 0', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: [] as any,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// [] coerces to 0, should be rejected
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('handles phase as boolean true (coerces to 1)', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: true as any,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// true coerces to 1, should be accepted
			expect(parsed.success).toBe(true);
			expect(parsed.phase).toBe(1);
		});

		test('handles phase as boolean false (coerces to 0)', async () => {
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: false as any,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// false coerces to 0, should be rejected
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('handles sessionID as number (coerced to string)', async () => {
			// Number sessionID gets coerced to string
			ensureAgentSession('12345');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: '12345',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
		});
	});

	describe('Event file injection attempts', () => {
		test('handles injection attempt in summary written to events.jsonl', async () => {
			ensureAgentSession('sess1');

			// Try JSON injection via summary
			const maliciousSummary = '"event":"hacked"}';

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
				summary: maliciousSummary,
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Read events file and ensure it's valid JSONL
			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const lines = eventsContent.trim().split('\n');

			// Each line should be valid JSON
			lines.forEach((line) => {
				expect(() => JSON.parse(line)).not.toThrow();
			});
		});

		test('handles newline injection in summary', async () => {
			ensureAgentSession('sess1');

			const summaryWithNewline = 'Phase complete\nInjected line\nAnother line';

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
				summary: summaryWithNewline,
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Read events file - newlines in summary should be escaped in JSON
			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const lines = eventsContent.trim().split('\n');

			// Each line should be valid JSON (newlines in summary are properly escaped).
			// Multiple lines may exist due to curator compliance events.
			expect(lines.length).toBeGreaterThanOrEqual(1);
			lines.forEach((line) => {
				expect(() => JSON.parse(line)).not.toThrow();
			});

			// Verify the phase_complete event has the correct summary
			const phaseEvent = lines
				.map((l) => JSON.parse(l))
				.find((e: Record<string, unknown>) => e.event === 'phase_complete');
			expect(phaseEvent).toBeDefined();
			expect(phaseEvent.summary).toBe(summaryWithNewline);
		});
	});

	describe('Config tampering attempts', () => {
		test('handles malicious config with very large arrays', async () => {
			// Create config with huge arrays
			const hugeArray = Array.from({ length: 10000 }, (_, i) => `agent${i}`);

			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: hugeArray,
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should handle without crashing
			expect(parsed.success).toBe(false); // Missing agents
			expect(parsed.agentsMissing.length).toBeGreaterThan(0);
		});

		test('handles config with circular structure (should fail parse)', async () => {
			// Circular structure can't be written to JSON, but we can test malformed JSON
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				'{"phase_complete": {"enabled": true, "required_agents": [1, 2, 3,]}}', // Trailing comma - invalid JSON
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// SECURE: Malformed config triggers fallback to safe defaults
			// The system should handle this gracefully without crashing
			// It may succeed with defaults or fail with appropriate error
			expect(['true', 'false']).toContain(String(parsed.success));
		});
	});

	describe('Memory and resource exhaustion attempts', () => {
		test('handles extremely long delegation chain', async () => {
			ensureAgentSession('sess1');

			// Create a huge delegation chain
			const hugeChain = Array.from({ length: 10000 }, (_, i) => ({
				from: `agent${i}`,
				to: `agent${i + 1}`,
				timestamp: Date.now() - (10000 - i) * 1000,
			}));

			swarmState.delegationChains.set('sess1', hugeChain);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should complete without crashing
			expect(parsed.success).toBe(true);
		});

		test('handles many phaseAgentsDispatched entries', async () => {
			ensureAgentSession('sess1');

			// Add many agents
			for (let i = 0; i < 1000; i++) {
				recordPhaseAgentDispatch('sess1', `agent${i}`);
			}

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should complete without crashing
			expect(parsed.success).toBe(true);
			// Structured gate output is intentionally bounded against untrusted state.
			expect(parsed.agentsDispatched.length).toBe(64);
			expect(
				parsed.gate_report.entries.every(
					(entry: { agentsDispatched: string[] }) =>
						entry.agentsDispatched.length <= 64,
				),
			).toBe(true);
		});
	});
});
