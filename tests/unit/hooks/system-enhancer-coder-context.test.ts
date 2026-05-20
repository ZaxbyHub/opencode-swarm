import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, readFileSync, rm, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createSystemEnhancerHook } from '../../../src/hooks/system-enhancer';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

// Mock knowledge-recall module at file scope
const mockExecute = mock(() => Promise.resolve('{"results":[],"total":0}'));

mock.module('../../../src/tools/knowledge-recall', () => ({
	knowledge_recall: {
		execute: mockExecute,
	},
}));

describe('Coder Context Pack (system-enhancer.ts lines 690-799)', () => {
	let tempDir: string;
	let hook: Record<string, unknown>;
	let transformHook: (input: any, output: any) => Promise<void>;

	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};

	const enabledConfig: PluginConfig = {
		...defaultConfig,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: false,
			delegation_max_chars: 1000,
		},
		context_budget: {
			enabled: false,
		},
	};

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-coder-context-'));
		resetSwarmState();

		// Reset mock
		mockExecute.mockClear();

		// Create .swarm directory
		await mkdir(join(tempDir, '.swarm'), { recursive: true });

		// Create hook
		hook = createSystemEnhancerHook(enabledConfig, tempDir);
		transformHook = hook['experimental.chat.system.transform'] as any;
	});

	afterEach(async () => {
		// CROSS-MODULE mock cleanup — no _internals seam in system-enhancer.ts for knowledge-recall
		mock.restore();
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		resetSwarmState();
	});

	/**
	 * Helper to invoke the transform hook with coder role
	 */
	async function invokeAsCoder(
		sessionId: string,
		taskId: string,
		primaryFile: string,
	) {
		// Set up active agent as coder
		swarmState.activeAgent.set(sessionId, 'paid_coder');

		// Use startAgentSession to properly initialize the session with all required fields
		startAgentSession(sessionId, 'paid_coder');

		// Then modify only the fields we need for this test
		const session = swarmState.agentSessions.get(sessionId)!;
		session.currentTaskId = taskId;
		session.declaredCoderScope = [primaryFile];

		const input = { sessionID: sessionId };
		const output = { system: ['Initial system prompt'] };

		await transformHook(input, output);
		return output.system;
	}

	// ============================================================================
	// Scenario 1: Knowledge recall returns results → block is injected
	// ============================================================================
	test('1. Knowledge recall returns results → knowledge block is injected', async () => {
		// Set up knowledge recall to return results
		mockExecute.mockImplementationOnce(() =>
			Promise.resolve(
				JSON.stringify({
					results: [
						{
							id: 'k1',
							lesson: 'Always use path.join for cross-platform paths',
							category: 'tooling',
							confidence: 0.95,
							score: 0.8,
						},
						{
							id: 'k2',
							lesson: 'Handle Promise rejections with try/catch',
							category: 'debugging',
							confidence: 0.88,
							score: 0.75,
						},
					],
					total: 2,
				}),
			),
		);

		const system = await invokeAsCoder(
			'session-kb-1',
			'task-1',
			'src/utils/paths.ts',
		);

		// Should have injected knowledge block
		const hasKnowledgeBlock = system.some((s) =>
			s.includes('## CONTEXT FROM KNOWLEDGE BASE'),
		);
		expect(hasKnowledgeBlock).toBe(true);

		// Verify knowledge recall was called with primary file
		expect(mockExecute).toHaveBeenCalledTimes(1);
	});

	// ============================================================================
	// Scenario 2: Knowledge recall returns empty → block is empty (no injection)
	// ============================================================================
	test('2. Knowledge recall returns empty → no knowledge block injected', async () => {
		// Set up knowledge recall to return empty results
		mockExecute.mockImplementationOnce(() =>
			Promise.resolve(JSON.stringify({ results: [], total: 0 })),
		);

		const system = await invokeAsCoder(
			'session-kb-2',
			'task-2',
			'src/utils/paths.ts',
		);

		// Should NOT have knowledge block
		const hasKnowledgeBlock = system.some((s) =>
			s.includes('## CONTEXT FROM KNOWLEDGE BASE'),
		);
		expect(hasKnowledgeBlock).toBe(false);
	});

	// ============================================================================
	// Scenario 3: Evidence file doesn't exist → rejection block empty (no crash)
	// ============================================================================
	test('3. Evidence file does not exist → no rejection block, no crash', async () => {
		// No evidence file is created - existsSync will return false for non-existent paths

		// Knowledge recall returns empty to isolate rejection test
		mockExecute.mockImplementationOnce(() =>
			Promise.resolve(JSON.stringify({ results: [], total: 0 })),
		);

		// Should not throw
		const system = await invokeAsCoder(
			'session-no-evidence',
			'task-no-evidence',
			'src/utils/paths.ts',
		);

		// Should NOT have rejection block
		const hasRejectionBlock = system.some((s) =>
			s.includes('## PRIOR REJECTIONS'),
		);
		expect(hasRejectionBlock).toBe(false);
	});

	// ============================================================================
	// Scenario 4: Evidence file has no reviewer rejections → rejection block empty
	// ============================================================================
	test('4. Evidence file exists but has no reviewer rejections → no rejection block', async () => {
		// Create evidence file with no reviewer rejections (only linter gate that passes)
		const evidenceData = {
			bundle: {
				entries: [
					{
						type: 'gate',
						gate_type: 'linter',
						verdict: 'pass',
						reason: 'No issues found',
					},
					{
						type: 'gate',
						gate_type: 'test',
						verdict: 'fail',
						reason: 'Tests failed',
					},
				],
			},
		};

		const evidenceDir = join(tempDir, '.swarm', 'evidence');
		await mkdir(evidenceDir, { recursive: true });
		writeFileSync(
			join(evidenceDir, 'task-no-rejections.json'),
			JSON.stringify(evidenceData),
		);

		// Knowledge recall returns empty to isolate rejection test
		mockExecute.mockImplementationOnce(() =>
			Promise.resolve(JSON.stringify({ results: [], total: 0 })),
		);

		const system = await invokeAsCoder(
			'session-no-rejections',
			'task-no-rejections',
			'src/utils/paths.ts',
		);

		// Should NOT have rejection block (no reviewer verdicts = reject)
		const hasRejectionBlock = system.some((s) =>
			s.includes('## PRIOR REJECTIONS'),
		);
		expect(hasRejectionBlock).toBe(false);
	});

	// ============================================================================
	// Scenario 5: Both knowledge and rejections present → both injected correctly
	// ============================================================================
	test('5. Both knowledge and rejections present → both blocks injected correctly', async () => {
		// Set up knowledge recall to return results
		mockExecute.mockImplementationOnce(() =>
			Promise.resolve(
				JSON.stringify({
					results: [
						{
							id: 'k1',
							lesson: 'Remember to handle edge cases in loops',
							category: 'debugging',
							confidence: 0.9,
							score: 0.8,
						},
					],
					total: 1,
				}),
			),
		);

		// Set up evidence file with reviewer rejections
		const evidenceData = {
			bundle: {
				entries: [
					{
						type: 'gate',
						gate_type: 'reviewer',
						verdict: 'reject',
						reason: 'Missing null check on line 42',
					},
					{
						type: 'gate',
						gate_type: 'reviewer',
						verdict: 'reject',
						reason: 'Inefficient algorithm detected',
					},
				],
			},
		};

		const evidenceDir = join(tempDir, '.swarm', 'evidence');
		await mkdir(evidenceDir, { recursive: true });
		writeFileSync(
			join(evidenceDir, 'task-both.json'),
			JSON.stringify(evidenceData),
		);

		const system = await invokeAsCoder(
			'session-both',
			'task-both',
			'src/utils/paths.ts',
		);

		// Should have BOTH knowledge block AND rejection block
		const hasKnowledgeBlock = system.some((s) =>
			s.includes('## CONTEXT FROM KNOWLEDGE BASE'),
		);
		const hasRejectionBlock = system.some((s) =>
			s.includes('## PRIOR REJECTIONS'),
		);

		expect(hasKnowledgeBlock).toBe(true);
		expect(hasRejectionBlock).toBe(true);

		// Verify the knowledge block contains the lesson
		const knowledgeText = system.find((s) =>
			s.includes('## CONTEXT FROM KNOWLEDGE BASE'),
		);
		expect(knowledgeText).toContain('Remember to handle edge cases');
		expect(knowledgeText).toContain('[debugging]');

		// Verify the rejection block contains the reasons
		const rejectionText = system.find((s) => s.includes('## PRIOR REJECTIONS'));
		expect(rejectionText).toContain('Missing null check on line 42');
		expect(rejectionText).toContain('Inefficient algorithm detected');
	});

	// ============================================================================
	// Additional edge case: non-coder role should not receive context pack
	// ============================================================================
	test('non-coder role should not receive context pack injection', async () => {
		// Set up as reviewer instead of coder
		swarmState.activeAgent.set('session-reviewer', 'paid_reviewer');

		// Use startAgentSession to properly initialize the session with all required fields
		startAgentSession('session-reviewer', 'paid_reviewer');

		// Then modify only the fields we need for this test
		const session = swarmState.agentSessions.get('session-reviewer')!;
		session.currentTaskId = 'task-reviewer';
		session.declaredCoderScope = ['src/utils/paths.ts'];

		const input = { sessionID: 'session-reviewer' };
		const output = { system: ['Initial system prompt'] };

		await transformHook(input, output);

		// Knowledge recall should NOT have been called
		expect(mockExecute).toHaveBeenCalledTimes(0);

		// Neither block should be present
		const hasKnowledgeBlock = output.system.some((s) =>
			s.includes('## CONTEXT FROM KNOWLEDGE BASE'),
		);
		const hasRejectionBlock = output.system.some((s) =>
			s.includes('## PRIOR REJECTIONS'),
		);
		expect(hasKnowledgeBlock).toBe(false);
		expect(hasRejectionBlock).toBe(false);
	});

	// ============================================================================
	// Edge case: truncated long lessons (>200 chars)
	// ============================================================================
	test('long lessons are truncated to 200 characters', async () => {
		const longLesson =
			'This is a very long lesson that exceeds two hundred characters and should be truncated to avoid consuming too much context budget. It continues on and on with more details about the best practices for handling complex scenarios in distributed systems.';

		mockExecute.mockImplementationOnce(() =>
			Promise.resolve(
				JSON.stringify({
					results: [
						{
							id: 'k-long',
							lesson: longLesson,
							category: 'architecture',
							confidence: 0.95,
							score: 0.9,
						},
					],
					total: 1,
				}),
			),
		);

		const system = await invokeAsCoder(
			'session-long',
			'task-long',
			'src/utils/paths.ts',
		);

		const knowledgeText = system.find((s) =>
			s.includes('## CONTEXT FROM KNOWLEDGE BASE'),
		);
		expect(knowledgeText).toBeDefined();

		// The lesson should be truncated with "..."
		expect(knowledgeText).toContain('...');

		// The line prefix is "- [architecture] " = 17 chars
		// Lesson is truncated to 200 chars, so total = 17 + 200 + "..." = 220
		// The entire knowledge block should be longer than just the truncated lesson line
		const truncatedPart = knowledgeText!.split(
			'## CONTEXT FROM KNOWLEDGE BASE',
		)[1];
		// Should contain "...", indicating truncation happened
		expect(truncatedPart).toContain('...');
	});

	// ============================================================================
	// Edge case: empty primary file → no knowledge recall
	// ============================================================================
	test('empty primary file → no knowledge recall call', async () => {
		// Set up session with empty primary file
		swarmState.activeAgent.set('session-empty', 'paid_coder');
		startAgentSession('session-empty', 'paid_coder');
		const session = swarmState.agentSessions.get('session-empty')!;
		session.currentTaskId = 'task-empty';
		session.declaredCoderScope = ['']; // Empty string

		const input = { sessionID: 'session-empty' };
		const output = { system: ['Initial system prompt'] };

		await transformHook(input, output);

		// Knowledge recall should NOT have been called because primaryFile is empty
		expect(mockExecute).toHaveBeenCalledTimes(0);

		// No knowledge block
		const hasKnowledgeBlock = output.system.some((s) =>
			s.includes('## CONTEXT FROM KNOWLEDGE BASE'),
		);
		expect(hasKnowledgeBlock).toBe(false);
	});

	// ============================================================================
	// Edge case: evidence file with malformed JSON → graceful handling
	// ============================================================================
	test('malformed evidence JSON → graceful handling (no crash)', async () => {
		// Create malformed evidence file
		const evidenceDir = join(tempDir, '.swarm', 'evidence');
		await mkdir(evidenceDir, { recursive: true });
		writeFileSync(join(evidenceDir, 'task-malformed.json'), 'not valid json {');

		// Knowledge recall returns empty
		mockExecute.mockImplementationOnce(() =>
			Promise.resolve(JSON.stringify({ results: [], total: 0 })),
		);

		// Should not throw despite malformed JSON
		const system = await invokeAsCoder(
			'session-malformed',
			'task-malformed',
			'src/utils/paths.ts',
		);

		// Should have empty rejection block (caught by try/catch)
		const hasRejectionBlock = system.some((s) =>
			s.includes('## PRIOR REJECTIONS'),
		);
		expect(hasRejectionBlock).toBe(false);

		// But also shouldn't crash - knowledge block should still work
		const hasKnowledgeBlock = system.some((s) =>
			s.includes('## CONTEXT FROM KNOWLEDGE BASE'),
		);
		expect(hasKnowledgeBlock).toBe(false); // Empty knowledge recall
	});

	// ============================================================================
	// Environment prompt injection for coder
	// ============================================================================
	test('coder receives environment profile prompt injection', async () => {
		mockExecute.mockImplementationOnce(() =>
			Promise.resolve(JSON.stringify({ results: [], total: 0 })),
		);

		const system = await invokeAsCoder(
			'session-env-coder',
			'task-env',
			'src/utils/paths.ts',
		);

		// Environment prompt should be injected for coder agents
		const hasEnvPrompt = system.some(
			(s) =>
				s.includes('ENVIRONMENT') ||
				s.includes('Command Policy') ||
				s.includes('posix-native') ||
				s.includes('powershell-native'),
		);
		expect(hasEnvPrompt).toBe(true);
	});

	// ============================================================================
	// Non-coder role should NOT receive environment profile injection
	// ============================================================================
	test('architect does NOT receive environment profile injection', async () => {
		swarmState.activeAgent.set('session-env-arch', 'paid_architect');
		startAgentSession('session-env-arch', 'paid_architect');

		const input = { sessionID: 'session-env-arch' };
		const output = { system: ['Initial system prompt'] };

		await transformHook(input, output);

		// Environment prompt should NOT be injected for architect agents
		const hasEnvPrompt = output.system.some(
			(s) => s.includes('posix-native') || s.includes('powershell-native'),
		);
		expect(hasEnvPrompt).toBe(false);
	});
});
