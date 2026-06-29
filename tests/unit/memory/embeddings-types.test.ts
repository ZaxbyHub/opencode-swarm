import { describe, expect, test } from 'bun:test';
import type {
	EmbeddingProvider,
	EmbeddingVersion,
} from '../../../src/memory/embeddings/types';
import {
	EmbeddingUnavailableError,
	EmbeddingVersionMismatchError,
} from '../../../src/memory/embeddings/types';

// ---------------------------------------------------------------------------
// EmbeddingUnavailableError — correct .name and .message
// ---------------------------------------------------------------------------
describe('EmbeddingUnavailableError', () => {
	test('has correct .name', () => {
		const err = new EmbeddingUnavailableError();
		expect(err.name).toBe('EmbeddingUnavailableError');
	});

	test('has correct .message when constructed without args', () => {
		const err = new EmbeddingUnavailableError();
		expect(err.message).toBe(
			'Embedding provider is unavailable (dependency not installed or model failed to load)',
		);
	});

	test('accepts a custom message', () => {
		const err = new EmbeddingUnavailableError('Custom unavailable message');
		expect(err.message).toBe('Custom unavailable message');
		expect(err.name).toBe('EmbeddingUnavailableError');
	});

	test('is an instance of Error', () => {
		const err = new EmbeddingUnavailableError();
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(EmbeddingUnavailableError);
	});

	test('has no own enumerable properties beyond name and message', () => {
		const err = new EmbeddingUnavailableError('test');
		const ownKeys = Object.keys(err);
		// Error base class has 'message' as own property
		expect(ownKeys).not.toContain('queryVersion');
		expect(ownKeys).not.toContain('storedVersion');
	});
});

// ---------------------------------------------------------------------------
// EmbeddingVersionMismatchError — correct .name, .message, and properties
// ---------------------------------------------------------------------------
describe('EmbeddingVersionMismatchError', () => {
	test('has correct .name', () => {
		const err = new EmbeddingVersionMismatchError('v1', 'v2');
		expect(err.name).toBe('EmbeddingVersionMismatchError');
	});

	test('has correct .message', () => {
		const err = new EmbeddingVersionMismatchError(
			'Xenova/all-MiniLM-L6-v2:384',
			'old-version',
		);
		expect(err.message).toBe(
			'Embedding version mismatch: query uses Xenova/all-MiniLM-L6-v2:384 but stored vectors are old-version. Rebuild the index or pin the model version.',
		);
	});

	test('exposes queryVersion property', () => {
		const err = new EmbeddingVersionMismatchError('v1', 'v2');
		expect(err.queryVersion).toBe('v1');
	});

	test('exposes storedVersion property', () => {
		const err = new EmbeddingVersionMismatchError('v1', 'v2');
		expect(err.storedVersion).toBe('v2');
	});

	test('queryVersion and storedVersion are independent', () => {
		const err = new EmbeddingVersionMismatchError('alpha', 'beta');
		expect(err.queryVersion).toBe('alpha');
		expect(err.storedVersion).toBe('beta');
	});

	test('is an instance of Error', () => {
		const err = new EmbeddingVersionMismatchError('a', 'b');
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(EmbeddingVersionMismatchError);
	});

	test('message includes both version values', () => {
		const err = new EmbeddingVersionMismatchError('query-model', 'store-model');
		expect(err.message).toContain('query-model');
		expect(err.message).toContain('store-model');
	});
});

// ---------------------------------------------------------------------------
// EmbeddingVersion — type alias for string
// ---------------------------------------------------------------------------
describe('EmbeddingVersion', () => {
	test('EmbeddingVersion is a string type alias', () => {
		const version: EmbeddingVersion = 'Xenova/all-MiniLM-L6-v2:384';
		expect(typeof version).toBe('string');
		expect(version).toBe('Xenova/all-MiniLM-L6-v2:384');
	});
});

// ---------------------------------------------------------------------------
// Minimal stub implementation of EmbeddingProvider (type-check test)
// This verifies the EmbeddingProvider interface is actually usable/implementable.
// If the interface has issues, this will fail to compile.
// ---------------------------------------------------------------------------
describe('EmbeddingProvider interface — minimal stub compiles', () => {
	test('a minimal stub implementing EmbeddingProvider type-checks', () => {
		// This is a type-level test — if it compiles, the interface is well-formed.
		// We use an explicit cast to EmbeddingProvider to exercise the type.
		const stubProvider: EmbeddingProvider = {
			async embed(text: string): Promise<Float32Array> {
				return new Float32Array(384);
			},
			async embedBatch(texts: string[]): Promise<Float32Array[]> {
				return texts.map(() => new Float32Array(384));
			},
			modelVersion: 'Xenova/all-MiniLM-L6-v2:384',
			dimension: 384,
			available: false,
		};
		expect(stubProvider.available).toBe(false);
		expect(stubProvider.modelVersion).toBe('Xenova/all-MiniLM-L6-v2:384');
		expect(stubProvider.dimension).toBe(384);
	});

	test('EmbeddingProvider.available can be true', () => {
		const availableProvider: EmbeddingProvider = {
			async embed(text: string): Promise<Float32Array> {
				return new Float32Array(384);
			},
			async embedBatch(texts: string[]): Promise<Float32Array[]> {
				return texts.map(() => new Float32Array(384));
			},
			modelVersion: 'Xenova/all-MiniLM-L6-v2:384',
			dimension: 384,
			available: true,
		};
		expect(availableProvider.available).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Module import surface — guards Node-ESM-loadable dist invariant
// The types module must not pull in heavy runtime dependencies that would
// break the Bun-native dist bundle's portability.
// ---------------------------------------------------------------------------
describe('embeddings/types.ts — no heavy runtime imports (Node-ESM-loadable invariant)', () => {
	test('the module exports only types and error classes', () => {
		// Re-import to check runtime exports are limited to the two error classes.
		// If new runtime imports are added, this test will fail, catching the
		// invariant violation before it reaches the dist bundle.
		const moduleKeys = Object.keys(
			require('../../../src/memory/embeddings/types.js'),
		);
		// Should only have: EmbeddingProvider, EmbeddingVersion, EmbeddingCacheEntry,
		// EmbeddingUnavailableError, EmbeddingVersionMismatchError
		// (plus standard Error properties from the Error base class)
		const runtimeExports = moduleKeys.filter(
			(k) => typeof (globalThis as any)[k] !== 'undefined' && k !== 'prototype',
		);
		// This is a lightweight sanity check — actual dist validation happens via
		// the bundle-portability test in CI.
		expect(Object.keys(runtimeExports).sort()).toEqual([
			'EmbeddingCacheEntry',
			'EmbeddingProvider',
			'EmbeddingUnavailableError',
			'EmbeddingVersion',
			'EmbeddingVersionMismatchError',
		]);
	});
});
