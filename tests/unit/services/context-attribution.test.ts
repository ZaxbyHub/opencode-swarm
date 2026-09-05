import { describe, expect, test } from 'bun:test';
import {
	_internals,
	estimateTokensFromBytes,
	measureCitedFileTokens,
	recordContextSourceAttribution,
} from '../../../src/services/context-attribution.js';

const emissions: Array<Record<string, unknown>> = [];
const origEmit = _internals.emit;
function capture() {
	emissions.length = 0;
	_internals.emit = (event, data) => {
		if (event === 'context_source_attribution') emissions.push(data);
	};
}
function restore() {
	_internals.emit = origEmit;
}

describe('context-attribution — issue #2482/#1990 honesty rule', () => {
	test('estimate math: saved = max(0, citedTotal - returned), floored at 0', () => {
		capture();
		try {
			expect(
				recordContextSourceAttribution({
					sessionId: 's1',
					source: 'context_pack',
					tokensReturned: 400,
					citedFileTokensTotal: 2000,
					taskId: 't1',
				}),
			).toBe(true);
			expect(emissions.length).toBe(1);
			expect(emissions[0]).toEqual({
				sessionId: 's1',
				taskId: 't1',
				source: 'context_pack',
				tokensReturned: 400,
				tokensSavedEstimate: 1600,
				estimate: true,
			});
			// Negative savings floor at zero, still emitted (measurement known).
			recordContextSourceAttribution({
				sessionId: 's1',
				source: 'ask',
				tokensReturned: 3000,
				citedFileTokensTotal: 1000,
			});
			expect(emissions[1]!.tokensSavedEstimate).toBe(0);
		} finally {
			restore();
		}
	});

	test('omit-when-unknown: NO event when the cited total is unknown', () => {
		capture();
		try {
			for (const bad of [undefined, null, 0, -5, Number.NaN, Infinity]) {
				expect(
					recordContextSourceAttribution({
						sessionId: 's1',
						source: 'context_pack',
						tokensReturned: 400,
						citedFileTokensTotal: bad as number | undefined,
					}),
				).toBe(false);
			}
			expect(emissions.length).toBe(0);
		} finally {
			restore();
		}
	});

	test('fail-open: emit throwing never propagates', () => {
		_internals.emit = () => {
			throw new Error('sink down');
		};
		try {
			expect(() =>
				recordContextSourceAttribution({
					sessionId: 's1',
					source: 'reflection',
					tokensReturned: 10,
					citedFileTokensTotal: 100,
				}),
			).not.toThrow();
			expect(
				recordContextSourceAttribution({
					sessionId: 's1',
					source: 'reflection',
					tokensReturned: 10,
					citedFileTokensTotal: 100,
				}),
			).toBe(false);
		} finally {
			restore();
		}
	});

	test('measureCitedFileTokens: unmeasurable files are skipped and counted, never zero-weighted', () => {
		const statOk = () => ({ size: 4000 }); // 1000 tokens each
		const res = measureCitedFileTokens(['a.ts', 'missing.ts', 'b.ts'], (p) =>
			p === 'missing.ts' ? statOkAndThrow() : statOk(),
		);
		function statOkAndThrow(): { size: number } {
			throw new Error('ENOENT');
		}
		expect(res.total).toBe(2000);
		expect(res.unmeasured).toBe(1);
	});

	test('measureCitedFileTokens: the stat loop is capped at 32 files', () => {
		const paths = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
		const res = measureCitedFileTokens(paths, () => ({ size: 4 }));
		expect(res.total).toBe(32);
		expect(res.unmeasured).toBe(8);
	});

	test('estimateTokensFromBytes is conservative and guards bad input', () => {
		expect(estimateTokensFromBytes(4000)).toBe(1000);
		expect(estimateTokensFromBytes(0)).toBe(0);
		expect(estimateTokensFromBytes(-1)).toBe(0);
		expect(estimateTokensFromBytes(Number.NaN)).toBe(0);
	});
});
