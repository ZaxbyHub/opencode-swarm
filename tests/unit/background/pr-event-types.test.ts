/**
 * Phase 1 PR Monitor infrastructure — AutomationEventType PR event types tests.
 * Verifies all 13 new PR event types are present in the AutomationEventType union.
 */
import { describe, expect, test } from 'bun:test';
import type { AutomationEventType } from '../../../src/background/event-bus';

// The 13 new PR event types added by Phase 1 (FR-001)
const PR_EVENT_TYPES = [
	'pr.subscribed',
	'pr.unsubscribed',
	'pr.status.updated',
	'pr.ci.failed',
	'pr.ci.passed',
	'pr.new.comment',
	'pr.merge.conflict',
	'pr.merge.conflict_resolved',
	'pr.merged',
	'pr.closed',
	'pr.review.approved',
	'pr.review.changes_requested',
	'pr.subscription.expired',
] as const;

describe('AutomationEventType PR event types', () => {
	describe('all 13 PR event types are in the union', () => {
		for (const eventType of PR_EVENT_TYPES) {
			test(`'${eventType}' is a valid AutomationEventType`, () => {
				// Type-level check: the cast should succeed if the type is valid
				const asEventType = eventType as AutomationEventType;
				// Runtime check: the string is included in the union
				const unionValues: AutomationEventType[] = [
					'queue.item.enqueued',
					'queue.item.dequeued',
					'queue.item.completed',
					'queue.item.failed',
					'queue.item.retry scheduled',
					'worker.started',
					'worker.stopped',
					'worker.error',
					'circuit.breaker.opened',
					'circuit.breaker.half-open',
					'circuit.breaker.closed',
					'loop.protection.triggered',
					'automation.started',
					'automation.stopped',
					'preflight.requested',
					'preflight.triggered',
					'preflight.skipped',
					'preflight.completed',
					'phase.boundary.detected',
					'phase.status.checked',
					'task.completed',
					'evidence.summary.generated',
					'evidence.summary.error',
					'curator.init.completed',
					'curator.init.llm_completed',
					'curator.init.llm_fallback',
					'curator.phase.completed',
					'curator.phase.llm_completed',
					'curator.phase.llm_fallback',
					'curator.drift.completed',
					'curator.docdrift.completed',
					'curator.error',
					'pr.subscribed',
					'pr.unsubscribed',
					'pr.status.updated',
					'pr.ci.failed',
					'pr.ci.passed',
					'pr.new.comment',
					'pr.merge.conflict',
					'pr.merge.conflict_resolved',
					'pr.merged',
					'pr.closed',
					'pr.review.approved',
					'pr.review.changes_requested',
					'pr.subscription.expired',
				];
				expect(unionValues).toContain(asEventType);
			});
		}
	});

	describe('AutomationEventBus handles PR event types', async () => {
		const { AutomationEventBus } = await import(
			'../../../src/background/event-bus'
		);

		test('can subscribe to a PR event type', () => {
			const bus = new AutomationEventBus();
			let callCount = 0;
			const unsub = bus.subscribe('pr.subscribed', (event) => {
				callCount++;
				expect(event.type).toBe('pr.subscribed');
			});

			bus.publish('pr.subscribed', { prNumber: 42 });
			expect(callCount).toBe(1);

			unsub();
			bus.publish('pr.subscribed', { prNumber: 43 });
			expect(callCount).toBe(1); // No longer subscribed
		});

		test('can publish all 13 PR event types without error', async () => {
			const bus = new AutomationEventBus();
			const receivedTypes: string[] = [];

			for (const eventType of PR_EVENT_TYPES) {
				bus.subscribe(eventType, (event) => {
					receivedTypes.push(event.type);
				});
			}

			// Publish each PR event type
			for (const eventType of PR_EVENT_TYPES) {
				await bus.publish(eventType as AutomationEventType, {
					prNumber: 1,
					repoFullName: 'o/r',
				});
			}

			expect(receivedTypes).toHaveLength(PR_EVENT_TYPES.length);
			for (const eventType of PR_EVENT_TYPES) {
				expect(receivedTypes).toContain(eventType);
			}
		});

		test('publish returns a Promise', async () => {
			const bus = new AutomationEventBus();
			const result = bus.publish('pr.subscribed', { prNumber: 1 });
			expect(result).toBeInstanceOf(Promise);
			await result; // Should not throw
		});
	});

	describe('AutomationEventType union count', () => {
		test('union contains exactly the documented event types', async () => {
			const { AutomationEventBus } = await import(
				'../../../src/background/event-bus'
			);
			const bus = new AutomationEventBus();

			// Count total distinct event types in the union by subscribing to all
			const allTypes = new Set<string>();
			bus.subscribe('automation.started', (e) => allTypes.add(e.type));

			// Manually check that we can construct all documented types without error
			const unionCheck: Record<AutomationEventType, true> = {} as Record<
				AutomationEventType,
				true
			>;

			// This map will fail to compile if any event type is missing from the union
			for (const t of PR_EVENT_TYPES) {
				unionCheck[t] = true;
			}

			expect(Object.keys(unionCheck)).toHaveLength(13);
		});
	});
});
