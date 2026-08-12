import { afterEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	type ActionMenuItem,
	REFLECTION_SYSTEM_PROMPT,
	runSessionReflection,
	type SessionReflectionData,
} from './session-reflection';

// ─── Test fixtures ──────────────────────────────────────────────────

/** Minimal SessionReflectionData with all zeros for clean-session tests. */
const cleanData: SessionReflectionData = {
	timestamp: '2026-01-01T00:00:00Z',
	totalToolCalls: 0,
	totalToolFailures: 0,
	toolProblems: [],
	agentDispatches: [],
	gateFailures: [],
	lessonsFromRetros: [],
	errorTaxonomy: {},
	lessonsStored: 0,
	knowledgeCreated: 0,
	dedupDropCount: 0,
	drainAdmitted: 0,
	drainReinforced: 0,
	drainRejected: 0,
	skillViolationSignals: [],
	nearDuplicateCandidates: [],
	draftedIssueCandidates: [],
};

/** SessionReflectionData with non-zero values across all signal classes. */
const fullData: SessionReflectionData = {
	timestamp: '2026-01-01T00:00:00Z',
	totalToolCalls: 100,
	totalToolFailures: 5,
	toolProblems: [
		{
			tool: 'bash',
			failureCount: 4,
			totalCalls: 20,
			failureRate: 0.2,
			avgDurationMs: 250,
		},
	],
	agentDispatches: [
		{ agent: 'coder', delegationCount: 3, lastDelegationReason: 'task-1.1' },
	],
	gateFailures: [{ gate: 'reviewer', taskId: '1.1', count: 2 }],
	lessonsFromRetros: ['Always check imports before using'],
	errorTaxonomy: { timeout: 3, logic_error: 1 },
	lessonsStored: 2,
	knowledgeCreated: 3,
	dedupDropCount: 1,
	drainAdmitted: 4,
	drainReinforced: 2,
	drainRejected: 1,
	skillViolationSignals: [
		{ skillPath: '.opencode/skills/writing-tests/SKILL.md', violationCount: 3 },
	],
	nearDuplicateCandidates: [
		{
			sessionEntryText: 'Always use path.join for cross-platform paths',
			existingEntryText: 'Use path.join for file paths',
			existingEntryId: 'abc-123',
		},
	],
	draftedIssueCandidates: [
		{
			title: '[bash] Repeated failures during session reflection',
			body: '## Problem\n\n...',
			errorCategory: 'bash',
			evidence: 'Session recorded 2 error taxonomy entries',
		},
	],
};

// ─── buildDeterministicReport tests ──────────────────────────────────

describe('buildDeterministicReport', () => {
	test('includes knowledge delta section with explicit values', () => {
		const report = _internals.buildDeterministicReport(fullData);
		expect(report).toContain('## Knowledge Delta');
		expect(report).toContain('Lessons curated: 2');
		expect(report).toContain('Knowledge entries created: 3');
		expect(report).toContain('Dedup drops (already-known): 1');
		expect(report).toContain('Drain admitted: 4');
		expect(report).toContain('Drain reinforced: 2');
		expect(report).toContain('Drain rejected: 1');
	});

	test('includes skill violations section', () => {
		const report = _internals.buildDeterministicReport(fullData);
		expect(report).toContain('## Skill Violations');
		expect(report).toContain('writing-tests');
		expect(report).toContain('3 violation(s)');
	});

	test('includes near-duplicate section', () => {
		const report = _internals.buildDeterministicReport(fullData);
		expect(report).toContain('## Near-Duplicate Candidates');
		expect(report).toContain('abc-123');
		expect(report).toContain('Always use path.join');
	});

	test('includes drafted issues section', () => {
		const report = _internals.buildDeterministicReport(fullData);
		expect(report).toContain('## Drafted Issue Candidates');
		expect(report).toContain('[bash]');
		expect(report).toContain('Repeated failures during session reflection');
	});

	test('does NOT include Proposed Actions section (appended externally)', () => {
		const dataWithMenu: SessionReflectionData = {
			...fullData,
			assembledMenu: [
				{
					number: 1,
					description: 'Review skill violations for test-skill',
					targetTool: 'skill_improve',
					data: {},
				},
			],
		};
		const report = _internals.buildDeterministicReport(dataWithMenu);
		expect(report).not.toContain('## Proposed Actions');
	});

	test('clean session produces output with explicit negatives (FR-004)', () => {
		const report = _internals.buildDeterministicReport(cleanData);
		// Should always produce output — never empty
		expect(report.length).toBeGreaterThan(0);
		// Proposed Actions is NOT rendered inside buildDeterministicReport (appended externally)
		expect(report).not.toContain('## Proposed Actions');
		// Explicit negative: knowledge delta with all zeros
		expect(report).toContain('## Knowledge Delta');
		expect(report).toContain('Lessons curated: 0');
		expect(report).toContain('Knowledge entries created: 0');
		expect(report).toContain('Dedup drops (already-known): 0');
		expect(report).toContain('Drain admitted: 0');
		expect(report).toContain('Drain reinforced: 0');
		expect(report).toContain('Drain rejected: 0');
		// Explicit negative: skill violations
		expect(report).toContain('## Skill Violations');
		expect(report).toContain('No skill violations detected this session.');
		// Explicit negative: near-duplicate candidates
		expect(report).toContain('## Near-Duplicate Candidates');
		expect(report).toContain(
			'No near-duplicate candidates detected this session.',
		);
		// Explicit negative: drafted issues
		expect(report).toContain('## Drafted Issue Candidates');
		expect(report).toContain('No drafted issue candidates this session.');
		// Explicit negative: skill recommendations
		expect(report).toContain('## Skill Recommendations');
		expect(report).toContain(
			'No skills need updating or creating — capturing nothing is a valid outcome.',
		);
	});

	test('includes problems section for session with failures', () => {
		const report = _internals.buildDeterministicReport(fullData);
		expect(report).toContain('## Problems Encountered');
		expect(report).toContain('5 tool failure(s) across 100 calls');
		expect(report).toContain('1 gate failure(s) recorded');
	});
});

