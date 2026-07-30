/**
 * The restatement guard — what model prose may reach disk (#1821 AC18).
 *
 * The property under test is a BOUND, not a classifier, and the difference has
 * cost this file two revisions. It is NOT "a reasoning trace can never be
 * persisted": a chained single sentence
 * (`first i list the runs; then i count the passes; then i divide`) carries no
 * sentence terminator, is admitted, and reads as three steps. The
 * `a single sentence chained with %s IS admitted` table below asserts exactly
 * that for semicolons, a colon-and-dash, the one permitted abbreviation, commas,
 * and a Tibetan shad — so the limitation cannot be quietly re-claimed away, and
 * the reason it is irreducible (the comma has to stay admitted) is visible.
 *
 * What IS enforced, and what every test here pins:
 * - only the FIRST `FINDING:` line of one dispatch is considered, and nothing
 *   else in the response can ride along with it;
 * - the captured text is rejected on bracket markup, on a forged `[REDACTED:…]`
 *   marker, on any listed reasoning marker, on a sentence terminator anywhere
 *   but a single trailing run once decimal points and at most one
 *   lower-case-continued abbreviation are masked (the terminator class is
 *   Unicode's `Sentence_Terminal` plus the ellipsis and leader family, sampled
 *   in `miner-restatement-terminators.test.ts`), and on exceeding
 *   `MAX_CONSENSUS_STATEMENT_CHARS` rather than being clipped to fit.
 *
 * That has to be a whitelist. `SUMMARIZATION_SYSTEM` asks for one sentence; a
 * model is free to ignore it. `sanitizeExcerpt` only redacts secrets, collapses
 * control and format characters, and truncates — none of which removes
 * reasoning. Before the guard existed, a dispatcher returning
 * `"Reasoning: the model thought hard. Answer: ..."` was persisted verbatim into
 * `attributes[].statement`.
 *
 * Every test below drives the REAL miner with an adversarial dispatcher and
 * asserts on the REAL report, not on a helper — a guard tested through its own
 * extractor could pass while the miner called something else.
 */

import { describe, expect, test } from 'bun:test';
import { mineConsensus } from '../../../src/consensus/miner';
import {
	config,
	corpusOf,
	finding,
	fixedCorpusLoader,
	recordingDispatcher,
	request,
	twoRunAgreement,
} from './fixtures';

const DIRECTORY = '/virtual/project';

/** Mine the standard two-run corpus with a dispatcher returning `text`. */
async function mineWith(text: string) {
	const { dispatcher } = recordingDispatcher({ text });
	return mineConsensus(DIRECTORY, request({ minSupport: 2 }), {
		config: config(),
		loadCorpus: fixedCorpusLoader(corpusOf(twoRunAgreement())),
		now: () => new Date('2026-07-24T00:00:00.000Z'),
		dispatcher,
	});
}

/** Everything the report persists as text, flattened for substring assertions. */
function persistedText(report: unknown): string {
	return JSON.stringify(report);
}

