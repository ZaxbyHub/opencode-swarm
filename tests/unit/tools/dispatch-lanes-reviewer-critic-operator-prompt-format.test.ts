// Issue #3310 AC8 — reviewer/critic operator prompts must not ship
// verdict-row template text.
//
// The PR-review controller owns verdict-row authorship: the contract card
// prepended by applyPrWorkflowPromptContract carries the authoritative
// [REVIEWED] / [CRITIC] row grammars. An operator prompt that embeds a
// verdict-row TEMPLATE — the marker followed by a pipe and field placeholder
// text like item_id / classification / status — teaches the lane a competing
// format and must be rejected at prompt-assembly time, mirroring the
// discovery-lane rejection of [CANDIDATE]/[CLEAN] template text inside
// applyExplorerFormatSuffix.
//
// RED at base, GREEN after the fix: for roles 'reviewer' and 'critic' in
// swarm-pr-review modes, applyPrWorkflowPromptContract rejects an operator
// prompt containing a `[REVIEWED] |` or `[CRITIC] |` ROW FORMAT — result.ok
// === false with an error naming the offending token (e.g. '[REVIEWED] |')
// and telling the operator to remove the template text. Prose that merely
// mentions the marker word mid-sentence — with no marker-pipe row shape
// anywhere in the text — must NOT be rejected; a line consisting of the bare
// marker IS rejected, because the parser accepts it as an (arity-1) row
// (issue #3335).
import { describe, expect, test } from 'bun:test';
import { _test_exports } from '../../../src/tools/dispatch-lanes.js';

type ContractOptions = Parameters<
	typeof _test_exports.applyPrWorkflowPromptContract
>[1];
type ContractLane = Parameters<
	typeof _test_exports.applyPrWorkflowPromptContract
>[0][number];

function run(lane: ContractLane, mode: string) {
	return _test_exports.applyPrWorkflowPromptContract([lane], {
		mode,
		prHeadSha: 'abc123',
		revisionDigest: 'revision-1',
	});
}

