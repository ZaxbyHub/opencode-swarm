import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	evaluatePhaseCriticalDirectives,
	formatDirectiveBlockMessage,
} from '../../../src/hooks/phase-complete-directive-gate.js';

// ---------------------------------------------------------------------------
// Helper types mirroring source
// ---------------------------------------------------------------------------

interface RetrievedEvent {
	type: 'retrieved';
	knowledge_id?: never;
	trace_id: string;
	session_id: string;
	agent: string;
	source: string;
	result_ids: string[];
	phase: string;
	timestamp: string;
	event_id?: string;
}

interface ReceiptEvent {
	type: 'applied' | 'ignored' | 'n_a' | 'violated';
	knowledge_id: string;
	trace_id: string;
	session_id: string;
	agent: string;
	source: string;
	reason?: string;
	timestamp: string;
	event_id?: string;
}

type MockKnowledgeEvent = RetrievedEvent | ReceiptEvent;

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeReadKnowledgeEvents(events: MockKnowledgeEvent[]) {
	return mock(() => Promise.resolve(events as any));
}

function makeCollectPhaseDirectiveIds(ids: string[]) {
	return mock(() => Promise.resolve(ids));
}

function makeReadEntriesById(
	entries: Map<
		string,
		{ id: string; directive_priority: string; status: string }
	>,
) {
	return mock(() => Promise.resolve(entries as any));
}

// ---------------------------------------------------------------------------
// Module-level mocks (restored via mock.restore())
// ---------------------------------------------------------------------------

// Real module captures — used in mock spread below
import * as realKnowledgeEvents from '../../../src/hooks/knowledge-events.js';
import * as realPhaseDirectives from '../../../src/hooks/phase-directives.js';

let mockReadKnowledgeEvents: ReturnType<typeof mock>;
let mockCollectPhaseDirectiveIds: ReturnType<typeof mock>;
let mockReadEntriesById: ReturnType<typeof mock>;

beforeEach(() => {
	mockReadKnowledgeEvents = makeReadKnowledgeEvents([]);
	mockCollectPhaseDirectiveIds = makeCollectPhaseDirectiveIds([]);
	mockReadEntriesById = makeReadEntriesById(new Map());

	mock.module('../../../src/hooks/knowledge-events.js', () => ({
		...realKnowledgeEvents,
		readKnowledgeEvents: mockReadKnowledgeEvents,
	}));

	mock.module('../../../src/hooks/phase-directives.js', () => ({
		...realPhaseDirectives,
		collectPhaseDirectiveIds: mockCollectPhaseDirectiveIds,
		readEntriesById: mockReadEntriesById,
	}));
});

afterEach(() => {
	mock.restore();
});

// ---------------------------------------------------------------------------
// formatDirectiveBlockMessage — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe('formatDirectiveBlockMessage', () => {
	test('renders no_verdict entry with correct explanation', () => {
		const unresolved = [{ id: 'K001', reason: 'no_verdict' as const }];
		const msg = formatDirectiveBlockMessage(unresolved);
		expect(msg).toContain('PHASE_COMPLETE_BLOCKED');
		expect(msg).toContain('K001');
		expect(msg).toContain('no terminal verdict');
	});

	test('renders unremediated_violation entry with correct explanation', () => {
		const unresolved = [
			{ id: 'K002', reason: 'unremediated_violation' as const },
		];
		const msg = formatDirectiveBlockMessage(unresolved);
		expect(msg).toContain('K002');
		expect(msg).toContain(
			'violated with no subsequent applied/verified remediation',
		);
	});

	test('renders multiple unresolved entries', () => {
		const unresolved = [
			{ id: 'K001', reason: 'no_verdict' as const },
			{ id: 'K002', reason: 'unremediated_violation' as const },
		];
		const msg = formatDirectiveBlockMessage(unresolved);
		expect(msg).toContain('K001');
		expect(msg).toContain('K002');
	});
});

// ---------------------------------------------------------------------------
// evaluatePhaseCriticalDirectives — observable outcomes
// ---------------------------------------------------------------------------

