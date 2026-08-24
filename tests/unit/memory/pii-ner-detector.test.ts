import { afterEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	MemoryPiiDetectorError,
	MemoryValidationError,
} from '../../../src/memory/errors';
import {
	_internals,
	NerPiiDetector,
	type PiiFinding,
} from '../../../src/memory/pii';

afterEach(() => {
	_internals.reset();
});

/**
 * Real @xenova/transformers@2.17.2 token-classification output (verified
 * against the package source at tag 2.17.2): a FLAT array of
 * { entity: 'B-PER'|'I-PER'|..., score, index, word, start, end } — no
 * `answer` wrapper, no `entity_group`, no aggregation. PR #2310 feedback
 * FB-1: the original mock encoded a non-existent QA shape.
 */
interface PiiToken {
	entity: string;
	score: number;
	index: number;
	word: string;
}

function fakeModule(entities: Array<Partial<PiiToken>> = []) {
	return {
		pipeline: async () => {
			return async () =>
				entities.map((e, i) => ({
					entity: e.entity ?? 'B-PER',
					score: e.score ?? 0.9,
					index: e.index ?? i,
					word: e.word ?? `tok${i}`,
				}));
		},
		env: {},
	};
}

describe('NerPiiDetector (#1466, real 2.17.2 pipeline contract)', () => {
	test('absent peer dependency surfaces a typed error with an install hint, not ERR_MODULE_NOT_FOUND', () => {
		_internals.requireModule = () => {
			throw new Error("Cannot find module '@xenova/transformers'");
		};
		const detector = new NerPiiDetector();
		expect(() => detector.assertAvailable()).toThrow(MemoryPiiDetectorError);
		try {
			detector.assertAvailable();
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain('@xenova/transformers');
			expect(message).toContain('piiDetector');
		}
	});

	test('PRR-016: the typed error is a MemoryValidationError with a stable code', () => {
		_internals.requireModule = () => {
			throw new Error('boom');
		};
		const detector = new NerPiiDetector();
		try {
			detector.assertAvailable();
			throw new Error('expected assertAvailable to throw');
		} catch (err) {
			expect(err).toBeInstanceOf(MemoryValidationError);
			expect((err as MemoryValidationError).code).toBe(
				'memory_pii_detector_error',
			);
		}
	});

	test('module without pipeline() surfaces a typed error', () => {
		_internals.requireModule = () => ({ notPipeline: true });
		const detector = new NerPiiDetector();
		expect(() => detector.assertAvailable()).toThrow(MemoryPiiDetectorError);
	});

	test('PRR-024: production createRequire path (after reset) throws the typed error', () => {
		// _internals.reset() restores the REAL module loader; the optional
		// peer dependency is not installed in this repo, so the production
		// createRequire(import.meta.url) resolution path runs and fails with
		// our typed error. Exercises the exact default branch the mocks
		// otherwise bypass (a typo in the module id would slip all mocks).
		// If a dev machine has the peer installed, resolution succeeds — the
		// test then accepts success; it only fails on a RAW error type.
		_internals.reset();
		const detector = new NerPiiDetector();
		try {
			detector.assertAvailable();
		} catch (err) {
			expect(err).toBeInstanceOf(MemoryPiiDetectorError);
		}
	});

	test('maps flat BIO-tagged tokens to findings; LOC mapped, MISC ignored (PRR-021)', async () => {
		_internals.requireModule = () =>
			fakeModule([
				{ entity: 'B-PER', score: 0.98, index: 1, word: 'Brett' },
				{ entity: 'B-ORG', score: 0.91, index: 3, word: 'Acme' },
				{ entity: 'B-LOC', score: 0.87, index: 5, word: 'Berlin' },
				{ entity: 'B-MISC', score: 0.9, index: 7, word: 'ignored' },
			]);
		const detector = new NerPiiDetector();
		const findings: PiiFinding[] = await detector.detect(
			'Brett at Acme in Berlin',
		);
		expect(findings).toEqual([
			{ type: 'person', match: 'Brett', confidence: 0.98 },
			{ type: 'organization', match: 'Acme', confidence: 0.91 },
			{ type: 'location', match: 'Berlin', confidence: 0.87 },
		]);
	});

	test('consecutive B-/I- tokens of one entity group into a single finding', async () => {
		_internals.requireModule = () =>
			fakeModule([
				{ entity: 'B-PER', score: 0.95, index: 1, word: 'Mary' },
				{ entity: 'I-PER', score: 0.72, index: 2, word: 'Jane' },
				{ entity: 'I-PER', score: 0.99, index: 3, word: 'Watson' },
				{ entity: 'B-LOC', score: 0.9, index: 5, word: 'Paris' },
			]);
		const detector = new NerPiiDetector();
		const findings = await detector.detect('Mary Jane Watson visited Paris');
		expect(findings).toEqual([
			// Group confidence = MIN token score (conservative).
			{ type: 'person', match: 'Mary Jane Watson', confidence: 0.72 },
			{ type: 'location', match: 'Paris', confidence: 0.9 },
		]);
	});

	test('non-adjacent same-type tokens produce separate findings', async () => {
		_internals.requireModule = () =>
			fakeModule([
				{ entity: 'B-PER', score: 0.9, index: 1, word: 'Ann' },
				// gap at index 2 (an ignored O token)
				{ entity: 'B-PER', score: 0.8, index: 3, word: 'Bob' },
			]);
		const detector = new NerPiiDetector();
		const findings = await detector.detect('Ann and Bob');
		expect(findings).toEqual([
			{ type: 'person', match: 'Ann', confidence: 0.9 },
			{ type: 'person', match: 'Bob', confidence: 0.8 },
		]);
	});

	test('FB-5: concurrent first detect() calls share ONE pipeline load', async () => {
		let loads = 0;
		_internals.requireModule = () => ({
			pipeline: async () => {
				loads++;
				return async () => [
					{ entity: 'B-PER', score: 0.9, index: 1, word: 'X' },
				];
			},
			env: {},
		});
		const detector = new NerPiiDetector();
		const results = await Promise.all([
			detector.detect('one'),
			detector.detect('two'),
			detector.detect('three'),
			detector.detect('four'),
		]);
		expect(loads).toBe(1);
		expect(results).toHaveLength(4);
		expect(results.every((r) => r.length === 1)).toBe(true);
	});

	test('model cache dir is an ABSOLUTE tilde-free path (final-critic item 2)', async () => {
		const fakeEnv: { cacheDir?: string } = {};
		_internals.requireModule = () => ({
			pipeline: async () => async () => [],
			env: fakeEnv,
		});
		const detector = new NerPiiDetector();
		detector.assertAvailable();
		await detector.detect('x');
		expect(fakeEnv.cacheDir).toBeDefined();
		expect(path.isAbsolute(fakeEnv.cacheDir as string)).toBe(true);
		expect(fakeEnv.cacheDir).not.toContain('~');
		expect((fakeEnv.cacheDir as string).endsWith('opencode-swarm')).toBe(false);
	});

	test('load failure is sticky — construction errors are cached and rethrown', async () => {
		_internals.requireModule = () => {
			throw new Error('boom');
		};
		const detector = new NerPiiDetector();
		await expect(detector.detect('text')).rejects.toBeInstanceOf(
			MemoryPiiDetectorError,
		);
		// Second call fails fast with the SAME typed error.
		await expect(detector.detect('text')).rejects.toBeInstanceOf(
			MemoryPiiDetectorError,
		);
	});
});
