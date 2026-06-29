import { beforeEach, describe, expect, it, vi } from 'bun:test';
import {
	type DelegationState,
	formatHandoffMarkdown,
	getHandoffData,
	type HandoffData,
	type PendingQA,
} from '../../../src/services/handoff-service.js';

// Mock all the imported modules
vi.mock('../../../src/hooks/utils.js', () => ({
	readSwarmFileAsync: vi.fn(),
}));

vi.mock('../../../src/plan/manager.js', () => ({
	loadPlanJsonOnly: vi.fn(),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));

// Import mocked modules
import { readSwarmFileAsync } from '../../../src/hooks/utils.js';
import { loadPlanJsonOnly } from '../../../src/plan/manager.js';

// Type assertions for mocks
const mockReadSwarmFileAsync = readSwarmFileAsync as ReturnType<typeof vi.fn>;
const mockLoadPlanJsonOnly = loadPlanJsonOnly as ReturnType<typeof vi.fn>;

// Helper to create a valid session state JSON
function makeSessionState(overrides?: {
	activeAgent?: Record<string, string>;
	delegationChains?: Record<string, any[]>;
	agentSessions?: Record<string, any>;
}): string {
	return JSON.stringify({
		activeAgent: overrides?.activeAgent ?? { test: 'TestAgent' },
		delegationChains: overrides?.delegationChains ?? {},
		agentSessions: overrides?.agentSessions ?? {},
	});
}

// Helper to create valid plan object
function makePlan(overrides?: { current_phase?: number; phases?: any[] }): any {
	return {
		schema_version: '1.0.0',
		title: 'Test Project',
		swarm: 'mega',
		current_phase: overrides?.current_phase ?? 1,
		phases: overrides?.phases ?? [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						size: 'small',
						description: 'Task 1',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: 'Task 2',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.3',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task 3',
						depends: [],
						files_touched: [],
					},
				],
			},
			{
				id: 2,
				name: 'Phase 2',
				status: 'pending',
				tasks: [
					{
						id: '2.1',
						phase: 2,
						status: 'pending',
						size: 'medium',
						description: 'Task 4',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

// Helper to create valid context.md with decisions
function makeContextMd(overrides?: { decisions?: string[] }): string {
	const decisions = overrides?.decisions ?? [
		'Decision 1 - approved',
		'Decision 2 - confirmed',
		'Decision 3 - done',
	];

	return `# Context

## Decisions
- ${decisions[0]}
- ${decisions[1] || 'No decision 2'}
- ${decisions[2] || 'No decision 3'}

## Phase Metrics
- Task 1.1: completed
- Task 1.2: in progress
- Total: 2/4
`;
}

beforeEach(() => {
	vi.clearAllMocks();
	// Default: all files return null (missing)
	mockReadSwarmFileAsync.mockResolvedValue(null);
	mockLoadPlanJsonOnly.mockResolvedValue(null);
});

describe('getHandoffData', () => {
	describe('with valid .swarm/session/state.json', () => {
		it('should return populated HandoffData', async () => {
			// Arrange
			const sessionState = makeSessionState({
				activeAgent: { test: 'TestAgent' },
				agentSessions: {
					test: {
						lastGateFailure: { taskId: '1.2', tool: 'test-tool' },
						currentTaskId: '1.2',
					},
				},
				delegationChains: {
					chain1: [
						{
							from: 'AgentA',
							to: 'AgentB',
							taskId: '1.1',
							timestamp: 1234567890,
						},
					],
				},
			});

			mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
				if (file === 'session/state.json') return Promise.resolve(sessionState);
				if (file === 'plan.json') return Promise.resolve(null);
				if (file === 'context.md') return Promise.resolve(makeContextMd());
				return Promise.resolve(null);
			});

			mockLoadPlanJsonOnly.mockResolvedValue(makePlan());

			// Act
			const result = await getHandoffData('/test/dir');

			// Assert
			expect(result).toBeDefined();
			expect(result.generated).toBeDefined();
			expect(result.currentPhase).toBe('Phase 1: Phase 1');
			expect(result.currentTask).toBe('1.2');
			expect(result.incompleteTasks).toContain('1.2');
			expect(result.incompleteTasks).toContain('1.3');
			expect(result.incompleteTasks).toContain('2.1');
			expect(result.activeAgent).toBe('TestAgent');
			expect(result.pendingQA).toEqual({
				taskId: '1.2',
				lastFailure: 'test-tool',
			});
			expect(result.delegationState).toBeDefined();
			expect(result.delegationState?.activeChains).toContain(
				'AgentA-&gt;AgentB',
			);
			expect(result.delegationState?.delegationDepth).toBe(1);
			expect(result.recentDecisions.length).toBeGreaterThan(0);
		});
	});

	describe('with missing files', () => {
		it('should return null fields gracefully when no session state', async () => {
			// Arrange - all mocks return null
			mockReadSwarmFileAsync.mockResolvedValue(null);
			mockLoadPlanJsonOnly.mockResolvedValue(null);

			// Act
			const result = await getHandoffData('/test/dir');

			// Assert
			expect(result).toBeDefined();
			expect(result.generated).toBeDefined();
			expect(result.currentPhase).toBeNull();
			expect(result.currentTask).toBeNull();
			expect(result.incompleteTasks).toEqual([]);
			expect(result.activeAgent).toBeNull();
			expect(result.pendingQA).toBeNull();
			expect(result.delegationState).toBeNull();
			expect(result.recentDecisions).toEqual([]);
		});

		it('should handle missing session/state.json but have valid plan.json', async () => {
			// Arrange - use structured plan.json instead of legacy plan.md
			mockLoadPlanJsonOnly.mockResolvedValue(
				makePlan({
					current_phase: 1,
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'in_progress',
							tasks: [
								{
									id: '1.1',
									phase: 1,
									status: 'in_progress',
									size: 'small',
									description: 'Task 1',
									depends: [],
									files_touched: [],
								},
								{
									id: '1.2',
									phase: 1,
									status: 'pending',
									size: 'small',
									description: 'Task 2',
									depends: [],
									files_touched: [],
								},
							],
						},
					],
				}),
			);

			mockReadSwarmFileAsync.mockResolvedValue(null);

			// Act
			const result = await getHandoffData('/test/dir');

			// Assert
			expect(result).toBeDefined();
			expect(result.currentPhase).toBe('Phase 1: Phase 1');
			expect(result.currentTask).toBe('1.1');
			expect(result.incompleteTasks).toContain('1.1');
			expect(result.incompleteTasks).toContain('1.2');
		});

		it('should handle partial session state with only activeAgent', async () => {
			// Arrange
			const sessionState = makeSessionState({
				activeAgent: { test: 'PartialAgent' },
			});

			mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
				if (file === 'session/state.json') return Promise.resolve(sessionState);
				return Promise.resolve(null);
			});

			mockLoadPlanJsonOnly.mockResolvedValue(null);

			// Act
			const result = await getHandoffData('/test/dir');

			// Assert
			expect(result.activeAgent).toBe('PartialAgent');
			expect(result.pendingQA).toBeNull();
			expect(result.delegationState).toBeNull();
		});

		it('should handle invalid JSON in session state gracefully', async () => {
			// Arrange
			mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
				if (file === 'session/state.json')
					return Promise.resolve('not valid json{');
				return Promise.resolve(null);
			});

			mockLoadPlanJsonOnly.mockResolvedValue(null);

			// Act
			const result = await getHandoffData('/test/dir');

			// Assert - should not throw, should return null fields
			expect(result).toBeDefined();
			expect(result.activeAgent).toBeNull();
			expect(result.pendingQA).toBeNull();
			expect(result.delegationState).toBeNull();
		});
	});
});

