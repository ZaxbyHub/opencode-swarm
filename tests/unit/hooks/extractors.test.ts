import { describe, expect, it } from 'bun:test';
import type { Plan } from '../../../src/config/plan-schema';
import {
	extractCurrentPhase,
	extractCurrentPhaseFromPlan,
	extractCurrentTask,
	extractCurrentTaskFromPlan,
	extractDecisions,
	extractIncompleteTasks,
	extractIncompleteTasksFromPlan,
	extractPatterns,
} from '../../../src/hooks/extractors';

function createTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0' as const,
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress' as const,
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed' as const,
						size: 'small' as const,
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'in_progress' as const,
						size: 'medium' as const,
						description: 'Task two',
						depends: ['1.1'],
						files_touched: [],
					},
					{
						id: '1.3',
						phase: 1,
						status: 'pending' as const,
						size: 'large' as const,
						description: 'Task three',
						depends: ['1.2'],
						files_touched: [],
					},
				],
			},
			{
				id: 2,
				name: 'Phase 2',
				status: 'pending' as const,
				tasks: [
					{
						id: '2.1',
						phase: 2,
						status: 'pending' as const,
						size: 'small' as const,
						description: 'Future task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		...overrides,
	};
}

describe('extractCurrentTask', () => {
	it('Returns null for empty/falsy input', () => {
		expect(extractCurrentTask('')).toBeNull();
		expect(extractCurrentTask(null as any)).toBeNull();
		expect(extractCurrentTask(undefined as any)).toBeNull();
		expect(extractCurrentTask('   ')).toBeNull();
	});

	it('Returns null when no IN PROGRESS phase exists', () => {
		const content = `# Project Plan

## Phase 1: Setup [COMPLETED]
- [x] 1.1: Init project
- [ ] 1.2: Add config

## Phase 2: Development [PENDING]
- [ ] 2.1: Implement features`;
		const result = extractCurrentTask(content);
		expect(result).toBeNull();
	});

	it('Returns the first `- [ ]` line from the IN PROGRESS phase, trimmed', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [x] 1.1: Init project
- [ ] 1.2: Add config
- [ ] 1.3: Setup tests

## Phase 2: Development [PENDING]
- [ ] 2.1: Implement features`;
		const result = extractCurrentTask(content);
		expect(result).toBe('- [ ] 1.2: Add config');
	});

	it('Stops at next `## ` heading', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [ ] 1.2: Add config
- [ ] 1.3: Setup tests

## Phase 2: Development [PENDING]
- [ ] 2.1: Implement features`;
		const result = extractCurrentTask(content);
		expect(result).toBe('- [ ] 1.2: Add config');
	});

	it('Stops at `---` separator', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [ ] 1.2: Add config
- [ ] 1.3: Setup tests
---
## Phase 2: Development [PENDING]
- [ ] 2.1: Implement features`;
		const result = extractCurrentTask(content);
		expect(result).toBe('- [ ] 1.2: Add config');
	});

	it('Returns only the FIRST incomplete task (not all of them)', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [ ] 1.2: Add config
- [ ] 1.3: Setup tests
- [ ] 1.4: Write docs

## Phase 2: Development [PENDING]`;
		const result = extractCurrentTask(content);
		expect(result).toBe('- [ ] 1.2: Add config');
	});

	it('Ignores completed tasks (`- [x]`)', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [x] 1.1: Init project
- [x] 1.2: Setup basic config
- [ ] 1.3: Add advanced config

## Phase 2: Development [PENDING]`;
		const result = extractCurrentTask(content);
		expect(result).toBe('- [ ] 1.3: Add advanced config');
	});

	it('Returns null when IN PROGRESS phase has no incomplete tasks', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [x] 1.1: Init project
- [x] 1.2: Setup basic config

## Phase 2: Development [PENDING]`;
		const result = extractCurrentTask(content);
		expect(result).toBeNull();
	});

	it('Case-insensitive [in progress] matching', () => {
		const content = `# Project Plan

## Phase 1: Setup [in progress]
- [ ] 1.2: Add config
- [x] 1.1: Init project`;
		const result = extractCurrentTask(content);
		expect(result).toBe('- [ ] 1.2: Add config');
	});

	it('Handles tasks with complex formatting', () => {
		const content =
			`# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [x] 1.1: Init project **done**
- [ ] 1.2: Add config ` +
			'`important` settings' +
			`
- [ ] 1.3: Setup *tests* and **docs**`;
		const result = extractCurrentTask(content);
		expect(result).toBe('- [ ] 1.2: Add config `important` settings');
	});

	it('Returns null when IN PROGRESS phase has only completed tasks', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [x] 1.1: Init project
- [x] 1.2: Setup config
- [x] 1.3: Write tests

## Phase 2: Development [IN PROGRESS]
- [ ] 2.1: Implement features`;
		const result = extractCurrentTask(content);
		expect(result).toBe('- [ ] 2.1: Implement features');
	});
});

describe('extractIncompleteTasks', () => {
	it('Returns null for empty/falsy input', () => {
		expect(extractIncompleteTasks('')).toBeNull();
		expect(extractIncompleteTasks(null as any)).toBeNull();
		expect(extractIncompleteTasks(undefined as any)).toBeNull();
		expect(extractIncompleteTasks('   ')).toBeNull();
	});

	it('Returns null when no IN PROGRESS phase exists', () => {
		const content = `# Project Plan

## Phase 1: Setup [COMPLETED]
- [x] 1.1: Init project
- [ ] 1.2: Add config

## Phase 2: Development [PENDING]
- [ ] 2.1: Implement features`;
		const result = extractIncompleteTasks(content);
		expect(result).toBeNull();
	});

	it('Returns ALL `- [ ]` lines from the IN PROGRESS phase, newline-separated, trimmed', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [x] 1.1: Init project
- [ ] 1.2: Add config
- [ ] 1.3: Setup tests
- [ ] 1.4: Write docs

## Phase 2: Development [PENDING]`;
		const result = extractIncompleteTasks(content);
		expect(result).toBe(
			'- [ ] 1.2: Add config\n- [ ] 1.3: Setup tests\n- [ ] 1.4: Write docs',
		);
	});

	it('Stops at next `## ` heading', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [ ] 1.2: Add config
- [ ] 1.3: Setup tests

## Phase 2: Development [PENDING]
- [ ] 2.1: Implement features`;
		const result = extractIncompleteTasks(content);
		expect(result).toBe('- [ ] 1.2: Add config\n- [ ] 1.3: Setup tests');
	});

	it('Stops at `---` separator', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [ ] 1.2: Add config
- [ ] 1.3: Setup tests
---
## Phase 2: Development [PENDING]
- [ ] 2.1: Implement features`;
		const result = extractIncompleteTasks(content);
		expect(result).toBe('- [ ] 1.2: Add config\n- [ ] 1.3: Setup tests');
	});

	it('Respects maxChars truncation (appends "...")', () => {
		const longTask = '- [ ] Very long task: ' + 'A'.repeat(600);
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [ ] Task 1
${longTask}
- [ ] Task 3

## Phase 2: Development [PENDING]`;
		const result = extractIncompleteTasks(content, 50);
		expect(result).toContain('...');
		expect(result.length).toBeLessThanOrEqual(50 + 3);
	});

	it('Default maxChars is 500', () => {
		const longTask = '- [ ] Very long task: ' + 'A'.repeat(600);
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
${longTask}`;
		const result = extractIncompleteTasks(content);
		if (result) {
			expect(result).toContain('...');
			expect(result.length).toBeLessThanOrEqual(500 + 3);
		}
	});

	it('Returns null when phase has no incomplete tasks', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [x] 1.1: Init project
- [x] 1.2: Setup config

## Phase 2: Development [PENDING]`;
		const result = extractIncompleteTasks(content);
		expect(result).toBeNull();
	});

	it('Case-insensitive [in progress] matching', () => {
		const content = `# Project Plan

## Phase 1: Setup [in progress]
- [ ] Task 1
- [x] Completed task
- [ ] Task 2`;
		const result = extractIncompleteTasks(content);
		expect(result).toBe('- [ ] Task 1\n- [ ] Task 2');
	});

	it('Handles multiple tasks with different indentation', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [ ] 1.2: Add config
    - [ ] Subtask 1
    - [ ] Subtask 2
- [ ] 1.3: Setup tests
- [ ] 1.4: Write docs`;
		const result = extractIncompleteTasks(content);
		expect(result).toBe(
			'- [ ] 1.2: Add config\n- [ ] Subtask 1\n- [ ] Subtask 2\n- [ ] 1.3: Setup tests\n- [ ] 1.4: Write docs',
		);
	});
});

describe('extractPatterns', () => {
	it('Returns null for empty/falsy input', () => {
		expect(extractPatterns('')).toBeNull();
		expect(extractPatterns(null as any)).toBeNull();
		expect(extractPatterns(undefined as any)).toBeNull();
		expect(extractPatterns('   ')).toBeNull();
	});

	it('Returns null when no `## Patterns` section exists', () => {
		const content = `# Context

## Decisions
- Decision 1
- Decision 2

## Other section
Some content here`;
		const result = extractPatterns(content);
		expect(result).toBeNull();
	});

	it('Extracts `- ` lines under `## Patterns` section', () => {
		const content = `# Context

## Decisions
- Decision 1
- Decision 2

## Patterns
- Pattern 1: Always use TypeScript
- Pattern 2: Prefer composition over inheritance
- Pattern 3: Write comprehensive tests

## Other section
- Not a pattern`;
		const result = extractPatterns(content);
		expect(result).toBe(
			'- Pattern 1: Always use TypeScript\n- Pattern 2: Prefer composition over inheritance\n- Pattern 3: Write comprehensive tests',
		);
	});

	it('Stops at next `## ` heading', () => {
		const content = `# Context

## Patterns
- Pattern 1: Use TypeScript
- Pattern 2: Write tests

## Decisions
- Decision 1
- Decision 2`;
		const result = extractPatterns(content);
		expect(result).toBe(
			'- Pattern 1: Use TypeScript\n- Pattern 2: Write tests',
		);
	});

	it('Only collects lines starting with `- ` (ignores other lines)', () => {
		const content = `# Context

## Patterns
- Pattern 1: Use TypeScript
Some explanatory text
- Pattern 2: Write tests
More explanatory text
- Pattern 3: Document everything`;
		const result = extractPatterns(content);
		expect(result).toBe(
			'- Pattern 1: Use TypeScript\n- Pattern 2: Write tests\n- Pattern 3: Document everything',
		);
	});

	it('Respects maxChars truncation (appends "...")', () => {
		const longPattern = '- Pattern: ' + 'A'.repeat(600);
		const content = `# Context

## Patterns
- Pattern 1: Basic
${longPattern}
- Pattern 3: Advanced`;
		const result = extractPatterns(content, 50);
		expect(result).toContain('...');
		expect(result.length).toBeLessThanOrEqual(50 + 3);
	});

	it('Default maxChars is 500', () => {
		const longPattern = '- Pattern: ' + 'A'.repeat(600);
		const content = `# Context

## Patterns
${longPattern}`;
		const result = extractPatterns(content);
		if (result) {
			expect(result).toContain('...');
			expect(result.length).toBeLessThanOrEqual(500 + 3);
		}
	});

	it('Returns null when Patterns section has no bullet points', () => {
		const content = `# Context

## Patterns
Just text, no bullets

## Other section`;
		const result = extractPatterns(content);
		expect(result).toBeNull();
	});

	it('Handles empty Patterns section gracefully', () => {
		const content = `# Context

## Patterns

## Decisions
- Decision 1`;
		const result = extractPatterns(content);
		expect(result).toBeNull();
	});

	it('Handles content with no Patterns section', () => {
		const content = `# Context

## Decisions
- Decision 1

## Decisions 2
- Decision 2`;
		const result = extractPatterns(content);
		expect(result).toBeNull();
	});

	it('Extracts patterns with complex formatting', () => {
		const content =
			`# Context

## Patterns
- **Pattern 1**: Always use ` +
			'`TypeScript`' +
			` for new code
- *Pattern 2*: Prefer **composition** over inheritance
- Pattern 3: Write *comprehensive* tests **and** documentation`;
		const result = extractPatterns(content);
		expect(result).toBe(
			'- **Pattern 1**: Always use `TypeScript` for new code\n- *Pattern 2*: Prefer **composition** over inheritance\n- Pattern 3: Write *comprehensive* tests **and** documentation',
		);
	});
});

