/**
 * Issue #2487 acceptance check AC6.
 *
 * A legacy projection failure must not prevent canonical telemetry listeners
 * from receiving the event and recording it through their own path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	addTelemetryListener,
	emit,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('issue #2487 — listener fail-open parity', () => {
	let directory: string;

	beforeEach(() => {
		directory = canonicalMkdtemp('issue-2487-observability-listener-');
		resetTelemetryForTesting();
	});

	afterEach(() => {
		resetTelemetryForTesting();
		rmSync(directory, { recursive: true, force: true });
	});

	test('AC6: listener remains notified when legacy serialization fails', () => {
		initTelemetry(directory);
		const received: Array<{ event: string; canonical: unknown }> = [];
		addTelemetryListener((event, _data, canonical) => {
			received.push({ event, canonical });
		});

		// Before the fix, JSON.stringify of the legacy projection throws before
		// listener fan-out, so the canonical sink silently loses this event.
		expect(() =>
			emit('session_started', {
				sessionId: 'issue-2487-session',
				unserializable: 1n,
			}),
		).not.toThrow();

		expect(received).toHaveLength(1);
		expect(received[0]?.event).toBe('session_started');
		expect(received[0]?.canonical).toMatchObject({
			kind: 'session_started',
		});
	});
});
