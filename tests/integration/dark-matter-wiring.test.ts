/**
 * Dark matter pipeline wiring integration tests
 *
 * Verifies the dark matter detection pipeline is properly wired:
 * 1. co_change_analyzer is registered in tool registry
 * 2. system-enhancer triggers dark matter scan in DISCOVER mode
 * 3. Repos without git skip silently
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AGENT_TOOL_MAP } from '../../src/config/constants';
import type { PluginConfig } from '../../src/config/schema';
import type { CoChangeEntry } from '../../src/tools/co-change-analyzer';
import { co_change_analyzer } from '../../src/tools/index';
import { TOOL_NAMES } from '../../src/tools/tool-names';

// Track calls to detectDarkMatter for verification
const detectDarkMatterCalls: Array<{ directory: string; options: unknown }> =
	[];
const formatDarkMatterOutputCalls: Array<CoChangeEntry[]> = [];
const darkMatterToKnowledgeEntriesCalls: Array<{
	pairs: CoChangeEntry[];
	projectName: string;
}> = [];

// Mock co-change-analyzer module
const mockDetectDarkMatter = mock(
	async (directory: string, options?: unknown) => {
		detectDarkMatterCalls.push({ directory, options });
		return [];
	},
);

const mockFormatDarkMatterOutput = mock((pairs: CoChangeEntry[]) => {
	formatDarkMatterOutputCalls.push(pairs);
	if (pairs.length === 0) {
		return '## Dark Matter: Hidden Couplings\n\nNo hidden couplings detected.';
	}
	return `## Dark Matter: Hidden Couplings\n\nFound ${pairs.length} co-change patterns:\n${pairs.map((p) => `- ${p.fileA} <-> ${p.fileB} (NPMI: ${p.npmi})`).join('\n')}`;
});

const mockDarkMatterToKnowledgeEntries = mock(
	(
		pairs: CoChangeEntry[],
		projectName: string,
	): Array<{ lesson: string; category: string; tags: string[] }> => {
		darkMatterToKnowledgeEntriesCalls.push({ pairs, projectName });
		return pairs.slice(0, 10).map((pair) => ({
			lesson: `Files ${pair.fileA} and ${pair.fileB} co-change with NPMI=${pair.npmi.toFixed(3)}`,
			category: 'architecture' as const,
			tags: ['co-change', 'hidden-coupling'],
		}));
	},
);

// Mock knowledge-store module
const mockAppendKnowledge = mock(async () => {});
const mockResolveSwarmKnowledgePath = mock(
	() => '/test/.swarm/knowledge.jsonl',
);
const mockReadKnowledge = mock(async () => []);

mock.module('../../src/tools/co-change-analyzer.js', () => ({
	detectDarkMatter: mockDetectDarkMatter,
	formatDarkMatterOutput: mockFormatDarkMatterOutput,
	darkMatterToKnowledgeEntries: mockDarkMatterToKnowledgeEntries,
}));

mock.module('../../src/hooks/knowledge-store.js', () => ({
	resolveSwarmKnowledgePath: mockResolveSwarmKnowledgePath,
	readKnowledge: mockReadKnowledge,
	appendKnowledge: mockAppendKnowledge,
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
}));

// Import after mock setup
const { detectArchitectMode, createSystemEnhancerHook } = await import(
	'../../src/hooks/system-enhancer'
);

describe('co_change_analyzer registration', () => {
	describe('TOOL_NAMES registration', () => {
		test('co_change_analyzer appears in TOOL_NAMES', () => {
			expect(TOOL_NAMES).toContain('co_change_analyzer');
		});

		test('TOOL_NAMES has no duplicates', () => {
			const occurrences = TOOL_NAMES.filter(
				(name) => name === 'co_change_analyzer',
			);
			expect(occurrences).toHaveLength(1);
		});
	});

	describe('AGENT_TOOL_MAP registration', () => {
		test('co_change_analyzer is in AGENT_TOOL_MAP.architect', () => {
			const architectTools = AGENT_TOOL_MAP.architect;
			expect(architectTools).toContain('co_change_analyzer');
		});

		test('co_change_analyzer is only in architect agent', () => {
			const allAgentTools = Object.values(AGENT_TOOL_MAP).flat();
			const coChangeAnalyzerAgents = (
				Object.keys(AGENT_TOOL_MAP) as Array<keyof typeof AGENT_TOOL_MAP>
			).filter((agent) => AGENT_TOOL_MAP[agent].includes('co_change_analyzer'));

			expect(coChangeAnalyzerAgents).toEqual(['architect']);
		});
	});

	describe('tool export verification', () => {
		test('co_change_analyzer is exported from src/tools/index.ts', () => {
			expect(co_change_analyzer).toBeDefined();
			expect(typeof co_change_analyzer).toBe('object');
		});

		test('co_change_analyzer has required tool properties', () => {
			expect(co_change_analyzer).toHaveProperty('description');
			expect(typeof co_change_analyzer.description).toBe('string');
			expect(co_change_analyzer.description.length).toBeGreaterThan(0);

			expect(co_change_analyzer).toHaveProperty('args');
			expect(typeof co_change_analyzer.args).toBe('object');

			expect(co_change_analyzer).toHaveProperty('execute');
			expect(typeof co_change_analyzer.execute).toBe('function');
		});
	});
});

describe('system-enhancer dark matter trigger', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), 'dark-matter-wiring-'));
		detectDarkMatterCalls.length = 0;
		formatDarkMatterOutputCalls.length = 0;
		darkMatterToKnowledgeEntriesCalls.length = 0;
		mockDetectDarkMatter.mockClear();
		mockFormatDarkMatterOutput.mockClear();
		mockDarkMatterToKnowledgeEntries.mockClear();
		mockAppendKnowledge.mockClear();
		mockReadKnowledge.mockClear();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('detectArchitectMode returns DISCOVER when no plan exists', async () => {
		// Create .swarm directory but no plan
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		const mode = await detectArchitectMode(tempDir);
		expect(mode).toBe('DISCOVER');
	});

	test('system-enhancer hook triggers detectDarkMatter', async () => {
		// Create .swarm directory
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		// Create the system-enhancer hook and invoke it
		const hook = createSystemEnhancerHook({} as PluginConfig, tempDir);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string; model?: unknown },
			output: { system: string[] },
		) => Promise<void>;

		// Invoke the hook which triggers dark matter scan
		await transform({ sessionID: 'test-session' }, { system: [] });

		// Verify detectDarkMatter was called through the hook
		expect(mockDetectDarkMatter).toHaveBeenCalled();
		expect(detectDarkMatterCalls.length).toBeGreaterThan(0);
		expect(detectDarkMatterCalls[0].directory).toBe(tempDir);
	});

	test('system-enhancer writes dark-matter.md when co-changes found', async () => {
		// Create .swarm directory
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		// Set up mock to return co-change pairs
		const mockPairs: CoChangeEntry[] = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 5,
				npmi: 0.75,
				lift: 2.5,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 30,
				commitsB: 25,
			},
		];

		// Configure mock to return the pairs
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		// Create and invoke the system-enhancer hook
		const hook = createSystemEnhancerHook({} as PluginConfig, tempDir);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string; model?: unknown },
			output: { system: string[] },
		) => Promise<void>;

		await transform({ sessionID: 'test-session' }, { system: [] });

		// Verify formatDarkMatterOutput was called
		expect(mockFormatDarkMatterOutput).toHaveBeenCalled();
		expect(formatDarkMatterOutputCalls.length).toBeGreaterThan(0);

		// Verify dark-matter.md was written
		const darkMatterPath = path.join(tempDir, '.swarm', 'dark-matter.md');
		expect(fs.existsSync(darkMatterPath)).toBe(true);
		const content = fs.readFileSync(darkMatterPath, 'utf-8');
		expect(content).toContain('src/a.ts');
		expect(content).toContain('src/b.ts');
	});

	test('system-enhancer generates knowledge entries from dark matter results', async () => {
		// Create .swarm directory
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		const mockPairs: CoChangeEntry[] = [
			{
				fileA: 'src/service.ts',
				fileB: 'src/repository.ts',
				coChangeCount: 8,
				npmi: 0.82,
				lift: 3.2,
				hasStaticEdge: false,
				totalCommits: 150,
				commitsA: 45,
				commitsB: 40,
			},
		];

		// Set up mock to return pairs
		mockDetectDarkMatter.mockImplementation(async () => mockPairs);

		// Create and invoke the system-enhancer hook
		const hook = createSystemEnhancerHook({} as PluginConfig, tempDir);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string; model?: unknown },
			output: { system: string[] },
		) => Promise<void>;

		await transform({ sessionID: 'test-session' }, { system: [] });

		// Verify darkMatterToKnowledgeEntries was called
		expect(mockDarkMatterToKnowledgeEntries).toHaveBeenCalled();
		expect(darkMatterToKnowledgeEntriesCalls.length).toBeGreaterThan(0);

		// Verify the call arguments
		const call = darkMatterToKnowledgeEntriesCalls[0];
		expect(call.pairs).toEqual(mockPairs);
	});
});

describe('repos without git skip silently', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), 'dark-matter-no-git-'));
		detectDarkMatterCalls.length = 0;
		mockDetectDarkMatter.mockClear();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('system-enhancer writes dark-matter.md even when detectDarkMatter returns empty (#1021)', async () => {
		// Empty results must still be cached to prevent repeated O(n²) recomputation
		const darkMatterPath = path.join(tempDir, '.swarm', 'dark-matter.md');

		// Create .swarm directory
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		// Explicitly set mock to return empty array (mockClear only clears calls, not implementation)
		mockDetectDarkMatter.mockImplementation(async () => []);
		const hook = createSystemEnhancerHook({} as PluginConfig, tempDir);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string; model?: unknown },
			output: { system: string[] },
		) => Promise<void>;

		await transform({ sessionID: 'test-session' }, { system: [] });

		// dark-matter.md MUST exist even on empty results to prevent recomputation
		expect(fs.existsSync(darkMatterPath)).toBe(true);
		const content = fs.readFileSync(darkMatterPath, 'utf-8');
		expect(content).toContain('No hidden couplings detected');
	});

	test('system-enhancer does not recompute when dark-matter.md cache exists (#1021)', async () => {
		// Create .swarm directory with pre-existing cache
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		const darkMatterPath = path.join(tempDir, '.swarm', 'dark-matter.md');
		fs.writeFileSync(
			darkMatterPath,
			'## Dark Matter: Hidden Couplings\n\nNo hidden couplings detected.',
			'utf-8',
		);

		mockDetectDarkMatter.mockImplementation(async () => []);
		const hook = createSystemEnhancerHook({} as PluginConfig, tempDir);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string; model?: unknown },
			output: { system: string[] },
		) => Promise<void>;

		// Invoke twice
		await transform({ sessionID: 'test-session' }, { system: [] });
		await transform({ sessionID: 'test-session' }, { system: [] });

		// detectDarkMatter should NOT have been called — cache was present
		expect(mockDetectDarkMatter).not.toHaveBeenCalled();
	});

	test('system-enhancer writes dark-matter.md even when .swarm/ directory does not pre-exist (#1021)', async () => {
		// Regression guard: if .swarm/ doesn't exist when writeFile is called, the ENOENT
		// would be swallowed by the outer catch and O(n²) recomputation would repeat forever.
		// The fix: mkdir({ recursive: true }) before writeFile ensures the directory is created.
		const darkMatterPath = path.join(tempDir, '.swarm', 'dark-matter.md');

		// Deliberately do NOT create .swarm/ — tempDir is a bare empty directory
		expect(fs.existsSync(path.join(tempDir, '.swarm'))).toBe(false);

		mockDetectDarkMatter.mockImplementation(async () => []);
		const hook = createSystemEnhancerHook({} as PluginConfig, tempDir);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string; model?: unknown },
			output: { system: string[] },
		) => Promise<void>;

		await transform({ sessionID: 'test-session' }, { system: [] });

		// dark-matter.md must exist even though .swarm/ was not pre-created
		expect(fs.existsSync(darkMatterPath)).toBe(true);
		const content = fs.readFileSync(darkMatterPath, 'utf-8');
		expect(content).toContain('No hidden couplings detected');
	});

	test('system-enhancer wraps detectDarkMatter in try-catch', async () => {
		// This verifies error handling: when detectDarkMatter throws,
		// system-enhancer continues gracefully without writing dark-matter.md

		const darkMatterPath = path.join(tempDir, '.swarm', 'dark-matter.md');

		// Make mockDetectDarkMatter throw an error (simulating git error)
		mockDetectDarkMatter.mockImplementation(async () => {
			throw new Error('Git error');
		});

		// Create .swarm directory
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		// Create and invoke the hook - the try-catch in system-enhancer should catch any errors
		const hook = createSystemEnhancerHook({} as PluginConfig, tempDir);
		const transform = hook['experimental.chat.system.transform'] as (
			input: { sessionID?: string; model?: unknown },
			output: { system: string[] },
		) => Promise<void>;

		// Should not throw despite mock throwing
		await transform({ sessionID: 'test-session' }, { system: [] });

		// dark-matter.md should not exist because the error was caught
		expect(fs.existsSync(darkMatterPath)).toBe(false);
	});
});
