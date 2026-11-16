/**
 * Epic phase review — provider dispatch failure redaction.
 * File: tests/unit/epic/phase-readiness-dispatch-error-redaction-3710.test.ts
 *
 * #3710 swarm-pr-review R-09 — the Epic phase-review family is a PERSISTENCE
 * sink for provider error text. A failed reviewer/critic dispatch throws with
 * the raw provider message; the catch arm persists
 * `"<role> dispatch failed: " + <message>` into the durable evidence file
 * `.swarm/evidence/<phase>/epic-phase-review.json`.
 *
 * The fix wraps the persisted reason in `sanitizeFailureEvidenceDisplay`
 * AFTER the `classify` callback has read the raw message (so the
 * transient/permanent classification is unchanged).
 *
 * All tokens below are synthetic.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals,
	EPIC_PHASE_REVIEW_FILENAME,
	runEpicPhaseReview,
} from '../../../src/epic/phase-readiness';
import type {
	ReviewDispatchRequest,
	ReviewModelDispatcher,
} from '../../../src/review/contracts';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SYNTH_TOKEN = 'sk-Synth0q9Xb2Lw4R5tY8uI1oP3sD6fG';
const SYNTH_PLACEHOLDER = '[REDACTED:openai]';

let dir: string;
const originalInternals = { ..._internals };

function writePlan(root: string): void {
	fs.mkdirSync(path.join(root, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Epic Redaction Plan',
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

/** Dispatcher that always fails with a token-carrying provider error. */
function failingDispatcher(
	calls: ReviewDispatchRequest[],
): ReviewModelDispatcher {
	return {
		dispatch: async (request) => {
			calls.push(request);
			return {
				agentName: request.agentName,
				status: 'error' as const,
				text: '',
				error: `Provider authentication rejected: invalid API key ${SYNTH_TOKEN} for model access`,
				durationMs: 5,
				promptBytes: request.prompt.length,
				responseBytes: 0,
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
	dir = canonicalMkdtemp('epic-phase-redact-3710-');
	writePlan(dir);
});

afterEach(() => {
	Object.assign(_internals, originalInternals);
	closeAllProjectDbs();
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('epic phase review dispatch failure persists a redacted reason (#3710 R-09)', () => {
	test('the persisted reviewer reason carries the placeholder, not the token', async () => {
		const calls: ReviewDispatchRequest[] = [];
		const result = await runEpicPhaseReview(dir, 1, 'arch', {
			dispatcher: failingDispatcher(calls),
		});

		// Fail-closed posture preserved under redaction.
		expect(result.success && !result.ready).toBe(true);

		const reviewer = stored().reviewer as {
			reason?: string;
			verdict?: string;
			dispatch?: string;
		} | null;
		expect(reviewer).not.toBeNull();
		expect(reviewer?.verdict).toBe('REJECTED');
		expect(reviewer?.dispatch).toBe('failed');
		const reason = reviewer?.reason;
		expect(reason, 'reviewer reason missing').toBeDefined();
		expect(
			reason?.includes(SYNTH_TOKEN),
			`persisted epic reason carries token cleartext: ${reason}`,
		).toBe(false);
		expect(reason).toContain(SYNTH_PLACEHOLDER);
		expect(reason).toContain('reviewer dispatch failed');
	}, 60_000);
});
