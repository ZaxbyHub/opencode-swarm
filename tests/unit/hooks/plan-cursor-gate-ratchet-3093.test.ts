/**
 * Source-scan ratchet for issue #3093 (plan-cursor + parallel pre-check
 * suppression under an active PR_REVIEW gate).
 *
 * Guards the SHAPE of the #3093 fix in `src/hooks/system-enhancer.ts`: the
 * durable gate input (`readPrWorkflowGateState`) must be wired into the
 * composition layer, and the resolved mode discriminant (`prReviewGateActive`)
 * must gate exactly the two cursor emissions (Path A tryInject, Path B scoring
 * candidate) and the two parallel pre-check hint emissions — while the cursor
 * builder in `src/hooks/extractors.ts` stays free of any gate read (it must
 * remain a pure plan-markdown extractor; gate reads belong to the composition
 * layer that owns emission).
 *
 * This is a static ratchet, not a behavioral test — the behavioral matrix
 * lives in `plan-cursor-gate-suppression.test.ts`. No mocks, no clock reads.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const ENHANCER_PATH = resolve(REPO_ROOT, 'src', 'hooks', 'system-enhancer.ts');
const EXTRACTORS_PATH = resolve(REPO_ROOT, 'src', 'hooks', 'extractors.ts');

/**
 * Pinned occurrence count for the #3093 fix shape: exactly
 *   1 `let prReviewGateActive` binding (resolved once per composition, after
 *     the durable readPrWorkflowGateState call), plus
 *   4 gating uses — two cursor conditions (Path A "tryInject" injection,
 *     Path B "scoring candidates" push) and two parallel-pre-check hint
 *     conditions (the same two paths).
 * A legitimate restructuring of the composition layer must update this
 * ratchet deliberately alongside the source change — the count exists so an
 * accidental removal (or uncontrolled growth) of any one of those five sites
 * cannot land silently.
 */
const PINNED_PR_REVIEW_GATE_ACTIVE_COUNT = 5;

describe('plan-cursor gate suppression source ratchet (#3093)', () => {
	it('system-enhancer reads the durable PR-workflow gate state in the composition layer', () => {
		const source = readFileSync(ENHANCER_PATH, 'utf8');
		expect(source.includes('readPrWorkflowGateState')).toBe(true);
	});

	it('system-enhancer gates the cursor and parallel pre-check emissions through prReviewGateActive exactly 5 times', () => {
		const source = readFileSync(ENHANCER_PATH, 'utf8');
		const count = (source.match(/prReviewGateActive/g) ?? []).length;
		expect(count).toBe(PINNED_PR_REVIEW_GATE_ACTIVE_COUNT);
	});

	it('extractors.ts contains zero gate reads (the cursor builder stays pure)', () => {
		const source = readFileSync(EXTRACTORS_PATH, 'utf8');
		expect(source.includes('readPrWorkflowGateState')).toBe(false);
	});
});
