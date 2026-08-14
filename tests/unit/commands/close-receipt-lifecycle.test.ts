import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	type CloseStageContext,
	_internals as closeInternals,
	closeReceiptLifecycleInternals,
	runFinalizeStage,
} from '../../../src/commands/close.js';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';

const realClosePlanTerminalState = closeInternals.closePlanTerminalState;
const realCurateAndStoreSwarm = closeInternals.curateAndStoreSwarm;
const realCreateCuratorLLMDelegate = closeInternals.createCuratorLLMDelegate;
const realRunCuratorPostMortem = closeInternals.runCuratorPostMortem;
const realRecordPhaseCloseIntent =
	closeReceiptLifecycleInternals.recordPhaseCloseIntent;
const realReconcilePhaseClose =
	closeReceiptLifecycleInternals.reconcilePhaseClose;

let directory: string;

function makeContext(): CloseStageContext {
	const phases = [
		{
			id: 1,
			name: 'Research',
			status: 'pending' as const,
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'pending' as const,
					size: 'small' as const,
					description: 'Research task',
					depends: [],
					files_touched: [],
				},
			],
		},
		{
			id: 2,
			name: 'Canonical implementation',
			status: 'in_progress' as const,
			tasks: [
				{
					id: '2.1',
					phase: 2,
					status: 'in_progress' as const,
					size: 'small' as const,
					description: 'Implementation task',
					depends: [],
					files_touched: [],
				},
			],
		},
	];
	return {
		directory,
		swarmDir: path.join(directory, '.swarm'),
		planData: {
			title: 'Receipt lifecycle',
			schema_version: '1.0.0',
			current_phase: 2,
			phases,
		},
		planExists: true,
		planAlreadyDone: false,
		config: KnowledgeConfigSchema.parse({ enabled: true, hive_enabled: false }),
		projectName: 'Receipt lifecycle',
		warnings: [],
		closedPhases: [],
		closedTasks: [],
		sessionStart: undefined,
		isForced: false,
		runSkillReview: false,
		options: {},
		phases,
		inProgressPhases: [],
		curationSucceeded: false,
		curationResult: undefined,
		allLessons: [],
		explicitLessons: [],
		retroLessons: [],
		knowledgeSkillHint: '',
		skillReviewSummary: '',
		postMortemSummary: '',
		sessionReflection: undefined,
		hivePromoted: 0,
		sessionKnowledgeCreated: 0,
		fallbackKnowledgeCreated: 0,
		dedupDropped: 0,
		dedupAvailable: true,
		retroLessonTotal: 0,
		fullAuto: false,
		originalStatuses: new Map(),
		guaranteeResult: { closedPhaseIds: [], closedTaskIds: [] },
		archiveResult: '',
		archivedFileCount: 0,
		archivedActiveStateFiles: new Set(),
		archivedActiveStateDirs: new Set(),
		archiveFailureReasons: new Map(),
		archiveResults: [],
		archiveStageFailed: false,
		timestamp: '',
		archiveDir: '',
		archiveSuffix: '',
		args: [],
	};
}

beforeEach(() => {
	directory = mkdtempSync(path.join(tmpdir(), 'close-receipt-lifecycle-'));
	mkdirSync(path.join(directory, '.swarm'));
	closeInternals.curateAndStoreSwarm = mock(async () => ({
		stored: 0,
	})) as never;
	closeInternals.createCuratorLLMDelegate = mock(() => null) as never;
	closeInternals.runCuratorPostMortem = mock(async () => ({
		success: true,
		summary: '',
		warnings: [],
	})) as never;
});

afterEach(() => {
	closeInternals.closePlanTerminalState = realClosePlanTerminalState;
	closeInternals.curateAndStoreSwarm = realCurateAndStoreSwarm;
	closeInternals.createCuratorLLMDelegate = realCreateCuratorLLMDelegate;
	closeInternals.runCuratorPostMortem = realRunCuratorPostMortem;
	closeReceiptLifecycleInternals.recordPhaseCloseIntent =
		realRecordPhaseCloseIntent;
	closeReceiptLifecycleInternals.reconcilePhaseClose = realReconcilePhaseClose;
	rmSync(directory, { recursive: true, force: true });
});

test('records canonical intents before durable plan close and reconciles afterward', async () => {
	const order: string[] = [];
	closeReceiptLifecycleInternals.recordPhaseCloseIntent = mock(
		async (_directory, phase) => {
			order.push(`intent:${phase}`);
			return { ok: true, event_id: 'intent' } as never;
		},
	);
	closeInternals.closePlanTerminalState = mock(async () => {
		order.push('plan');
	}) as never;
	closeReceiptLifecycleInternals.reconcilePhaseClose = mock(
		async (_directory, phase) => {
			order.push(`closed:${phase}`);
			return { ok: true, reconciled: true };
		},
	);

	await runFinalizeStage(makeContext());

	expect(order).toEqual([
		'intent:Phase 1: Research [PENDING]',
		'intent:Phase 2: Canonical implementation [IN PROGRESS]',
		'plan',
		'closed:Phase 1: Research [PENDING]',
		'closed:Phase 2: Canonical implementation [IN PROGRESS]',
	]);
});

test('does not reconcile phase_closed when durable plan persistence fails', async () => {
	const closed = mock(async () => ({ ok: true, reconciled: true }));
	closeReceiptLifecycleInternals.recordPhaseCloseIntent = mock(
		async () => ({ ok: true, event_id: 'intent' }) as never,
	);
	closeInternals.closePlanTerminalState = mock(async () => {
		throw new Error('disk unavailable');
	}) as never;
	closeReceiptLifecycleInternals.reconcilePhaseClose = closed;
	const ctx = makeContext();

	await runFinalizeStage(ctx);

	expect(closed).not.toHaveBeenCalled();
	expect(ctx.warnings).toContain(
		'Failed to persist terminal plan state: disk unavailable',
	);
});
