/**
 * #3177 finding B (AC4-AC5): the scoped model-fallback selection is keyed per
 * phase — lane ids restart their numbering every phase, so phase N+1's
 * same-named lane must NOT resume phase N's advanced (or exhausted)
 * selection.
 *
 * - AC4: phase 2's lane dispatches (>= 1 session.prompt call) even after
 *   phase 1 exhausted the chain.
 * - AC5: phase 2's first dispatch is on the primary model (no wrong-model
 *   resume after phase 1 advanced and ended permanently on the fallback).
 */
import { describe, expect, test } from 'bun:test';
import {
	FALLBACK_MODEL,
	makeRunner3177Harness,
	PRIMARY_MODEL,
} from './runner-3177-fixtures';

describe('#3177 phase-fresh scoped fallback selection', () => {
	test('AC4: phase 2 dispatches after phase 1 exhausted the chain transiently', async () => {
		const h = makeRunner3177Harness([
			{ statusCode: 429, message: 'Rate limit exceeded for model' },
		]);
		try {
			await h.runner.runPhase(1);
			// Phase 1 exhausted primary + fallback.
			expect(h.promptModels).toEqual([PRIMARY_MODEL, FALLBACK_MODEL]);

			h.setResponses([null]);
			const before = h.promptModels.length;
			await h.runner.runPhase(2);
			// Phase 2 dispatched (no instant "no dispatch attempted").
			expect(h.promptModels.length).toBeGreaterThan(before);
		} finally {
			h.cleanup();
		}
	}, 30_000);

	test('AC5: phase 2 restarts from the primary after phase 1 advanced and failed permanently on the fallback', async () => {
		const h = makeRunner3177Harness([
			// Primary attempt: transient → advance. Fallback attempt (sticky):
			// deterministic 403 → chain stops there.
			{ statusCode: 429, message: 'Rate limit exceeded for model' },
			{ statusCode: 403, message: 'access denied for this key' },
		]);
		try {
			await h.runner.runPhase(1);
			expect(h.promptModels).toEqual([PRIMARY_MODEL, FALLBACK_MODEL]);

			h.setResponses([null]);
			await h.runner.runPhase(2);
			// Phase 2's first dispatch used the PRIMARY model, not the
			// fallback phase 1 died on.
			expect(h.promptModels).toEqual([
				PRIMARY_MODEL,
				FALLBACK_MODEL,
				PRIMARY_MODEL,
			]);
		} finally {
			h.cleanup();
		}
	}, 30_000);
});

test('AC4 (run scope): a sibling runner for the SAME phase starts fresh after exhaustion', async () => {
	// F-002: pins the per-runner run ordinal — a re-run of the same phase
	// (the lean-turbo-run-phase tool builds a fresh runner per call, in the
	// SAME process and session) must not inherit that phase's own exhausted
	// chain. The sibling shares this harness's directory/session/agent chain
	// WITHOUT resetting the scoped-selection store, so only the run ordinal
	// separates the two keys — under a constant-run-ordinal mutant the sibling
	// would inherit the exhausted selection and dispatch nothing.
	const h = makeRunner3177Harness([
		{ statusCode: 429, message: 'Rate limit exceeded for model' },
	]);
	try {
		await h.runner.runPhase(1);
		expect(h.promptModels).toEqual([PRIMARY_MODEL, FALLBACK_MODEL]);

		const sibling = h.makeSiblingRunner([null]);
		await sibling.runner.runPhase(1);
		expect(sibling.promptModels).toEqual([PRIMARY_MODEL]);
	} finally {
		h.cleanup();
	}
}, 30_000);