describe('evaluatePhaseCriticalDirectives', () => {
	const mockDir = path.join(os.tmpdir(), 'phase-directive-gate-test');

	describe('blocked: true — required gates unmet', () => {
		test('blocks when a critical directive has no verdict at all (no_verdict)', async () => {
			const phaseLabel = '1';
			const directiveId = 'K-critical-001';

			// Phase has one retrieved event that surfaced the directive
			mockReadKnowledgeEvents.mockImplementationOnce(
				makeReadKnowledgeEvents([
					{
						type: 'retrieved',
						trace_id: 't1',
						session_id: 's1',
						agent: 'reviewer',
						source: 'reviewer',
						result_ids: [directiveId],
						phase: phaseLabel,
						timestamp: '2024-01-01T10:00:00.000Z',
					},
				]),
			);
			mockCollectPhaseDirectiveIds.mockResolvedValueOnce([directiveId]);
			mockReadEntriesById.mockResolvedValueOnce(
				new Map([
					[
						directiveId,
						{
							id: directiveId,
							directive_priority: 'critical',
							status: 'established',
						},
					],
				]) as any,
			);

			const result = await evaluatePhaseCriticalDirectives({
				directory: mockDir,
				phaseLabel,
			});

			expect(result.blocked).toBe(true);
			expect(result.unresolved).toContainEqual({
				id: directiveId,
				reason: 'no_verdict',
			});
			expect(result.overridden).toHaveLength(0);
			expect(result.failedClosed).toBe(false);
		});

		test('blocks when a critical directive is violated with no later applied/verified (unremediated_violation)', async () => {
			const phaseLabel = '1';
			const directiveId = 'K-critical-002';

			// Phase window starts at first retrieved event
			mockReadKnowledgeEvents.mockImplementationOnce(
				makeReadKnowledgeEvents([
					{
						type: 'retrieved',
						trace_id: 't1',
						session_id: 's1',
						agent: 'reviewer',
						source: 'reviewer',
						result_ids: [directiveId],
						phase: phaseLabel,
						timestamp: '2024-01-01T10:00:00.000Z',
					},
					{
						type: 'violated',
						knowledge_id: directiveId,
						trace_id: 't2',
						session_id: 's1',
						agent: 'reviewer',
						source: 'reviewer',
						timestamp: '2024-01-01T11:00:00.000Z',
					},
					// No applied after the violation → unremediated
				]),
			);
			mockCollectPhaseDirectiveIds.mockResolvedValueOnce([directiveId]);
			mockReadEntriesById.mockResolvedValueOnce(
				new Map([
					[
						directiveId,
						{
							id: directiveId,
							directive_priority: 'critical',
							status: 'established',
						},
					],
				]) as any,
			);

			const result = await evaluatePhaseCriticalDirectives({
				directory: mockDir,
				phaseLabel,
			});

			expect(result.blocked).toBe(true);
			expect(result.unresolved).toContainEqual({
				id: directiveId,
				reason: 'unremediated_violation',
			});
		});

		test('fails-closed (blocked + failedClosed: true) when readKnowledgeEvents throws', async () => {
			mockReadKnowledgeEvents.mockImplementationOnce(
				mock(() => {
					throw new Error('disk error');
				}),
			);

			const result = await evaluatePhaseCriticalDirectives({
				directory: mockDir,
			});

			expect(result.blocked).toBe(true);
			expect(result.failedClosed).toBe(true);
			expect(result.unresolved).toHaveLength(0);
		});
	});

	describe('blocked: false — all gates pass', () => {
		test('allows when critical directive has applied outcome dated after violation', async () => {
			const phaseLabel = '2';
			const directiveId = 'K-critical-003';
			const violationTs = '2024-01-01T11:00:00.000Z';
			const appliedTs = '2024-01-01T12:00:00.000Z';

			mockReadKnowledgeEvents.mockImplementationOnce(
				makeReadKnowledgeEvents([
					{
						type: 'retrieved',
						trace_id: 't1',
						session_id: 's1',
						agent: 'reviewer',
						source: 'reviewer',
						result_ids: [directiveId],
						phase: phaseLabel,
						timestamp: '2024-01-01T10:00:00.000Z',
					},
					{
						type: 'violated',
						knowledge_id: directiveId,
						trace_id: 't2',
						session_id: 's1',
						agent: 'reviewer',
						source: 'reviewer',
						timestamp: violationTs,
					},
					{
						type: 'applied',
						knowledge_id: directiveId,
						trace_id: 't3',
						session_id: 's1',
						agent: 'architect',
						source: 'reviewer',
						timestamp: appliedTs,
					},
				]),
			);
			mockCollectPhaseDirectiveIds.mockResolvedValueOnce([directiveId]);
			mockReadEntriesById.mockResolvedValueOnce(
				new Map([
					[
						directiveId,
						{
							id: directiveId,
							directive_priority: 'critical',
							status: 'established',
						},
					],
				]) as any,
			);

			const result = await evaluatePhaseCriticalDirectives({
				directory: mockDir,
				phaseLabel,
			});

			expect(result.blocked).toBe(false);
			expect(result.unresolved).toHaveLength(0);
		});

		test('allows when critical directive has ignored outcome with reason and no later violation', async () => {
			const phaseLabel = '2';
			const directiveId = 'K-critical-004';

			mockReadKnowledgeEvents.mockImplementationOnce(
				makeReadKnowledgeEvents([
					{
						type: 'retrieved',
						trace_id: 't1',
						session_id: 's1',
						agent: 'reviewer',
						source: 'reviewer',
						result_ids: [directiveId],
						phase: phaseLabel,
						timestamp: '2024-01-01T10:00:00.000Z',
					},
					{
						type: 'ignored',
						knowledge_id: directiveId,
						trace_id: 't2',
						session_id: 's1',
						agent: 'architect',
						source: 'reviewer',
						reason: 'Not applicable to this phase scope',
						timestamp: '2024-01-01T11:00:00.000Z',
					},
				]),
			);
			mockCollectPhaseDirectiveIds.mockResolvedValueOnce([directiveId]);
			mockReadEntriesById.mockResolvedValueOnce(
				new Map([
					[
						directiveId,
						{
							id: directiveId,
							directive_priority: 'critical',
							status: 'established',
						},
					],
				]) as any,
			);

			const result = await evaluatePhaseCriticalDirectives({
				directory: mockDir,
				phaseLabel,
			});

			expect(result.blocked).toBe(false);
			expect(result.unresolved).toHaveLength(0);
		});

		test('allows when critical directive has n_a outcome with reason', async () => {
			const phaseLabel = '3';
			const directiveId = 'K-critical-005';

			mockReadKnowledgeEvents.mockImplementationOnce(
				makeReadKnowledgeEvents([
					{
						type: 'retrieved',
						trace_id: 't1',
						session_id: 's1',
						agent: 'reviewer',
						source: 'reviewer',
						result_ids: [directiveId],
						phase: phaseLabel,
						timestamp: '2024-01-01T10:00:00.000Z',
					},
					{
						type: 'n_a',
						knowledge_id: directiveId,
						trace_id: 't2',
						session_id: 's1',
						agent: 'architect',
						source: 'reviewer',
						reason: 'Duplicate of K001',
						timestamp: '2024-01-01T11:00:00.000Z',
					},
				]),
			);
			mockCollectPhaseDirectiveIds.mockResolvedValueOnce([directiveId]);
			mockReadEntriesById.mockResolvedValueOnce(
				new Map([
					[
						directiveId,
						{
							id: directiveId,
							directive_priority: 'critical',
							status: 'established',
						},
					],
				]) as any,
			);

			const result = await evaluatePhaseCriticalDirectives({
				directory: mockDir,
				phaseLabel,
			});

			expect(result.blocked).toBe(false);
			expect(result.unresolved).toHaveLength(0);
		});

		test('allows when there are no critical directives in phase', async () => {
			mockReadKnowledgeEvents.mockResolvedValueOnce([]);
			mockCollectPhaseDirectiveIds.mockResolvedValueOnce([]);

			const result = await evaluatePhaseCriticalDirectives({
				directory: mockDir,
				phaseLabel: '99',
			});

			expect(result.blocked).toBe(false);
			expect(result.unresolved).toHaveLength(0);
			expect(result.overridden).toHaveLength(0);
			expect(result.failedClosed).toBe(false);
		});
	});

	describe('overridden — architect acceptViolations', () => {
		test('moves directive to overridden list when its id is in acceptViolations', async () => {
			const phaseLabel = '1';
			const directiveId = 'K-critical-override-001';

			mockReadKnowledgeEvents.mockImplementationOnce(
				makeReadKnowledgeEvents([
					{
						type: 'retrieved',
						trace_id: 't1',
						session_id: 's1',
						agent: 'reviewer',
						source: 'reviewer',
						result_ids: [directiveId],
						phase: phaseLabel,
						timestamp: '2024-01-01T10:00:00.000Z',
					},
					// Still violated, but architect overrides
				]),
			);
			mockCollectPhaseDirectiveIds.mockResolvedValueOnce([directiveId]);
			mockReadEntriesById.mockResolvedValueOnce(
				new Map([
					[
						directiveId,
						{
							id: directiveId,
							directive_priority: 'critical',
							status: 'established',
						},
					],
				]) as any,
			);

			const result = await evaluatePhaseCriticalDirectives({
				directory: mockDir,
				phaseLabel,
				acceptViolations: [directiveId],
			});

			expect(result.blocked).toBe(false);
			expect(result.overridden).toContain(directiveId);
			expect(result.unresolved).toHaveLength(0);
		});
	});

	describe('directive-blocked event / message fidelity', () => {
		test('unresolved list is accurate — both reasons represented', async () => {
			const phaseLabel = '1';
			const idNoVerdict = 'K-nov-001';
			const idUnremediated = 'K-unrem-001';

			mockReadKnowledgeEvents.mockImplementationOnce(
				makeReadKnowledgeEvents([
					{
						type: 'retrieved',
						trace_id: 't1',
						session_id: 's1',
						agent: 'reviewer',
						source: 'reviewer',
						result_ids: [idNoVerdict],
						phase: phaseLabel,
						timestamp: '2024-01-01T10:00:00.000Z',
					},
					{
						type: 'retrieved',
						trace_id: 't2',
						session_id: 's1',
						agent: 'reviewer',
						source: 'reviewer',
						result_ids: [idUnremediated],
						phase: phaseLabel,
						timestamp: '2024-01-01T10:00:00.000Z',
					},
					{
						type: 'violated',
						knowledge_id: idUnremediated,
						trace_id: 't3',
						session_id: 's1',
						agent: 'reviewer',
						source: 'reviewer',
						timestamp: '2024-01-01T11:00:00.000Z',
					},
				]),
			);
			mockCollectPhaseDirectiveIds.mockResolvedValueOnce([
				idNoVerdict,
				idUnremediated,
			]);
			mockReadEntriesById.mockResolvedValueOnce(
				new Map([
					[
						idNoVerdict,
						{
							id: idNoVerdict,
							directive_priority: 'critical',
							status: 'established',
						},
					],
					[
						idUnremediated,
						{
							id: idUnremediated,
							directive_priority: 'critical',
							status: 'established',
						},
					],
				]) as any,
			);

			const result = await evaluatePhaseCriticalDirectives({
				directory: mockDir,
				phaseLabel,
			});

			expect(result.blocked).toBe(true);
			expect(result.unresolved).toContainEqual({
				id: idNoVerdict,
				reason: 'no_verdict',
			});
			expect(result.unresolved).toContainEqual({
				id: idUnremediated,
				reason: 'unremediated_violation',
			});

			// Verify the block message contains both IDs and correct explanations
			const msg = formatDirectiveBlockMessage(result.unresolved);
			expect(msg).toContain(idNoVerdict);
			expect(msg).toContain(idUnremediated);
			expect(msg).toContain('no terminal verdict');
			expect(msg).toContain(
				'violated with no subsequent applied/verified remediation',
			);
		});
	});
});
