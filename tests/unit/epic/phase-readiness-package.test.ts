/**
 * Epic v2 C6 — the phase-review package reads declared / undeclared files
 * from the open epic's recorded outcomes (no divergence log any more) and
 * carries each task's attribution status: `undeclared: []` with attribution
 * `unavailable` / `no-git` is NOT a clean task, so its `files_changed`
 * fall back to the declared scope + `files_touched` instead of claiming the
 * declared ∪ undeclared set is complete.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EpicTaskOutcome } from '../../../src/epic/lifecycle';
import {
	_internals,
	runEpicPhaseReview,
} from '../../../src/epic/phase-readiness';
import type {
	ReviewDispatchRequest,
	ReviewModelDispatcher,
} from '../../../src/review/contracts';
import { stubEpicRecord } from '../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalInternals = { ..._internals };
let dir: string;
let restoreClock: Restore | null = null;

function outcome(
	taskId: string,
	overrides: Partial<EpicTaskOutcome>,
): EpicTaskOutcome {
	return {
		taskId,
		phase: 1,
		waveSeq: 1,
		resolution: 'completed',
		resolvedAt: '2026-06-01T00:00:00.000Z',
		generation: 1,
		stageAFailures: 0,
		stageBFailures: 0,
		mergeFailure: null,
		declared: [`src/${taskId}.ts`],
		undeclared: [],
		attribution: 'session',
		reopened: 0,
		marker: null,
		...overrides,
	};
}

function dispatcher(calls: ReviewDispatchRequest[]): ReviewModelDispatcher {
	return {
		dispatch: async (request) => {
			calls.push(request);
			return {
				status: 'completed',
				agentName: request.agentName,
				text: 'VERDICT: NEEDS_REVISION\nREASON: test',
				durationMs: 1,
				promptBytes: request.prompt.length,
				responseBytes: 1,
			};
		},
	};
}

beforeEach(() => {
	restoreClock = freezeClock({
		fixedNow: Date.parse('2026-06-01T12:00:00.000Z'),
	});
	dir = canonicalMkdtemp('epic-phase-package-');
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Package Plan',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: ['1.1', '1.2', '1.3'].map((id) => ({
						id,
						phase: 1,
						status: 'completed',
						description: `Task ${id}`,
						files_touched: [`src/${id}.ts`, `src/${id}.plan.ts`],
					})),
				},
			],
		}),
	);
	_internals.getOpenEpic = (() =>
		stubEpicRecord({
			tasks: {
				'1.1': outcome('1.1', {
					undeclared: ['src/extra.ts'],
					attribution: 'session',
				}),
				'1.2': outcome('1.2', { attribution: 'unavailable' }),
			},
		})) as never;
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(_internals, originalInternals);
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('phase-review package divergence', () => {
	test('attributed tasks report declared ∪ undeclared; unattributed ones keep files_touched', async () => {
		const calls: ReviewDispatchRequest[] = [];
		await runEpicPhaseReview(dir, 1, 's', { dispatcher: dispatcher(calls) });
		expect(calls.length).toBeGreaterThan(0);
		const json = /```json\n([\s\S]*?)\n```/.exec(calls[0].prompt)?.[1];
		const pkg = JSON.parse(json ?? '{}');
		const byId = Object.fromEntries(
			pkg.tasks.map((t: { id: string }) => [t.id, t]),
		);
		expect(byId['1.1'].divergence).toEqual({
			declared_scope: ['src/1.1.ts'],
			undeclared: ['src/extra.ts'],
			attribution: 'session',
		});
		expect(byId['1.2'].divergence).toEqual({
			declared_scope: ['src/1.2.ts'],
			undeclared: [],
			attribution: 'unavailable',
		});
		expect(byId['1.3'].divergence).toBeUndefined();
		expect(pkg.files_changed).toEqual([
			'src/1.1.ts',
			'src/1.2.plan.ts',
			'src/1.2.ts',
			'src/1.3.plan.ts',
			'src/1.3.ts',
			'src/extra.ts',
		]);
	});
});
