/**
 * Recurrence guardrail for the Stage A silent-wedge class
 * (TASK_WORKFLOW_STAGE_A_REQUIRED post-reset wedge).
 *
 * The escalation path in guardrails/index.ts classifies reducer throw codes:
 * attribution-miss codes escalate to a visible advisory, everything else stays
 * log-only. This test mechanically pins that classification to the actual
 * reducer: every TASK_WORKFLOW_* error literal emitted by src/gate-evidence.ts
 * must be either explicitly classified or explicitly allowlisted. A new
 * reducer error code added without touching the classification fails here, so
 * the class cannot silently return as an unclassified swallow.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	STAGE_A_ATTRIBUTION_MISS_CODES,
	stageAWriteErrorCode,
} from '../../../src/hooks/guardrails/index';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let cleanup: () => void;
let directory: string;

beforeEach(() => {
	({ dir: directory, cleanup } = createSafeTestDir('stage-a-guardrail'));
});

afterEach(() => {
	cleanup();
});

const REDUCER_ALLOWLIST = new Set([
	// Terminal/fencing churn: a late gate result after close/settlement is
	// expected and must stay log-only (see STAGE_A_ATTRIBUTION_MISS_CODES doc).
	'TASK_WORKFLOW_TERMINAL',
	'CODER_SETTLEMENT_IN_PROGRESS',
	'TASK_TERMINAL_PREPARED',
	'TASK_REPAIR_PREPARED',
	// Dispatch-binding integrity for Stage B gates, not task attribution.
	'TASK_WORKFLOW_GENERATION_REQUIRED',
	// QA gating on terminal transitions, not Stage A attribution.
	'TASK_WORKFLOW_QA_REQUIRED',
]);

function extractReducerErrorCodes(): string[] {
	const source = fs.readFileSync(
		path.resolve(import.meta.dir, '../../../src/gate-evidence.ts'),
		'utf8',
	);
	const codes = new Set<string>();
	for (const match of source.matchAll(/`([A-Z][A-Z0-9_]+):/g)) {
		if (match[1].startsWith('TASK_WORKFLOW_')) codes.add(match[1]);
	}
	return [...codes].sort();
}

describe('Stage A error classification guardrail', () => {
	test('every reducer workflow error code is classified or allowlisted', () => {
		const classified = new Set([
			...STAGE_A_ATTRIBUTION_MISS_CODES,
			...REDUCER_ALLOWLIST,
		]);
		const reducerCodes = extractReducerErrorCodes();
		expect(reducerCodes.length).toBeGreaterThan(0);
		const unclassified = reducerCodes.filter((code) => !classified.has(code));
		expect(unclassified).toEqual([]);
	});

	test('classification set only contains codes the reducer can actually throw', () => {
		const reducerCodes = new Set(extractReducerErrorCodes());
		const stale = [...STAGE_A_ATTRIBUTION_MISS_CODES].filter(
			(code) => !reducerCodes.has(code),
		);
		expect(stale).toEqual([]);
	});

	test('stageAWriteErrorCode extracts leading codes and rejects prose', () => {
		expect(
			stageAWriteErrorCode(
				new Error('TASK_WORKFLOW_GENERATION_MISMATCH: expected 1, current 2'),
			),
		).toBe('TASK_WORKFLOW_GENERATION_MISMATCH');
		expect(stageAWriteErrorCode(new Error('EACCES: denied'))).toBe('EACCES');
		expect(stageAWriteErrorCode('plain failure text')).toBeNull();
	});
});
