import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

// Import the tool after setting up environment
const { phase_complete, executePhaseComplete } = await import(
	'../../../src/tools/phase-complete'
);
const { recordGateEvidence } = await import('../../../src/gate-evidence');

/**
 * Helper function to write a valid retro bundle for a phase
 */
function writeRetroBundle(
	directory: string,
	phaseNumber: number,
	verdict: 'pass' | 'fail' = 'pass',
): void {
	const retroDir = path.join(
		directory,
		'.swarm',
		'evidence',
		`retro-${phaseNumber}`,
	);
	fs.mkdirSync(retroDir, { recursive: true });

	const retroBundle = {
		schema_version: '1.0.0',
		task_id: `retro-${phaseNumber}`,
		entries: [
			{
				task_id: `retro-${phaseNumber}`,
				type: 'retrospective',
				timestamp: new Date().toISOString(),
				agent: 'architect',
				verdict: verdict,
				summary: 'Phase retrospective',
				metadata: {},
				phase_number: phaseNumber,
				total_tool_calls: 10,
				coder_revisions: 1,
				reviewer_rejections: 0,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				task_count: 5,
				task_complexity: 'moderate',
				top_rejection_reasons: [],
				lessons_learned: ['Lesson 1'],
			},
		],
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};

	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify(retroBundle, null, 2),
	);
}

/**
 * Helper function to write gate evidence files for Phase 4 mandatory gates
 * (completion-verify and drift-verifier)
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

/**
 * Helper to create a minimal ToolContext mock for testing
 */
function mockCtx(sessionID: string, directory: string): ToolContext {
	return {
		sessionID,
		messageID: 'test-message-id',
		agent: 'test-agent',
		directory,
		worktree: directory,
		abort: new AbortController().signal,
		metadata: () => {},
		ask: async () => {},
	};
}

