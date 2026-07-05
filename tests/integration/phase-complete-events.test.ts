import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../src/state';
import { executePhaseComplete } from '../../src/tools/phase-complete';

describe('phase_complete integration — events.jsonl', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-int-test-'));
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
		const lines = content
			.trim()
			.split('\n')
			.filter((l) => l.trim());
		const events = lines.map((l) => JSON.parse(l));
		if (eventType) {
			return events.filter((e) => e.event === eventType);
		}
		return events;
	}

	/**
	 * Helper to write config file
	 */
	function writeConfig(config: Record<string, unknown>): void {
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify(config, null, 2),
		);
	}

	/**
	 * Helper to write retrospective evidence bundle for retrospective gate
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
					agent_name: 'critic',
					session_id: 'sess1',
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

	describe('1. Full successful architect session', () => {
		it('writes correct event with all agents dispatched', async () => {
			// Use default config: required_agents: [coder, reviewer, test_engineer], require_docs: true
			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			// Simulate: architect delegates to coder, reviewer, test_engineer, docs
			recordPhaseAgentDispatch(sessionID, 'coder');
			recordPhaseAgentDispatch(sessionID, 'reviewer');
			recordPhaseAgentDispatch(sessionID, 'test_engineer');
			recordPhaseAgentDispatch(sessionID, 'docs');

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

			// Assert: tool return value
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			expect(parsed.agentsDispatched).toContain('coder');
			expect(parsed.agentsDispatched).toContain('reviewer');
			expect(parsed.agentsDispatched).toContain('test_engineer');
			expect(parsed.agentsDispatched).toContain('docs');
			expect(parsed.agentsMissing).toEqual([]);

			// Assert: events.jsonl has exactly 1 phase_complete event
			const events = readEvents('phase_complete');
			expect(events.length).toBe(1);

			const event = events[0];
			expect(event.event).toBe('phase_complete');
			expect(event.phase).toBe(1);
			expect(event.status).toBe('success');
			expect(event.summary).toBe('Phase 1 complete');
			expect(event.agents_dispatched).toContain('coder');
			expect(event.agents_dispatched).toContain('reviewer');
			expect(event.agents_dispatched).toContain('test_engineer');
			expect(event.agents_dispatched).toContain('docs');
			expect(event.agents_missing).toEqual([]);
			expect(event.timestamp).toBeDefined();
		});
	});

	describe('2. Incomplete phase (missing agents in enforce mode)', () => {
		it('writes event with status incomplete and missing agents', async () => {
			// Default config: required_agents: [coder, reviewer, test_engineer], require_docs: true, policy: enforce
			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			// Simulate: architect delegates to coder only (no reviewer, no test_engineer, no docs)
			recordPhaseAgentDispatch(sessionID, 'coder');

			writeRetro(1);
			writeGateEvidence(1);
			const result = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
				},
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: tool return value has success: false
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.agentsMissing).toContain('reviewer');
			expect(parsed.agentsMissing).toContain('test_engineer');
			expect(parsed.agentsMissing).toContain('docs');

			// Assert: event line written with incomplete status
			const events = readEvents('phase_complete');
			expect(events.length).toBe(1);

			const event = events[0];
			expect(event.event).toBe('phase_complete');
			expect(event.phase).toBe(1);
			expect(event.status).toBe('incomplete');
			expect(event.agents_missing).toContain('reviewer');
			expect(event.agents_missing).toContain('test_engineer');
			expect(event.agents_missing).toContain('docs');
		});
	});

	describe('3. Sequential phase_complete calls — phase resets between calls', () => {
		it('produces two separate event lines with correct phase numbers', async () => {
			// Config: require all 4 agents, policy enforce
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: ['coder', 'reviewer', 'test_engineer'],
					require_docs: true,
					policy: 'enforce',
				},
			});

			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			// === Phase 1 ===
			recordPhaseAgentDispatch(sessionID, 'coder');
			recordPhaseAgentDispatch(sessionID, 'reviewer');
			recordPhaseAgentDispatch(sessionID, 'test_engineer');
			recordPhaseAgentDispatch(sessionID, 'docs');

			writeRetro(1);
			writeGateEvidence(1);
			const result1 = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
					summary: 'Phase 1 complete',
				},
				tempDir,
			);
			const parsed1 = JSON.parse(result1);
			expect(parsed1.success).toBe(true);
			expect(parsed1.phase).toBe(1);

			// === Phase 2 ===
			// Re-dispatch agents for phase 2 (state was reset after phase 1)
			recordPhaseAgentDispatch(sessionID, 'coder');
			recordPhaseAgentDispatch(sessionID, 'reviewer');
			recordPhaseAgentDispatch(sessionID, 'test_engineer');
			recordPhaseAgentDispatch(sessionID, 'docs');

			writeRetro(2);
			writeGateEvidence(2);
			const result2 = await executePhaseComplete(
				{
					phase: 2,
					sessionID,
					summary: 'Phase 2 complete',
				},
				tempDir,
			);
			const parsed2 = JSON.parse(result2);
			expect(parsed2.success).toBe(true);
			expect(parsed2.phase).toBe(2);

			// Assert: events.jsonl has exactly 2 phase_complete events
			const events = readEvents('phase_complete');
			expect(events.length).toBe(2);

			// Assert: line 1 has phase: 1, line 2 has phase: 2
			expect(events[0].phase).toBe(1);
			expect(events[0].status).toBe('success');
			expect(events[1].phase).toBe(2);
			expect(events[1].status).toBe('success');

			// Assert: phaseAgentsDispatched is empty after each successful phase_complete
			const session = swarmState.agentSessions.get(sessionID);
			expect(session?.phaseAgentsDispatched.size).toBe(0);

			// Assert: lastPhaseCompletePhase is 2 after second call
			expect(session?.lastPhaseCompletePhase).toBe(2);
		});
	});

	describe('4. phaseAgentsDispatched resets between phases', () => {
		it('only includes agents from current phase in dispatched list', async () => {
			// Config: warn policy, require coder + reviewer + test_engineer
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: ['coder', 'reviewer', 'test_engineer'],
					require_docs: false,
					policy: 'warn',
				},
			});

			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			// === Phase 1: dispatch all 4 agents ===
			recordPhaseAgentDispatch(sessionID, 'coder');
			recordPhaseAgentDispatch(sessionID, 'reviewer');
			recordPhaseAgentDispatch(sessionID, 'test_engineer');
			recordPhaseAgentDispatch(sessionID, 'docs');

			writeRetro(1);
			writeGateEvidence(1);
			const result1 = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
				},
				tempDir,
			);
			const parsed1 = JSON.parse(result1);
			expect(parsed1.success).toBe(true);

			// Verify session.phaseAgentsDispatched is empty after phase 1
			const session = swarmState.agentSessions.get(sessionID);
			expect(session?.phaseAgentsDispatched.size).toBe(0);

			// === Phase 2: dispatch ONLY coder ===
			recordPhaseAgentDispatch(sessionID, 'coder');

			writeRetro(2);
			writeGateEvidence(2);
			const result2 = await executePhaseComplete(
				{
					phase: 2,
					sessionID,
				},
				tempDir,
			);
			const parsed2 = JSON.parse(result2);
			// Warn policy - should succeed with warning
			expect(parsed2.success).toBe(true);
			expect(parsed2.status).toBe('warned');

			// Verify phase 2 event only has 'coder' in agents_dispatched (NOT coder+reviewer+etc from phase 1)
			const events = readEvents('phase_complete');
			expect(events.length).toBe(2);

			const phase2Event = events[1];
			expect(phase2Event.phase).toBe(2);
			expect(phase2Event.agents_dispatched).toContain('coder');
			expect(phase2Event.agents_dispatched).not.toContain('reviewer');
			expect(phase2Event.agents_dispatched).not.toContain('test_engineer');
		});
	});

	describe('5. Custom required_agents integration', () => {
		it('succeeds with custom required_agents config', async () => {
			// Config: required_agents: [coder, reviewer], require_docs: false, policy: warn
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: ['coder', 'reviewer'],
					require_docs: false,
					policy: 'warn',
				},
			});

			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			// Dispatch coder, reviewer
			recordPhaseAgentDispatch(sessionID, 'coder');
			recordPhaseAgentDispatch(sessionID, 'reviewer');

			writeRetro(1);
			writeGateEvidence(1);
			const result = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
				},
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: status success, no warnings, agents_missing empty
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			expect(parsed.agentsMissing).toEqual([]);

			// Check event
			const events = readEvents('phase_complete');
			expect(events.length).toBe(1);
			expect(events[0].status).toBe('success');
			expect(events[0].agents_missing).toEqual([]);
		});
	});

	describe('6. Warn policy: event written even when agents missing', () => {
		it('writes event with status warned and missing agents, but success=true', async () => {
			// Config: policy warn, required_agents: [coder, reviewer, test_engineer], require_docs: false
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: ['coder', 'reviewer', 'test_engineer'],
					require_docs: false,
					policy: 'warn',
				},
			});

			const sessionID = 'sess1';
			ensureAgentSession(sessionID);

			// Dispatch only coder
			recordPhaseAgentDispatch(sessionID, 'coder');

			writeRetro(1);
			writeGateEvidence(1);
			const result = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
				},
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: success is true (warn policy doesn't fail)
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('warned');
			expect(parsed.warnings.length).toBeGreaterThan(0);
			expect(parsed.warnings).toSatisfy((warnings: string[]) =>
				warnings.some((warning) => warning.includes('missing required agents')),
			);
			expect(parsed.agentsMissing).toContain('reviewer');
			expect(parsed.agentsMissing).toContain('test_engineer');

			// Assert: event line written with status: warned
			const events = readEvents('phase_complete');
			expect(events.length).toBe(1);

			const event = events[0];
			expect(event.event).toBe('phase_complete');
			expect(event.phase).toBe(1);
			expect(event.status).toBe('warned');
			expect(event.agents_missing).toContain('reviewer');
			expect(event.agents_missing).toContain('test_engineer');
		});
	});

	describe('7. Delegation chains integration with events', () => {
		it('records agents from delegation chains in event', async () => {
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

			// Set up delegation chains
			swarmState.delegationChains.set(sessionID, [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 5000 },
				{ from: 'architect', to: 'reviewer', timestamp: Date.now() - 3000 },
			]);

			writeRetro(1);
			writeGateEvidence(1);
			const result = await executePhaseComplete(
				{
					phase: 1,
					sessionID,
				},
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Check event includes agents from delegation chains
			const events = readEvents('phase_complete');
			expect(events.length).toBe(1);
			expect(events[0].agents_dispatched).toContain('coder');
			expect(events[0].agents_dispatched).toContain('reviewer');
		});
	});

	describe('8. Multiple sessions write to same events.jsonl', () => {
		it('appends events from different sessions', async () => {
			writeConfig({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			});

			// Session 1
			const session1 = 'sess1';
			ensureAgentSession(session1);
			writeRetro(1);
			writeGateEvidence(1);
			await executePhaseComplete({ phase: 1, sessionID: session1 }, tempDir);

			// Session 2
			const session2 = 'sess2';
			ensureAgentSession(session2);
			writeRetro(1);
			writeGateEvidence(1);
			await executePhaseComplete({ phase: 1, sessionID: session2 }, tempDir);

			// Should have 2 phase_complete events
			const events = readEvents('phase_complete');
			expect(events.length).toBe(2);
		});
	});
});
