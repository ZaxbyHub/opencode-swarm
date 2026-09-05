import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { indexVerdictRows } from '../../../src/pr-review/legacy-transcript-adapter.js';
import {
	addTelemetryListener,
	initTelemetry,
	removeTelemetryListener,
	resetTelemetryForTesting,
} from '../../../src/telemetry.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2482 / #2184: the verdict-row pipe tail-merge fidelity class
 * (legacy-fidelity-safe vs legacy-lossy) is now IN THE EVENT LIFECYCLE, not
 * only in the debug-gated warn. emit() notifies listeners only once
 * initTelemetry has opened the stream, so each test initializes telemetry in
 * a throwaway project.
 */

const events: Array<Record<string, unknown>> = [];
const listener = (event: string, data: Record<string, unknown>) => {
	if (event === 'verdict_row_pipe_recovery') events.push(data);
};

// Fixtures proven against the parser by the sibling tolerance suite
// (tests/unit/hooks/pr-workflow-gate-verdict-pipe-tolerance.test.ts
// 'production indexing retains both legacy overflow recovery classes'):
// the twelve-field fidelity-safe shape (canonical row plus one extra
// trailing empty field, issue #2383) and a mid-row-pipe lossy [CRITIC] row.
const SAFE_ROW =
	'[REVIEWED] | C-safe | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | SECURITY | ';
const LOSSY_ROW =
	'[CRITIC] | C-lossy | UPHELD | HIGH | rationale with | a pipe | required change';

function withTelemetry(fn: () => void): void {
	const tmp = canonicalMkdtemp('verdict-emit-');
	initTelemetry(tmp);
	events.length = 0;
	addTelemetryListener(listener);
	try {
		fn();
	} finally {
		removeTelemetryListener(listener);
		resetTelemetryForTesting();
		rmSync(tmp, { recursive: true, force: true });
	}
}

describe('verdict_row_pipe_recovery emission (issue #2184 residual)', () => {
	test('fidelity-safe and lossy recoveries both emit, carrying the class', () => {
		withTelemetry(() => {
			indexVerdictRows(SAFE_ROW, '[REVIEWED]');
			indexVerdictRows(LOSSY_ROW, '[CRITIC]');
		});
		expect(events.length).toBe(2);
		const kinds = events.map((e) => e.recovery).sort();
		expect(kinds).toEqual(['legacy-fidelity-safe', 'legacy-lossy']);
		// PRR-014: pin the fixture-derived values, not just their types —
		// a payload of arbitrary well-typed values must NOT satisfy this.
		expect(events[0]?.marker).toBe('[REVIEWED]');
		expect(events[0]?.itemId).toBe('C-safe');
		expect(events[0]?.recovery).toBe('legacy-fidelity-safe');
		expect(events[1]?.marker).toBe('[CRITIC]');
		expect(events[1]?.itemId).toBe('C-lossy');
		expect(events[1]?.recovery).toBe('legacy-lossy');
		for (const e of events) {
			// Identifiers/enums only — no row prose leaks into the event.
			expect(typeof e.marker).toBe('string');
			expect(typeof e.itemId).toBe('string');
			expect(typeof e.fieldCount).toBe('number');
			const serialized = JSON.stringify(e);
			expect(serialized.includes('rationale with')).toBe(false);
			expect(serialized.includes('required change')).toBe(false);
		}
	});

	test('clean rows emit nothing', () => {
		withTelemetry(() => {
			indexVerdictRows(
				'[REVIEWED] | C-1 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:2 | rationale | probe | notes',
				'[REVIEWED]',
			);
		});
		expect(events.length).toBe(0);
	});
});
