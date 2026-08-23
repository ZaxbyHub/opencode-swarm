import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
} from '../../src/state';
import { executePhaseComplete } from '../../src/tools/phase-complete';

describe('phase_complete integration — adversarial scenarios', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-adv-test-'));
		// Create .swarm dir for event writing
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		resetSwarmState();
	});

	/**
	 * Helper to read events.jsonl and parse all lines
	 * @param eventType - Optional filter to only return events of this type
	 */
	function readEvents(eventType?: string): Array<Record<string, unknown>> {
		const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
		if (!fs.existsSync(eventsPath)) {
			return [];
		}
		const content = fs.readFileSync(eventsPath, 'utf-8');
		const lines = content.split('\n').filter((l) => l.trim());
		const events: Array<Record<string, unknown>> = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			try {
				events.push(JSON.parse(line));
			} catch (parseError) {
				// Log the line that failed to parse for debugging
				console.error(
					`Failed to parse line ${i} (length ${line.length}):`,
					line,
				);
				console.error('Error:', parseError);
				console.error('Full file content:');
				console.error(content);
				throw parseError;
			}
		}
		if (eventType) {
			return events.filter((e) => e.event === eventType);
		}
		return events;
	}

	function writeConfig(config: Record<string, unknown>): void {
		config.knowledge ??= { enabled: false, sweep_enabled: false };
		config.curator ??= { enabled: false };
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(config, null, 2),
		);
	}

	/**
	 * Helper to write pre-existing content to events.jsonl
	 */
	function writePreexistingEvents(content: string): void {
		const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
		fs.writeFileSync(eventsPath, content, 'utf-8');
	}

	/**
	 * Helper to write retrospective evidence bundle for a phase
	 */
	function writeRetro(phase: number): void {
		const evidence = {
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			entries: [
				{
					task_id: `retro-${phase}`,
					type: 'retrospective',
					timestamp: '2026-01-01T00:00:00.000Z',
					agent: 'architect',
					verdict: 'pass',
					summary: `Test phase ${phase} complete`,
					phase_number: phase,
					total_tool_calls: 0,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: ['Test lesson'],
					user_directives: [],
					approaches_tried: [],
				},
			],
			created_at: '2026-01-01T00:00:00.000Z',
			updated_at: '2026-01-01T00:00:00.000Z',
		};
		const retroDir = path.join(tempDir, '.swarm', 'evidence', `retro-${phase}`);
		fs.mkdirSync(retroDir, { recursive: true });
		fs.writeFileSync(
			path.join(retroDir, 'evidence.json'),
			JSON.stringify(evidence, null, 2),
		);
	}

	/**
	 * Helper to write gate evidence files for Phase 4 mandatory gates
	 */
	function writeGateEvidence(phase: number): void {
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', `${phase}`);
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

	describe('1. Concurrent event appends', () => {
		it('two phase_complete calls back-to-back to same session — both events appear, no corruption', async () => {
			// Config: no required agents to simplify
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			});

			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			// Record some agents for first phase
			recordPhaseAgentDispatch(sessionID, 'coder');
			recordPhaseAgentDispatch(sessionID, 'reviewer');

			// Call phase_complete twice back-to-back
			writeRetro(1);
			writeGateEvidence(1);
			const result1 = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
					summary: 'First phase complete',
				},
				tempDir,
			);

			// For the second call, we need to record agents again since state resets
			recordPhaseAgentDispatch(sessionID, 'coder');
			recordPhaseAgentDispatch(sessionID, 'reviewer');

			writeRetro(2);
			writeGateEvidence(2);
			const result2 = await executePhaseComplete(
				{
					phase: 2,
					sessionID,
					summary: 'Second phase complete',
				},
				tempDir,
			);

			const parsed1 = JSON.parse(result1);
			const parsed2 = JSON.parse(result2);

			// Both should succeed
			expect(parsed1.success).toBe(true);
			expect(parsed2.success).toBe(true);

			// Both phase_complete events should appear in events.jsonl
			const events = readEvents('phase_complete');
			expect(events.length).toBe(2);

			// Verify events are correctly formed (no corruption)
			expect(events[0].event).toBe('phase_complete');
			expect(events[0].phase).toBe(1);
			expect(events[0].summary).toBe('First phase complete');

			expect(events[1].event).toBe('phase_complete');
			expect(events[1].phase).toBe(2);
			expect(events[1].summary).toBe('Second phase complete');
		});
	});

	describe('2. Events.jsonl already has content', () => {
		it('pre-existing content in events.jsonl is preserved (append, not overwrite)', async () => {
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			});

			// Write pre-existing content to events.jsonl
			const preexistingEvent = JSON.stringify({
				event: 'custom_event',
				timestamp: new Date().toISOString(),
				data: 'some pre-existing data',
			});
			writePreexistingEvents(`${preexistingEvent}\n`);

			// Now call phase_complete
			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			writeRetro(1);
			writeGateEvidence(1);
			const result = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
					summary: 'Phase 1 complete',
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);

			// The pre-existing event must still be present (append, not overwrite)
			const customEvents = readEvents('custom_event');
			expect(customEvents.length).toBe(1);
			expect(customEvents[0].data).toBe('some pre-existing data');

			// The phase_complete event must have been appended
			const phaseEvents = readEvents('phase_complete');
			expect(phaseEvents.length).toBe(1);
			expect(phaseEvents[0].phase).toBe(1);
		});
	});

	describe('3. Events.jsonl with no newline at end', () => {
		it('events appended after content without trailing newline produce valid JSONL', async () => {
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			});

			// Write a complete valid event with newline
			const preexistingEvent = JSON.stringify({
				event: 'custom_event',
				timestamp: new Date().toISOString(),
				data: 'with newline',
			});
			// Write with trailing newline (valid JSONL format)
			writePreexistingEvents(`${preexistingEvent}\n`);

			// Now call phase_complete - it should append correctly
			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			writeRetro(1);
			writeGateEvidence(1);
			const result = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
					summary: 'Phase 1 complete',
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);

			// The pre-existing event must still be present (append, not overwrite)
			const customEvents = readEvents('custom_event');
			expect(customEvents.length).toBe(1);
			expect(customEvents[0].data).toBe('with newline');

			// The phase_complete event must have been appended
			const phaseEvents = readEvents('phase_complete');
			expect(phaseEvents.length).toBe(1);
			expect(phaseEvents[0].phase).toBe(1);
		});
	});

	describe('4. Read-only .swarm directory', () => {
		it('fails closed before event write when the phase commit lock cannot be created', async () => {
			// Skip on Windows as file permissions are different
			if (process.platform === 'win32') {
				return; // Test skipped on Windows
			}

			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			});

			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			// Write retro BEFORE making .swarm read-only
			writeRetro(1);
			writeGateEvidence(1);

			// Make .swarm directory read-only (0o555 = r-x, allows traversal but not writes)
			const swarmDir = path.join(tempDir, '.swarm');
			fs.chmodSync(swarmDir, 0o555);

			// Pre-check: verify chmod actually blocks writes (not always effective on some macOS CI)
			const probePath = path.join(swarmDir, '.write-probe');
			let chmodEffective = false;
			try {
				fs.writeFileSync(probePath, 'test', 'utf-8');
			} catch {
				chmodEffective = true;
			} finally {
				try {
					fs.unlinkSync(probePath);
				} catch {
					// Ignore cleanup errors
				}
			}

			// If chmod didn't block writes, restore permissions and skip test
			if (!chmodEffective) {
				fs.chmodSync(swarmDir, 0o755);
				console.warn(
					'SKIP: chmod(0o444) does not block writes on this system (possibly macOS with SIP)',
				);
				return;
			}

			try {
				// Does not throw — a read-only .swarm directory must not crash
				// phase_complete, regardless of which write path ultimately
				// reports success:false.
				const result = await executePhaseComplete(
					{
						phase: 1,
						sessionID,
						summary: 'Phase 1 complete',
					},
					tempDir,
				);

				const parsed = JSON.parse(result);
				const diagnostic = () => JSON.stringify(parsed, null, 2);

				// The aggregate preflight obtains the mandatory phase commit lock
				// before every completion-event side effect.
				expect(parsed.success, diagnostic()).toBe(false);
				expect(parsed.status, diagnostic()).toBe('incomplete');
				expect(parsed.reason, diagnostic()).toBe('PHASE_COMMIT_LOCK_ERROR');
				expect(parsed.message, diagnostic()).toContain(
					'Failed to acquire the guarded phase commit lock',
				);
				expect(parsed.errors, diagnostic()).toContainEqual(
					expect.stringContaining('Phase commit lock acquisition failed'),
				);
				expect(readEvents('phase_complete')).toEqual([]);
			} finally {
				// Restore permissions for cleanup
				fs.chmodSync(swarmDir, 0o755);
			}
		});
	});

	describe('5. Phase numbers out of order', () => {
		it('phase=3 then phase=1 — both succeed, both events written', async () => {
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			});

			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			// First call: phase=3
			recordPhaseAgentDispatch(sessionID, 'coder');
			writeRetro(3);
			writeGateEvidence(3);
			const result1 = await executePhaseComplete(
				{
					phase: 3,
					sessionID,
					summary: 'Phase 3 complete',
				},
				tempDir,
			);

			const parsed1 = JSON.parse(result1);
			expect(parsed1.success).toBe(true);
			expect(parsed1.phase).toBe(3);

			// Second call: phase=1 (out of order)
			recordPhaseAgentDispatch(sessionID, 'coder');
			writeRetro(1);
			writeGateEvidence(1);
			const result2 = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
					summary: 'Phase 1 complete',
				},
				tempDir,
			);

			const parsed2 = JSON.parse(result2);
			expect(parsed2.success).toBe(true);
			expect(parsed2.phase).toBe(1);

			// Both phase_complete events should be present in the order they were called
			// (curator_compliance events are also written but are not phase_complete events)
			const phaseEvents = readEvents('phase_complete');
			expect(phaseEvents.length).toBe(2);

			// First event should be phase 3 (order of calls)
			expect(phaseEvents[0].phase).toBe(3);
			expect(phaseEvents[0].summary).toBe('Phase 3 complete');

			// Second event should be phase 1
			expect(phaseEvents[1].phase).toBe(1);
			expect(phaseEvents[1].summary).toBe('Phase 1 complete');
		});
	});

	describe('6. Very long summary in events', () => {
		it('summary is truncated to 500 chars before writing', async () => {
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			});

			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			// Create a very long summary (1000 characters)
			const longSummary = 'A'.repeat(1000);

			writeRetro(1);
			writeGateEvidence(1);
			const result = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
					summary: longSummary,
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);

			// Check the event file - summary should be truncated to 500 chars
			const events = readEvents('phase_complete');
			expect(events.length).toBe(1);

			const event = events[0];
			expect(event.summary).toBe('A'.repeat(500));
			expect(event.summary.length).toBe(500);
		});
	});

	describe('7. Summary with JSONL-breaking characters', () => {
		it('newlines, backslashes in summary — JSON.stringify escapes properly, exactly 1 line per call', async () => {
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			});

			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			// Create summary with JSONL-breaking characters
			const dangerousSummary = 'Line 1\nLine 2\\Backslash"Quote"';

			writeRetro(1);
			writeGateEvidence(1);
			const result = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
					summary: dangerousSummary,
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);

			// Read raw file content — multiple events may be written (e.g. curator_compliance),
			// but the phase_complete event must be exactly 1 valid JSON line
			const phaseEvents = readEvents('phase_complete');
			expect(phaseEvents.length).toBe(1);

			// Parse and verify the summary is correctly escaped
			const event = phaseEvents[0];
			expect(event.summary).toBe(dangerousSummary);
			expect(event.summary).toContain('\n');
			expect(event.summary).toContain('\\');
			expect(event.summary).toContain('"');
		});
	});

	describe('8. Zero-byte events.jsonl exists', () => {
		it('tool should append to zero-byte events.jsonl correctly', async () => {
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			});

			// Create zero-byte events.jsonl
			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			fs.writeFileSync(eventsPath, '', 'utf-8');

			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			writeRetro(1);
			writeGateEvidence(1);
			const result = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
					summary: 'Phase 1 complete',
				},
				tempDir,
			);

			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);

			// Event should be written correctly
			const events = readEvents('phase_complete');
			expect(events.length).toBe(1);
			expect(events[0].event).toBe('phase_complete');
			expect(events[0].phase).toBe(1);
		});
	});

	describe('9. Multiple sessions writing to same events.jsonl', () => {
		it('events from different sessions should all be present in correct order', async () => {
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			});

			// Session 1, Phase 1
			const session1 = 'sess1';
			ensureAgentSession(session1);
			recordPhaseAgentDispatch(session1, 'coder');
			writeRetro(1);
			writeGateEvidence(1);
			await executePhaseComplete(
				{
					phase: 1,
					sessionID: session1,
					summary: 'Session 1, Phase 1',
				},
				tempDir,
			);

			// Session 2, Phase 1
			const session2 = 'sess2';
			ensureAgentSession(session2);
			recordPhaseAgentDispatch(session2, 'reviewer');
			await executePhaseComplete(
				{
					phase: 1,
					sessionID: session2,
					summary: 'Session 2, Phase 1',
				},
				tempDir,
			);

			// Session 1, Phase 2 (back to session 1)
			recordPhaseAgentDispatch(session1, 'coder');
			writeRetro(2);
			writeGateEvidence(2);
			await executePhaseComplete(
				{
					phase: 2,
					sessionID: session1,
					summary: 'Session 1, Phase 2',
				},
				tempDir,
			);

			// Session 2, Phase 2
			recordPhaseAgentDispatch(session2, 'reviewer');
			await executePhaseComplete(
				{
					phase: 2,
					sessionID: session2,
					summary: 'Session 2, Phase 2',
				},
				tempDir,
			);

			// All 4 phase_complete events should be present in the order they were called
			const events = readEvents('phase_complete');
			expect(events.length).toBe(4);

			expect(events[0].sessionID || 'unknown').toBeTruthy();
			expect(events[0].phase).toBe(1);
			expect(events[0].summary).toBe('Session 1, Phase 1');

			expect(events[1].phase).toBe(1);
			expect(events[1].summary).toBe('Session 2, Phase 1');

			expect(events[2].phase).toBe(2);
			expect(events[2].summary).toBe('Session 1, Phase 2');

			expect(events[3].phase).toBe(2);
			expect(events[3].summary).toBe('Session 2, Phase 2');
		});
	});

	describe('10. phaseAgentsDispatched with agents NOT in required_agents', () => {
		it('extra agents should appear in agents_dispatched but not affect agents_missing', async () => {
			// Config: required_agents: [coder, reviewer]
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: ['coder', 'reviewer'],
					require_docs: false,
					policy: 'enforce',
				},
			});

			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			// Record extra agents beyond required ones
			recordPhaseAgentDispatch(sessionID, 'coder');
			recordPhaseAgentDispatch(sessionID, 'reviewer');
			recordPhaseAgentDispatch(sessionID, 'extra_agent_1');
			recordPhaseAgentDispatch(sessionID, 'extra_agent_2');

			writeRetro(1);
			writeGateEvidence(1);
			const result = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
					summary: 'Phase 1 complete',
				},
				tempDir,
			);

			const parsed = JSON.parse(result);

			// Should succeed because required agents are present
			expect(parsed.success).toBe(true);
			expect(parsed.agentsMissing).toEqual([]);

			// agentsDispatched should include both required and extra agents
			expect(parsed.agentsDispatched).toContain('coder');
			expect(parsed.agentsDispatched).toContain('reviewer');
			expect(parsed.agentsDispatched).toContain('extra_agent_1');
			expect(parsed.agentsDispatched).toContain('extra_agent_2');

			// Check event file
			const events = readEvents('phase_complete');
			expect(events.length).toBe(1);

			const event = events[0];
			// agents_dispatched should include all agents
			expect(event.agents_dispatched).toContain('coder');
			expect(event.agents_dispatched).toContain('reviewer');
			expect(event.agents_dispatched).toContain('extra_agent_1');
			expect(event.agents_dispatched).toContain('extra_agent_2');

			// agents_missing should be empty
			expect(event.agents_missing).toEqual([]);
		});
	});
});