// ─── buildReflectionDataSummary tests ─────────────────────────────────

describe('buildReflectionDataSummary', () => {
	test('includes knowledge delta block for full data', () => {
		const summary = _internals.buildReflectionDataSummary(fullData);
		expect(summary).toContain('KNOWLEDGE DELTA:');
		expect(summary).toContain('Lessons stored (curated): 2');
		expect(summary).toContain('Knowledge entries created: 3');
		expect(summary).toContain('Dedup drops (already-known): 1');
		expect(summary).toContain('Drain admitted: 4');
		expect(summary).toContain('Drain reinforced: 2');
		expect(summary).toContain('Drain rejected: 1');
	});

	test('includes knowledge delta block even for clean session', () => {
		const summary = _internals.buildReflectionDataSummary(cleanData);
		expect(summary).toContain('KNOWLEDGE DELTA:');
		expect(summary).toContain('Lessons stored (curated): 0');
	});

	test('includes skill violation signals when present', () => {
		const summary = _internals.buildReflectionDataSummary(fullData);
		expect(summary).toContain('SKILL VIOLATION SIGNALS:');
		expect(summary).toContain('writing-tests');
	});

	test('includes near-duplicate candidates when present', () => {
		const summary = _internals.buildReflectionDataSummary(fullData);
		expect(summary).toContain('NEAR-DUPLICATE CANDIDATES:');
		expect(summary).toContain('abc-123');
	});

	test('includes drafted issue candidates when present', () => {
		const summary = _internals.buildReflectionDataSummary(fullData);
		expect(summary).toContain('DRAFTED ISSUE CANDIDATES:');
		expect(summary).toContain('[bash]');
	});

	test('renders all signal sections with zero counts for clean session (FR-004)', () => {
		const summary = _internals.buildReflectionDataSummary(cleanData);
		expect(summary).toContain('SKILL VIOLATION SIGNALS: 0 detected');
		expect(summary).toContain('NEAR-DUPLICATE CANDIDATES: 0 found');
		expect(summary).toContain('DRAFTED ISSUE CANDIDATES: 0 drafted');
	});

	test('includes action menu item count summary (FR-007)', () => {
		const dataWithMenu: SessionReflectionData = {
			...fullData,
			assembledMenu: [
				{
					number: 1,
					description: 'Review skill violations for test-skill',
					targetTool: 'skill_improve',
					data: {},
				},
				{
					number: 2,
					description: 'File issue: [bash] Repeated failures',
					targetTool: 'gh issue create',
					data: {},
				},
			],
		};
		const summary = _internals.buildReflectionDataSummary(dataWithMenu);
		expect(summary).toContain('ACTION MENU: 2 items proposed');
	});

	test('shows zero action menu items when assembledMenu is empty (FR-007)', () => {
		const summary = _internals.buildReflectionDataSummary(cleanData);
		expect(summary).toContain('ACTION MENU: 0 items proposed');
	});
});

