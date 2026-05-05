/**
 * Tests for critic dispatch implementation in full-auto-intercept.ts
 *
 * Tests the three exported functions:
 * - parseCriticResponse: Parses the critic's structured text format
 * - dispatchCriticAndWriteEvent: Creates ephemeral session, calls critic, writes event
 * - injectVerdictIntoMessages: Injects verdict as assistant message after architect's message
 *
 * NOTE: dispatchCriticAndWriteEvent requires swarmState.opencodeClient to be mocked
 * because it makes actual LLM calls when the client is present. These tests mock
 * the client to test the fallback behavior when client is null.
 *
 * MOCK CONVERSION NOTES:
 * - src/state.ts: Converted to _internals DI seam (mutate properties, not reassign)
 * - src/telemetry.js, src/hooks/utils.js, src/parallel/file-locks.js, src/agents/critic.js:
 *   Cannot convert - source uses direct imports (not _internals routing)
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// =============================================================================
// STATE MODULE - Converted to _internals DI seam
// =============================================================================
// Import _internals directly - we mutate its properties, not reassign the object
import { _internals } from '../../../src/state.js';

// Save original _internals properties for restoration in afterEach
let origHasActiveFullAuto: typeof _internals.hasActiveFullAuto;
let origSwarmState: typeof _internals.swarmState;
let origEnsureAgentSession: typeof _internals.ensureAgentSession;
let origResetSwarmState: typeof _internals.resetSwarmState;

// Mock hasActiveFullAuto function - starts returning true
const mockHasActiveFullAutoFn = mock(() => true);

// Mock state object - allows tests to control hasActiveFullAutoResult
const mockState = {
	hasActiveFullAutoResult: false,
};

// Persistent session state storage
interface SessionState {
	fullAutoInteractionCount: number;
	fullAutoDeadlockCount: number;
	fullAutoLastQuestionHash: string | undefined;
}

const globalState = globalThis as typeof globalThis & {
	_sessionStorage?: Map<string, SessionState>;
};

if (!globalState._sessionStorage) {
	globalState._sessionStorage = new Map<string, SessionState>();
}

const stateRef: { sessionStorage: Map<string, SessionState> } = {
	sessionStorage: globalState._sessionStorage,
};

// Mock ensureAgentSession
function mockEnsureAgentSession(sessionId: string) {
	if (!stateRef.sessionStorage.has(sessionId)) {
		stateRef.sessionStorage.set(sessionId, {
			fullAutoInteractionCount: 0,
			fullAutoDeadlockCount: 0,
			fullAutoLastQuestionHash: undefined,
		});
	}
	return stateRef.sessionStorage.get(sessionId)!;
}

// Mock resetSwarmState
function mockResetSwarmState() {
	stateRef.sessionStorage.clear();
}

// Mock swarmState object - opencodeClient: null for fallback tests
const mockSwarmState = {
	agentSessions: stateRef.sessionStorage,
	opencodeClient: null,
};

// =============================================================================
// REMAINING MOCKS - Cannot convert (source uses direct imports, not _internals)
// These remain as mock.module per the plan:
// - src/telemetry.js: source imports { telemetry } directly, not via _internals
// - src/hooks/utils.js: source imports { validateSwarmPath } directly
// - src/parallel/file-locks.js: source imports { tryAcquireLock } directly
// - src/agents/critic.js: source imports { createCriticAutonomousOversightAgent } directly
// =============================================================================

// Track console.warn calls for verification
const consoleWarnCalls: string[] = [];
const consoleLogCalls: string[] = [];
const consoleErrorCalls: string[] = [];

// Mock telemetry - remains as mock.module (no _internals seam for direct import)
mock.module('../../../src/telemetry.js', () => ({
	telemetry: {
		autoOversightEscalation: mock(() => {}),
		sessionStarted: mock(() => {}),
		sessionEnded: mock(() => {}),
		agentActivated: mock(() => {}),
		delegationBegin: mock(() => {}),
		delegationEnd: mock(() => {}),
		taskStateChanged: mock(() => {}),
		gatePassed: mock(() => {}),
		gateFailed: mock(() => {}),
		phaseChanged: mock(() => {}),
		budgetUpdated: mock(() => {}),
		modelFallback: mock(() => {}),
		hardLimitHit: mock(() => {}),
		revisionLimitHit: mock(() => {}),
		loopDetected: mock(() => {}),
		scopeViolation: mock(() => {}),
		qaSkipViolation: mock(() => {}),
		heartbeat: mock(() => {}),
		turboModeChanged: mock(() => {}),
	},
}));

mock.module('../../../src/hooks/utils.js', () => ({
	validateSwarmPath: (dir: string, file: string) =>
		path.join(dir, '.swarm', file),
}));

mock.module('../../../src/parallel/file-locks.js', () => ({
	tryAcquireLock: mock(async () => ({
		acquired: false,
		lock: { _release: async () => {} },
	})),
}));

mock.module('../../../src/agents/critic.js', () => ({
	createCriticAutonomousOversightAgent: mock(() => ({
		name: 'critic_oversight',
	})),
}));

// Import after mock setup
const {
	parseCriticResponse,
	dispatchCriticAndWriteEvent,
	injectVerdictIntoMessages,
} = await import('../../../src/hooks/full-auto-intercept.js');

let testDir: string;
let originalConsoleLog: typeof console.log;
let originalConsoleWarn: typeof console.warn;
let originalConsoleError: typeof console.error;

describe('parseCriticResponse', () => {
	beforeEach(() => {
		// Save original _internals properties
		origHasActiveFullAuto = _internals.hasActiveFullAuto;
		origSwarmState = _internals.swarmState;
		origEnsureAgentSession = _internals.ensureAgentSession;
		origResetSwarmState = _internals.resetSwarmState;

		// Replace _internals properties with mocks
		_internals.hasActiveFullAuto = mockHasActiveFullAutoFn;
		_internals.swarmState = mockSwarmState;
		_internals.ensureAgentSession = mockEnsureAgentSession;
		_internals.resetSwarmState = mockResetSwarmState;

		// Set mock implementation to use mockState.hasActiveFullAutoResult
		mockHasActiveFullAutoFn.mockImplementation(
			() => mockState.hasActiveFullAutoResult,
		);

		originalConsoleLog = console.log;
		originalConsoleWarn = console.warn;
		originalConsoleError = console.error;
		consoleLogCalls.length = 0;
		consoleWarnCalls.length = 0;
		consoleErrorCalls.length = 0;
		console.log = (...args: unknown[]) => {
			consoleLogCalls.push(args.join(' '));
			originalConsoleLog.apply(console, args);
		};
		console.warn = (...args: unknown[]) => {
			consoleWarnCalls.push(args.join(' '));
			originalConsoleWarn.apply(console, args);
		};
		console.error = (...args: unknown[]) => {
			consoleErrorCalls.push(args.join(' '));
			originalConsoleError.apply(console, args);
		};
	});

	afterEach(() => {
		// Restore original _internals properties
		_internals.hasActiveFullAuto = origHasActiveFullAuto;
		_internals.swarmState = origSwarmState;
		_internals.ensureAgentSession = origEnsureAgentSession;
		_internals.resetSwarmState = origResetSwarmState;

		console.log = originalConsoleLog;
		console.warn = originalConsoleWarn;
		console.error = originalConsoleError;

		// Restore cross-module mocks
		mock.restore();
	});

	describe('single-line values', () => {
		it('parses APPROVED verdict with all fields', () => {
			const input = `VERDICT: APPROVED
REASONING: The implementation looks correct
EVIDENCE_CHECKED: tests/unit/hooks/guardrails.test.ts
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('APPROVED');
			expect(result.reasoning).toBe('The implementation looks correct');
			expect(result.evidenceChecked).toEqual([
				'tests/unit/hooks/guardrails.test.ts',
			]);
			expect(result.antiPatternsDetected).toEqual([]);
			expect(result.escalationNeeded).toBe(false);
			expect(result.rawResponse).toBe(input);
		});

		it('parses NEEDS_REVISION verdict', () => {
			const input = `VERDICT: NEEDS_REVISION
REASONING: Missing error handling for edge case
EVIDENCE_CHECKED: src/hooks/guardrails.ts
ANTI_PATTERNS_DETECTED: incomplete_validation
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('NEEDS_REVISION');
			expect(result.reasoning).toBe('Missing error handling for edge case');
			expect(result.evidenceChecked).toEqual(['src/hooks/guardrails.ts']);
			expect(result.antiPatternsDetected).toEqual(['incomplete_validation']);
			expect(result.escalationNeeded).toBe(false);
		});

		it('parses ESCALATE_TO_HUMAN verdict', () => {
			const input = `VERDICT: ESCALATE_TO_HUMAN
REASONING: This question requires human judgment
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: YES`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('ESCALATE_TO_HUMAN');
			expect(result.reasoning).toBe('This question requires human judgment');
			expect(result.escalationNeeded).toBe(true);
		});

		it('parses REJECTED verdict', () => {
			const input = `VERDICT: REJECTED
REASONING: Security vulnerability detected
EVIDENCE_CHECKED: src/auth.ts, src/validation.ts
ANTI_PATTERNS_DETECTED: sql_injection_risk
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('REJECTED');
			expect(result.reasoning).toBe('Security vulnerability detected');
			expect(result.evidenceChecked).toEqual([
				'src/auth.ts',
				'src/validation.ts',
			]);
			expect(result.antiPatternsDetected).toEqual(['sql_injection_risk']);
		});

		it('parses BLOCKED verdict', () => {
			const input = `VERDICT: BLOCKED
REASONING: Dependency on incomplete feature
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: circular_dependency
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('BLOCKED');
		});

		it('parses ANSWER verdict', () => {
			const input = `VERDICT: ANSWER
REASONING: The answer is yes, you should proceed with the implementation
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('ANSWER');
			expect(result.reasoning).toBe(
				'The answer is yes, you should proceed with the implementation',
			);
		});

		it('parses REPHRASE verdict', () => {
			const input = `VERDICT: REPHRASE
REASONING: The question was unclear
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: unclear_requirements
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('REPHRASE');
		});
	});

	describe('multi-line reasoning', () => {
		it('accumulates multi-line reasoning until next field header', () => {
			const input = `VERDICT: NEEDS_REVISION
REASONING: The implementation has several issues:
1. Missing null checks
2. No error boundaries
3. Insufficient test coverage

EVIDENCE_CHECKED: src/core.ts, tests/core.test.ts
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('NEEDS_REVISION');
			expect(result.reasoning).toBe(
				'The implementation has several issues:\n1. Missing null checks\n2. No error boundaries\n3. Insufficient test coverage',
			);
			expect(result.evidenceChecked).toEqual([
				'src/core.ts',
				'tests/core.test.ts',
			]);
		});

		it('handles reasoning with blank lines in between', () => {
			// Note: blank lines are skipped in the current implementation,
			// so multi-line content joins with single newlines
			const input = `VERDICT: APPROVED
REASONING: Good implementation.

Consider adding more tests in the future.

Overall looks solid.
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('APPROVED');
			// Blank lines are skipped, so content joins with single newlines
			expect(result.reasoning).toBe(
				'Good implementation.\nConsider adding more tests in the future.\nOverall looks solid.',
			);
		});

		it('handles deeply nested multi-line content', () => {
			const input = `VERDICT: NEEDS_REVISION
REASONING: Issues found:
- Item 1
  - Sub-item A
  - Sub-item B
- Item 2
  - Sub-item C
EVIDENCE_CHECKED: file1.ts
ANTI_PATTERNS_DETECTED: complexity_issues
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.reasoning).toBe(
				'Issues found:\n- Item 1\n  - Sub-item A\n  - Sub-item B\n- Item 2\n  - Sub-item C',
			);
		});
	});

	describe('empty response handling', () => {
		it('returns defaults for empty string', () => {
			const result = parseCriticResponse('');

			expect(result.verdict).toBe('NEEDS_REVISION');
			expect(result.reasoning).toBe('');
			expect(result.evidenceChecked).toEqual([]);
			expect(result.antiPatternsDetected).toEqual([]);
			expect(result.escalationNeeded).toBe(false);
			expect(result.rawResponse).toBe('');
		});

		it('returns defaults for whitespace-only string', () => {
			const result = parseCriticResponse('   \n\n   ');

			expect(result.verdict).toBe('NEEDS_REVISION');
			expect(result.reasoning).toBe('');
		});

		it('returns defaults when only some fields are present', () => {
			const result = parseCriticResponse('VERDICT: APPROVED');

			expect(result.verdict).toBe('APPROVED');
			expect(result.reasoning).toBe('');
			expect(result.evidenceChecked).toEqual([]);
			expect(result.antiPatternsDetected).toEqual([]);
			expect(result.escalationNeeded).toBe(false);
		});
	});

	describe('unknown verdict handling', () => {
		it('defaults to NEEDS_REVISION for unknown verdict with warning', () => {
			const input = `VERDICT: UNKNOWN_VERDICT
REASONING: Some reasoning
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('NEEDS_REVISION');
			expect(consoleWarnCalls.some((c) => c.includes('Unknown verdict'))).toBe(
				true,
			);
		});

		it('normalizes verdict value before validation', () => {
			const input = `VERDICT: approved
REASONING: lowercase verdict
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('APPROVED');
		});

		it('strips backticks from verdict', () => {
			const input = `VERDICT: \`APPROVED\`
REASONING: verdict with backticks
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('APPROVED');
		});

		it('strips asterisks from verdict', () => {
			const input = `VERDICT: **APPROVED**
REASONING: verdict with asterisks
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('APPROVED');
		});

		it('strips markdown asterisks and backticks from verdict', () => {
			const input = `VERDICT: *APPROVED*
REASONING: verdict with asterisks
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('APPROVED');
		});

		it('strips markdown backticks from verdict', () => {
			const input = `VERDICT: \`APPROVED\`
REASONING: verdict with backticks
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('APPROVED');
		});

		it('handles mixed case verdict normalization', () => {
			const input = `VERDICT: NeEdS_ReViSiOn
REASONING: mixed case verdict
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('NEEDS_REVISION');
		});
	});

	describe('none values handling', () => {
		it('parses "none" for EVIDENCE_CHECKED', () => {
			const input = `VERDICT: APPROVED
REASONING: All good
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.evidenceChecked).toEqual([]);
		});

		it('parses "none" for ANTI_PATTERNS_DETECTED', () => {
			const input = `VERDICT: APPROVED
REASONING: All good
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.antiPatternsDetected).toEqual([]);
		});

		it('parses quoted "none" for EVIDENCE_CHECKED', () => {
			const input = `VERDICT: APPROVED
REASONING: All good
EVIDENCE_CHECKED: "none"
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.evidenceChecked).toEqual([]);
		});
	});

	describe('multiple evidence items', () => {
		it('parses comma-separated evidence items', () => {
			const input = `VERDICT: NEEDS_REVISION
REASONING: Issues found
EVIDENCE_CHECKED: file1.ts, file2.ts, file3.ts
ANTI_PATTERNS_DETECTED: issue1, issue2
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.evidenceChecked).toEqual([
				'file1.ts',
				'file2.ts',
				'file3.ts',
			]);
			expect(result.antiPatternsDetected).toEqual(['issue1', 'issue2']);
		});

		it('handles evidence items with spaces around them', () => {
			const input = `VERDICT: APPROVED
REASONING: Good
EVIDENCE_CHECKED: file1.ts ,  file2.ts , file3.ts
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO`;

			const result = parseCriticResponse(input);

			expect(result.evidenceChecked).toEqual([
				'file1.ts',
				'file2.ts',
				'file3.ts',
			]);
		});
	});

	describe('field order independence', () => {
		it('parses fields in different order', () => {
			const input = `EVIDENCE_CHECKED: file1.ts
VERDICT: APPROVED
ESCALATION_NEEDED: NO
REASONING: Looks good
ANTI_PATTERNS_DETECTED: none`;

			const result = parseCriticResponse(input);

			expect(result.verdict).toBe('APPROVED');
			expect(result.reasoning).toBe('Looks good');
			expect(result.evidenceChecked).toEqual(['file1.ts']);
			expect(result.escalationNeeded).toBe(false);
		});

		it('handles REASONING appearing after other fields', () => {
			const input = `VERDICT: APPROVED
EVIDENCE_CHECKED: none
ANTI_PATTERNS_DETECTED: none
ESCALATION_NEEDED: NO
REASONING: Final reasoning line`;

			const result = parseCriticResponse(input);

			expect(result.reasoning).toBe('Final reasoning line');
		});
	});
});

describe('dispatchCriticAndWriteEvent fallback', () => {
	beforeEach(() => {
		// Save original _internals properties
		origHasActiveFullAuto = _internals.hasActiveFullAuto;
		origSwarmState = _internals.swarmState;
		origEnsureAgentSession = _internals.ensureAgentSession;
		origResetSwarmState = _internals.resetSwarmState;

		// Replace _internals properties with mocks
		_internals.hasActiveFullAuto = mockHasActiveFullAutoFn;
		_internals.swarmState = mockSwarmState;
		_internals.ensureAgentSession = mockEnsureAgentSession;
		_internals.resetSwarmState = mockResetSwarmState;

		// Set mock implementation to use mockState.hasActiveFullAutoResult
		mockHasActiveFullAutoFn.mockImplementation(
			() => mockState.hasActiveFullAutoResult,
		);

		testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-'));
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });

		originalConsoleLog = console.log;
		originalConsoleWarn = console.warn;
		originalConsoleError = console.error;
		consoleLogCalls.length = 0;
		consoleWarnCalls.length = 0;
		consoleErrorCalls.length = 0;
		console.log = (...args: unknown[]) => {
			consoleLogCalls.push(args.join(' '));
			originalConsoleLog.apply(console, args);
		};
		console.warn = (...args: unknown[]) => {
			consoleWarnCalls.push(args.join(' '));
			originalConsoleWarn.apply(console, args);
		};
		console.error = (...args: unknown[]) => {
			consoleErrorCalls.push(args.join(' '));
			originalConsoleError.apply(console, args);
		};
	});

	afterEach(() => {
		// Restore original _internals properties
		_internals.hasActiveFullAuto = origHasActiveFullAuto;
		_internals.swarmState = origSwarmState;
		_internals.ensureAgentSession = origEnsureAgentSession;
		_internals.resetSwarmState = origResetSwarmState;

		console.log = originalConsoleLog;
		console.warn = originalConsoleWarn;
		console.error = originalConsoleError;
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}

		// Restore cross-module mocks
		mock.restore();
	});

	it('returns PENDING verdict when swarmState.opencodeClient is null', async () => {
		const result = await dispatchCriticAndWriteEvent(
			testDir,
			'Ready for Phase 2?',
			'Critic context',
			'claude-sonnet-4-20250514',
			'phase_completion',
			0,
			0,
			'critic_oversight',
		);

		expect(result.verdict).toBe('PENDING');
		expect(result.reasoning).toBe(
			'No opencodeClient available — critic dispatch not possible',
		);
		expect(result.escalationNeeded).toBe(false);
	});

	it('writes fallback event when swarmState.opencodeClient is null', async () => {
		await dispatchCriticAndWriteEvent(
			testDir,
			'Ready for Phase 2?',
			'Critic context',
			'claude-sonnet-4-20250514',
			'phase_completion',
			5,
			2,
			'critic_oversight',
		);

		const eventsPath = path.join(testDir, '.swarm', 'events.jsonl');
		expect(fs.existsSync(eventsPath)).toBe(true);

		const content = fs.readFileSync(eventsPath, 'utf-8');
		const event = JSON.parse(content.trim());

		expect(event.type).toBe('auto_oversight');
		expect(event.critic_verdict).toBe('PENDING');
		expect(event.interaction_count).toBe(5);
		expect(event.deadlock_count).toBe(2);
	});

	it('logs warning when falling back due to no opencodeClient', async () => {
		await dispatchCriticAndWriteEvent(
			testDir,
			'Ready for Phase 2?',
			'Critic context',
			'claude-sonnet-4-20250514',
			'phase_completion',
			0,
			0,
			'critic_oversight',
		);

		expect(
			consoleWarnCalls.some((c) =>
				c.includes('No opencodeClient — critic dispatch skipped'),
			),
		).toBe(true);
	});
});

describe('injectVerdictIntoMessages', () => {
	interface MessageWithParts {
		info: {
			role: string;
			agent?: string;
			sessionID?: string;
			[key: string]: unknown;
		};
		parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
	}

	function makeMessages(): MessageWithParts[] {
		return [
			{
				info: { role: 'assistant' as const, agent: 'orchestrator' },
				parts: [{ type: 'text' as const, text: 'Orchestrator message' }],
			},
			{
				info: { role: 'user' as const, agent: 'architect' },
				parts: [{ type: 'text' as const, text: 'Ready for Phase 2?' }],
			},
			{
				info: { role: 'assistant' as const, agent: 'architect' },
				parts: [{ type: 'text' as const, text: 'Architect response' }],
			},
		];
	}

	describe('ANSWER verdict', () => {
		it('injects reasoning as assistant message after architect', () => {
			const messages = makeMessages();
			const architectIndex = 1; // The architect user message

			const criticResult = {
				verdict: 'ANSWER',
				reasoning: 'The answer is yes, you should proceed to phase 2.',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				architectIndex,
				criticResult,
				'phase_completion',
				'critic_oversight',
			);

			// Should have 5 messages now (3 original + verdict + continuation)
			expect(messages.length).toBe(5);

			// Injected verdict message should be at architectIndex + 1
			const injected = messages[architectIndex + 1];
			expect(injected.info.role).toBe('assistant');
			expect(injected.info.agent).toBe('critic_oversight');
			expect(injected.parts[0].text).toContain('ANSWER');
			expect(injected.parts[0].text).toContain(
				'The answer is yes, you should proceed to phase 2.',
			);
		});

		it('handles empty ANSWER reasoning', () => {
			const messages = makeMessages();

			const criticResult = {
				verdict: 'ANSWER',
				reasoning: '',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				1,
				criticResult,
				'question',
				'critic_oversight',
			);

			const injected = messages[2];
			expect(injected.info.role).toBe('assistant');
			expect(injected.info.agent).toBe('critic_oversight');
			expect(injected.parts[0].text).toContain('ANSWER');
		});
	});

	describe('ESCALATE_TO_HUMAN verdict', () => {
		it('injects escalation notice after architect', () => {
			const messages = makeMessages();
			const architectIndex = 1;

			const criticResult = {
				verdict: 'ESCALATE_TO_HUMAN',
				reasoning:
					'This requires human judgment on the architectural decision.',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: true,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				architectIndex,
				criticResult,
				'question',
				'critic_oversight',
			);

			expect(messages.length).toBe(4);

			const injected = messages[architectIndex + 1];
			expect(injected.info.role).toBe('assistant');
			expect(injected.info.agent).toBe('critic_oversight');
			expect(injected.parts[0].text).toContain('ESCALATE_TO_HUMAN');
			expect(injected.parts[0].text).toContain('This requires human judgment');
			expect(injected.parts[0].text).toContain('paused for human review');
		});

		it('injects when verdict is ESCALATE_TO_HUMAN even if escalationNeeded is false', () => {
			const messages = makeMessages();
			const architectIndex = 1;

			const criticResult = {
				verdict: 'ESCALATE_TO_HUMAN',
				reasoning: 'Manual review required.',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				architectIndex,
				criticResult,
				'question',
				'critic_oversight',
			);

			expect(messages.length).toBe(4);

			const injected = messages[architectIndex + 1];
			expect(injected.info.agent).toBe('critic_oversight');
			expect(injected.parts[0].text).toContain('ESCALATE_TO_HUMAN');
		});
	});

	describe('APPROVED verdict', () => {
		it('injects with ✅ emoji after architect', () => {
			const messages = makeMessages();
			const architectIndex = 1;

			const criticResult = {
				verdict: 'APPROVED',
				reasoning: 'Phase 1 tasks are complete. Ready to proceed.',
				evidenceChecked: ['plan.json', 'phase-1-tasks.md'],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				architectIndex,
				criticResult,
				'phase_completion',
				'critic_oversight',
			);

			expect(messages.length).toBe(5);

			const injected = messages[architectIndex + 1];
			expect(injected.info.role).toBe('assistant');
			expect(injected.info.agent).toBe('critic_oversight');
			expect(injected.parts[0].text).toContain('✅');
			expect(injected.parts[0].text).toContain('APPROVED');
			expect(injected.parts[0].text).toContain('Phase 1 tasks are complete');
		});

		it('verdict is spliced at architectIndex + 1 (not 0 or end)', () => {
			const messages = makeMessages();
			const originalLength = messages.length;
			const architectIndex = 1;

			const criticResult = {
				verdict: 'APPROVED',
				reasoning: 'Approved.',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				architectIndex,
				criticResult,
				'phase_completion',
				'critic_oversight',
			);

			// Messages after injection: [orchestrator, architect, verdict, continuation, architect_response]
			expect(messages.length).toBe(originalLength + 2);
			expect(messages[0].info.role).toBe('assistant'); // orchestrator unchanged
			expect(messages[1].info.role).toBe('user'); // architect unchanged
			expect(messages[2].info.role).toBe('assistant'); // injected verdict
			expect(messages[2].info.agent).toBe('critic_oversight');
			expect(messages[4].info.role).toBe('assistant'); // original architect response (shifted by 2)
		});
	});

	describe('NEEDS_REVISION verdict', () => {
		it('injects with 🔄 emoji after architect', () => {
			const messages = makeMessages();
			const architectIndex = 1;

			const criticResult = {
				verdict: 'NEEDS_REVISION',
				reasoning: 'Missing documentation for the new API endpoints.',
				evidenceChecked: [],
				antiPatternsDetected: ['missing_docs'],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				architectIndex,
				criticResult,
				'phase_completion',
				'critic_oversight',
			);

			expect(messages.length).toBe(4);

			const injected = messages[architectIndex + 1];
			expect(injected.info.role).toBe('assistant');
			expect(injected.info.agent).toBe('critic_oversight');
			expect(injected.parts[0].text).toContain('🔄');
			expect(injected.parts[0].text).toContain('NEEDS_REVISION');
			expect(injected.parts[0].text).toContain(
				'Missing documentation for the new API endpoints',
			);
		});
	});

	describe('REJECTED verdict', () => {
		it('injects with ❌ emoji', () => {
			const messages = makeMessages();

			const criticResult = {
				verdict: 'REJECTED',
				reasoning: 'Security issues found.',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				1,
				criticResult,
				'question',
				'critic_oversight',
			);

			const injected = messages[2];
			expect(injected.info.agent).toBe('critic_oversight');
			expect(injected.parts[0].text).toContain('❌');
			expect(injected.parts[0].text).toContain('REJECTED');
		});
	});

	describe('BLOCKED verdict', () => {
		it('injects with 🚫 emoji', () => {
			const messages = makeMessages();

			const criticResult = {
				verdict: 'BLOCKED',
				reasoning: 'Waiting on dependency.',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				1,
				criticResult,
				'question',
				'critic_oversight',
			);

			const injected = messages[2];
			expect(injected.info.agent).toBe('critic_oversight');
			expect(injected.parts[0].text).toContain('🚫');
			expect(injected.parts[0].text).toContain('BLOCKED');
		});
	});

	describe('REPHRASE verdict', () => {
		it('injects with 💬 emoji (default)', () => {
			const messages = makeMessages();

			const criticResult = {
				verdict: 'REPHRASE',
				reasoning: 'Question was unclear.',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				1,
				criticResult,
				'question',
				'critic_oversight',
			);

			const injected = messages[2];
			expect(injected.info.agent).toBe('critic_oversight');
			expect(injected.parts[0].text).toContain('💬');
			expect(injected.parts[0].text).toContain('REPHRASE');
		});
	});

	describe('boundary cases', () => {
		it('handles architectIndex at 0 (first message)', () => {
			const messages = [
				{
					info: { role: 'user' as const, agent: 'architect' },
					parts: [{ type: 'text' as const, text: 'First message' }],
				},
			];

			const criticResult = {
				verdict: 'ANSWER',
				reasoning: 'First answer.',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				0,
				criticResult,
				'question',
				'critic_oversight',
			);

			expect(messages.length).toBe(3);
			expect(messages[0].info.role).toBe('user'); // architect unchanged
			expect(messages[1].info.role).toBe('assistant'); // injected verdict
			expect(messages[1].info.agent).toBe('critic_oversight');
		});

		it('handles very long reasoning', () => {
			const messages = makeMessages();
			const longReasoning = 'A'.repeat(10000);

			const criticResult = {
				verdict: 'APPROVED',
				reasoning: longReasoning,
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				1,
				criticResult,
				'phase_completion',
				'critic_oversight',
			);

			const injected = messages[2];
			expect(injected.info.agent).toBe('critic_oversight');
			expect(injected.parts[0].text).toContain(longReasoning);
		});

		it('handles special characters in reasoning', () => {
			const messages = makeMessages();

			const criticResult = {
				verdict: 'APPROVED',
				reasoning:
					'Works with "quotes", `backticks`, *asterisks*, and [brackets].',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				1,
				criticResult,
				'phase_completion',
				'critic_oversight',
			);

			const injected = messages[2];
			expect(injected.info.agent).toBe('critic_oversight');
			expect(injected.parts[0].text).toContain('"quotes"');
			expect(injected.parts[0].text).toContain('`backticks`');
			expect(injected.parts[0].text).toContain('*asterisks*');
		});

		it('handles unicode in reasoning', () => {
			const messages = makeMessages();

			const criticResult = {
				verdict: 'APPROVED',
				reasoning: 'Works with émoji 🎉 and unicode ✓',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				1,
				criticResult,
				'phase_completion',
				'critic_oversight',
			);

			const injected = messages[2];
			expect(injected.info.agent).toBe('critic_oversight');
			expect(injected.parts[0].text).toContain('🎉');
			expect(injected.parts[0].text).toContain('✓');
		});
	});

	describe('prefixed swarm oversight agent name', () => {
		it('injects verdict with mega_critic_oversight when architect is mega_architect', () => {
			const messages = [
				{
					info: { role: 'assistant' as const, agent: 'orchestrator' },
					parts: [{ type: 'text' as const, text: 'Orchestrator message' }],
				},
				{
					info: { role: 'user' as const, agent: 'mega_architect' },
					parts: [{ type: 'text' as const, text: 'Ready for Phase 2?' }],
				},
			];
			const architectIndex = 1;

			const criticResult = {
				verdict: 'APPROVED',
				reasoning: 'Phase 2 is ready.',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				architectIndex,
				criticResult,
				'phase_completion',
				'mega_critic_oversight',
			);

			expect(messages.length).toBe(4);
			const injected = messages[architectIndex + 1];
			expect(injected.info.role).toBe('assistant');
			expect(injected.info.agent).toBe('mega_critic_oversight');
		});

		it('injects verdict with teamalpha_critic_oversight when architect is teamalpha_architect', () => {
			const messages = [
				{
					info: { role: 'user' as const, agent: 'teamalpha_architect' },
					parts: [{ type: 'text' as const, text: 'Should I proceed?' }],
				},
			];
			const architectIndex = 0;

			const criticResult = {
				verdict: 'ANSWER',
				reasoning: 'Yes, proceed with the implementation.',
				evidenceChecked: [],
				antiPatternsDetected: [],
				escalationNeeded: false,
				rawResponse: '',
			};

			injectVerdictIntoMessages(
				messages,
				architectIndex,
				criticResult,
				'question',
				'teamalpha_critic_oversight',
			);

			expect(messages.length).toBe(3);
			const injected = messages[architectIndex + 1];
			expect(injected.info.agent).toBe('teamalpha_critic_oversight');
		});
	});
});
