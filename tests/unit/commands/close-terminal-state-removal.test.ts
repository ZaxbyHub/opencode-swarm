/**
 * Regression: finalize must remove terminal plan state even when archiving fails,
 * so the next session cannot resurrect the CLOSED plan.
 *
 * Background: the align stage's blanket `git clean -fdX` used to delete the whole
 * gitignored `.swarm/` tree — a backstop that (as a side effect) removed a
 * surviving terminal `plan.json`/`plan-ledger.jsonl` on the archive-failure path.
 * That blanket clean also destroyed `.swarm/knowledge.jsonl` (the reported bug).
 * The fix scopes the align clean to a build-artifact allowlist, so the clean stage
 * (`runCleanStage`) must now own terminal-state removal itself — unconditionally,
 * not gated on archive success — while still preserving cumulative knowledge.
 *
 * This drives `runCleanStage` down the archive-FAILURE path (`archivedActiveStateFiles`
 * empty, which triggers the "Skipped active-state cleanup ... Files preserved" branch),
 * and asserts the terminal plan/ledger are still removed and knowledge is kept.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	type CloseStageContext,
	runCleanStage,
} from '../../../src/commands/close';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let dir: string;
let cleanup: () => void;

function swarmDir(): string {
	return path.join(dir, '.swarm');
}

/**
 * Build a CloseStageContext for the ARCHIVE-FAILURE path: `archivedActiveStateFiles`
 * is empty, so `runCleanStage` takes the "nothing archived → preserve active state"
 * branch. Cast through `unknown` to avoid re-declaring the full sub-type graph in a
 * test fixture; `runCleanStage` only reads the fields set below.
 */
function makeCtx(): CloseStageContext {
	return {
		directory: dir,
		swarmDir: swarmDir(),
		planData: { title: 'Terminal State Test' },
		planExists: true,
		planAlreadyDone: true,
		config: {},
		projectName: 'Terminal State Test',
		warnings: [],
		closedPhases: [],
		closedTasks: [],
		sessionStart: undefined,
		isForced: false,
		runSkillReview: false,
		options: {},
		phases: [],
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
		originalStatuses: new Map(),
		guaranteeResult: { closedPhaseIds: [], closedTaskIds: [] },
		archiveResult: '',
		archivedFileCount: 0,
		// EMPTY → simulate archive failure (nothing was archived).
		archivedActiveStateFiles: new Set<string>(),
		archivedActiveStateDirs: new Set<string>(),
		archiveFailureReasons: new Map(),
		timestamp: '',
		archiveDir: '',
		archiveSuffix: '',
		args: [],
	} as unknown as CloseStageContext;
}

describe('runCleanStage — terminal-state removal on archive failure', () => {
	beforeEach(() => {
		({ dir, cleanup } = createSafeTestDir('close-terminal-state-'));
		mkdirSync(swarmDir(), { recursive: true });
	});

	afterEach(() => {
		cleanup();
	});

	test('removes plan.json + plan-ledger.jsonl but preserves knowledge.jsonl when archiving failed', async () => {
		writeFileSync(path.join(swarmDir(), 'plan.json'), '{"title":"closed"}');
		writeFileSync(
			path.join(swarmDir(), 'plan-ledger.jsonl'),
			'{"seq":1,"event":"created"}\n',
		);
		writeFileSync(
			path.join(swarmDir(), 'knowledge.jsonl'),
			'{"id":1,"lesson":"keep me"}\n',
		);

		const ctx = makeCtx();
		await runCleanStage(ctx);

		// Confirm we actually exercised the archive-failure branch.
		expect(
			ctx.warnings.some((w) => w.includes('Skipped active-state cleanup')),
		).toBe(true);

		// Terminal plan state is gone → no CLOSED-plan resurrection next session.
		expect(existsSync(path.join(swarmDir(), 'plan.json'))).toBe(false);
		expect(existsSync(path.join(swarmDir(), 'plan-ledger.jsonl'))).toBe(false);

		// Cumulative knowledge is preserved. NOTE: `runCleanStage` never targets
		// knowledge.jsonl, so this guards against a *future* regression that adds it to
		// TERMINAL_STATE_FILES / ACTIVE_STATE_TO_CLEAN. The authoritative knowledge-
		// preservation guard against the git-clean bug is the real-git integration test
		// (tests/integration/finalize-clean-preserves-swarm.test.ts).
		expect(existsSync(path.join(swarmDir(), 'knowledge.jsonl'))).toBe(true);
	});

	test('partial archive failure: terminal files removed WITHOUT a misleading "Preserved" warning (F1)', async () => {
		// Prior wart: when plan.json/plan-ledger.jsonl specifically failed to archive,
		// the archive-first guard pushed `Preserved plan-ledger.jsonl ...` — then the
		// unconditional terminal-state removal deleted it anyway, contradicting the
		// warning during a failure investigation. The warning is now reworded for these
		// two files to say they are removed (no archive copy retained).
		writeFileSync(path.join(swarmDir(), 'plan.json'), '{"title":"closed"}');
		writeFileSync(
			path.join(swarmDir(), 'plan-ledger.jsonl'),
			'{"seq":1,"event":"created"}\n',
		);
		writeFileSync(
			path.join(swarmDir(), 'knowledge.jsonl'),
			'{"id":1,"lesson":"keep me"}\n',
		);

		const ctx = makeCtx();
		// Simulate PARTIAL archive success: something archived (enters the guarded
		// branch), but the two terminal files failed to archive with a reason.
		ctx.archivedActiveStateFiles = new Set<string>(['events.jsonl']);
		ctx.archiveFailureReasons = new Map<string, string>([
			['plan.json', 'EBUSY'],
			['plan-ledger.jsonl', 'EBUSY'],
		]);

		await runCleanStage(ctx);

		// Terminal files are still removed (resurrection prevention).
		expect(existsSync(path.join(swarmDir(), 'plan.json'))).toBe(false);
		expect(existsSync(path.join(swarmDir(), 'plan-ledger.jsonl'))).toBe(false);
		// Knowledge preserved.
		expect(existsSync(path.join(swarmDir(), 'knowledge.jsonl'))).toBe(true);
		// No contradictory "Preserved <terminal file>" diagnostic.
		expect(
			ctx.warnings.some((w) => /Preserved plan(-ledger\.jsonl|\.json)/.test(w)),
		).toBe(false);
		// Accurate diagnostic present instead.
		expect(
			ctx.warnings.some(
				(w) =>
					w.includes('plan-ledger.jsonl was not archived') &&
					w.includes('resurrection'),
			),
		).toBe(true);
	});

	test('is idempotent when terminal files are already absent', async () => {
		writeFileSync(
			path.join(swarmDir(), 'knowledge.jsonl'),
			'{"id":1,"lesson":"keep me"}\n',
		);

		const ctx = makeCtx();
		await runCleanStage(ctx);

		// No terminal-state removal failure warnings when the files never existed.
		expect(
			ctx.warnings.some((w) => w.includes('Failed to remove terminal-state')),
		).toBe(false);
		expect(existsSync(path.join(swarmDir(), 'knowledge.jsonl'))).toBe(true);
	});
});