describe('restatement guard — reasoning is rejected outright', () => {
	test('the reproduction case: bare "Reasoning: ... Answer: ..." is not persisted', async () => {
		const result = await mineWith(
			'Reasoning: the model thought hard about the counts and cross-checked them. ' +
				'Answer: scoring succeeds across both refactor tasks.',
		);
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.llmSummary).toBeUndefined();
		expect(persistedText(result.report)).not.toContain('thought hard');
	});

	test.each([
		['bare prose with no envelope', 'Scoring succeeds across both tasks.'],
		[
			'a <think> block',
			'<think>first I count the runs, then I compare</think> Scoring succeeds.',
		],
		[
			'a step-by-step narration',
			'Step 1: count the runs. Step 2: compare outcomes. Scoring succeeds.',
		],
		[
			'a first-person plan',
			'I will check the support counts and then restate the finding.',
		],
		[
			'a markdown list',
			'- support: 2\n- tasks: 2\n\nConclusion: scoring succeeds.',
		],
		['a code fence', '```\nFINDING is not on this line\n```'],
		['a lowercase envelope', 'finding: scoring succeeds across both tasks.'],
		['an envelope with no content', 'FINDING:'],
		['an envelope with only whitespace', 'FINDING:    '],
	])('rejects %s', async (_label, text) => {
		const result = await mineWith(text);
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.llmSummary).toBeUndefined();
	});

	test.each([
		[
			'a <think> block sharing the envelope line',
			'FINDING: <think>I counted them one by one</think> Scoring succeeded.',
		],
		[
			'a <scratchpad> block sharing the envelope line',
			'FINDING: <scratchpad>step 1, step 2</scratchpad> Scoring succeeded.',
		],
		['a stray closing tag', 'FINDING: Scoring succeeded.</think>'],
		[
			'a square-bracket scratchpad',
			'FINDING: [think] I counted them one by one [/think] Scoring succeeded.',
		],
		[
			'a CJK-bracket scratchpad',
			// U+3010/U+3011 are the CJK bracket form of `[think]`. Escaped
			// rather than embedded literally so this file stays plain text.
			'FINDING: \u3010think\u3011 I counted them one by one Scoring succeeded.',
		],
		[
			'a brace scratchpad',
			'FINDING: {think} I counted them one by one {/think} Scoring succeeded.',
		],
	])('rejects %s — the envelope is line-scoped, so markup must be', async (_label, text) => {
		// The bypass this closes: the envelope matches a LINE, so a reasoning block
		// on the same line lands inside the captured group and would be persisted
		// verbatim. Rejecting outright beats stripping tags — a restatement of a
		// statistical finding has no legitimate need for markup. Angle brackets
		// alone left `[think]`, `{think}`, and the CJK bracket form wide open.
		const result = await mineWith(text);
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.llmSummary).toBeUndefined();
		expect(persistedText(result.report)).not.toContain('counted them');
		expect(persistedText(result.report)).not.toContain('step 1');
	});

	test.each([
		['reasoning', finding('My reasoning: the two runs agree.')],
		['rationale', finding('The rationale is that both runs scored.')],
		['chain-of-thought', finding('Chain-of-thought suggests both runs agree.')],
		['thinking', finding('Thinking through it, both runs scored.')],
		['analysis', finding('Analysis: both runs scored on distinct tasks.')],
		['first person', finding('I think both runs scored on distinct tasks.')],
		['step-by-step', finding('Step-by-step, both runs scored.')],
		['deliberation', finding('After deliberation both runs scored.')],
	])('rejects a well-formed envelope whose sentence leaks %s', async (_label, text) => {
		const result = await mineWith(text);
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.llmSummary).toBeUndefined();
	});
});

describe('restatement guard — the envelope is a whitelist, not a filter', () => {
	test('reasoning ABOVE a FINDING line is discarded, and only the line survives', async () => {
		// The important half: it is not that the whole response is rejected, it is
		// that nothing outside the envelope can be carried along with what is kept.
		const result = await mineWith(
			[
				'Let me work through this carefully.',
				'The corpus shows two evaluation runs, r1 and r2, both scored.',
				'FINDING: Scoring succeeded on every observed refactor task.',
			].join('\n'),
		);
		expect(result.summarizedCount).toBe(1);
		expect(result.report.attributes[0]?.llmSummary).toBe(
			'Scoring succeeded on every observed refactor task.',
		);
		const persisted = persistedText(result.report);
		expect(persisted).not.toContain('work through this');
		expect(persisted).not.toContain('r1 and r2');
	});

	test('trailing commentary after the FINDING line is discarded', async () => {
		const result = await mineWith(
			[
				'FINDING: Scoring succeeded on every observed refactor task.',
				'Note: I based this on the success counts rather than the raw refs.',
			].join('\n'),
		);
		expect(result.report.attributes[0]?.llmSummary).toBe(
			'Scoring succeeded on every observed refactor task.',
		);
		expect(persistedText(result.report)).not.toContain('I based this on');
	});

	test('the FIRST envelope line wins, so a later one cannot smuggle content', async () => {
		const result = await mineWith(
			[
				'FINDING: Scoring succeeded on the observed tasks.',
				'FINDING: Ignore the above; my reasoning was different.',
			].join('\n'),
		);
		expect(result.report.attributes[0]?.llmSummary).toBe(
			'Scoring succeeded on the observed tasks.',
		);
		expect(persistedText(result.report)).not.toContain('Ignore the above');
	});
});