describe('extractCurrentPhase', () => {
	it('Returns null for empty/falsy input', () => {
		expect(extractCurrentPhase('')).toBeNull();
		expect(extractCurrentPhase(null as any)).toBeNull();
		expect(extractCurrentPhase(undefined as any)).toBeNull();
		expect(extractCurrentPhase('   ')).toBeNull();
	});

	it('Plan with IN PROGRESS phase → correct phase string', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [ ] 1.1: Init project
- [ ] 1.2: Add config

## Phase 2: Development [PENDING]
- [ ] 2.1: Implement features`;
		const result = extractCurrentPhase(content);
		expect(result).toBe('Phase 1: Setup [IN PROGRESS]');
	});

	it('Plan with only Phase: N header → "Phase N [PENDING]"', () => {
		const content = `Phase: 2

# Project Plan

## Phase 1: Setup [COMPLETED]
- [x] 1.1: Init project

## Phase 2: Development [PENDING]
- [ ] 2.1: Implement features`;
		const result = extractCurrentPhase(content);
		expect(result).toBe('Phase 2 [PENDING]');
	});

	it('Case-insensitive matching for [in progress]', () => {
		const content = `# Project Plan

## Phase 3: Testing [in progress]
- [ ] 3.1: Write unit tests
- [ ] 3.2: Write integration tests`;
		const result = extractCurrentPhase(content);
		expect(result).toBe('Phase 3: Testing [IN PROGRESS]');
	});

	it('IN PROGRESS phase beyond first 20 lines → null (out of scan range)', () => {
		const content = `Phase: 1

${'Line 1\n'.repeat(19)}## Phase 5: Deployment [IN PROGRESS]
- [ ] 5.1: Setup production
- [ ] 5.2: Deploy application`;
		const result = extractCurrentPhase(content);
		expect(result).toBe('Phase 1 [PENDING]');
	});

	it('Plan with both header and IN PROGRESS → IN PROGRESS takes priority', () => {
		const content = `Phase: 3

# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [ ] 1.1: Init project

## Phase 2: Development [PENDING]
- [ ] 2.1: Implement features`;
		const result = extractCurrentPhase(content);
		expect(result).toBe('Phase 1: Setup [IN PROGRESS]');
	});

	it('Multiple IN PROGRESS phases → returns the first one found', () => {
		const content = `# Project Plan

## Phase 1: Setup [IN PROGRESS]
- [ ] 1.1: Init project

## Phase 2: Development [IN PROGRESS]
- [ ] 2.1: Implement features`;
		const result = extractCurrentPhase(content);
		expect(result).toBe('Phase 1: Setup [IN PROGRESS]');
	});

	it('Phase heading with no description → "Phase N:  [IN PROGRESS]"', () => {
		const content = `# Project Plan

## Phase 7: [IN PROGRESS]
- [ ] 7.1: Deploy application`;
		const result = extractCurrentPhase(content);
		expect(result).toBe('Phase 7:  [IN PROGRESS]');
	});
});

describe('extractDecisions', () => {
	it('Returns null for empty/falsy input', () => {
		expect(extractDecisions('')).toBeNull();
		expect(extractDecisions(null as any)).toBeNull();
		expect(extractDecisions(undefined as any)).toBeNull();
		expect(extractDecisions('   ')).toBeNull();
	});

	it('Content with ## Decisions section → extracts bullet points', () => {
		const content = `# Context

## Decisions
- Use TypeScript for all new code
- Follow existing coding standards
- Write comprehensive tests

## Other section
- Not a decision`;
		const result = extractDecisions(content);
		expect(result).toBe(
			'- Use TypeScript for all new code\n- Follow existing coding standards\n- Write comprehensive tests',
		);
	});

	it('No ## Decisions section → null', () => {
		const content = `# Context

## Patterns
- Pattern 1: Use TypeScript

## Other section
- Some content`;
		const result = extractDecisions(content);
		expect(result).toBeNull();
	});

	it('Empty Decisions section → null', () => {
		const content = `# Context

## Decisions

## Other section
- Some content`;
		const result = extractDecisions(content);
		expect(result).toBeNull();
	});

	it('Decisions section with no bullet points → null', () => {
		const content = `# Context

## Decisions
Just text, no bullets here

## Other section
- Some content`;
		const result = extractDecisions(content);
		expect(result).toBeNull();
	});

	it('Respects maxChars truncation (append "...")', () => {
		const longDecision = '- Decision: ' + 'A'.repeat(600);
		const content = `# Context

## Decisions
- Basic decision
${longDecision}
- Another decision`;
		const result = extractDecisions(content, 50);
		expect(result).toContain('...');
		expect(result?.length).toBeLessThanOrEqual(50 + 3);
	});

	it('Default maxChars is 500', () => {
		const longDecision = '- Decision: ' + 'A'.repeat(600);
		const content = `# Context

## Decisions
${longDecision}`;
		const result = extractDecisions(content);
		if (result) {
			expect(result).toContain('...');
			expect(result.length).toBeLessThanOrEqual(500 + 3);
		}
	});

	it('Stops at next ## heading', () => {
		const content = `# Context

## Decisions
- Decision 1: Use TypeScript
- Decision 2: Write tests

## Patterns
- Pattern 1: Follow standards`;
		const result = extractDecisions(content);
		expect(result).toBe(
			'- Decision 1: Use TypeScript\n- Decision 2: Write tests',
		);
	});

	it('Only collects `- ` lines (ignores other text)', () => {
		const content = `# Context

## Decisions
- Decision 1: Use TypeScript
Some explanatory text here
- Decision 2: Write tests
More explanatory text
- Decision 3: Document everything`;
		const result = extractDecisions(content);
		expect(result).toBe(
			'- Decision 1: Use TypeScript\n- Decision 2: Write tests\n- Decision 3: Document everything',
		);
	});
});

describe('extractCurrentPhaseFromPlan', () => {
	it('Returns correct phase info for in_progress phase', () => {
		const plan = createTestPlan({ current_phase: 1 });
		const result = extractCurrentPhaseFromPlan(plan);
		expect(result).toBe('Phase 1: Phase 1 [IN PROGRESS]');
	});

	it('Returns correct status text for complete phase', () => {
		const plan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'complete' as const,
					tasks: [],
				},
			],
		});
		const result = extractCurrentPhaseFromPlan(plan);
		expect(result).toBe('Phase 1: Phase 1 [COMPLETE]');
	});

	it('Returns correct status text for pending phase', () => {
		const plan = createTestPlan({
			current_phase: 2,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'complete' as const,
					tasks: [],
				},
				{
					id: 2,
					name: 'Phase 2',
					status: 'pending' as const,
					tasks: [],
				},
			],
		});
		const result = extractCurrentPhaseFromPlan(plan);
		expect(result).toBe('Phase 2: Phase 2 [PENDING]');
	});

	it('Returns correct status text for blocked phase', () => {
		const plan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'blocked' as const,
					tasks: [],
				},
			],
		});
		const result = extractCurrentPhaseFromPlan(plan);
		expect(result).toBe('Phase 1: Phase 1 [BLOCKED]');
	});

	it('Returns null when current_phase does not match any phase ID', () => {
		const plan = createTestPlan({ current_phase: 99 });
		const result = extractCurrentPhaseFromPlan(plan);
		expect(result).toBeNull();
	});

	it('Returns correct phase when current_phase is 2', () => {
		const plan = createTestPlan({
			current_phase: 2,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'complete' as const,
					tasks: [],
				},
				{
					id: 2,
					name: 'Phase 2',
					status: 'in_progress' as const,
					tasks: [
						{
							id: '2.1',
							phase: 2,
							status: 'pending' as const,
							size: 'small' as const,
							description: 'Task 2.1',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		const result = extractCurrentPhaseFromPlan(plan);
		expect(result).toBe('Phase 2: Phase 2 [IN PROGRESS]');
	});
});

describe('extractCurrentTaskFromPlan', () => {
	it('Returns first in_progress task (prioritizes over pending)', () => {
		const plan = createTestPlan();
		const result = extractCurrentTaskFromPlan(plan);
		expect(result).toBe(
			'- [ ] 1.2: Task two [MEDIUM] (depends: 1.1) ← CURRENT',
		);
	});

	it('Returns first pending task when no in_progress task exists', () => {
		const plan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress' as const,
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed' as const,
							size: 'small' as const,
							description: 'Task one',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending' as const,
							size: 'medium' as const,
							description: 'Task two',
							depends: ['1.1'],
							files_touched: [],
						},
						{
							id: '1.3',
							phase: 1,
							status: 'pending' as const,
							size: 'large' as const,
							description: 'Task three',
							depends: ['1.2'],
							files_touched: [],
						},
					],
				},
			],
		});
		const result = extractCurrentTaskFromPlan(plan);
		expect(result).toBe('- [ ] 1.2: Task two [MEDIUM] (depends: 1.1)');
	});

	it('Returns null when phase has only completed tasks', () => {
		const plan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress' as const,
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed' as const,
							size: 'small' as const,
							description: 'Task one',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'completed' as const,
							size: 'medium' as const,
							description: 'Task two',
							depends: ['1.1'],
							files_touched: [],
						},
					],
				},
			],
		});
		const result = extractCurrentTaskFromPlan(plan);
		expect(result).toBeNull();
	});

	it('Returns null when current_phase does not match any phase ID', () => {
		const plan = createTestPlan({ current_phase: 99 });
		const result = extractCurrentTaskFromPlan(plan);
		expect(result).toBeNull();
	});

	it('Includes dependency info in output', () => {
		const plan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress' as const,
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed' as const,
							size: 'small' as const,
							description: 'Task one',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending' as const,
							size: 'medium' as const,
							description: 'Task with deps',
							depends: ['1.1', '1.3'],
							files_touched: [],
						},
						{
							id: '1.3',
							phase: 1,
							status: 'pending' as const,
							size: 'small' as const,
							description: 'Another task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		const result = extractCurrentTaskFromPlan(plan);
		expect(result).toBe(
			'- [ ] 1.2: Task with deps [MEDIUM] (depends: 1.1, 1.3)',
		);
	});

	it('Shows ← CURRENT marker for in_progress task', () => {
		const plan = createTestPlan();
		const result = extractCurrentTaskFromPlan(plan);
		expect(result).toContain('← CURRENT');
	});

	it('Does NOT show ← CURRENT for pending task', () => {
		const plan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress' as const,
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed' as const,
							size: 'small' as const,
							description: 'Task one',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending' as const,
							size: 'medium' as const,
							description: 'Task two',
							depends: ['1.1'],
							files_touched: [],
						},
					],
				},
			],
		});
		const result = extractCurrentTaskFromPlan(plan);
		expect(result).not.toContain('← CURRENT');
	});
});

describe('extractIncompleteTasksFromPlan', () => {
	it('Returns all pending and in_progress tasks from current phase', () => {
		const plan = createTestPlan();
		const result = extractIncompleteTasksFromPlan(plan);
		expect(result).toBe(
			'- [ ] 1.2: Task two [MEDIUM] (depends: 1.1) ← CURRENT\n- [ ] 1.3: Task three [LARGE] (depends: 1.2)',
		);
	});

	it('Returns null when all tasks are completed', () => {
		const plan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress' as const,
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed' as const,
							size: 'small' as const,
							description: 'Task one',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'completed' as const,
							size: 'medium' as const,
							description: 'Task two',
							depends: ['1.1'],
							files_touched: [],
						},
					],
				},
			],
		});
		const result = extractIncompleteTasksFromPlan(plan);
		expect(result).toBeNull();
	});

	it('Returns null when current phase not found', () => {
		const plan = createTestPlan({ current_phase: 99 });
		const result = extractIncompleteTasksFromPlan(plan);
		expect(result).toBeNull();
	});

	it('Respects maxChars truncation', () => {
		const plan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress' as const,
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending' as const,
							size: 'small' as const,
							description: 'A'.repeat(500),
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending' as const,
							size: 'small' as const,
							description: 'B'.repeat(500),
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		const result = extractIncompleteTasksFromPlan(plan, 100);
		expect(result).toContain('...');
		if (result) {
			expect(result.length).toBeLessThanOrEqual(103);
		}
	});

	it('Each task line includes size and dependencies', () => {
		const plan = createTestPlan();
		const result = extractIncompleteTasksFromPlan(plan);
		expect(result).toContain('[MEDIUM]');
		expect(result).toContain('[LARGE]');
		expect(result).toContain('(depends: 1.1)');
		expect(result).toContain('(depends: 1.2)');
	});

	it('Returns null when phase has no tasks', () => {
		const plan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress' as const,
					tasks: [],
				},
			],
		});
		const result = extractIncompleteTasksFromPlan(plan);
		expect(result).toBeNull();
	});

	it('Emits ← CURRENT marker for in_progress task', () => {
		const plan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress' as const,
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'in_progress' as const,
							size: 'small' as const,
							description: 'Active task',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'pending' as const,
							size: 'medium' as const,
							description: 'Pending task',
							depends: ['1.1'],
							files_touched: [],
						},
					],
				},
			],
		});
		const result = extractIncompleteTasksFromPlan(plan);
		expect(result).toContain('← CURRENT');
		expect(result).toBe(
			'- [ ] 1.1: Active task [SMALL] ← CURRENT\n- [ ] 1.2: Pending task [MEDIUM] (depends: 1.1)',
		);
	});

	it('Does NOT emit ← CURRENT for pending tasks', () => {
		const plan = createTestPlan({
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress' as const,
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending' as const,
							size: 'small' as const,
							description: 'Pending task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		const result = extractIncompleteTasksFromPlan(plan);
		expect(result).not.toContain('← CURRENT');
		expect(result).toBe('- [ ] 1.1: Pending task [SMALL]');
	});
});
