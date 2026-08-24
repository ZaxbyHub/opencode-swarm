import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	EMBEDDING_MODEL_PIN_PLACEHOLDER,
	resolveCurrentEmbeddingPin,
} from '../../../scripts/memory-recall-regression.ts';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../..',
);

/**
 * PR #2310 feedback PRR-029 (reviewer follow-up): pin the regression-gate's
 * pipeline-identity resolver AND the committed baseline's pin so a maintainer
 * who edits one of the two sites (resolver constant, --update writer, gate
 * check) cannot silently break the round-trip — the fast unit test fails
 * before CI does.
 */
describe('memory-recall-regression pin (PRR-029)', () => {
	test('default config (embeddings disabled) resolves to the lexical pin', () => {
		expect(resolveCurrentEmbeddingPin()).toBe(EMBEDDING_MODEL_PIN_PLACEHOLDER);
		expect(EMBEDDING_MODEL_PIN_PLACEHOLDER).toBe('lexical-default-v1');
	});

	test('committed baseline pin round-trips against the current resolver', () => {
		const baseline = JSON.parse(
			readFileSync(
				path.join(
					REPO_ROOT,
					'tests',
					'fixtures',
					'memory-recall-baseline.json',
				),
				'utf-8',
			),
		) as { embedding_model_version: string };
		expect(baseline.embedding_model_version).toBe(resolveCurrentEmbeddingPin());
	});
});
