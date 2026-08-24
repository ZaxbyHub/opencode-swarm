import { describe, expect, test } from 'bun:test';
import { dispatch_lanes_async } from '../../../src/tools/dispatch-lanes.js';

describe('dispatch_lanes PR workflow schema', () => {
	test('exposes mandatory review and feedback ledgers', () => {
		expect(dispatch_lanes_async.args.trigger_evaluation).toBeDefined();
		expect(dispatch_lanes_async.args.feedback_inventory).toBeDefined();
		expect(dispatch_lanes_async.args.base_sha).toBeDefined();
		expect(dispatch_lanes_async.args.base_ref).toBeDefined();
		expect(dispatch_lanes_async.args.pr_review_wave_stage).toBeDefined();
		expect(dispatch_lanes_async.args.pr_review_wave_attempt).toBeDefined();
		expect(dispatch_lanes_async.args.trigger_evaluation.description).toContain(
			'required for the first',
		);
		expect(dispatch_lanes_async.args.trigger_evaluation.description).toContain(
			'any subsequent micro batch may omit',
		);
		expect(dispatch_lanes_async.args.trigger_evaluation.description).toContain(
			'exactly identical',
		);
		expect(
			dispatch_lanes_async.args.pr_review_wave_stage.description,
		).toContain('canary');
		expect(
			dispatch_lanes_async.args.pr_review_wave_stage.description,
		).toContain('base-only');
		expect(
			dispatch_lanes_async.args.pr_review_wave_stage.description,
		).toContain('fanout');
		expect(
			dispatch_lanes_async.args.pr_review_wave_attempt.description,
		).toContain('attempt 0');
		expect(
			dispatch_lanes_async.args.pr_review_wave_attempt.description,
		).toContain('base-only');
		expect(
			dispatch_lanes_async.args.pr_review_wave_attempt.description,
		).toContain('at most two retry attempts');
	});
});
