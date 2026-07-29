/**
 * The restatement guard's sentence-terminator class is not ASCII-only.
 *
 * Split from `miner-restatement-guard.test.ts`, where the guard's other
 * properties live. This split is required, not stylistic: merged, the two would
 * be ~540 lines, over the FR-006 500-line cap.
 *
 * The bound `extractRestatement` enforces is "no sentence terminator except a
 * single trailing run, after masking". While the class was `[.!?]`, every
 * payload below was persisted verbatim as a single "sentence" — multi-clause
 * narration joined by a stop that JavaScript's ASCII class does not match.
 *
 * The class has two halves and the table below is grouped to match them:
 * Unicode's `Sentence_Terminal` property, and a hand-added ellipsis/leader
 * family. Each group says which it is, because the split is not obvious — the
 * horizontal ellipsis is NOT `Sentence_Terminal` while the one dot leader is.
 *
 * `;`, `:`, `,` and the Tibetan shad are deliberately NOT terminators — see the
 * limitation table in `miner-restatement-guard.test.ts`, which pins them as
 * admitted and says why.
 *
 * Each case drives the REAL miner and asserts on the REAL report.
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

describe('restatement guard — non-ASCII sentence terminators', () => {
	// Escaped rather than embedded literally so this file stays plain text.
	test.each([
		// --- Unicode `Sentence_Terminal`, the widely-known stops ---
		['an ideographic full stop (U+3002)', '\u3002'],
		['a fullwidth exclamation mark (U+FF01)', '\uFF01'],
		['a fullwidth question mark (U+FF1F)', '\uFF1F'],
		['a fullwidth full stop (U+FF0E)', '\uFF0E'],
		['an Arabic full stop (U+06D4)', '\u06D4'],
		['an Arabic question mark (U+061F)', '\u061F'],
		['a Devanagari danda (U+0964)', '\u0964'],
		['a Devanagari double danda (U+0965)', '\u0965'],
		['a double exclamation mark (U+203C)', '\u203C'],
		['a double question mark (U+2047)', '\u2047'],
		['a question-exclamation mark (U+2048)', '\u2048'],
		['an exclamation-question mark (U+2049)', '\u2049'],
		['an Armenian full stop (U+0589)', '\u0589'],
		['an Ethiopic full stop (U+1362)', '\u1362'],
		['a Khmer khan (U+17D4)', '\u17D4'],
		// --- Unicode `Sentence_Terminal`, stops a hand-written list would miss.
		// They need no entry of their own precisely because the property covers
		// them; that is the argument for delegating to the property. ---
		['a halfwidth ideographic stop (U+FF61)', '\uFF61'],
		['a Myanmar sentence marker (U+104B)', '\u104B'],
		['a Mongolian full stop (U+1803)', '\u1803'],
		['a small full stop (U+FE52)', '\uFE52'],
		['a one dot leader (U+2024)', '\u2024'],
		// --- Hand-added. Unicode classifies these as neither `Sentence_Terminal`
		// nor `Terminal_Punctuation`, so they are covered ONLY by the explicit
		// list in `SENTENCE_TERMINATOR_CLASS` — which is why the list exists,
		// and why covering only U+2026 would have left the siblings open. ---
		['a horizontal ellipsis (U+2026)', '\u2026'],
		['a two dot leader (U+2025)', '\u2025'],
		['a midline horizontal ellipsis (U+22EF)', '\u22EF'],
		['a vertical ellipsis form (U+FE19)', '\uFE19'],
		['a vertical two dot leader (U+FE30)', '\uFE30'],
	])('rejects a second clause introduced by %s', async (_label, terminator) => {
		const result = await mineWith(
			finding(
				`first i enumerate the runs${terminator}then i count how many passed`,
			),
		);
		expect(result.summarizedCount).toBe(0);
		expect(result.report.attributes[0]?.llmSummary).toBeUndefined();
		expect(JSON.stringify(result.report)).not.toContain('i enumerate');
	});

	test('a single trailing non-ASCII terminator is still one sentence', async () => {
		// The class must bound the COUNT of terminator runs, not ban the
		// characters: a restatement that ends in an ideographic full stop is one
		// sentence exactly as an ASCII period would be.
		const sentence = `Scoring succeeded on every observed refactor task\u3002`;
		const result = await mineWith(finding(sentence));
		expect(result.report.attributes[0]?.llmSummary).toBe(sentence);
	});
});