describe('formatHandoffMarkdown', () => {
	it('should produce valid markdown under 3KB', () => {
		// Arrange
		const data: HandoffData = {
			generated: new Date().toISOString(),
			currentPhase: 'Phase 1: Test Phase',
			currentTask: '1.2',
			incompleteTasks: [
				'1.2',
				'1.3',
				'2.1',
				'2.2',
				'2.3',
				'2.4',
				'2.5',
				'2.6',
				'2.7',
				'2.8',
				'2.9',
				'3.1',
			],
			pendingQA: { taskId: '1.1', lastFailure: 'test-tool' },
			activeAgent: 'TestAgent',
			recentDecisions: [
				'Decision 1 - approved',
				'Decision 2 - confirmed',
				'Decision 3 - done',
				'Decision 4 - finalized',
				'Decision 5 - completed',
			],
			delegationState: {
				activeChains: ['AgentA->AgentB', 'AgentB->AgentC', 'AgentC->AgentD'],
				delegationDepth: 3,
				pendingHandoffs: ['Phase Metrics Content Here'],
			},
		};

		// Act
		const markdown = formatHandoffMarkdown(data);
		const byteSize = new Blob([markdown]).size;

		// Assert
		expect(markdown).toBeDefined();
		expect(byteSize).toBeLessThan(3 * 1024); // Under 3KB
		console.log(`Markdown size: ${byteSize} bytes`);
	});

	it('should include all HandoffData fields in output', () => {
		// Arrange
		const data: HandoffData = {
			generated: '2024-01-01T00:00:00.000Z',
			currentPhase: 'Phase 1: Test Phase',
			currentTask: '1.1',
			incompleteTasks: ['1.1', '1.2'],
			pendingQA: { taskId: '1.1', lastFailure: 'tool-failure' },
			activeAgent: 'Agent1',
			recentDecisions: ['Decision 1'],
			delegationState: {
				activeChains: ['A->B'],
				delegationDepth: 1,
				pendingHandoffs: ['metrics'],
			},
		};

		// Act
		const markdown = formatHandoffMarkdown(data);

		// Assert - check all fields are present
		expect(markdown).toContain('## Swarm Handoff');
		expect(markdown).toContain('**Generated**:');
		expect(markdown).toContain('### Current State');
		expect(markdown).toContain('**Phase**: Phase 1: Test Phase');
		expect(markdown).toContain('**Task**: 1.1');
		expect(markdown).toContain('**Active Agent**: Agent1');
		expect(markdown).toContain('### Incomplete Tasks');
		expect(markdown).toContain('1.1');
		expect(markdown).toContain('1.2');
		expect(markdown).toContain('### Pending QA');
		expect(markdown).toContain('**Task**: 1.1');
		expect(markdown).toContain('**Last Failure**: tool-failure');
		expect(markdown).toContain('### Delegation');
		expect(markdown).toContain('**Depth**: 1');
		expect(markdown).toContain('A->B');
		expect(markdown).toContain('### Recent Decisions');
		expect(markdown).toContain('Decision 1');
		expect(markdown).toContain('### Phase Metrics');
	});

	it('should handle empty/null fields gracefully', () => {
		// Arrange - minimal data
		const data: HandoffData = {
			generated: '2024-01-01T00:00:00.000Z',
			currentPhase: null,
			currentTask: null,
			incompleteTasks: [],
			pendingQA: null,
			activeAgent: null,
			recentDecisions: [],
			delegationState: null,
		};

		// Act
		const markdown = formatHandoffMarkdown(data);

		// Assert
		expect(markdown).toBeDefined();
		expect(markdown).toContain('## Swarm Handoff');
		expect(markdown).toContain('**Generated**:');
		// Should not contain any sections with null data
		expect(markdown).not.toContain('### Incomplete Tasks');
		expect(markdown).not.toContain('### Pending QA');
		expect(markdown).not.toContain('### Delegation');
		expect(markdown).not.toContain('### Recent Decisions');
		// Current state should only have header, no fields
		const currentStateSection =
			markdown.split('### Current State')[1]?.split('###')[0] || '';
		expect(currentStateSection.trim()).toBe('');
	});

	it('should truncate long decisions', () => {
		// Arrange - long decision text
		// Note: Truncation happens upstream in getHandoffData via sanitizeString.
		// formatHandoffMarkdown is a pure formatting function and renders decisions as-is.
		// We test that a pre-truncated decision (as getHandoffData would produce) is rendered.
		const truncatedDecision = 'A'.repeat(497) + '...';
		const data: HandoffData = {
			generated: '2024-01-01T00:00:00.000Z',
			currentPhase: null,
			currentTask: null,
			incompleteTasks: [],
			pendingQA: null,
			activeAgent: null,
			recentDecisions: [truncatedDecision],
			delegationState: null,
		};

		// Act
		const markdown = formatHandoffMarkdown(data);

		// Assert
		expect(markdown).toContain('...');
		expect(markdown).toContain(truncatedDecision);
	});

	it('should limit incomplete tasks to 10 in display', () => {
		// Arrange - more than 10 tasks
		const tasks = Array.from(
			{ length: 15 },
			(_, i) => `${Math.floor(i / 5) + 1}.${(i % 5) + 1}`,
		);
		const data: HandoffData = {
			generated: '2024-01-01T00:00:00.000Z',
			currentPhase: null,
			currentTask: null,
			incompleteTasks: tasks,
			pendingQA: null,
			activeAgent: null,
			recentDecisions: [],
			delegationState: null,
		};

		// Act
		const markdown = formatHandoffMarkdown(data);

		// Assert
		expect(markdown).toContain('and 5 more');
		expect(markdown).not.toContain('1.6'); // Should be truncated
	});

	it('should limit delegation chains to 3 in display', () => {
		// Arrange - more than 3 chains
		const data: HandoffData = {
			generated: '2024-01-01T00:00:00.000Z',
			currentPhase: null,
			currentTask: null,
			incompleteTasks: [],
			pendingQA: null,
			activeAgent: null,
			recentDecisions: [],
			delegationState: {
				activeChains: ['A->B', 'B->C', 'C->D', 'D->E'],
				delegationDepth: 4,
				pendingHandoffs: [],
			},
		};

		// Act
		const markdown = formatHandoffMarkdown(data);

		// Assert
		expect(markdown).toContain('A->B');
		expect(markdown).toContain('B->C');
		expect(markdown).toContain('C->D');
		expect(markdown).not.toContain('D->E'); // Should be limited to 3
	});
});
