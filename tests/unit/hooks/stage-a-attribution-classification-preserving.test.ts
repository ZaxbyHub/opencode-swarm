/** Preserves genuine Stage A attribution/recovery classification semantics. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as guardrails from '../../../src/hooks/guardrails/index';
import { STAGE_A_ATTRIBUTION_MISS_CODES } from '../../../src/hooks/guardrails/index';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let cleanup: () => void;

beforeEach(() => {
	({ cleanup } = createSafeTestDir('stage-a-attribution-class'));
});

afterEach(() => {
	cleanup();
});

function optionalCoderMutationCodes(): Set<string> {
	const exported = (guardrails as unknown as Record<string, unknown>)[
		'STAGE_A_CODER_MUTATION_REQUIRED_CODES'
	];
	return exported instanceof Set ? new Set(exported as Set<string>) : new Set();
}

describe('preserving Stage A attribution classification', () => {
	test('keeps TASK_WORKFLOW_STAGE_A_REQUIRED in attribution recovery only', () => {
		const attributionCode = 'TASK_WORKFLOW_STAGE_A_REQUIRED';
		expect(STAGE_A_ATTRIBUTION_MISS_CODES.has(attributionCode)).toBe(true);
		expect(optionalCoderMutationCodes().has(attributionCode)).toBe(false);
	});
});