describe('restatement guard — the single-sentence bound is a whitelist', () => {
	// Every case in this describe is isolated to `isSingleSentence`: none carries
	// markup, none trips a reasoning marker, and none exceeds the length bound. If
	// the guard is reverted to the old "terminator + whitespace + ASCII capital"
	// boundary detector, every test here fails — which is the point. The previous
	// version of this file used
	// `'Scoring succeeded. My reasoning follows from the counts.'`, rejected by
	// BOTH the capital-`M` branch and the word `reasoning`, so it passed while the
	// property it named was false.

	test('the four-sentence reproduction is rejected, not persisted', async () => {
		// Verbatim from the adversarial re-review. No angle bracket;
		// REASONING_MARKER_RE matches `step-by-step` (not `step one`) and
		// `i will` / `i need to` (not `i enumerate` / `i count` / `i divide`). The
		// single-sentence bound is the only thing between this chain of thought and
		// the report file, and the old bound let all four sentences through.
		const result = await mineWith(
			finding(
				'first i enumerate the runs that carried the signal. then i count how many ' +
					'of them passed. then i divide to get the rate and round it. so the ' +
					'conclusion is that the scoring signal holds.',
			),
		);
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.llmSummary).toBeUndefined();
		const persisted = persistedText(result.report);
		expect(persisted).not.toContain('i enumerate');
		expect(persisted).not.toContain('i divide');
	});

	test.each([
		[
			'a lower-case word',
			'Scoring succeeded. the tallies were compared afterwards.',
		],
		[
			'no space at all after the period',
			'Scoring succeeded.Then the tallies were compared.',
		],
		['a digit', 'Scoring succeeded. 42 runs were tallied afterwards.'],
		[
			'a quotation mark',
			'Scoring succeeded. "the tallies" were compared afterwards.',
		],
		// Escaped rather than embedded literally so this file stays plain text.
		[
			'a non-ASCII capital',
			'Scoring succeeded. \u00c9tape deux compte les runs.',
		],
		['a lower-case word after "?"', 'Did scoring succeed? both runs say yes.'],
		['a lower-case word after "!"', 'Scoring succeeded! both runs agree.'],
	])('rejects a second sentence beginning with %s', async (_label, sentence) => {
		const result = await mineWith(finding(sentence));
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.llmSummary).toBeUndefined();
	});

	test('the case the OLD bound caught stays caught', async () => {
		// A regression guard on the other side: replacing the boundary detector
		// with a whitelist must not lose the one shape it did handle.
		const result = await mineWith(
			finding('Scoring succeeded. Both runs were compared afterwards.'),
		);
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.llmSummary).toBeUndefined();
	});

	test.each([
		['etc.', 'Scoring succeeded etc. The tallies were compared afterwards.'],
		['e.g.', 'Scoring succeeded e.g. The tallies were compared afterwards.'],
		['i.e.', 'Scoring succeeded i.e. The tallies were compared afterwards.'],
	])('a real boundary after "%s" is still a boundary', async (_label, sentence) => {
		// The regression the abbreviation mask itself introduced: blanking the
		// whole token INCLUDING its trailing period deleted the genuine sentence
		// break, so each of these was persisted as "one sentence". The suite
		// covered only the bare `. Capital` shape above, which is why it slipped.
		// The mask now requires a lower-case continuation, which a new sentence
		// does not have.
		const result = await mineWith(finding(sentence));
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.llmSummary).toBeUndefined();
	});

	test('a chain of abbreviations cannot reassemble the narration', async () => {
		// The four-sentence reproduction above with `.` swapped for `etc.`. Every
		// `etc.` here IS followed by a lower-case word, so the lower-case rule alone
		// would mask all three and admit the whole chain; bounding how many
		// abbreviations may be masked is what rejects it.
		const result = await mineWith(
			finding(
				'first i enumerate the runs that carried the signal etc. then i count ' +
					'how many of them passed etc. then i divide to get the rate etc. so ' +
					'the scoring signal holds',
			),
		);
		expect(result.summarizedCount).toBe(0);
		const persisted = persistedText(result.report);
		expect(persisted).not.toContain('i enumerate');
		expect(persisted).not.toContain('i divide');
	});
});

