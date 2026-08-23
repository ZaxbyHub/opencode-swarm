import { afterEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { MemoryPiiDetectorError } from '../../../src/memory/errors';
import {
	_internals,
	NerPiiDetector,
	type PiiFinding,
} from '../../../src/memory/pii';

afterEach(() => {
	_internals.reset();
});

describe('NerPiiDetector (#1466)', () => {
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

	test('module without pipeline() surfaces a typed error', () => {
		_internals.requireModule = () => ({ notPipeline: true });
		const detector = new NerPiiDetector();
		expect(() => detector.assertAvailable()).toThrow(MemoryPiiDetectorError);
	});

	test('loads the model through the injected seam and maps entities to findings', async () => {
		const fakeEnv: { cacheDir?: string } = {};
		_internals.requireModule = () => ({
			pipeline: async () => {
				return async () => ({
					answer: [
						{ entity_group: 'PER', word: 'Brett' },
						{ entity_group: 'ORG', word: 'Acme Corp' },
						{ entity_group: 'MISC', word: 'ignored' },
					],
				});
			},
			env: fakeEnv,
		});
		const detector = new NerPiiDetector();
		detector.assertAvailable();
		const findings: PiiFinding[] = await detector.detect(
			'Brett works at Acme Corp',
		);
		expect(findings).toEqual([
			{ type: 'person', match: 'Brett', confidence: 0.9 },
			{ type: 'organization', match: 'Acme Corp', confidence: 0.8 },
		]);
		// Final-critic item 2: the model cache dir must be an ABSOLUTE,
		// tilde-free path — Node does not expand '~'.
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
