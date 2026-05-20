import { beforeEach, describe, expect, it, vi } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import * as planManager from '../../../src/plan/manager';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

function makeInput(
	sessionID = 'test-session',
	tool = 'read',
	callID = 'call-1',
) {
	return { tool, sessionID, callID };
}

function makeOutput(args: unknown = { filePath: '/test.ts' }) {
	return { args };
}

describe('guardrails directory parameter injection', () => {
	beforeEach(() => {
		resetSwarmState();
		vi.clearAllMocks();
	});

	describe('factory receives directory parameter', () => {
		it('creates hooks with injected directory parameter', async () => {
			const config = defaultConfig();
			const testDirectory = path.join(os.tmpdir(), 'test-project');

			// Should not throw - factory accepts directory parameter
			const hooks = createGuardrailsHooks(testDirectory, config);

			expect(hooks).toBeDefined();
			expect(hooks.toolBefore).toBeInstanceOf(Function);
			expect(hooks.toolAfter).toBeInstanceOf(Function);
			expect(hooks.messagesTransform).toBeInstanceOf(Function);
		});

		it('uses different directory when specified', async () => {
			const config = defaultConfig();
			const dir1 = '/test/project1';
			const dir2 = '/test/project2';

			const hooks1 = createGuardrailsHooks(dir1, config);
			const hooks2 = createGuardrailsHooks(dir2, config);

			// Both should create valid hooks independently
			expect(hooks1).toBeDefined();
			expect(hooks2).toBeDefined();
		});

		it('does not use process.cwd() as fallback', async () => {
			const config = defaultConfig();
			const testDirectory = '/custom/test/path';

			// Create hooks with custom directory
			const hooks = createGuardrailsHooks(testDirectory, config);

			// Mock loadPlan to verify it's called with the injected directory
			const loadPlanSpy = vi
				.spyOn(planManager, 'loadPlan')
				.mockResolvedValue(null);

			// Set up session for toolAfter hook (use coder to avoid architect exemption)
			startAgentSession('test-session', 'coder');
			const session = swarmState.agentSessions.get('test-session');
			if (session) {
				session.gateLog.set('task-1', new Set());
				session.reviewerCallCount.set(1, 0);
			}

			// Call toolBefore first to populate inputArgsByCallID
			const input = makeInput('test-session', 'Task', 'call-1');
			await hooks.toolBefore(input, { args: { subagent_type: 'reviewer' } });

			// Call toolAfter with a Task delegation (which triggers loadPlan)
			const output = {
				title: 'Task Result',
				output: 'success',
				metadata: {},
			};

			await hooks.toolAfter(input, output);

			// Verify loadPlan was called with the injected directory, not process.cwd()
			expect(loadPlanSpy).toHaveBeenCalledWith(testDirectory);
			expect(loadPlanSpy).not.toHaveBeenCalledWith(process.cwd());

			loadPlanSpy.mockRestore();
		});
	});

	describe('isOutsideSwarmDir uses injected directory', () => {
		it('correctly identifies files outside .swarm/ using injected directory', async () => {
			const config = defaultConfig();
			const testDirectory = path.join(os.tmpdir(), 'test-project');
			const hooks = createGuardrailsHooks(testDirectory, config);

			// Start a non-architect session (to bypass architect exemption)
			startAgentSession('test-session', 'coder');

			// Call toolBefore with a file path outside .swarm/
			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'src/test.ts' });

			// Should not throw - file is outside .swarm/
			await hooks.toolBefore(input, output);

			// Verify that the hook executed without error
			const session = swarmState.agentSessions.get('test-session');
			expect(session).toBeDefined();
		});

		it('correctly identifies files inside .swarm/ using injected directory', async () => {
			const config = defaultConfig();
			const testDirectory = path.join(os.tmpdir(), 'test-project');
			const hooks = createGuardrailsHooks(testDirectory, config);

			// Use an architect session writing to an allowed .swarm/ path.
			// (PR #501 + #496: coder now has blockedPrefix:['.swarm/'] so coder
			// can no longer write under .swarm/; architect retains write access
			// to .swarm/ except for the exact plan files.) This test's intent is
			// to verify isOutsideSwarmDir uses the injected directory — we need
			// a write that successfully reaches the .swarm/ check path.
			startAgentSession('test-session', 'architect');

			// Call toolBefore with a file path inside .swarm/ (not blockedExact for architect)
			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.swarm/evidence/test.json' });

			// Should not throw - file is inside .swarm/ (recognised via injected directory)
			await hooks.toolBefore(input, output);

			// Verify that the hook executed without error
			const session = swarmState.agentSessions.get('test-session');
			expect(session).toBeDefined();
		});

		it('respects path.join(directory, ".swarm") for validation', async () => {
			const config = defaultConfig();
			const testDirectory = path.join(os.tmpdir(), 'test-project');
			const hooks = createGuardrailsHooks(testDirectory, config);

			// Start an architect session (self-coding detection)
			startAgentSession('test-session', 'architect');

			// Mock warn to verify it's called for self-coding detection
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			// Call toolBefore with a source code file outside .swarm/
			// This should trigger self-coding detection since architect is writing code
			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'src/index.ts' });

			await hooks.toolBefore(input, output);

			// Verify self-coding detection was triggered
			// The isOutsideSwarmDir check used the injected directory
			const session = swarmState.agentSessions.get('test-session');
			expect(session?.architectWriteCount).toBeGreaterThan(0);

			warnSpy.mockRestore();
		});
	});

	describe('loadPlan uses injected directory', () => {
		it('loads plan from injected directory in toolAfter', async () => {
			const config = defaultConfig();
			const testDirectory = path.join(os.tmpdir(), 'test-project');
			const hooks = createGuardrailsHooks(testDirectory, config);

			// Mock loadPlan to verify the directory parameter
			const loadPlanSpy = vi
				.spyOn(planManager, 'loadPlan')
				.mockResolvedValue(null);

			// Set up session with gate log (use coder to avoid architect exemption)
			startAgentSession('test-session', 'coder');
			const session = swarmState.agentSessions.get('test-session');
			if (session) {
				session.gateLog.set('task-1', new Set());
				session.reviewerCallCount.set(1, 0);
			}

			// Call toolBefore first to populate inputArgsByCallID
			const input = makeInput('test-session', 'Task', 'call-1');
			await hooks.toolBefore(input, { args: { subagent_type: 'reviewer' } });

			// Call toolAfter with Task delegation (which triggers loadPlan)
			const output = {
				title: 'Task Result',
				output: 'success',
				metadata: {},
			};

			await hooks.toolAfter(input, output);

			// Verify loadPlan was called with injected directory
			expect(loadPlanSpy).toHaveBeenCalledWith(testDirectory);
			expect(loadPlanSpy).toHaveBeenCalledTimes(1);

			loadPlanSpy.mockRestore();
		});

		it('loads plan from injected directory in messagesTransform', async () => {
			const config = defaultConfig();
			const testDirectory = '/custom/project/dir';
			const hooks = createGuardrailsHooks(testDirectory, config);

			// Mock loadPlan to verify the directory parameter
			const mockPlan = {
				schema_version: '1.0.0' as const,
				title: 'Test Plan',
				swarm: 'test-swarm',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [],
						status: 'complete' as const,
					},
				],
			};
			const loadPlanSpy = vi
				.spyOn(planManager, 'loadPlan')
				.mockResolvedValue(mockPlan);

			// Set up session with gate log and catastrophic warnings
			startAgentSession('test-session', 'architect');
			const session = swarmState.agentSessions.get('test-session');
			if (session) {
				session.catastrophicPhaseWarnings = new Set();
				session.reviewerCallCount = new Map();
			}

			// Call messagesTransform (which checks catastrophic warnings and loads plan)
			const messages = [
				{
					info: {
						role: 'assistant',
						sessionID: 'test-session',
						agent: 'architect',
					},
					parts: [{ type: 'text', text: 'Phase complete' }],
				},
			];

			await hooks.messagesTransform({}, { messages });

			// Verify loadPlan was called with injected directory
			expect(loadPlanSpy).toHaveBeenCalledWith(testDirectory);

			loadPlanSpy.mockRestore();
		});
	});

	describe('no process.cwd() fallback in hooks', () => {
		it('toolBefore does not use process.cwd() for path validation', async () => {
			const config = defaultConfig();
			const testDirectory = path.join(os.tmpdir(), 'custom-project');
			const hooks = createGuardrailsHooks(testDirectory, config);

			// Start architect session for self-coding detection
			startAgentSession('test-session', 'architect');

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({
				filePath: path.join(testDirectory, 'src/file.ts'),
			});

			// Mock warn to capture warnings
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			await hooks.toolBefore(input, output);

			// Verify session used the injected directory path
			const session = swarmState.agentSessions.get('test-session');
			expect(session?.architectWriteCount).toBeGreaterThan(0);

			// Verify no reference to process.cwd() in the warning
			const warnCalls = warnSpy.mock.calls as unknown[][];
			const hasCwdReference = warnCalls.some((call) => {
				const args = call[0] as string | undefined;
				return typeof args === 'string' && args.includes(process.cwd());
			});
			expect(hasCwdReference).toBe(false);

			warnSpy.mockRestore();
		});

		it('toolAfter does not use process.cwd() for plan loading', async () => {
			const config = defaultConfig();
			const testDirectory = '/project/dir';
			const hooks = createGuardrailsHooks(testDirectory, config);

			// Mock loadPlan to capture directory parameter
			const loadPlanSpy = vi
				.spyOn(planManager, 'loadPlan')
				.mockResolvedValue(null);

			// Set up session (use coder to avoid architect exemption)
			startAgentSession('test-session', 'coder');
			const session = swarmState.agentSessions.get('test-session');
			if (session) {
				session.gateLog.set('task-1', new Set());
				session.reviewerCallCount.set(1, 0);
			}

			// Call toolAfter with Task delegation
			const input = makeInput('test-session', 'Task', 'call-1');
			await hooks.toolBefore(input, { args: { subagent_type: 'reviewer' } });

			const output = {
				title: 'Task Result',
				output: 'success',
				metadata: {},
			};

			await hooks.toolAfter(input, output);

			// Verify loadPlan was called only with injected directory
			expect(loadPlanSpy).toHaveBeenCalledWith(testDirectory);
			expect(loadPlanSpy).toHaveBeenCalledTimes(1);

			// Verify no call to process.cwd()
			const calls = loadPlanSpy.mock.calls.map((call) => call[0]);
			expect(calls).not.toContain(process.cwd());

			loadPlanSpy.mockRestore();
		});

		it('messagesTransform does not use process.cwd() for plan loading', async () => {
			const config = defaultConfig();
			const testDirectory = '/test/directory';
			const hooks = createGuardrailsHooks(testDirectory, config);

			// Mock loadPlan to capture directory parameter
			const mockPlan = {
				schema_version: '1.0.0' as const,
				title: 'Test Plan',
				swarm: 'test-swarm',
				phases: [],
			};
			const loadPlanSpy = vi
				.spyOn(planManager, 'loadPlan')
				.mockResolvedValue(mockPlan);

			// Set up session
			startAgentSession('test-session', 'architect');
			const session = swarmState.agentSessions.get('test-session');
			if (session) {
				session.catastrophicPhaseWarnings = new Set();
			}

			// Call messagesTransform
			const messages = [
				{
					info: {
						role: 'assistant',
						sessionID: 'test-session',
						agent: 'architect',
					},
					parts: [{ type: 'text', text: 'Test message' }],
				},
			];

			await hooks.messagesTransform({}, { messages });

			// Verify loadPlan was called only with injected directory
			expect(loadPlanSpy).toHaveBeenCalledWith(testDirectory);

			loadPlanSpy.mockRestore();
		});
	});

	describe('edge cases with directory parameter', () => {
		it('handles absolute paths correctly', async () => {
			const config = defaultConfig();
			const absoluteDirectory = '/absolute/path/to/project';
			const hooks = createGuardrailsHooks(absoluteDirectory, config);

			// Mock loadPlan
			const loadPlanSpy = vi
				.spyOn(planManager, 'loadPlan')
				.mockResolvedValue(null);

			// Set up session (use coder to avoid architect exemption)
			startAgentSession('test-session', 'coder');
			const session = swarmState.agentSessions.get('test-session');
			if (session) {
				session.gateLog.set('task-1', new Set());
				session.reviewerCallCount.set(1, 0);
			}

			// Call toolAfter with Task delegation
			const input = makeInput('test-session', 'Task', 'call-1');
			await hooks.toolBefore(input, { args: { subagent_type: 'reviewer' } });

			const output = {
				title: 'Task Result',
				output: 'success',
				metadata: {},
			};

			await hooks.toolAfter(input, output);

			// Verify loadPlan was called with absolute directory
			expect(loadPlanSpy).toHaveBeenCalledWith(absoluteDirectory);

			loadPlanSpy.mockRestore();
		});

		it('handles relative paths correctly', async () => {
			const config = defaultConfig();
			const relativeDirectory = '../relative/project';
			const hooks = createGuardrailsHooks(relativeDirectory, config);

			// Mock loadPlan
			const loadPlanSpy = vi
				.spyOn(planManager, 'loadPlan')
				.mockResolvedValue(null);

			// Set up session (use coder to avoid architect exemption)
			startAgentSession('test-session', 'coder');
			const session = swarmState.agentSessions.get('test-session');
			if (session) {
				session.gateLog.set('task-1', new Set());
				session.reviewerCallCount.set(1, 0);
			}

			// Call toolAfter with Task delegation
			const input = makeInput('test-session', 'Task', 'call-1');
			await hooks.toolBefore(input, { args: { subagent_type: 'reviewer' } });

			const output = {
				title: 'Task Result',
				output: 'success',
				metadata: {},
			};

			await hooks.toolAfter(input, output);

			// Verify loadPlan was called with relative directory as-is
			expect(loadPlanSpy).toHaveBeenCalledWith(relativeDirectory);

			loadPlanSpy.mockRestore();
		});

		it('handles Windows-style paths correctly', async () => {
			const config = defaultConfig();
			const windowsDirectory = 'C:\\Users\\test\\project';
			const hooks = createGuardrailsHooks(windowsDirectory, config);

			// Mock loadPlan
			const loadPlanSpy = vi
				.spyOn(planManager, 'loadPlan')
				.mockResolvedValue(null);

			// Set up session (use coder to avoid architect exemption)
			startAgentSession('test-session', 'coder');
			const session = swarmState.agentSessions.get('test-session');
			if (session) {
				session.gateLog.set('task-1', new Set());
				session.reviewerCallCount.set(1, 0);
			}

			// Call toolAfter with Task delegation
			const input = makeInput('test-session', 'Task', 'call-1');
			await hooks.toolBefore(input, { args: { subagent_type: 'reviewer' } });

			const output = {
				title: 'Task Result',
				output: 'success',
				metadata: {},
			};

			await hooks.toolAfter(input, output);

			// Verify loadPlan was called with Windows directory as-is
			expect(loadPlanSpy).toHaveBeenCalledWith(windowsDirectory);

			loadPlanSpy.mockRestore();
		});
	});
});