// ─── REFLECTION_SYSTEM_PROMPT tests ──────────────────────────────────

describe('REFLECTION_SYSTEM_PROMPT', () => {
	test('includes NOOP license in Skill Recommendations section (FR-005)', () => {
		expect(REFLECTION_SYSTEM_PROMPT).toContain(
			'capturing nothing is a valid outcome',
		);
	});

	test('includes the NOOP license text in the Skill Recommendations context', () => {
		// The NOOP license should appear between the skill recommendation bullets
		// and the Process Improvements section
		const skillIdx = REFLECTION_SYSTEM_PROMPT.indexOf(
			'## Skill Recommendations',
		);
		const processIdx = REFLECTION_SYSTEM_PROMPT.indexOf(
			'## Process Improvements',
		);
		expect(skillIdx).toBeGreaterThan(-1);
		expect(processIdx).toBeGreaterThan(skillIdx);
		const noopIdx = REFLECTION_SYSTEM_PROMPT.indexOf(
			'capturing nothing is a valid outcome',
		);
		expect(noopIdx).toBeGreaterThan(skillIdx);
		expect(noopIdx).toBeLessThan(processIdx);
	});
});

// ─── formatActionMenuText tests ───────────────────────────────────

describe('formatActionMenuText', () => {
	test('renders numbered menu items (FR-007)', () => {
		const menu: ActionMenuItem[] = [
			{
				number: 1,
				description: 'Review skill violations',
				targetTool: 'skill_improve',
				data: {},
			},
			{
				number: 2,
				description: 'File issue: bash failures',
				targetTool: 'gh issue create',
				data: {},
			},
		];
		const text = _internals.formatActionMenuText(menu);
		expect(text).toContain('## Proposed Actions');
		expect(text).toContain(
			'1. Review skill violations → (tool: skill_improve)',
		);
		expect(text).toContain(
			'2. File issue: bash failures → (tool: gh issue create)',
		);
	});

	test('returns empty string for empty array', () => {
		const text = _internals.formatActionMenuText([]);
		expect(text).toBe('');
	});

	test('returns empty string for undefined input', () => {
		const text = _internals.formatActionMenuText(
			undefined as unknown as ActionMenuItem[],
		);
		expect(text).toBe('');
	});
});

// ─── runSessionReflection: menu append tests ───────────────────────

describe('runSessionReflection menu append (FR-007)', () => {
	const originalAssembleActionMenu = _internals.assembleActionMenu;
	const mockMenu: ActionMenuItem[] = [
		{
			number: 1,
			description: 'Review skill violations',
			targetTool: 'skill_improve',
			data: {},
		},
	];

	afterEach(() => {
		_internals.assembleActionMenu = originalAssembleActionMenu;
	});

	test('LLM delegate output includes appended action menu', async () => {
		_internals.assembleActionMenu = () => mockMenu;
		const mockDelegate = async () =>
			'LLM report without menu. This is the delegate analysis.';

		const result = await runSessionReflection({
			directory: process.cwd(),
			toolAggregates: new Map(),
			agentSessions: new Map(),
			delegate: mockDelegate,
		});

		expect(result.source).toBe('llm');
		expect(result.architectReport).toContain('LLM report without menu');
		expect(result.architectReport).toContain('## Proposed Actions');
		expect(result.architectReport).toContain(
			'1. Review skill violations → (tool: skill_improve)',
		);
	});

	test('deterministic path includes appended action menu', async () => {
		_internals.assembleActionMenu = () => mockMenu;

		// No delegate → deterministic path
		const result = await runSessionReflection({
			directory: process.cwd(),
			toolAggregates: new Map(),
			agentSessions: new Map(),
		});

		expect(result.source).toBe('deterministic');
		expect(result.architectReport).toContain('## Proposed Actions');
		expect(result.architectReport).toContain(
			'1. Review skill violations → (tool: skill_improve)',
		);
	});

	test('no menu appended when assembledMenu is empty', async () => {
		_internals.assembleActionMenu = () => [];
		const mockDelegate = async () => 'LLM report.';

		const result = await runSessionReflection({
			directory: process.cwd(),
			toolAggregates: new Map(),
			agentSessions: new Map(),
			delegate: mockDelegate,
		});

		expect(result.architectReport).toBe('LLM report.');
		expect(result.architectReport).not.toContain('## Proposed Actions');
	});
});
