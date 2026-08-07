/**
 * Tests for the governed-skill-optimizer lifecycle state machine.
 * Covers: every legal transition, illegal-transition rejection, restart-from-
 * last-complete, never-rerun-one-shot validation, inconclusive re-entry.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	assertTransition,
	currentCandidateState,
	IllegalTransitionError,
	isLegalTransition,
	isTerminal,
	recordTransition,
} from '../../../../src/services/skill-optimizer/lifecycle.js';
import { mintCandidateId } from '../../../../src/services/skill-optimizer/store.js';

let tmp = '';

beforeEach(() => {
	tmp = mkdtempSync(path.join(tmpdir(), 'skill-opt-life-'));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe('skill-opt lifecycle — legal transitions', () => {
	it('allows discovered -> drafted', () => {
		expect(isLegalTransition(null, 'discovered')).toBe(true);
		expect(isLegalTransition('discovered', 'drafted')).toBe(true);
	});

	it('allows the full happy path', () => {
		expect(isLegalTransition('drafted', 'smoke_validated')).toBe(true);
		expect(isLegalTransition('smoke_validated', 'validation_running')).toBe(
			true,
		);
		expect(
			isLegalTransition('validation_running', 'accepted_pending_approval'),
		).toBe(true);
		expect(isLegalTransition('accepted_pending_approval', 'activated')).toBe(
			true,
		);
		expect(isLegalTransition('activated', 'rolled_back')).toBe(true);
	});

	it('allows inconclusive -> drafted re-entry (D8)', () => {
		expect(isLegalTransition('validation_running', 'inconclusive')).toBe(true);
		expect(isLegalTransition('inconclusive', 'drafted')).toBe(true);
	});

	it('rejects illegal transitions', () => {
		expect(() => assertTransition('discovered', 'activated')).toThrow(
			IllegalTransitionError,
		);
		expect(() => assertTransition('rejected', 'drafted')).toThrow(
			IllegalTransitionError,
		);
		expect(() => assertTransition('drafted', 'activated')).toThrow(
			IllegalTransitionError,
		);
		expect(() => assertTransition(null, 'activated')).toThrow(
			IllegalTransitionError,
		);
	});
});

describe('skill-opt lifecycle — recordTransition', () => {
	it('records a sequence of transitions', async () => {
		const slug = 'seq-skill';
		const id = mintCandidateId();
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'drafted',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		const state = currentCandidateState(tmp, slug, id);
		expect(state.state).toBe('drafted');
		expect(state.lastEvent?.seq).toBe(2);
	});

	it('refuses an illegal transition', async () => {
		const slug = 'illegal-skill';
		const id = mintCandidateId();
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		let threw = false;
		try {
			await recordTransition({
				directory: tmp,
				skillSlug: slug,
				candidateId: id,
				toState: 'activated',
				eventType: 'e',
				actor: 't',
				origin: 't',
				reason: 'r',
			});
		} catch (err) {
			threw = err instanceof IllegalTransitionError;
		}
		expect(threw).toBe(true);
	});

	it('never reruns a one-shot validation', async () => {
		const slug = 'oneshot-skill';
		const id = mintCandidateId();
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'drafted',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'smoke_validated',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'validation_running',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'accepted_pending_approval',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		// Attempting to re-enter validation_running must throw.
		let threw = false;
		try {
			await recordTransition({
				directory: tmp,
				skillSlug: slug,
				candidateId: id,
				toState: 'validation_running',
				eventType: 'e',
				actor: 't',
				origin: 't',
				reason: 'r',
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	it('restarts from the last complete transition', async () => {
		const slug = 'restart-skill';
		const id = mintCandidateId();
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'discovered',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'drafted',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		// currentCandidateState re-derives from the ledger (restart-safe).
		const state = currentCandidateState(tmp, slug, id);
		expect(state.state).toBe('drafted');
		// A further transition continues from 'drafted'.
		await recordTransition({
			directory: tmp,
			skillSlug: slug,
			candidateId: id,
			toState: 'smoke_validated',
			eventType: 'e',
			actor: 't',
			origin: 't',
			reason: 'r',
		});
		expect(currentCandidateState(tmp, slug, id).state).toBe('smoke_validated');
	});

	it('identifies terminal states', () => {
		expect(isTerminal('rejected')).toBe(true);
		expect(isTerminal('expired')).toBe(true);
		expect(isTerminal('rolled_back')).toBe(true);
		expect(isTerminal('activated')).toBe(false);
		expect(isTerminal('drafted')).toBe(false);
		expect(isTerminal(null)).toBe(false);
	});
});
