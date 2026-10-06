/**
 * F-013 (PR #3066 review): the phase approval is bound to the epic instance.
 *
 * The freshness binding covered the plan, the phase's tasks and their gate
 * evidence, but not WHICH epic the review ran under, and the evidence file
 * survives `/swarm epic close`. A review recorded under one epic could then
 * satisfy phase_complete under a new epic on the same plan (same plan, same
 * task evidence, within the 24h TTL). The binding now records the open
 * epic's key; a different key, or evidence written before the field existed,
 * is stale and the architect re-runs `epic_phase_review`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals,
	EPIC_PHASE_REVIEW_FILENAME,
	runEpicPhaseReview,
	verifyEpicPhaseReadiness,
} from '../../../src/epic/phase-readiness';
import type {
	ReviewDispatchRequest,
	ReviewModelDispatcher,
} from '../../../src/review/contracts';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
const originalInternals = { ..._internals };
const FROZEN_NOW_MS = Date.parse('2026-06-01T12:00:00.000Z');
let restoreClock: Restore | null = null;

const APPROVED =
	'Looks good.\nVERDICT: APPROVED\nREASON: integrated change is sound';

function writePlan(root: string): void {
	fs.mkdirSync(path.join(root, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Epic Retry Plan',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: ['1.1', '1.2'].map((id) => ({
						id,
						phase: 1,
						status: 'completed',
						description: `Task ${id}`,
						files_touched: [`src/${id}.ts`],
					})),
				},
			],
		}),
	);
	for (const id of ['1.1', '1.2']) {
		fs.writeFileSync(
			path.join(root, '.swarm', 'evidence', `${id}.json`),
			JSON.stringify({ taskId: id }),
		);
	}
}

/**
 * Scripted dispatcher: each agent gets its responses in order (a string is a
 * `completed` response with that text, an Error is an `error` dispatch).
 */
type Scripted = string | Error | { text: string; durationMs: number };

function scriptedDispatcher(
	script: Record<string, Scripted[]>,
	calls: ReviewDispatchRequest[],
): ReviewModelDispatcher {
	const cursor: Record<string, number> = {};
	return {
		dispatch: async (request) => {
			calls.push(request);
			const index = cursor[request.agentName] ?? 0;
			cursor[request.agentName] = index + 1;
			const raw = script[request.agentName]?.[index] ?? '';
			const timed = typeof raw === 'object' && !(raw instanceof Error);
			const next = timed ? raw.text : raw;
			const base = {
				agentName: request.agentName,
				durationMs: timed ? raw.durationMs : 5,
				promptBytes: request.prompt.length,
			};
			return next instanceof Error
				? {
						...base,
						status: 'error' as const,
						text: '',
						error: next.message,
						responseBytes: 0,
					}
				: {
						...base,
						status: 'completed' as const,
						text: next,
						responseBytes: next.length,
					};
		},
	};
}

function stored(): Record<string, Record<string, unknown> | null> {
	return JSON.parse(
		fs.readFileSync(
			path.join(dir, '.swarm', 'evidence', '1', EPIC_PHASE_REVIEW_FILENAME),
			'utf-8',
		),
	);
}

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FROZEN_NOW_MS });
	dir = canonicalMkdtemp('epic-phase-binding-');
	writePlan(dir);
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(_internals, originalInternals);
	closeAllProjectDbs();
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

function openEpic(epicKey: string | null): void {
	_internals.getOpenEpic = (() =>
		epicKey === null ? null : { epicKey, waves: [], tasks: {} }) as never;
}

async function reviewUnder(epicKey: string): Promise<void> {
	openEpic(epicKey);
	const result = await runEpicPhaseReview(dir, 1, 'arch', {
		dispatcher: scriptedDispatcher(
			{ reviewer: [APPROVED], critic: [APPROVED] },
			[],
		),
	});
	expect(result.success && result.ready).toBe(true);
}

describe('epic phase review bound to the epic instance (F-013)', () => {
	test('the binding records the open epic key', async () => {
		await reviewUnder('epic-A');
		expect(stored().binding).toMatchObject({ epic_key: 'epic-A' });
	});

	test('a review recorded under one epic is stale under another', async () => {
		await reviewUnder('epic-A');
		openEpic('epic-B');
		const result = await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS);
		expect(result).toMatchObject({
			ok: false,
			code: 'EPIC_PHASE_REVIEW_STALE',
		});
		if (!result.ok) expect(result.reason).toContain('epic instance');
		openEpic('epic-A');
		expect((await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS)).ok).toBe(
			true,
		);
	});

	test('evidence written before the field existed is stale while an epic is open', async () => {
		await reviewUnder('epic-A');
		const file = path.join(
			dir,
			'.swarm',
			'evidence',
			'1',
			EPIC_PHASE_REVIEW_FILENAME,
		);
		const evidence = JSON.parse(fs.readFileSync(file, 'utf-8'));
		delete evidence.binding.epic_key;
		fs.writeFileSync(file, JSON.stringify(evidence));
		const result = await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS);
		expect(result).toMatchObject({
			ok: false,
			code: 'EPIC_PHASE_REVIEW_STALE',
		});
	});
});