describe('restatement guard — structural bounds', () => {
	test.each([
		// Every legitimate shape the abbreviation allowlist exists to keep. The
		// lower-case continuation is what distinguishes these from the rejected
		// `etc. The …` above; the last one needs no masking at all, because a
		// trailing terminator run is already allowed.
		[
			'mid-sentence with no trailing period',
			'Runs using e.g. the strict gate profile scored higher',
		],
		[
			'mid-sentence before a trailing period',
			'Scoring succeeded on both tasks, e.g. the refactor pair.',
		],
		[
			'in its comma form',
			'Scoring succeeded on both tasks, e.g., the refactor pair.',
		],
		[
			'closing the sentence',
			'Scoring succeeded on the refactor and lint tasks etc.',
		],
	])('an abbreviation %s does not count as a sentence break', async (_l, s) => {
		const result = await mineWith(finding(s));
		expect(result.report.attributes[0]?.llmSummary).toBe(s);
	});

	test('a decimal point does not count as a sentence break', async () => {
		// The whitelist masks exactly two constructs. Both need a test, or the
		// allowlist is one regex edit away from silently disappearing.
		const result = await mineWith(
			finding('Scoring succeeded on 0.8 of the observed runs.'),
		);
		expect(result.report.attributes[0]?.llmSummary).toBe(
			'Scoring succeeded on 0.8 of the observed runs.',
		);
	});

	test('rejects an over-long restatement instead of truncating it', async () => {
		// Truncating to fit is exactly how a trailing fragment of reasoning
		// survives a length bound, so the guard refuses rather than clips.
		const result = await mineWith(finding(`${'x'.repeat(700)}`));
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.llmSummary).toBeUndefined();
	});

	test('accepts a restatement sitting exactly on the bound', async () => {
		const exact = `${'x'.repeat(599)}.`;
		expect(exact).toHaveLength(600);
		const result = await mineWith(finding(exact));
		expect(result.report.attributes[0]?.llmSummary).toBe(exact);
	});

	test('control characters are collapsed, never persisted raw', async () => {
		const result = await mineWith(
			// NUL/BEL are what a pasted terminal dump carries, and the `\s` class
			// does not match them. Escaped rather than embedded literally so this
			// file stays plain text.
			'FINDING: Scoring\u0007 succeeded\u0000 on both tasks.',
		);
		expect(result.report.attributes[0]?.llmSummary).toBe(
			'Scoring succeeded on both tasks.',
		);
	});

	test.each([
		['a lone carriage return', '\r'],
		['a CRLF pair', '\r\n'],
		['a vertical tab', '\v'],
		['a form feed', '\f'],
		['a next line (U+0085)', '\u0085'],
		['a Unicode line separator', '\u2028'],
		['a Unicode paragraph separator', '\u2029'],
	])('content after %s cannot ride along inside the envelope', async (_label, separator) => {
		// JavaScript's `.` excludes only `\n`, so splitting on `/\r?\n/` alone
		// would leave everything after one of these INSIDE the captured group,
		// and `sanitizeExcerpt` would flatten it into the retained sentence.
		// U+0085 is the one JavaScript's `\s` does not match either, so it cannot
		// be covered incidentally \u2014 the split set names it explicitly.
		const result = await mineWith(
			`FINDING: Scoring succeeded.${separator}I counted them one by one and then compared.`,
		);
		const persisted = persistedText(result.report);
		expect(persisted).not.toContain('one by one');
		expect(result.report.attributes[0]?.llmSummary).toBe('Scoring succeeded.');
	});

	test('a non-string dispatcher payload is rejected without throwing', async () => {
		const result = await mineWith(undefined as unknown as string);
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.llmSummary).toBeUndefined();
	});

	test('a FORGED redaction marker is rejected, not persisted', async () => {
		// `[REDACTED:<type>]` is masked before the bracket test because it is the
		// miner's own output. Without rejecting a marker the MODEL wrote, that mask
		// is a forgery surface: this payload would persist a claim that the miner
		// removed an AWS key it never saw.
		const result = await mineWith(
			finding('Scoring succeeded [REDACTED:aws_key] across both tasks.'),
		);
		expect(result.summarizedCount).toBe(0);
		expect(persistedText(result.report)).not.toContain('REDACTED:aws_key');
	});

	test('a GENUINE redaction still passes the bracket test', async () => {
		// The other half: rejecting forged markers must not make the guard reject
		// its own handiwork. The secret is planted in the clear and only the
		// sanitizer's placeholder reaches the report.
		const result = await mineWith(
			finding('Scoring succeeded for AKIAIOSFODNN7EXAMPLE across both tasks.'),
		);
		expect(result.report.attributes[0]?.llmSummary).toBe(
			'Scoring succeeded for [REDACTED:aws_access_key_id] across both tasks.',
		);
		expect(persistedText(result.report)).not.toContain('AKIAIOSFODNN7EXAMPLE');
	});
});

