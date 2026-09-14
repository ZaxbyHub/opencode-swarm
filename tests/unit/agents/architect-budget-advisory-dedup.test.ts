import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	resetArchitectPromptBudgetAdvisories,
	warnArchitectPromptBudgetExceededOnce,
} from '../../../src/agents/architect';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';

/**
 * Pins the once-per-process-per-error dedup of
 * warnArchitectPromptBudgetExceededOnce (issue #2671 review PRR-102) and its
 * session-start reset contract (resetArchitectPromptBudgetAdvisories, wired
 * next to clearDeferredWarnings in src/index.ts so a fixed-then-reintroduced
 * config warns again in a new session).
 */

const ERROR_A = 'ARCHITECT_PROMPT_BUDGET_EXCEEDED: cell-a 162000 chars';
const ERROR_B = 'ARCHITECT_PROMPT_BUDGET_EXCEEDED: cell-b 163000 chars';

describe('architect budget advisory dedup (#2671 review)', () => {
	beforeEach(() => {
		clearDeferredWarnings();
		resetArchitectPromptBudgetAdvisories();
	});

	afterEach(() => {
		resetArchitectPromptBudgetAdvisories();
	});

	test('identical error text warns exactly once; distinct text warns again', () => {
		warnArchitectPromptBudgetExceededOnce(ERROR_A);
		warnArchitectPromptBudgetExceededOnce(ERROR_A);
		warnArchitectPromptBudgetExceededOnce(ERROR_A);
		expect(
			getDeferredWarnings().filter((w) => w === ERROR_A),
			'identical bounded error must emit exactly one advisory',
		).toHaveLength(1);

		warnArchitectPromptBudgetExceededOnce(ERROR_B);
		expect(
			getDeferredWarnings().some((w) => w === ERROR_B),
			'a distinct error (different label/lengths) must not be suppressed',
		).toBe(true);
	});

	test('reset re-enables emission for the same error (new-session contract)', () => {
		warnArchitectPromptBudgetExceededOnce(ERROR_A);
		expect(getDeferredWarnings().filter((w) => w === ERROR_A)).toHaveLength(1);

		resetArchitectPromptBudgetAdvisories();
		clearDeferredWarnings();
		warnArchitectPromptBudgetExceededOnce(ERROR_A);
		expect(
			getDeferredWarnings().filter((w) => w === ERROR_A),
			'after the session-start reset the same config must warn again',
		).toHaveLength(1);
	});

	// Review ROW-4: the dedup signature normalizes digit runs, so the volatile
	// ±1 char/token counts in an otherwise identical bounded error cannot
	// defeat dedup. RED under the pre-fix raw-text-keyed implementation.
	test('same label with volatile length digits emits exactly one advisory', () => {
		warnArchitectPromptBudgetExceededOnce(
			'ARCHITECT_PROMPT_BUDGET_EXCEEDED: cell-a is 162000 chars',
		);
		warnArchitectPromptBudgetExceededOnce(
			'ARCHITECT_PROMPT_BUDGET_EXCEEDED: cell-a is 162001 chars',
		);
		warnArchitectPromptBudgetExceededOnce(
			'ARCHITECT_PROMPT_BUDGET_EXCEEDED: cell-a is 162003 chars',
		);
		const cellA = getDeferredWarnings().filter((w) => w.includes('cell-a'));
		expect(
			cellA,
			'volatile count drift must not produce repeat advisories for the same label',
		).toHaveLength(1);
	});

	// Review PRR-B07: whitespace-variant formatting of the same bounded
	// error must dedup to one advisory (signature collapses whitespace).
	test('whitespace-variant duplicates emit exactly one advisory', () => {
		clearDeferredWarnings();
		warnArchitectPromptBudgetExceededOnce(
			'ARCHITECT_PROMPT_BUDGET_EXCEEDED: cell-w is  162000 chars',
		);
		warnArchitectPromptBudgetExceededOnce(
			'ARCHITECT_PROMPT_BUDGET_EXCEEDED:  cell-w  is 162000  chars',
		);
		const cellW = getDeferredWarnings().filter((w) => w.includes('cell-w'));
		expect(
			cellW.length,
			'whitespace drift must not produce repeat advisories',
		).toBeLessThanOrEqual(1);
	});

	// Review PRR-A03: the factory-exit check emits the bare 'architect'
	// label while the post-substitution check emits the prefixed
	// 'cloud_architect' label — the same overflowing architect must dedup to
	// ONE advisory across the two composition points.
	test('bare and prefixed labels for the same architect dedup to one advisory', () => {
		clearDeferredWarnings();
		warnArchitectPromptBudgetExceededOnce(
			"ARCHITECT_PROMPT_BUDGET_EXCEEDED: composed architect prompt for 'architect' is 162000 chars (> 161000 ceiling, ~40500 model-token estimate).",
		);
		warnArchitectPromptBudgetExceededOnce(
			"ARCHITECT_PROMPT_BUDGET_EXCEEDED: composed architect prompt for 'cloud_architect' is 162003 chars (> 161000 ceiling, ~40501 model-token estimate).",
		);
		const advisories = getDeferredWarnings().filter((w) =>
			w.includes('ARCHITECT_PROMPT_BUDGET_EXCEEDED'),
		);
		expect(
			advisories.length,
			`the bare and prefixed labels must dedup to one advisory, got: ${JSON.stringify(advisories)}`,
		).toBe(1);
	});

	// Review ROW-3: the signature set is FIFO-bounded — the oldest signature
	// is evicted past MAX_ARCHITECT_BUDGET_SIGNATURES and may warn again,
	// while recent signatures stay suppressed. RED under an unbounded set.
	test('signature set evicts the oldest entry past its bound (re-warn emits)', () => {
		clearDeferredWarnings();
		const distinct: string[] = [];
		for (let i = 0; i < 101; i++) {
			let label = 'agent-';
			let n = i;
			do {
				label += String.fromCharCode(97 + (n % 26));
				n = Math.floor(n / 26);
			} while (n > 0);
			distinct.push(
				`ARCHITECT_PROMPT_BUDGET_EXCEEDED: ${label} is 162000 chars`,
			);
		}
		for (const error of distinct) {
			warnArchitectPromptBudgetExceededOnce(error);
		}
		// The first signature was evicted FIFO; after draining the buffer it
		// must emit again, while the most recent signature stays suppressed.
		clearDeferredWarnings();
		warnArchitectPromptBudgetExceededOnce(distinct[0]);
		expect(
			getDeferredWarnings(),
			'the evicted oldest signature must be eligible to warn again',
		).toHaveLength(1);
		clearDeferredWarnings();
		warnArchitectPromptBudgetExceededOnce(distinct[100]);
		expect(
			getDeferredWarnings(),
			'the most recent signature must remain suppressed',
		).toHaveLength(0);
	});

	// Review PRR-B06: FIFO eviction is symmetric — a MIDDLE entry must also
	// be evicted (and re-warn) once enough newer signatures push it past the
	// bound, not just the oldest.
	test('signature set evicts middle entries once pushed past the bound', () => {
		clearDeferredWarnings();
		const distinct: string[] = [];
		for (let i = 0; i < 101; i++) {
			let label = 'agent-';
			let n = i;
			do {
				label += String.fromCharCode(97 + (n % 26));
				n = Math.floor(n / 26);
			} while (n > 0);
			distinct.push(
				`ARCHITECT_PROMPT_BUDGET_EXCEEDED: ${label} is 162000 chars`,
			);
		}
		for (const error of distinct) {
			warnArchitectPromptBudgetExceededOnce(error);
		}
		// Push 25 more distinct signatures: entries #0..#25 are evicted FIFO,
		// so middle entry #25 must now warn again while a still-recent
		// signature (#100) stays suppressed.
		for (let i = 0; i < 25; i++) {
			let label = 'push-';
			let n = i;
			do {
				label += String.fromCharCode(97 + (n % 26));
				n = Math.floor(n / 26);
			} while (n > 0);
			warnArchitectPromptBudgetExceededOnce(
				`ARCHITECT_PROMPT_BUDGET_EXCEEDED: ${label} is 162000 chars`,
			);
		}
		clearDeferredWarnings();
		warnArchitectPromptBudgetExceededOnce(distinct[25]);
		expect(
			getDeferredWarnings(),
			'the pushed-out middle signature must be eligible to warn again',
		).toHaveLength(1);
		clearDeferredWarnings();
		warnArchitectPromptBudgetExceededOnce(distinct[100]);
		expect(
			getDeferredWarnings(),
			'the most recent signature must remain suppressed',
		).toHaveLength(0);
	});
});
