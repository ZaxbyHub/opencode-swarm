import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import {
	_internals,
	collectReviewerReceiptAfter,
} from '../../../src/hooks/review-receipt-collector';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import {
	createFindingValidationScheduler,
	type FindingValidationScheduler,
} from '../../../src/review/finding-validator';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Stage-B validation telemetry must emit BOTH halves of the delegation
 * lifecycle. Previously `emitStageBValidationTelemetry` emitted only
 * `delegation_end` for each replayed validator attempt, so every Stage-B
 * validation appeared in the stream as a completion with no start.
 *
 * Both halves go through the `_internals` seam on purpose: a test that stubs
 * one necessarily controls the other, and a throwing sink skips the whole pair
 * instead of emitting an orphan.
 */

const STRUCTURED_REJECTED_OUTPUT = [
	'VERDICT: REJECTED',
	'RISK: HIGH',
	'ISSUES: none (see structured findings)',
	'FIXES: correct the loop bound',
	'```json',
	'{"findings":[{"title":"Final record is dropped","body":"The loop exits before processing the final record.","severity":"high","confidence":0.93,"file":"src/utils/parse.ts","line_start":42,"line_end":43}],"verdict":"REJECTED","overall_confidence":0.91}',
	'```',
].join('\n');

type DelegationCall = {
	half: 'begin' | 'end';
	sessionID: string;
	agentName: string;
	taskID: string;
};

let tmpDir: string;
let calls: DelegationCall[];
let validationScheduler: FindingValidationScheduler;
const originalDelegationBegin = _internals.delegationBegin;
const originalDelegationEnd = _internals.delegationEnd;
const originalResolveReviewerTaskScope = _internals.resolveReviewerTaskScope;

function validationConfig() {
	return resolveAutoReviewConfig({ enabled: true, validate_findings: true });
}

/** Always-completing dispatcher; its text is not a valid validation payload,
 * which is irrelevant here — an attempt is recorded either way, and the attempt
 * is what gets replayed into telemetry. */
function dispatcher(): ReviewModelDispatcher {
	return {
		async dispatch(request) {
			return {
				status: 'completed',
				text: 'not-a-validation-payload',
				agentName: request.agentName,
				durationMs: 1,
				promptBytes: request.prompt.length,
				responseBytes: 24,
				costFields: {
					tokens_input: 10,
					tokens_output: 5,
					tokens_reasoning: 0,
					tokens_cache: 0,
					cost_usd: null,
					cost_source: 'unavailable',
				},
			};
		},
	};
}

beforeEach(() => {
	tmpDir = canonicalMkdtemp('receipt-pairing-');
	calls = [];
	validationScheduler = createFindingValidationScheduler();
	_internals.delegationBegin = (sessionID, agentName, taskID) => {
		calls.push({ half: 'begin', sessionID, agentName, taskID });
	};
	_internals.delegationEnd = (sessionID, agentName, taskID) => {
		calls.push({ half: 'end', sessionID, agentName, taskID });
	};
	_internals.resolveReviewerTaskScope = async () => ({
		content: 'opencode-swarm-reviewer-task-scope-v1\npairing-fixture\n',
		description: 'reviewer-task-files-v1',
		files: ['src/fixture.ts'],
	});
});

afterEach(() => {
	validationScheduler.reset();
	_internals.delegationBegin = originalDelegationBegin;
	_internals.delegationEnd = originalDelegationEnd;
	_internals.resolveReviewerTaskScope = originalResolveReviewerTaskScope;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe('Stage-B validation telemetry pairing', () => {
	test('each replayed validator attempt emits a begin immediately before its end, with a matching identity', async () => {
		let advisoryDelivered!: () => void;
		const advisoryReady = new Promise<void>((resolve) => {
			advisoryDelivered = resolve;
		});

		const receiptPath = await collectReviewerReceiptAfter(
			tmpDir,
			{
				tool: 'Task',
				args: {
					subagent_type: 'reviewer',
					prompt: 'TASK: Review structured output',
				},
				sessionID: 'pairing-session',
			},
			{ output: STRUCTURED_REJECTED_OUTPUT },
			{
				config: validationConfig(),
				dispatcher: dispatcher(),
				injectAdvisory: () => advisoryDelivered(),
				validationScheduler,
			},
		);
		expect(receiptPath).not.toBeNull();
		await advisoryReady;

		const begins = calls.filter((call) => call.half === 'begin');
		const ends = calls.filter((call) => call.half === 'end');
		expect(ends.length).toBeGreaterThan(0);
		expect(begins).toHaveLength(ends.length);

		// Adjacent and identity-matched: every end is directly preceded by its
		// own begin carrying the same triple.
		for (let index = 0; index < calls.length; index++) {
			if (calls[index].half !== 'end') continue;
			const previous = calls[index - 1];
			expect(previous?.half).toBe('begin');
			expect(previous?.sessionID).toBe(calls[index].sessionID);
			expect(previous?.agentName).toBe(calls[index].agentName);
			expect(previous?.taskID).toBe(calls[index].taskID);
		}

		// The Stage-B constant, not a real plan task id.
		expect(begins[0].taskID).toBe('reviewer-task-validation');
		expect(begins[0].sessionID).toBe('pairing-session');
		expect(begins[0].agentName).toContain('critic_finding_validator');
	});
});