describe('reviewer/critic operator prompt verdict-row lint (issue #3310 AC8)', () => {
	test("rejects a reviewer operator prompt embedding a '[REVIEWED] |' row template", () => {
		const result = run(
			{
				id: 'rev-3310-fmt',
				agent: 'reviewer',
				prompt:
					'Re-verify each assigned candidate. Emit your verdict as:\n[REVIEWED] | item_id | classification | severity\nfor every assigned item.',
				workflow_lane: 'rev-chunk-1',
				review_item_ids: ['c1'],
			},
			'swarm-pr-review:reviewer',
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected prompt lint failure');
		const errors = result.errors.join('\n');
		// The rejection names the offending token.
		expect(errors).toContain('[REVIEWED] |');
		// ...and tells the operator to remove the template text.
		expect(errors).toMatch(/remove/i);
	});

	test("rejects a critic operator prompt embedding a '[CRITIC] |' row template", () => {
		const result = run(
			{
				id: 'critic-3310-fmt',
				agent: 'critic',
				prompt:
					'Challenge each assigned verdict. Emit your challenge as:\n[CRITIC] | item_id | status | severity\nper assigned item.',
				workflow_lane: 'critic-chunk-1',
				review_item_ids: ['c1'],
			},
			'swarm-pr-review:critic',
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected prompt lint failure');
		const errors = result.errors.join('\n');
		expect(errors).toContain('[CRITIC] |');
		expect(errors).toMatch(/remove/i);
	});

	test('a prose mention of the marker word without the pipe-row shape stays accepted (reviewer)', () => {
		const prose =
			'Consult the [REVIEWED] rows contract section of the reviewer handbook before classifying candidates.';
		const result = run(
			{
				id: 'rev-3310-prose',
				agent: 'reviewer',
				prompt: prose,
				workflow_lane: 'rev-chunk-1',
				review_item_ids: ['c1'],
			},
			'swarm-pr-review:reviewer',
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join('; '));
		expect(result.lanes[0]?.prompt).toContain(prose);
	});

	test('a prose mention of the marker word without the pipe-row shape stays accepted (critic)', () => {
		const prose =
			'Consult the [CRITIC] rows contract appendix when challenging an assigned verdict.';
		const result = run(
			{
				id: 'critic-3310-prose',
				agent: 'critic',
				prompt: prose,
				workflow_lane: 'critic-chunk-1',
				review_item_ids: ['c1'],
			},
			'swarm-pr-review:critic',
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join('; '));
		expect(result.lanes[0]?.prompt).toContain(prose);
	});
});

describe('issue #3335 AC1: guard rejects every parser-accepted marker form', () => {
	const fullRowTail =
		'c1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |';

	function rejectCase(label: string, prompt: string) {
		test(`rejects ${label}`, () => {
			const result = run(
				{
					id: 'rev-3335',
					agent: 'reviewer',
					prompt,
					workflow_lane: 'rev-chunk-1',
					review_item_ids: ['c1'],
				},
				'swarm-pr-review:reviewer',
			);
			expect(result.ok).toBe(false);
		});
	}

	// The parser trims every pipe-delimited field with String.trim() (Unicode
	// whitespace) and matches the marker by equality, so each of these parses
	// as a live [REVIEWED] row; the guard must reject them all.
	rejectCase(
		'a fullwidth-space marker row (U+3000)',
		`[REVIEWED]\u3000| ${fullRowTail}`,
	);
	rejectCase('an NBSP marker row (U+00A0)', `[REVIEWED]\u00a0| ${fullRowTail}`);
	rejectCase('a BOM marker row (U+FEFF)', `[REVIEWED]\ufeff| ${fullRowTail}`);
	rejectCase('a no-space ASCII marker row', '[REVIEWED]| c1 | CONFIRMED');
	rejectCase('a double-space ASCII marker row', `[REVIEWED]  | ${fullRowTail}`);
	rejectCase('a tab ASCII marker row', `[REVIEWED]\t| ${fullRowTail}`);
	// A line consisting solely of the marker parses as an arity-1 row; it is
	// template text and is rejected too (documented tightening).
	rejectCase('a bare marker line', 'Intro line.\n[REVIEWED]\nOutro line.');
	// Mid-line anti-teaching shapes (the parser would not accept these as
	// rows, but an operator prompt teaching the format mid-sentence must
	// still be rejected — including Unicode whitespace and a lone \r, which
	// the transport's /\r?\n/ line-split leaves in-line).
	rejectCase(
		'a mid-line Unicode-whitespace teaching fragment',
		`Teach the lane: [REVIEWED]\u202f| item | classification | severity per row.`,
	);
	rejectCase(
		'a mid-line lone-carriage-return teaching fragment',
		`Teach the lane: [REVIEWED]\r| item | classification | severity per row.`,
	);
	// The parser decodes the canonical \n escape INSIDE a field and trims it
	// at the field boundary, so an escape-decoded separator between marker and
	// pipe parses as a live row; only the parser arm catches this (the
	// anywhere-shape class excludes the literal characters).
	rejectCase(
		'an escape-decoded separator between marker and pipe',
		'[REVIEWED]\\n| c1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |',
	);

	test('rejects a parser-accepted marker form in the callerFocus channel', () => {
		const result = _test_exports.applyPrWorkflowPromptContract(
			[
				{
					id: 'rev-3335-focus',
					agent: 'reviewer',
					prompt: 'Legitimate content-only prompt.',
					workflow_lane: 'rev-chunk-1',
					review_item_ids: ['c1'],
				},
			],
			{
				mode: 'swarm-pr-review:reviewer',
				prHeadSha: 'abc123',
				revisionDigest: 'revision-1',
				callerFocus: `Also see [REVIEWED]\u3000| ${fullRowTail}`,
			},
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected prompt lint failure');
		expect(result.errors.join('\n')).toContain('caller scope');
	});
});
