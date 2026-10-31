/**
 * #3260-B behavioral enforcement for the clean-stage admission deadline (the
 * frozen C2 pins the constant; THIS test pins the behavior). Drives the real
 * runCleanStage over a real .swarm fixture with an injected clock
 * (_internals.now) and a stubbed artifact-unlink recorder:
 *  - expiry stops FURTHER artifact admissions (skipped artifact stays on disk),
 *  - exactly ONE bounded deadline warning is emitted,
 *  - the unconditional terminal-state removal still runs (real files gone —
 *    observed on disk, not through a seam: that loop calls fs.unlink directly),
 *  - env parsing: SWARM_CLEAN_STAGE_DEADLINE_MS overrides, invalid falls back.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	resolveCleanStageDeadlineMs,
	runCleanStage,
} from '../../../src/commands/close/clean-stage';
import type { CloseStageContext } from '../../../src/commands/close/context';
import { CLEAN_STAGE_DEADLINE_MS } from '../../../src/commands/close/unlink-schedule';
import { _internals } from '../../../src/commands/close.js';
import type { KnowledgeConfig } from '../../../src/config/schema';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realNow = _internals.now;
const realUnlinkWithRetry = _internals.unlinkActiveStateFileWithRetry;

afterEach(() => {
	_internals.now = realNow;
	_internals.unlinkActiveStateFileWithRetry = realUnlinkWithRetry;
	delete process.env.SWARM_CLEAN_STAGE_DEADLINE_MS;
});

function buildContext(root: string): CloseStageContext {
	return {
		directory: root,
		swarmDir: path.join(root, '.swarm'),
		planData: { title: 'deadline-fixture', phases: [] },
		planExists: true,
		planAlreadyDone: false,
		config: {} as KnowledgeConfig,
		projectName: 'deadline-fixture',
		warnings: [],
		closedPhases: [],
		closedTasks: [],
		sessionStart: undefined,
		isForced: false,
		runSkillReview: false,
		options: {},
		phases: [],
		inProgressPhases: [],
		curationSucceeded: true,
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
		archiveResult: 'fixture',
		archivedFileCount: 2,
		// ACTIVE_STATE_TO_CLEAN order: events.jsonl precedes handoff.md, so
		// events.jsonl is the admitted-first artifact and handoff.md the one
		// the expired deadline must skip.
		archivedActiveStateFiles: new Set(['events.jsonl', 'handoff.md']),
		archivedActiveStateDirs: new Set(),
		archiveFailureReasons: new Map(),
		archiveResults: [],
		archiveStageFailed: false,
		timestamp: '2026-10-31T00:00:00.000Z',
		archiveDir: path.join(root, '.swarm', 'archive'),
		archiveSuffix: 'fixture',
		args: [],
	};
}

describe('clean-stage admission deadline behavior (3260-B)', () => {
	test('expiry skips further artifact admissions, warns once, still removes terminal state', async () => {
		process.env.SWARM_CLEAN_STAGE_DEADLINE_MS = '100';
		const root = canonicalMkdtemp('clean-stage-deadline-3260-');
		const swarmDir = path.join(root, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		// Admitted-first artifact (deleted by the stub), skipped artifact
		// (must remain), and real terminal-state files.
		fs.writeFileSync(path.join(swarmDir, 'events.jsonl'), 'events');
		fs.writeFileSync(path.join(swarmDir, 'handoff.md'), 'handoff');
		fs.writeFileSync(path.join(swarmDir, 'plan.json'), '{}');
		fs.writeFileSync(path.join(swarmDir, 'plan-ledger.jsonl'), '');

		// Injected clock: starts in-budget; the unlink stub flips it past
		// the deadline AFTER the first artifact is admitted, so the NEXT
		// admission check trips.
		let nowValue = 0;
		_internals.now = () => nowValue;
		const unlinked: string[] = [];
		_internals.unlinkActiveStateFileWithRetry = (async (filePath: string) => {
			unlinked.push(filePath);
			await fs.promises.unlink(filePath);
			nowValue = 1_000_000;
		}) as typeof _internals.unlinkActiveStateFileWithRetry;

		try {
			const ctx = buildContext(root);
			const result = await runCleanStage(ctx);

			// Artifact admission: exactly one artifact admitted; the
			// skipped one remains on disk (preserved — archive copy exists).
			expect(unlinked).toHaveLength(1);
			expect(unlinked[0]).toBe(path.join(swarmDir, 'events.jsonl'));
			expect(fs.existsSync(path.join(swarmDir, 'handoff.md'))).toBe(true);

			// Exactly ONE bounded deadline warning for the whole stage.
			const deadlineWarnings = ctx.warnings.filter((w) =>
				w.includes('clean-stage admission deadline'),
			);
			expect(deadlineWarnings).toHaveLength(1);
			expect(deadlineWarnings[0]).toContain('1 active-state artifact');

			// Terminal-state removal is unconditional and post-admission:
			// observed ON DISK (that loop calls fs.unlink directly, not a
			// seam — see the plan's P2 note).
			expect(fs.existsSync(path.join(swarmDir, 'plan.json'))).toBe(false);
			expect(fs.existsSync(path.join(swarmDir, 'plan-ledger.jsonl'))).toBe(
				false,
			);
			expect(result.cleanedFiles).toContain('events.jsonl');
		} finally {
			_internals.now = realNow;
			_internals.unlinkActiveStateFileWithRetry = realUnlinkWithRetry;
			safeRmRecursive(root);
		}
	}, 30_000);

	test('env parsing: valid override wins, invalid and empty fall back to the default', () => {
		process.env.SWARM_CLEAN_STAGE_DEADLINE_MS = '1234';
		expect(resolveCleanStageDeadlineMs()).toBe(1234);
		process.env.SWARM_CLEAN_STAGE_DEADLINE_MS = 'not-a-number';
		expect(resolveCleanStageDeadlineMs()).toBe(CLEAN_STAGE_DEADLINE_MS);
		process.env.SWARM_CLEAN_STAGE_DEADLINE_MS = '-5';
		expect(resolveCleanStageDeadlineMs()).toBe(CLEAN_STAGE_DEADLINE_MS);
		process.env.SWARM_CLEAN_STAGE_DEADLINE_MS = '';
		expect(resolveCleanStageDeadlineMs()).toBe(CLEAN_STAGE_DEADLINE_MS);
	});
});
