import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { ToolResult } from './create-tool';

// Test utilities
function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-analyze-test-'));
	return dir;
}

function cleanupDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function createSwarmDir(dir: string): string {
	const swarmDir = path.join(dir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	return swarmDir;
}

// Helper to extract string from ToolResult
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

// Helper to call tool execute with proper context (bypasses strict type requirements for testing)
async function executeTool(
	args: Record<string, unknown>,
	directory: string,
): Promise<string> {
	const result = (await curator_analyze.execute(args, {
		directory,
	} as unknown as ToolContext)) as unknown as ToolResult;
	return resultToString(result);
}

// Extract mock functions before mock.module() calls so they can be cleared
const mockRunCuratorPhase = mock(async () => ({
	phase: 1,
	digest: {
		phase: 1,
		timestamp: '2026-01-01',
		summary: 'Test digest',
		agents_used: ['coder'],
		tasks_completed: 2,
		tasks_total: 3,
		key_decisions: [],
		blockers_resolved: [],
	},
	compliance: [
		{
			phase: 1,
			timestamp: '2026-01-01',
			type: 'missing_reviewer',
			description: 'No reviewer dispatched',
			severity: 'warning',
		},
	],
	knowledge_recommendations: [],
	summary_updated: true,
}));

const mockApplyCuratorKnowledgeUpdates = mock(async () => ({
	applied: 2,
	skipped: 0,
}));

const mockLoadPluginConfigWithMeta = mock(() => ({
	config: { curator: { enabled: true, phase_enabled: true } },
	meta: { path: '/tmp/test' },
}));

// Mock modules before importing curator_analyze
const realCurator = await import('../hooks/curator.js');
mock.module('../hooks/curator.js', () => ({
	...realCurator,
	runCuratorPhase: mockRunCuratorPhase,
	applyCuratorKnowledgeUpdates: mockApplyCuratorKnowledgeUpdates,
}));

const realConfig = await import('../config/index.js');
mock.module('../config/index.js', () => ({
	...realConfig,
	loadPluginConfigWithMeta: mockLoadPluginConfigWithMeta,
}));

const mockBuildRejectedReceipt = mock(() => ({}));
const mockBuildApprovedReceipt = mock(() => ({}));
mock.module('../hooks/review-receipt.js', () => ({
	buildRejectedReceipt: mockBuildRejectedReceipt,
	buildApprovedReceipt: mockBuildApprovedReceipt,
	persistReviewReceipt: mock(() => Promise.resolve()),
}));

// Dynamically import SUT after mocks are established
const { curator_analyze } = await import('./curator-analyze');

describe('curator_analyze tool', () => {
	let tempDir: string;

	beforeEach(() => {
		mockRunCuratorPhase.mockClear();
		mockApplyCuratorKnowledgeUpdates.mockClear();
		mockLoadPluginConfigWithMeta.mockClear();
		tempDir = createTempDir();
		createSwarmDir(tempDir);
	});

	afterEach(() => {
		cleanupDir(tempDir);
	});

	describe('Without recommendations', () => {
		it('returns phase_digest and compliance_count', async () => {
			const result = await executeTool({ phase: 1 }, tempDir);

			const parsed = JSON.parse(result);

			expect(parsed.phase_digest).toBeDefined();
			expect(parsed.phase_digest.phase).toBe(1);
			expect(parsed.phase_digest.summary).toBe('Test digest');
			expect(parsed.compliance_count).toBe(1);
			expect(parsed.applied).toBe(0);
			expect(parsed.skipped).toBe(0);
		});

		it('returns applied=0 and skipped=0 when no recommendations provided', async () => {
			const result = await executeTool({ phase: 1 }, tempDir);

			const parsed = JSON.parse(result);

			expect(parsed.applied).toBe(0);
			expect(parsed.skipped).toBe(0);
		});

		it('calls buildRejectedReceipt when compliance warnings exist', async () => {
			mockBuildRejectedReceipt.mockClear();
			mockBuildApprovedReceipt.mockClear();
			await executeTool({ phase: 1 }, tempDir);
			expect(mockBuildRejectedReceipt).toHaveBeenCalled();
			expect(mockBuildApprovedReceipt).not.toHaveBeenCalled();
		});
	});

	describe('With recommendations', () => {
		it('calls applyCuratorKnowledgeUpdates and returns applied/skipped', async () => {
			const recommendations = [
				{
					action: 'promote' as const,
					lesson: 'Test lesson',
					reason: 'Test reason',
				},
			];

			const result = await executeTool({ phase: 1, recommendations }, tempDir);

			const parsed = JSON.parse(result);

			expect(parsed.applied).toBe(2);
			expect(parsed.skipped).toBe(0);
			expect(parsed.phase_digest).toBeDefined();
			expect(parsed.compliance_count).toBe(1);
		});
	});

	describe('Error handling', () => {
		it('returns error JSON format (verified via validation path) for invalid phase', async () => {
			// Error JSON format is verified by the validation path — phase < 1 triggers error return
			const result = await executeTool({ phase: -1 }, tempDir);
			const parsed = JSON.parse(result);
			// Error path returns {error: string} not {phase_digest, compliance_count}
			expect(parsed.error).toBeDefined();
			expect(parsed.phase_digest).toBeUndefined();
		});
	});

	describe('Arg schema validation', () => {
		it('phase must be >= 1', async () => {
			// phase=0 should be rejected by schema
			const result = await executeTool({ phase: 0 }, tempDir);

			// Schema validation should fail - result should indicate error
			const parsed = JSON.parse(result);
			expect(parsed.error || parsed.message).toBeDefined();
		});

		it('recommendations array must have valid action values', async () => {
			// Invalid action value should be rejected by schema
			const result = await executeTool(
				{
					phase: 1,
					recommendations: [
						{
							action: 'invalid_action' as unknown as 'promote',
							lesson: 'Test',
							reason: 'Test',
						},
					],
				},
				tempDir,
			);

			// Schema validation should fail
			const parsed = JSON.parse(result);
			expect(parsed.error || parsed.message).toBeDefined();
		});

		it('accepts valid phase number', async () => {
			const result = await executeTool({ phase: 5 }, tempDir);

			const parsed = JSON.parse(result);

			expect(parsed.phase_digest).toBeDefined();
			expect(parsed.error).toBeUndefined();
		});

		it('accepts valid recommendations with all action types', async () => {
			const recommendations = [
				{ action: 'promote', lesson: 'L1', reason: 'R1' },
				{
					action: 'archive',
					entry_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
					lesson: 'L2',
					reason: 'R2',
				},
				{ action: 'flag_contradiction', lesson: 'L3', reason: 'R3' },
			];

			const result = await executeTool({ phase: 1, recommendations }, tempDir);

			const parsed = JSON.parse(result);

			expect(parsed.applied).toBe(2);
			expect(parsed.skipped).toBe(0);
		});
	});
});
