/**
 * Tests for handleHandoffCommand — continuation prompt behavior.
 *
 * Verifies that handoff now:
 *   - Returns a "## Continuation Prompt" section with fenced code block
 *   - Writes .swarm/handoff-prompt.md as a dedicated artifact
 *   - References the artifact path in the return message
 *   - Calls formatContinuationPrompt with the handoff data
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Mock data ────────────────────────────────────────────────────────

const MOCK_HANDOFF_DATA = {
	generated: '2024-01-01T00:00:00.000Z',
	currentPhase: 'Phase 2',
	currentTask: '2.1',
	incompleteTasks: ['2.1', '2.2', '2.3'],
	pendingQA: null,
	activeAgent: 'architect',
	recentDecisions: ['Decision A', 'Decision B', 'Decision C'],
	delegationState: null,
};

const MOCK_HANDOFF_MARKDOWN = '## Swarm Handoff\nTest handoff markdown content';
const MOCK_CONTINUATION_PROMPT =
	'```markdown\n**Phase**: Phase 2\n**Current Task**: 2.1\n```';

// ── Mocks (must precede the dynamic import) ──────────────────────────

const mockGetHandoffData = mock(async () => MOCK_HANDOFF_DATA);
const mockFormatHandoffMarkdown = mock(
	(_data: unknown) => MOCK_HANDOFF_MARKDOWN,
);
const mockFormatContinuationPrompt = mock(
	(_data: unknown) => MOCK_CONTINUATION_PROMPT,
);
const mockWriteSnapshot = mock(async () => {});
const mockFlushPendingSnapshot = mock(async () => {});
const mockSwarmState = {
	agentSessions: new Map(),
	delegationChains: new Map(),
};

mock.module('../../../src/services/handoff-service.js', () => ({
	getHandoffData: mockGetHandoffData,
	formatHandoffMarkdown: mockFormatHandoffMarkdown,
	formatContinuationPrompt: mockFormatContinuationPrompt,
}));

mock.module('../../../src/session/snapshot-writer.js', () => ({
	writeSnapshot: mockWriteSnapshot,
	flushPendingSnapshot: mockFlushPendingSnapshot,
}));

mock.module('../../../src/state.js', () => ({
	swarmState: mockSwarmState,
}));

// ── Import under test ────────────────────────────────────────────────
const { handleHandoffCommand } = await import(
	'../../../src/commands/handoff.js'
);

// ── Test suites ──────────────────────────────────────────────────────

let testDir: string;

describe('handleHandoffCommand — continuation prompt', () => {
	beforeEach(() => {
		mockGetHandoffData.mockClear();
		mockFormatHandoffMarkdown.mockClear();
		mockFormatContinuationPrompt.mockClear();
		mockWriteSnapshot.mockClear();
		mockFlushPendingSnapshot.mockClear();
		testDir = mkdtempSync(path.join(os.tmpdir(), 'handoff-continuation-test-'));
		mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		mock.restore();
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it('returned markdown contains a "## Continuation Prompt" section', async () => {
		const result = await handleHandoffCommand(testDir, []);

		expect(result).toContain('## Continuation Prompt');
	});

	it('returned markdown contains the fenced code block from formatContinuationPrompt', async () => {
		const result = await handleHandoffCommand(testDir, []);

		expect(result).toContain(MOCK_CONTINUATION_PROMPT);
		expect(result).toContain('```markdown');
		expect(result).toContain('**Phase**: Phase 2');
	});

	it('writes .swarm/handoff-prompt.md as an artifact', async () => {
		await handleHandoffCommand(testDir, []);

		const promptPath = path.join(testDir, '.swarm', 'handoff-prompt.md');
		expect(existsSync(promptPath)).toBe(true);
	});

	it('content of handoff-prompt.md matches the formatContinuationPrompt output', async () => {
		await handleHandoffCommand(testDir, []);

		const promptPath = path.join(testDir, '.swarm', 'handoff-prompt.md');
		const content = readFileSync(promptPath, 'utf-8');
		expect(content).toBe(MOCK_CONTINUATION_PROMPT);
	});

	it('return message does not contain "continue the previous work"', async () => {
		const result = await handleHandoffCommand(testDir, []);

		expect(result).not.toContain('continue the previous work');
	});

	it('return message references .swarm/handoff-prompt.md', async () => {
		const result = await handleHandoffCommand(testDir, []);

		expect(result).toContain('.swarm/handoff-prompt.md');
	});

	it('formatContinuationPrompt is called with the handoff data', async () => {
		await handleHandoffCommand(testDir, []);

		expect(mockFormatContinuationPrompt).toHaveBeenCalledTimes(1);
		expect(mockFormatContinuationPrompt).toHaveBeenCalledWith(
			MOCK_HANDOFF_DATA,
		);
	});
});
