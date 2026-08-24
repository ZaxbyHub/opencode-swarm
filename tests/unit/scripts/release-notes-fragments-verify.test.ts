/**
 * verifyBlockSurvived — settle-verify loop protecting the injected
 * custom-release-notes block against external PR-body rewriters (cubic).
 *
 * All I/O is injected (fetchBody / applyEdit / sleep), so the race is
 * exercised without mocking the gh subprocess.
 */

import { describe, expect, test } from 'bun:test';
import {
	MARKER_END,
	MARKER_START,
	verifyBlockSurvived,
} from '../../../scripts/release-notes-fragments.mjs';

const NOTES = `${MARKER_START}\nrich notes\n${MARKER_END}`;

interface Harness {
	edits: string[];
	sleptMs: number[];
	warnings: string[];
	current: string;
}

/**
 * Mutable single-value body store. `rewriteOnceAfterFirstEdit` simulates an
 * external rewriter (cubic) that drops the marker block AFTER our first
 * successful edit, during the settle window.
 */
function makeHarness(
	initial: string,
	opts: { rewriteOnceAfterFirstEdit?: boolean; alwaysRewrite?: boolean } = {},
) {
	const h: Harness = { edits: [], sleptMs: [], warnings: [], current: initial };
	let externalRewrites = 0;
	return {
		h,
		fetchBody: async () => {
			const shouldRewrite =
				opts.alwaysRewrite ||
				(opts.rewriteOnceAfterFirstEdit === true &&
					h.edits.length >= 1 &&
					externalRewrites === 0);
			if (shouldRewrite && h.current.includes(MARKER_START)) {
				externalRewrites++;
				h.current = h.current.replace(`${NOTES}\n\n`, '');
			}
			return h.current;
		},
		applyEdit: async (body: string) => {
			h.edits.push(body);
			h.current = body;
		},
		sleep: async (ms: number) => {
			h.sleptMs.push(ms);
		},
		log: (msg: string) => {
			if (msg.includes('::warning::')) h.warnings.push(msg);
		},
	};
}

/** A runAttempt that injects the block when missing (idempotent upsert). */
type AttemptCtx = {
	fetchBody: () => Promise<string>;
	applyEdit: (b: string) => Promise<void>;
	log: (m: string) => void;
};

function injectingAttempt() {
	return async (ctx: AttemptCtx) => {
		const body = await ctx.fetchBody();
		if (body.includes(MARKER_START)) {
			ctx.log('already up to date — no edit');
			return body;
		}
		const next = `${NOTES}\n\n${body}`;
		await ctx.applyEdit(next);
		return next;
	};
}