describe('phase_complete tool', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		// Reset state before each test
		resetSwarmState();

		// Create temp directory
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory and evidence directory structure
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });

		// Write retro bundles for phases 1 and 2 (tests use these phases)
		writeRetroBundle(tempDir, 1, 'pass');
		writeRetroBundle(tempDir, 2, 'pass');

		// Write gate evidence files for Phase 4 mandatory gates
		writeGateEvidence(tempDir, 1);
		writeGateEvidence(tempDir, 2);
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

	describe('argument validation', () => {
		test('returns error for invalid phase (NaN)', async () => {
			ensureAgentSession('sess1');
			const result = await phase_complete.execute({
				phase: NaN,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
			expect(parsed.warnings).toContain('Phase must be a positive number');
		});

		test('returns error for invalid phase (0)', async () => {
			ensureAgentSession('sess1');
			const result = await phase_complete.execute({
				phase: 0,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('returns error for invalid phase (negative)', async () => {
			ensureAgentSession('sess1');
			const result = await phase_complete.execute({
				phase: -1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('returns error when sessionID is missing', async () => {
			const result = await phase_complete.execute({ phase: 1 });
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Session ID is required');
		});
	});

	describe('enforcement disabled', () => {
		test('returns success with disabled status when enabled=false in config', async () => {
			// Create custom config with enabled: false
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: false,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('disabled');
			expect(parsed.message).toContain('enforcement disabled');
		});
	});

	describe('enforce mode with missing agents', () => {
		test('returns incomplete status when required agents missing in enforce mode', async () => {
			// Use default config which has required_agents: ['coder', 'reviewer', 'test_engineer']
			// and require_docs: true, policy: 'enforce'
			ensureAgentSession('sess1');
			// Only dispatch coder, missing reviewer, test_engineer, docs

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.message).toContain('missing required agents');
			expect(parsed.agentsMissing).toContain('coder');
			expect(parsed.agentsMissing).toContain('reviewer');
			expect(parsed.agentsMissing).toContain('test_engineer');
			expect(parsed.agentsMissing).toContain('docs');
		});

		test('returns success when all required agents present in enforce mode', async () => {
			// Use permissive config for this test
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

			ensureAgentSession('sess1');
			// No agents needed for empty required_agents

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});
	});

	describe('warn mode with missing agents', () => {
		test('returns warned status when required agents missing in warn mode', async () => {
			// Create config with warn policy
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'warn',
					},
				}),
			);

			ensureAgentSession('sess1');
			// Don't dispatch coder - will be warned but succeed

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('warned');
			expect(parsed.warnings.length).toBeGreaterThan(0);
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('missing required agents'),
				),
			).toBe(true);
			expect(parsed.warnings.some((w: string) => w.includes('coder'))).toBe(
				true,
			);
		});
	});

	describe('custom required_agents', () => {
		test('only requires specified agents', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			expect(parsed.agentsMissing).toEqual([]);
		});

		test('fails when custom required agent is missing', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder', 'reviewer'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');
			// Missing reviewer

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.agentsMissing).toContain('reviewer');
		});
	});

	describe('require_docs behavior', () => {
		test('adds docs to required when require_docs=true', async () => {
			// Default config has require_docs: true
			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'reviewer');
			recordPhaseAgentDispatch('sess1', 'test_engineer');
			// Missing docs

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.agentsMissing).toContain('docs');
		});

		test('does not add docs to required when require_docs=false', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');
			// Missing docs should NOT cause failure

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.agentsMissing).not.toContain('docs');
		});
	});

	describe('state reset on success', () => {
		test('resets phaseAgentsDispatched on successful completion', async () => {
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

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'reviewer');

			// Verify state before
			const sessionBefore = swarmState.agentSessions.get('sess1');
			expect(sessionBefore?.phaseAgentsDispatched.size).toBe(2);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Verify state reset
			const sessionAfter = swarmState.agentSessions.get('sess1');
			expect(sessionAfter?.phaseAgentsDispatched.size).toBe(0);
		});

		test('sets lastPhaseCompleteTimestamp and lastPhaseCompletePhase on success', async () => {
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

			ensureAgentSession('sess1');
			const beforeTime = Date.now();

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);
			const afterTime = Date.now();

			expect(parsed.success).toBe(true);

			const session = swarmState.agentSessions.get('sess1');
			expect(session?.lastPhaseCompleteTimestamp).toBeGreaterThanOrEqual(
				beforeTime,
			);
			expect(session?.lastPhaseCompleteTimestamp).toBeLessThanOrEqual(
				afterTime,
			);
			expect(session?.lastPhaseCompletePhase).toBe(1);
		});

		test('does NOT reset state on failure', async () => {
			// Default config with enforce will fail with no agents
			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'reviewer');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);

			// State should NOT be reset
			const session = swarmState.agentSessions.get('sess1');
			expect(session?.phaseAgentsDispatched.size).toBe(2);
			expect(session?.lastPhaseCompleteTimestamp).toBe(0);
		});
	});

	describe('prefix normalization', () => {
		test('mega_coder counts as coder', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');
			// Use prefixed agent name
			recordPhaseAgentDispatch('sess1', 'mega_coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.agentsDispatched).toContain('coder');
		});

		test('local_reviewer counts as reviewer', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'warn',
					},
				}),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'local_reviewer');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.agentsDispatched).toContain('reviewer');
		});

		test('prefix normalization works with delegation chains', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder', 'reviewer'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');
			// Set up delegation chain with prefixed agents
			swarmState.delegationChains.set('sess1', [
				{ from: 'architect', to: 'mega_coder', timestamp: Date.now() - 5000 },
				{
					from: 'mega_coder',
					to: 'local_reviewer',
					timestamp: Date.now() - 3000,
				},
			]);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.agentsDispatched).toContain('coder');
			expect(parsed.agentsDispatched).toContain('reviewer');
		});

		test('ignores caller delegation chains from before the phase reference timestamp', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder', 'reviewer'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			const referenceTimestamp = Date.now();
			ensureAgentSession('sess1');
			swarmState.agentSessions.get('sess1')!.lastPhaseCompleteTimestamp =
				referenceTimestamp;
			swarmState.delegationChains.set('sess1', [
				{
					from: 'architect',
					to: 'coder',
					timestamp: referenceTimestamp - 5000,
				},
				{
					from: 'coder',
					to: 'reviewer',
					timestamp: referenceTimestamp - 3000,
				},
			]);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.agentsDispatched).not.toContain('coder');
			expect(parsed.agentsDispatched).not.toContain('reviewer');
			expect(parsed.agentsMissing).toContain('coder');
			expect(parsed.agentsMissing).toContain('reviewer');
		});
	});

	describe('summary truncation', () => {
		test('truncates summary to 500 characters', async () => {
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

			ensureAgentSession('sess1');

			// Create a summary longer than 500 characters
			const longSummary = 'A'.repeat(600);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
				summary: longSummary,
			});
			const parsed = JSON.parse(result);

			expect(parsed.message.length).toBeLessThanOrEqual(
				500 + 'Phase 1 completed: '.length,
			);
		});

		test('summary is included in message when provided', async () => {
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

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
				summary: 'Test summary',
			});
			const parsed = JSON.parse(result);

			expect(parsed.message).toContain('Test summary');
		});
	});

	describe('event file writing', () => {
		test('writes event to .swarm/events.jsonl', async () => {
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
					curator: { enabled: false },
				}),
			);

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
				summary: 'Test phase',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
			expect(fs.existsSync(eventsPath)).toBe(true);

			const eventContent = fs.readFileSync(eventsPath, 'utf-8');
			const lines = eventContent.trim().split('\n').filter(Boolean);
			const event = lines
				.map((line: string) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.find(
					(e: Record<string, unknown> | null) => e?.event === 'phase_complete',
				);

			expect(event.event).toBe('phase_complete');
			expect(event.phase).toBe(1);
			expect(event.status).toBe('success');
			expect(event.summary).toBe('Test phase');
			expect(event.agents_dispatched).toEqual([]);
			expect(event.agents_missing).toEqual([]);
			expect(event.timestamp).toBeDefined();
		});

		test('adds warning when event file write fails', async () => {
			// Remove .swarm directory to cause event file write failure
			fs.rmSync(path.join(tempDir, '.swarm'), { recursive: true });

			// Create config
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

			ensureAgentSession('sess1');

			// Create .swarm directory structure with evidence (required by retrospective gate)
			// The .swarm directory itself will exist, so the retro check will pass,
			// but we'll make the events.jsonl unwritable to cause the warning
			fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
			writeRetroBundle(tempDir, 1, 'pass');
			writeGateEvidence(tempDir, 1);

			// Create events.jsonl as a directory instead of file to cause write failure
			fs.mkdirSync(path.join(tempDir, '.swarm', 'events.jsonl'), {
				recursive: true,
			});

			// This should NOT crash - just add a warning
			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.warnings.length).toBeGreaterThan(0);
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('failed to write phase complete event'),
				),
			).toBe(true);
		});
	});

	describe('empty delegation chain', () => {
		test('handles session with no agents dispatched', async () => {
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

			ensureAgentSession('sess1');
			// No agents recorded

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.agentsDispatched).toEqual([]);
		});
	});

	describe('sequential phase_complete calls', () => {
		test('second call only sees agents since last completion', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			// First completion - record coder
			recordPhaseAgentDispatch('sess1', 'coder');

			const result1 = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed1 = JSON.parse(result1);
			expect(parsed1.success).toBe(true);

			// After success, state is reset, so add new agents for phase 2
			recordPhaseAgentDispatch('sess1', 'coder');

			const result2 = await phase_complete.execute({
				phase: 2,
				sessionID: 'sess1',
			});
			const parsed2 = JSON.parse(result2);
			expect(parsed2.success).toBe(true);
		});

		test('phase scoping reset - different phases maintain separate state', async () => {
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

			ensureAgentSession('sess1');

			// Complete phase 1
			const result1 = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed1 = JSON.parse(result1);
			expect(parsed1.success).toBe(true);
			expect(parsed1.phase).toBe(1);

			// Verify phase tracking
			const session = swarmState.agentSessions.get('sess1');
			expect(session?.lastPhaseCompletePhase).toBe(1);

			// Complete phase 2
			const result2 = await phase_complete.execute({
				phase: 2,
				sessionID: 'sess1',
			});
			const parsed2 = JSON.parse(result2);
			expect(parsed2.success).toBe(true);
			expect(parsed2.phase).toBe(2);

			// Phase should be updated
			expect(session?.lastPhaseCompletePhase).toBe(2);
		});
	});

	describe('delegation chains integration', () => {
		test('uses both delegation chains and phaseAgentsDispatched', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder', 'reviewer'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			ensureAgentSession('sess1');

			// Set up delegation chain for coder
			swarmState.delegationChains.set('sess1', [
				{ from: 'architect', to: 'coder', timestamp: Date.now() - 5000 },
			]);

			// Add reviewer via phaseAgentsDispatched
			recordPhaseAgentDispatch('sess1', 'reviewer');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.agentsDispatched).toContain('coder');
			expect(parsed.agentsDispatched).toContain('reviewer');
		});
	});

	describe('timestamp and duration', () => {
		test('includes timestamp in result', async () => {
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

			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.timestamp).toBeDefined();
			expect(parsed.duration_ms).toBeDefined();
		});
	});

	describe('multi-session required-agent aggregation', () => {
		test('succeeds when required agents are split across multiple sessions in same phase window', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder', 'reviewer'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Session 1: has coder
			ensureAgentSession('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'coder');
			// Update lastToolCallTime to be recent (within phase window)
			swarmState.agentSessions.get('sess1')!.lastToolCallTime = Date.now();

			// Session 2: has reviewer
			ensureAgentSession('sess2', 'reviewer');
			recordPhaseAgentDispatch('sess2', 'reviewer');
			// Update lastToolCallTime to be recent (within phase window)
			swarmState.agentSessions.get('sess2')!.lastToolCallTime = Date.now();

			// Call phase_complete from sess1 - should aggregate coder from sess1 and reviewer from sess2
			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			expect(parsed.agentsDispatched).toContain('coder');
			expect(parsed.agentsDispatched).toContain('reviewer');
			expect(parsed.agentsMissing).toEqual([]);
		});

		test('fails when one required agent is truly missing across all sessions', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder', 'reviewer', 'test_engineer'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Session 1: has coder
			ensureAgentSession('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'coder');
			swarmState.agentSessions.get('sess1')!.lastToolCallTime = Date.now();

			// Session 2: has reviewer
			ensureAgentSession('sess2', 'reviewer');
			recordPhaseAgentDispatch('sess2', 'reviewer');
			swarmState.agentSessions.get('sess2')!.lastToolCallTime = Date.now();

			// test_engineer is missing from ALL sessions

			// Call phase_complete from sess1 - should detect test_engineer is missing
			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.agentsDispatched).toContain('coder');
			expect(parsed.agentsDispatched).toContain('reviewer');
			expect(parsed.agentsMissing).toContain('test_engineer');
		});

		test('resets contributor session phase-tracking state across sessions on success', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder', 'reviewer'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Session 1: has coder
			ensureAgentSession('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'coder');
			swarmState.agentSessions.get('sess1')!.lastToolCallTime = Date.now();

			// Session 2: has reviewer
			ensureAgentSession('sess2', 'reviewer');
			recordPhaseAgentDispatch('sess2', 'reviewer');
			swarmState.agentSessions.get('sess2')!.lastToolCallTime = Date.now();

			// Verify state before
			const sess1Before = swarmState.agentSessions.get('sess1');
			const sess2Before = swarmState.agentSessions.get('sess2');
			expect(sess1Before?.phaseAgentsDispatched.size).toBe(1);
			expect(sess2Before?.phaseAgentsDispatched.size).toBe(1);
			expect(sess1Before?.lastPhaseCompleteTimestamp).toBe(0);
			expect(sess2Before?.lastPhaseCompleteTimestamp).toBe(0);

			// Call phase_complete from sess1
			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Verify state reset for BOTH contributor sessions
			const sess1After = swarmState.agentSessions.get('sess1');
			const sess2After = swarmState.agentSessions.get('sess2');
			expect(sess1After?.phaseAgentsDispatched.size).toBe(0);
			expect(sess2After?.phaseAgentsDispatched.size).toBe(0);
			expect(sess1After?.lastPhaseCompleteTimestamp).toBeGreaterThan(0);
			expect(sess2After?.lastPhaseCompleteTimestamp).toBeGreaterThan(0);
			expect(sess1After?.lastPhaseCompletePhase).toBe(1);
			expect(sess2After?.lastPhaseCompletePhase).toBe(1);
		});

		test('does not reset state for sessions without recent activity', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Session 1: recent activity (caller) with established phase reference timestamp
			ensureAgentSession('sess1', 'coder');
			recordPhaseAgentDispatch('sess1', 'coder');
			swarmState.agentSessions.get('sess1')!.lastToolCallTime = Date.now();
			// Establish non-zero phase reference timestamp so stale session exclusion works
			swarmState.agentSessions.get('sess1')!.lastPhaseCompleteTimestamp =
				Date.now() - 60000;
			swarmState.agentSessions.get('sess1')!.lastPhaseCompletePhase = 0;

			// Session 2: stale activity (old session, should NOT be contributor)
			ensureAgentSession('sess2', 'reviewer');
			recordPhaseAgentDispatch('sess2', 'reviewer');
			// Set lastToolCallTime to old timestamp (outside phase window)
			swarmState.agentSessions.get('sess2')!.lastToolCallTime =
				Date.now() - 24 * 60 * 60 * 1000;

			// Call phase_complete from sess1
			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// sess1 should be reset
			const sess1After = swarmState.agentSessions.get('sess1');
			expect(sess1After?.phaseAgentsDispatched.size).toBe(0);

			// sess2 should NOT be reset (was not a contributor)
			const sess2After = swarmState.agentSessions.get('sess2');
			expect(sess2After?.phaseAgentsDispatched.size).toBe(1);
			expect(sess2After?.lastPhaseCompleteTimestamp).toBe(0);
		});

		test('ignores stale non-caller delegation chains even when the session has recent activity', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder', 'reviewer'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			const referenceTimestamp = Date.now();
			ensureAgentSession('caller');
			swarmState.agentSessions.get('caller')!.lastPhaseCompleteTimestamp =
				referenceTimestamp;

			ensureAgentSession('worker');
			swarmState.agentSessions.get('worker')!.lastToolCallTime =
				referenceTimestamp + 1000;
			swarmState.delegationChains.set('worker', [
				{
					from: 'architect',
					to: 'coder',
					timestamp: referenceTimestamp - 5000,
				},
				{
					from: 'coder',
					to: 'reviewer',
					timestamp: referenceTimestamp - 3000,
				},
				{
					from: 'architect',
					to: 'noop',
					timestamp: referenceTimestamp + 500,
				},
			]);

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'caller',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.agentsDispatched).not.toContain('coder');
			expect(parsed.agentsDispatched).not.toContain('reviewer');
			expect(parsed.agentsMissing).toContain('coder');
			expect(parsed.agentsMissing).toContain('reviewer');
		});

		test('includes restored session agents when lastPhaseCompleteTimestamp matches reference', async () => {
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['reviewer', 'test_engineer'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Create BOTH sessions before setting any stale timestamps.
			// ensureAgentSession calls startAgentSession for new sessions, which runs a
			// stale-session eviction loop (evicts sessions with lastToolCallTime > 2 hours ago).
			// Setting session-a's lastToolCallTime = 500 (epoch) BEFORE creating session-b
			// would cause session-a to be evicted during session-b creation.
			ensureAgentSession('session-a');
			ensureAgentSession('session-b');

			// Session A: has agents from before close/reopen, stale lastToolCallTime.
			// Set stale values AFTER session-b is created to avoid eviction.
			const sessionA = swarmState.agentSessions.get('session-a')!;
			sessionA.phaseAgentsDispatched = new Set(['reviewer', 'test_engineer']);
			sessionA.lastPhaseCompleteTimestamp = 1000; // matches reference
			sessionA.lastToolCallTime = 500; // old — before reference, fails hasRecentToolCalls

			// Session B (caller): phaseReferenceTimestamp will be lastPhaseCompleteTimestamp
			const sessionB = swarmState.agentSessions.get('session-b')!;
			sessionB.lastPhaseCompleteTimestamp = 1000; // same reference as session A
			sessionB.phaseAgentsDispatched = new Set();
			// lastToolCallTime updated by ensureAgentSession inside execute — no need to set here

			// Call phase_complete from session-b — should include session-a's agents
			// despite session-a having stale lastToolCallTime (hasRestoredAgents fires instead)
			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'session-b',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.agentsDispatched).toContain('reviewer');
			expect(parsed.agentsDispatched).toContain('test_engineer');
		});
	});

	describe('sessionID resolution from ToolContext', () => {
		test('resolves sessionID from ctx.sessionID when args.sessionID is absent', async () => {
			ensureAgentSession('ctx-session');
			recordPhaseAgentDispatch('ctx-session', 'coder');
			recordPhaseAgentDispatch('ctx-session', 'reviewer');
			recordPhaseAgentDispatch('ctx-session', 'test_engineer');
			recordPhaseAgentDispatch('ctx-session', 'docs');
			writeRetroBundle(tempDir, 1, 'pass');

			const ctx = mockCtx('ctx-session', tempDir);
			const result = await phase_complete.execute({ phase: 1 }, ctx);
			const parsed = JSON.parse(result);

			// Should succeed: sessionID resolved from ctx, not from args
			expect(parsed.success).toBe(true);
			expect(parsed.phase).toBe(1);
		});

		test('ctx.sessionID takes priority over args.sessionID when both are provided', async () => {
			ensureAgentSession('ctx-wins');
			recordPhaseAgentDispatch('ctx-wins', 'coder');
			recordPhaseAgentDispatch('ctx-wins', 'reviewer');
			recordPhaseAgentDispatch('ctx-wins', 'test_engineer');
			recordPhaseAgentDispatch('ctx-wins', 'docs');
			writeRetroBundle(tempDir, 1, 'pass');

			const ctx = mockCtx('ctx-wins', tempDir);
			const result = await phase_complete.execute(
				{ phase: 1, sessionID: 'args-ignored' },
				ctx,
			);
			const parsed = JSON.parse(result);

			// Should succeed using ctx-wins session (not args-ignored)
			// args-ignored was never registered as a session, but ctx-wins was
			expect(parsed.success).toBe(true);
			expect(parsed.phase).toBe(1);
		});
	});

	describe('plan.json phase status update on success', () => {
		test('updates plan.json phase status to completed on successful phase_complete', async () => {
			// Set up permissive config
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Create source file so completion-verify can find identifiers
			fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, 'src', 'setup.ts'),
				'export function setupProject() {}\n',
			);

			// Write plan.json with phase 1 status pending
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								description: 'Implement `setupProject` in src/setup.ts',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Read plan.json back and verify phase status updated
			const planAfter = JSON.parse(
				fs.readFileSync(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
			);
			expect(planAfter.phases[0].status).toBe('complete');
		});

		test('plan.json not found produces warning but success is still true', async () => {
			// Set up permissive config
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Do NOT write plan.json

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			// Should have warning about plan.json failure
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('failed to update plan.json'),
				),
			).toBe(true);
		});

		test('malformed plan.json produces warning but success is still true', async () => {
			// Set up permissive config
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Write malformed JSON to plan.json
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				'not valid json {{{',
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('failed to update plan.json'),
				),
			).toBe(true);
		});

		test('plan.json with no matching phase ID does not produce warning', async () => {
			// Set up permissive config
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Write plan.json with only phase 99 (no phase 1)
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 99,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [],
					},
					{
						id: 99,
						name: 'Phase 99',
						status: 'pending',
						tasks: [
							{
								id: '99.1',
								phase: 99,
								status: 'completed',
								description: 'Test task',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			// Should NOT have a warning about plan.json (phase just not found, silently skipped)
			expect(
				parsed.warnings.every(
					(w: string) => !w.includes('failed to update plan.json'),
				),
			).toBe(true);
		});
	});

	describe('plan.json agent dispatch fallback', () => {
		test('fallback does NOT activate when all tasks completed but gate evidence is missing', async () => {
			// Set up permissive config with required_agents
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Create source file so completion-verify can find identifiers
			fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, 'src', 'setup.ts'),
				'export function setupProject() {}\n',
			);

			// Write plan.json with phase 1 having ALL tasks completed
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								description: 'Implement `setupProject` in src/setup.ts',
							},
							{
								id: '1.2',
								phase: 1,
								status: 'completed',
								description: 'Implement `setupProject` in src/setup.ts',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			// Set up session with NO agents dispatched (agents missing)
			ensureAgentSession('sess1');
			// No recordPhaseAgentDispatch call - simulating session restart

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.agentsMissing).toContain('coder');
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('Agent dispatch fallback'),
				),
			).toBe(false);
		});

		test('fallback activates when all tasks completed and durable gate evidence passed', async () => {
			// Set up permissive config with required_agents
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Create source file so completion-verify can find identifiers
			fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, 'src', 'setup.ts'),
				'export function setupProject() {}\n',
			);

			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								description: 'Implement `setupProject` in src/setup.ts',
							},
							{
								id: '1.2',
								phase: 1,
								status: 'completed',
								description: 'Implement `setupProject` in src/setup.ts',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			await recordGateEvidence(tempDir, '1.1', 'reviewer', 'reviewer-sess');
			await recordGateEvidence(tempDir, '1.1', 'test_engineer', 'test-sess');
			await recordGateEvidence(tempDir, '1.2', 'reviewer', 'reviewer-sess');
			await recordGateEvidence(tempDir, '1.2', 'test_engineer', 'test-sess');

			// Set up session with NO agents dispatched, as after a session restart.
			ensureAgentSession('sess1');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('Agent dispatch fallback'),
				),
			).toBe(true);
		});

		test('fallback does NOT activate when tasks are incomplete', async () => {
			// Set up permissive config with required_agents
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Write plan.json with phase 1 having all pending tasks
			// No completed tasks avoids triggering completion-verify blocks
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [
							{ id: '1.1', phase: 1, status: 'pending', description: 'Task 1' },
							{ id: '1.2', phase: 1, status: 'pending', description: 'Task 2' },
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			// Set up session with NO agents dispatched
			ensureAgentSession('sess1');
			// No agents dispatched - should fail because tasks are incomplete

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.agentsMissing).toContain('coder');
			// Fallback should NOT trigger - no fallback warning
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('Agent dispatch fallback'),
				),
			).toBe(false);
		});

		test('fallback does NOT activate when phase has 0 tasks', async () => {
			// Set up permissive config with required_agents
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Write plan.json with phase 1 having empty tasks array
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			// Set up session with NO agents dispatched
			ensureAgentSession('sess1');
			// No agents dispatched - should fail because phase has 0 tasks (guard prevents fallback)

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			// Should fail because agents are still missing and fallback can't activate with 0 tasks
			expect(parsed.agentsMissing).toContain('coder');
			// Fallback should NOT trigger
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('Agent dispatch fallback'),
				),
			).toBe(false);
		});

		test('fallback does NOT activate when agents are already present', async () => {
			// Set up permissive config with required_agents
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Create source file so completion-verify can find identifiers
			fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, 'src', 'setup.ts'),
				'export function setupProject() {}\n',
			);

			// Write plan.json with phase 1 having all tasks completed
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								description: 'Implement `setupProject` in src/setup.ts',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			// Set up session WITH agents dispatched (agents ARE present)
			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			// Fallback should NOT trigger because agentsMissing.length === 0
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('Agent dispatch fallback'),
				),
			).toBe(false);
		});

		// ==== ADVERSARIAL TESTS ====
		test('ADVERSARY: malformed JSON in plan.json with missing agents - normal enforcement applies', async () => {
			// Set up permissive config with required_agents
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Write garbage to plan.json (malformed JSON)
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				'{ invalid json } garbage data',
			);

			// Set up session with NO agents dispatched
			ensureAgentSession('sess1');
			// No agents dispatched

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// JSON.parse throws, caught by try/catch, falls through to normal enforcement
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.agentsMissing).toContain('coder');
			// Fallback should NOT activate due to JSON parse error
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('Agent dispatch fallback'),
				),
			).toBe(false);
		});

		test('ADVERSARY: plan.json with null phases field - normal enforcement applies', async () => {
			// Set up permissive config with required_agents
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Write plan.json with null phases field
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify({ phases: null }),
			);

			// Set up session with NO agents dispatched
			ensureAgentSession('sess1');
			// No agents dispatched

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// .find() on null throws, caught by try/catch, falls through to normal enforcement
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.agentsMissing).toContain('coder');
			// Fallback should NOT activate due to null phases error
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('Agent dispatch fallback'),
				),
			).toBe(false);
		});

		test('ADVERSARY: plan.json with task having unexpected status value - fallback does NOT activate', async () => {
			// Set up permissive config with required_agents
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Write plan.json with task status = 'in_progress' (not 'completed')
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'in_progress',
								description: 'Task 1',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);

			// Set up session with NO agents dispatched
			ensureAgentSession('sess1');
			// No agents dispatched

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// .every() returns false because task status is not 'completed'
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.agentsMissing).toContain('coder');
			// Fallback should NOT activate because .every() returns false
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('Agent dispatch fallback'),
				),
			).toBe(false);
		});

		test('ADVERSARY: concurrent modification simulation - plan.json remains valid and phase status updated', async () => {
			// Set up permissive config with required_agents
			fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					phase_complete: {
						enabled: true,
						required_agents: ['coder'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);

			// Create source file so completion-verify can find identifiers
			fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, 'src', 'setup.ts'),
				'export function setupProject() {}\n',
			);

			// Write plan.json with phase 1 having ALL tasks completed
			const planJson = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								description: 'Implement `setupProject` in src/setup.ts',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(planJson, null, 2),
			);
			await recordGateEvidence(tempDir, '1.1', 'reviewer', 'reviewer-sess');
			await recordGateEvidence(tempDir, '1.1', 'test_engineer', 'test-sess');

			// Set up session with NO agents dispatched
			ensureAgentSession('sess1');
			// No agents dispatched, but durable gate evidence proves restart recovery is safe.

			const result = await phase_complete.execute({
				phase: 1,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			// Should succeed due to evidence-backed fallback
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('Agent dispatch fallback'),
				),
			).toBe(true);

			// Verify plan.json is still valid JSON (no corruption)
			const planPath = path.join(tempDir, '.swarm', 'plan.json');
			const planAfter = JSON.parse(fs.readFileSync(planPath, 'utf-8'));

			// Bug A fix should have updated phase status to 'complete'
			expect(planAfter.phases[0].status).toBe('complete');

			// Verify the JSON structure is still valid
			expect(planAfter.phases).toBeDefined();
			expect(Array.isArray(planAfter.phases)).toBe(true);
			expect(planAfter.phases[0].tasks).toBeDefined();
		});
	});

	describe('bypass behavior validation', () => {
		/**
		 * Test 1: Normal mode with spec + drift evidence missing → blocks with DRIFT_VERIFICATION_MISSING
		 */
		test('blocks with DRIFT_VERIFICATION_MISSING when spec.md exists but drift-verifier.json is missing', async () => {
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

			// Write spec.md to trigger drift gate enforcement
			fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'spec.md'),
				'# Test Spec\n\n## FR-01\nFeature requirement 1.\n',
			);

			// DO NOT write drift-verifier.json - missing evidence
			writeRetroBundle(tempDir, 3, 'pass');

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await executePhaseComplete(
				{ phase: 3, sessionID: 'sess1' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
			expect(parsed.message).toContain('drift verifier evidence not found');
		});

		/**
		 * Test 2: Normal mode without spec + drift evidence missing → succeeds with warning mentioning "No spec.md"
		 */
		test('succeeds with advisory warning when spec.md missing and drift evidence missing', async () => {
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

			// DO NOT write spec.md - no spec
			// DO NOT write drift-verifier.json - missing evidence
			writeRetroBundle(tempDir, 3, 'pass');

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await executePhaseComplete(
				{ phase: 3, sessionID: 'sess1' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			// Should have warning about missing spec.md
			expect(
				parsed.warnings.some((w: string) => w.includes('No spec.md')),
			).toBe(true);
		});

		/**
		 * Test 3: Turbo mode active → skips completion-verify and drift-verifier gates
		 */
		test('turbo mode skips completion-verify and drift-verifier gates with success', async () => {
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

			// Write spec.md to trigger drift gate enforcement (would normally require drift evidence)
			fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'spec.md'),
				'# Test Spec\n\n## FR-01\nFeature requirement 1.\n',
			);

			// DO NOT write drift-verifier.json - would normally block
			writeRetroBundle(tempDir, 3, 'pass');

			ensureAgentSession('sess1');
			// Enable turbo mode - this should bypass both completion-verify and drift-verifier gates
			swarmState.agentSessions.get('sess1')!.turboMode = true;
			recordPhaseAgentDispatch('sess1', 'coder');

			const originalWarn = console.warn;
			const originalError = console.error;
			const warnCalls: unknown[][] = [];
			const errorCalls: unknown[][] = [];
			console.warn = (...args: unknown[]) => {
				warnCalls.push(args);
			};
			console.error = (...args: unknown[]) => {
				errorCalls.push(args);
			};

			let parsed: {
				success: boolean;
				status: string;
				warnings: string[];
			};
			try {
				const result = await executePhaseComplete(
					{ phase: 3, sessionID: 'sess1' },
					tempDir,
				);
				parsed = JSON.parse(result);
			} finally {
				console.warn = originalWarn;
				console.error = originalError;
			}

			// Should succeed even without drift evidence because turbo mode bypasses gates
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			expect(
				parsed.warnings.some((warning) =>
					warning.includes('Turbo mode active'),
				),
			).toBe(true);
			expect(warnCalls).toHaveLength(0);
			expect(errorCalls).toHaveLength(0);
		});

		test('non-code drift skip uses result warnings instead of console info (F875)', async () => {
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(
					{
						schema_version: '1.0.0',
						title: 'Test Plan',
						swarm: 'test-swarm',
						current_phase: 3,
						migration_status: 'migrated',
						phases: [
							{
								id: 3,
								name: 'Phase 3',
								type: 'non-code',
								status: 'in_progress',
								tasks: [],
							},
						],
					},
					null,
					2,
				),
			);
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
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'spec.md'),
				'# Test Spec\n\n## FR-01\nFeature requirement 1.\n',
			);
			writeRetroBundle(tempDir, 3, 'pass');

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const originalInfo = console.info;
			const infoCalls: unknown[][] = [];
			console.info = (...args: unknown[]) => {
				infoCalls.push(args);
			};

			let parsed: {
				success: boolean;
				status: string;
				warnings: string[];
			};
			try {
				const result = await executePhaseComplete(
					{ phase: 3, sessionID: 'sess1' },
					tempDir,
				);
				parsed = JSON.parse(result);
			} finally {
				console.info = originalInfo;
			}

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			expect(
				parsed.warnings.some((warning) =>
					warning.includes("annotated as 'non-code'"),
				),
			).toBe(true);
			expect(infoCalls).toHaveLength(0);
		});

		/**
		 * Test 4: Curator disabled → phase_complete still succeeds, no curator-related warnings
		 */
		test('curator disabled - phase_complete succeeds without curator pipeline', async () => {
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
					curator: {
						enabled: false,
						phase_enabled: false,
					},
				}),
			);

			writeRetroBundle(tempDir, 3, 'pass');

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await executePhaseComplete(
				{ phase: 3, sessionID: 'sess1' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
			// No curator-related warnings should appear
			expect(parsed.warnings.every((w: string) => !w.includes('CURATOR'))).toBe(
				true,
			);
			expect(parsed.warnings.every((w: string) => !w.includes('curator'))).toBe(
				true,
			);
		});

		/**
		 * Test 5: Critic drift missing (spec exists, no drift-verifier.json) → blocks with DRIFT_VERIFICATION_MISSING
		 * This is the same as Test 1 but explicitly named to match requirements
		 */
		test('critic drift missing with spec present → blocks with DRIFT_VERIFICATION_MISSING', async () => {
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

			// Write spec.md to indicate critic drift verifier should have run
			fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'spec.md'),
				'# Test Spec\n\n## FR-01\nFeature requirement 1.\n',
			);

			// DO NOT write drift-verifier.json - critic drift check was never run
			writeRetroBundle(tempDir, 3, 'pass');

			ensureAgentSession('sess1');
			recordPhaseAgentDispatch('sess1', 'coder');

			const result = await executePhaseComplete(
				{ phase: 3, sessionID: 'sess1' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('blocked');
			expect(parsed.reason).toBe('DRIFT_VERIFICATION_MISSING');
			expect(parsed.message).toContain('drift verifier evidence not found');
			expect(parsed.message).toContain('Run drift verification');
		});
	});
});
