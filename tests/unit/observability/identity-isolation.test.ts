/**
 * AC3 + ID randomness/privacy (issue #2029 item 2/6).
 *
 * - Same cohort label in two different project paths -> different projectRef
 *   AND different cohortRef.
 * - `pseudonymousRef` never leaks the input path, is 16 lowercase hex,
 *   deterministic per (path, salt), and varies across salts.
 * - `newTraceId`/`newSpanId` are unique, correctly shaped, never all-zero
 *   across 500 draws.
 * - A prefixed agent name (`mega_architect`) and an unprefixed one
 *   (`architect`) in two sessions share no identity field.
 */
import { describe, expect, test } from 'bun:test';
import {
	newSpanId,
	newTraceId,
	pseudonymousRef,
	SPAN_ID_HEX_LENGTH,
	TRACE_ID_HEX_LENGTH,
} from '../../../src/observability/ids.js';
import {
	createObservation,
	initObservability,
	resetObservabilityForTesting,
} from '../../../src/observability/observe.js';

const HEX_16_LOWERCASE = /^[0-9a-f]{16}$/;

describe('identity isolation — AC3', () => {
	test('two different project directories with the SAME cohort label produce different projectRef AND different cohortRef', () => {
		resetObservabilityForTesting();
		initObservability({
			directory: '/home/user/project-a',
			cohortLabel: 'shared-cohort',
		});
		const eventA = createObservation('heartbeat', { sessionId: 's' });

		resetObservabilityForTesting();
		initObservability({
			directory: '/home/user/project-b',
			cohortLabel: 'shared-cohort',
		});
		const eventB = createObservation('heartbeat', { sessionId: 's' });

		expect(eventA.lineage.projectRef).toBeDefined();
		expect(eventB.lineage.projectRef).toBeDefined();
		expect(eventA.lineage.projectRef).not.toBe(eventB.lineage.projectRef);

		expect(eventA.lineage.cohortRef).toBeDefined();
		expect(eventB.lineage.cohortRef).toBeDefined();
		expect(eventA.lineage.cohortRef).not.toBe(eventB.lineage.cohortRef);

		resetObservabilityForTesting();
	});

	describe('pseudonymousRef', () => {
		const salt = 'test-salt-1';
		const path1 = '/Users/alice/very-secret-project-name';

		test('output contains no substring of the input path', () => {
			const ref = pseudonymousRef(path1, salt);
			expect(ref).not.toContain('alice');
			expect(ref).not.toContain('secret');
			expect(ref).not.toContain('project');
			expect(ref.toLowerCase()).not.toContain(path1.toLowerCase());
			// No 4+ char contiguous substring of the path survives into the ref.
			for (let i = 0; i + 4 <= path1.length; i++) {
				expect(ref).not.toContain(path1.slice(i, i + 4));
			}
		});

		test('is 16 lowercase hex characters', () => {
			const ref = pseudonymousRef(path1, salt);
			expect(ref.length).toBe(16);
			expect(HEX_16_LOWERCASE.test(ref)).toBe(true);
		});

		test('is deterministic for the same (path, salt) pair', () => {
			const ref1 = pseudonymousRef(path1, salt);
			const ref2 = pseudonymousRef(path1, salt);
			expect(ref1).toBe(ref2);
		});

		test('differs across salts for the same path', () => {
			const refA = pseudonymousRef(path1, 'salt-a');
			const refB = pseudonymousRef(path1, 'salt-b');
			expect(refA).not.toBe(refB);
		});

		test('differs across paths for the same salt', () => {
			const refA = pseudonymousRef('/path/one', salt);
			const refB = pseudonymousRef('/path/two', salt);
			expect(refA).not.toBe(refB);
		});
	});

	describe('newTraceId / newSpanId — randomness and shape', () => {
		test('500 draws of newTraceId are all unique, correct hex length, never all-zero', () => {
			const seen = new Set<string>();
			const allZero = '0'.repeat(TRACE_ID_HEX_LENGTH);
			for (let i = 0; i < 500; i++) {
				const id = newTraceId();
				expect(id.length).toBe(TRACE_ID_HEX_LENGTH);
				expect(/^[0-9a-f]+$/.test(id)).toBe(true);
				expect(id).not.toBe(allZero);
				seen.add(id);
			}
			expect(seen.size).toBe(500);
		});

		test('500 draws of newSpanId are all unique, correct hex length, never all-zero', () => {
			const seen = new Set<string>();
			const allZero = '0'.repeat(SPAN_ID_HEX_LENGTH);
			for (let i = 0; i < 500; i++) {
				const id = newSpanId();
				expect(id.length).toBe(SPAN_ID_HEX_LENGTH);
				expect(/^[0-9a-f]+$/.test(id)).toBe(true);
				expect(id).not.toBe(allZero);
				seen.add(id);
			}
			expect(seen.size).toBe(500);
		});
	});

	test('prefixed (mega_architect) vs unprefixed (architect) agent names in two sessions share no identity field', () => {
		resetObservabilityForTesting();
		initObservability({ directory: '/proj/x', cohortLabel: 'cohort-x' });
		const prefixed = createObservation('agent_activated', {
			sessionId: 'sess-mega',
			agentName: 'mega_architect',
		});

		resetObservabilityForTesting();
		initObservability({ directory: '/proj/x', cohortLabel: 'cohort-x' });
		const unprefixed = createObservation('agent_activated', {
			sessionId: 'sess-plain',
			agentName: 'architect',
		});

		expect(prefixed.eventId).not.toBe(unprefixed.eventId);
		expect(prefixed.trace.traceId).not.toBe(unprefixed.trace.traceId);
		expect(prefixed.trace.spanId).not.toBe(unprefixed.trace.spanId);
		expect(prefixed.workflow.hostSessionId).not.toBe(
			unprefixed.workflow.hostSessionId,
		);

		resetObservabilityForTesting();
	});
});
