/**
 * Tests for the Epic Mode banner constant.
 * File: tests/unit/hooks/system-enhancer-epic-banner.test.ts
 *
 * Epic v2 C2: the banner is narration only — the user comes first, an open
 * epic is not a start signal, talk to the user, and "call `epic_next_wave`
 * and do exactly what its `status` says". All procedure (wave composition,
 * dispatch steps, remedies) lives in the tool's responses. Delivery (driven
 * by the project's open epic) is covered by
 * system-enhancer-epic-open-banner.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { EPIC_MODE_BANNER } from '../../../src/config/constants';
import { estimateTokens } from '../../../src/hooks/utils';

describe('EPIC_MODE_BANNER content', () => {
	test('routes the whole flow through epic_next_wave and names every status', () => {
		expect(EPIC_MODE_BANNER).toContain(
			'call `epic_next_wave` and do exactly what its `status` says',
		);
		for (const status of [
			'dispatch',
			'declare-scopes',
			'in-progress',
			'blocked',
			'phase-ready-for-review',
			'epic-complete',
			'refused',
		]) {
			expect(EPIC_MODE_BANNER).toContain(`\`${status}\``);
		}
	});

	test('names none of the removed tools or subcommands', () => {
		for (const removed of [
			'epic_decide_phase',
			'epic_plan_waves',
			'epic_record_divergence',
			'epic_run_phase',
			'/swarm epic decide',
			'| last',
			'Seven-step flow',
			'promote',
			'demote',
		]) {
			expect(EPIC_MODE_BANNER).not.toContain(removed);
		}
	});

	test('per-task QA is never waived and dispatch is one Task per taskId in ONE message', () => {
		expect(EPIC_MODE_BANNER).toContain(
			'Per-task QA (Stage A + Stage B) is NEVER waived in Epic',
		);
		const dispatch = EPIC_MODE_BANNER.slice(
			EPIC_MODE_BANNER.indexOf('- `dispatch`'),
			EPIC_MODE_BANNER.indexOf('- `declare-scopes`'),
		);
		expect(dispatch).toContain('one `Task` per `taskId`, ALL in ONE message');
		expect(dispatch.indexOf('`pre_check_batch`')).toBeLessThan(
			dispatch.indexOf('`update_task_status(completed)`'),
		);
		expect(dispatch).toContain('`reviewer` + `test_engineer`');
	});

	test('phase-ready-for-review routes through epic_phase_review then phase_complete', () => {
		const review = EPIC_MODE_BANNER.slice(
			EPIC_MODE_BANNER.indexOf('- `phase-ready-for-review`'),
		);
		expect(review).toContain('`epic_phase_review(phase)`');
		expect(review.indexOf('epic_phase_review')).toBeLessThan(
			review.indexOf('`phase_complete`'),
		);
	});

	test('forbids the opaque Lean dispatch paths', () => {
		expect(EPIC_MODE_BANNER).toContain('`lean_turbo_run_phase`');
		expect(EPIC_MODE_BANNER).toContain('never call');
	});

	test('the user always comes first, before the flow', () => {
		expect(EPIC_MODE_BANNER).toContain('THE USER ALWAYS COMES FIRST');
		expect(EPIC_MODE_BANNER).toContain('STOP advancing the flow');
		expect(EPIC_MODE_BANNER.toLowerCase()).toContain('slash command');
		expect(
			EPIC_MODE_BANNER.indexOf('THE USER ALWAYS COMES FIRST'),
		).toBeLessThan(EPIC_MODE_BANNER.indexOf('epic_next_wave'));
	});

	test('v2 lifecycle: the user opens/closes the epic; no Turbo; no stale toggles', () => {
		expect(EPIC_MODE_BANNER).toContain('`/swarm epic start`');
		expect(EPIC_MODE_BANNER).toContain('Only the user opens or closes an epic');
		expect(EPIC_MODE_BANNER).toContain('Epic enables neither Turbo nor Lean');
		expect(EPIC_MODE_BANNER).not.toContain('/swarm turbo epic');
		expect(EPIC_MODE_BANNER).not.toContain('/swarm epic on');
		expect(EPIC_MODE_BANNER).toContain('`/swarm epic close`');
		expect(EPIC_MODE_BANNER).toContain('/swarm epic status | learning');
	});

	test('narration: talk to the user before each step', () => {
		expect(EPIC_MODE_BANNER).toContain('Talk to the user as you work');
		expect(EPIC_MODE_BANNER).toContain('never go silent');
	});

	test('after an approved phase review it hands off to the normal PHASE-WRAP (docs agent) before phase_complete', () => {
		const line = EPIC_MODE_BANNER.split('\n').find((l) =>
			l.includes('phase-ready-for-review'),
		);
		expect(line).toBeDefined();
		expect(line).toContain('PHASE-WRAP');
		expect(line).toContain('docs agent');
		expect(line?.indexOf('docs agent')).toBeLessThan(
			line?.indexOf('phase_complete') ?? -1,
		);
	});

	test('stays within the pre-v2 injection budget and shrank with C2 (≤ 1000 tokens)', () => {
		// The banner competes for the system-enhancer injection budget. C2
		// moved all procedure into epic_next_wave's responses, so the banner
		// must stay well under the C1 size (1976 tokens).
		expect(estimateTokens(EPIC_MODE_BANNER)).toBeLessThanOrEqual(1000);
	});
});
