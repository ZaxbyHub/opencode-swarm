/** OpenCode 2.3.x per-step usage is durable, never a session-total event.
 * Contract reference: packages/schema/src/session-event.ts (2.3.0).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { clearV2StepUsage, forgetV2StepUsage, ingestV2StepUsage } from './usage-bridge.js';

const step = (sessionID: string, swarmV2EventId: string, cost: number, input = 10) => ({
  type: 'step-finish' as const,
  swarmV2UsageStep: true as const,
  sessionID, swarmV2EventId, cost,
  tokens: { input, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
});

beforeEach(clearV2StepUsage);

describe('OpenCode 2.3 durable step usage aggregation', () => {
  test('adds multiple steps per exact child session', () => {
    expect(ingestV2StepUsage(step('ses_child', 'evt_1', 0.1))?.cost).toBe(0.1);
    const total = ingestV2StepUsage(step('ses_child', 'evt_2', 0.2, 40));
    expect(total?.cost).toBeCloseTo(0.3);
    expect(total?.tokens.input).toBe(50);
    expect(total?.tokens.cache.read).toBe(6);
  });
  test('replays are ignored and distinct sessions remain isolated', () => {
    ingestV2StepUsage(step('ses_child', 'evt_1', 0.1));
    expect(ingestV2StepUsage(step('ses_child', 'evt_1', 0.1))).toBeUndefined();
    expect(ingestV2StepUsage(step('ses_architect', 'evt_1', 1.0))?.cost).toBe(1);
    expect(ingestV2StepUsage(step('ses_child', 'evt_2', 0.1))?.cost).toBe(0.2);
  });
  test('invalid provider evidence never becomes fabricated zero', () => {
    expect(ingestV2StepUsage(step('ses_child', 'evt_1', NaN))).toBeUndefined();
    expect(ingestV2StepUsage({ ...step('ses_child', 'evt_2', 0.1), tokens: null })).toBeUndefined();
    expect(ingestV2StepUsage(step('ses_child', '', 0.1))).toBeUndefined();
  });
  test('completion clears the exact child accounting state', () => {
    ingestV2StepUsage(step('ses_child', 'evt_1', 0.1));
    forgetV2StepUsage('ses_child');
    expect(ingestV2StepUsage(step('ses_child', 'evt_1', 0.1))?.cost).toBe(0.1);
  });
});