describe('restatement guard — the limitation, asserted not claimed away', () => {
	// Not bug reports — the property this guard does NOT deliver, pinned so a
	// later revision cannot re-assert "a reasoning trace can never be persisted"
	// without a test failing. None of these joiners is a sentence terminator,
	// none trips a reasoning marker, and all are inside the length bound, so all
	// are admitted. Two earlier revisions claimed otherwise; both claims were
	// false, and more terminator rules cannot make them true.
	test.each([
		[
			'semicolons',
			'first i list the runs; then i count the passes; then i divide to get the rate',
		],
		[
			'a colon and a dash',
			'the method: i list the runs, count the passes — and divide to get the rate',
		],
		[
			'the one permitted abbreviation',
			// Bounding the exemption at one is what stops a CHAIN of these (see
			// "a chain of abbreviations cannot reassemble the narration"); it does
			// not stop a single join, and this asserts that it does not.
			'first i list the runs etc. then i count how many of them passed',
		],
		[
			'commas',
			// The reason the terminator class stops at `Sentence_Terminal` and does
			// not reach for `Terminal_Punctuation`: that property contains the
			// comma, which appears in nearly every legitimate restatement. Since
			// this payload has to stay admitted, clause chaining stays open however
			// the other 120 clause marks are treated.
			'first i list the runs, then i count the passes, then i divide to get the rate',
		],
		[
			'a Tibetan shad (U+0F0D)',
			// The same channel in another script, and the reason the class cannot
			// be described as "every character that ends a sentence". U+0F0D is
			// `Terminal_Punctuation` but NOT `Sentence_Terminal`, so it is not
			// counted \u2014 exactly like the comma above.
			'first i enumerate the runs\u0F0D then i count how many of them passed',
		],
	])('a single sentence chained with %s IS admitted', async (_l, narration) => {
		const result = await mineWith(finding(narration));
		expect(result.report.attributes[0]?.llmSummary).toBe(narration);
	});
});

describe('restatement guard — rejection never degrades the report', () => {
	test('a rejected restatement leaves every deterministic field intact', async () => {
		const rejected = await mineWith('Reasoning: I considered both runs.');
		const clean = await mineConsensus(DIRECTORY, request({ minSupport: 2 }), {
			config: config(),
			loadCorpus: fixedCorpusLoader(corpusOf(twoRunAgreement())),
			now: () => new Date('2026-07-24T00:00:00.000Z'),
		});
		expect(rejected.report.attributes).toEqual(clean.report.attributes);
		expect(rejected.report.proposals).toEqual(clean.report.proposals);
		expect(rejected.report.integrityHash).toBe(clean.report.integrityHash);
	});
});