describe('verifyBlockSurvived', () => {
	test('marker survives our edit → single attempt, no warning', async () => {
		const t = makeHarness('changelog body');
		const ok = await verifyBlockSurvived({
			runAttempt: injectingAttempt(),
			fetchBody: t.fetchBody,
			applyEdit: t.applyEdit,
			sleep: t.sleep,
			delayMs: 0,
			log: t.log,
		});
		expect(ok).toBe(true);
		expect(t.h.edits.length).toBe(1);
		// delayMs=0 skips the sleep entirely (impl guard) — no time wasted
		// in tests while the settle fetch still runs.
		expect(t.h.sleptMs).toEqual([]);
		expect(t.h.warnings).toEqual([]);
	});

	test('marker clobbered after edit → full re-attempt against the fresh (stripped) body', async () => {
		const t = makeHarness('changelog body', {
			rewriteOnceAfterFirstEdit: true,
		});
		let sawStrippedBody = false;
		const ok = await verifyBlockSurvived({
			runAttempt: async (ctx) => {
				const body = await ctx.fetchBody();
				if (t.h.edits.length === 1) {
					// Second attempt MUST see the externally-rewritten body —
					// re-extraction from the fresh body, never the stale one.
					expect(body).not.toContain(MARKER_START);
					sawStrippedBody = true;
				}
				return injectingAttempt()(ctx);
			},
			fetchBody: t.fetchBody,
			applyEdit: t.applyEdit,
			sleep: t.sleep,
			delayMs: 0,
			log: t.log,
		});
		expect(ok).toBe(true);
		expect(sawStrippedBody).toBe(true);
		expect(t.h.edits.length).toBe(2);
		expect(t.h.warnings).toEqual([]);
	});

	test('marker clobbered on every settle → warning, exactly maxAttempts attempts', async () => {
		const t = makeHarness('changelog body', { alwaysRewrite: true });
		let attempts = 0;
		const ok = await verifyBlockSurvived({
			runAttempt: async (ctx) => {
				attempts++;
				return injectingAttempt()(ctx);
			},
			fetchBody: t.fetchBody,
			applyEdit: t.applyEdit,
			sleep: t.sleep,
			delayMs: 0,
			log: t.log,
		});
		expect(ok).toBe(false);
		expect(attempts).toBe(2);
		expect(t.h.warnings.length).toBe(1);
		expect(t.h.warnings[0]).toContain('::warning::');
	});

	test('no-op attempt followed by clobber during settle → second attempt re-injects', async () => {
		// External rewriter strikes during the FIRST settle window after a
		// no-op attempt (body already carried the block; no edit was made).
		const h: Harness = {
			edits: [],
			sleptMs: [],
			warnings: [],
			current: `${NOTES}\n\nchangelog body`,
		};
		let rewritten = false;
		let fetches = 0;
		const ok = await verifyBlockSurvived({
			runAttempt: injectingAttempt(),
			fetchBody: async () => {
				fetches++;
				// The settle fetch is the second fetch (first is attempt
				// 1's read) — the external rewrite lands between them.
				if (!rewritten && fetches === 2) {
					rewritten = true;
					h.current = h.current.replace(`${NOTES}\n\n`, '');
				}
				return h.current;
			},
			applyEdit: async (b: string) => {
				h.edits.push(b);
				h.current = b;
			},
			sleep: async (ms: number) => {
				h.sleptMs.push(ms);
			},
			log: (m: string) => {
				if (m.includes('::warning::')) h.warnings.push(m);
			},
			delayMs: 0,
		});
		expect(rewritten).toBe(true);
		expect(ok).toBe(true);
		expect(h.edits.length).toBe(1);
		expect(h.warnings).toEqual([]);
	});

	test('blockExpected=false (legitimately no fragments) → no settle-verify, no false warning', async () => {
		const t = makeHarness('changelog body');
		let settleFetches = 0;
		const ok = await verifyBlockSurvived({
			runAttempt: async ({ fetchBody, log }) => {
				const body = await fetchBody();
				log('no candidates — nothing to inject');
				return { body, blockExpected: false };
			},
			fetchBody: async () => {
				settleFetches++;
				return t.h.current;
			},
			applyEdit: t.applyEdit,
			sleep: t.sleep,
			delayMs: 45_000,
			log: t.log,
		});
		expect(ok).toBe(true);
		expect(t.h.edits.length).toBe(0);
		// Only the attempt's own read — the settle fetch never runs.
		expect(settleFetches).toBe(1);
		expect(t.h.sleptMs).toEqual([]);
		expect(t.h.warnings).toEqual([]);
	});

	test('applyEdit failure propagates', async () => {
		const t = makeHarness('changelog body');
		await expect(
			verifyBlockSurvived({
				runAttempt: injectingAttempt(),
				fetchBody: t.fetchBody,
				applyEdit: async () => {
					throw new Error('gh pr edit failed');
				},
				sleep: t.sleep,
				delayMs: 0,
				log: t.log,
			}),
		).rejects.toThrow('gh pr edit failed');
	});

	test('delayMs is honored per attempt', async () => {
		const t = makeHarness(`${NOTES}\n\nbody`);
		await verifyBlockSurvived({
			runAttempt: injectingAttempt(),
			fetchBody: t.fetchBody,
			applyEdit: t.applyEdit,
			sleep: t.sleep,
			delayMs: 250,
			log: t.log,
		});
		expect(t.h.sleptMs).toEqual([250]);
	});
});
