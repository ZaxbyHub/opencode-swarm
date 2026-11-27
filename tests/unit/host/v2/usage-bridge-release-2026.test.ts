/**
 * PR 3922 closeout: the usage bridge caps tracked sessions at 200 and only the
 * synchronous Task consumer used to release them. Native-async children are
 * released at their verified terminal (completion-observer), so the cap must
 * recover and later sessions must keep attributing usage.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	clearV2StepUsage,
	forgetV2StepUsage,
	ingestV2StepUsage,
} from '../../../../src/host/v2/usage-bridge';

function step(sessionID: string, eventId: string) {
	return {
		swarmV2UsageStep: true,
		sessionID,
		swarmV2EventId: eventId,
		cost: 1,
		tokens: {
			input: 1,
			output: 1,
			reasoning: 0,
			cache: { read: 0, write: 0 },
		},
	};
}

describe('usage bridge session release (PR 3922 closeout)', () => {
	afterEach(() => {
		clearV2StepUsage();
	});

	test('a saturated bridge refuses a new session until a finished child is released', () => {
		for (let i = 0; i < 200; i++) {
			expect(ingestV2StepUsage(step(`ses_child_${i}`, `e${i}`))).toBeDefined();
		}
		expect(
			ingestV2StepUsage(step('ses_sync_after_cap', 'e-sync')),
		).toBeUndefined();

		forgetV2StepUsage('ses_child_0');

		expect(
			ingestV2StepUsage(step('ses_sync_after_cap', 'e-sync')),
		).toMatchObject({ cost: 1, sessionID: 'ses_sync_after_cap' });
	});

	test('releasing a session does not disturb another session total', () => {
		ingestV2StepUsage(step('ses_keep', 'k1'));
		ingestV2StepUsage(step('ses_drop', 'd1'));

		forgetV2StepUsage('ses_drop');

		expect(ingestV2StepUsage(step('ses_keep', 'k2'))).toMatchObject({
			cost: 2,
			sessionID: 'ses_keep',
		});
	});
});
