/** #2031 regression: legacy diagnostic FIFO churn cannot erase V2 gate authority. */

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	commitDisplayedMembership,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { evaluatePhaseCriticalDirectives } from '../../../src/hooks/phase-complete-directive-gate.js';

let directory: string | undefined;

afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});

test('blocks after more than 5,000 diagnostics, then passes only after exact terminal', async () => {
	directory = mkdtempSync(path.join(tmpdir(), 'phase-gate-fifo-v2-'));
	writeFileSync(path.join(directory, '.git'), 'gitdir: fixture');
	const phase = 'Canonical FIFO phase';
	const displayed = await commitDisplayedMembership(directory, {
		trace_id: 'trace-fifo',
		session_id: 'session-fifo',
		phase,
		entries: [{ entry_id: 'critical-fifo-rule', critical: true }],
	});
	if (!displayed.ok) throw new Error(displayed.detail);

	const diagnostics = Array.from({ length: 5_101 }, (_, index) =>
		JSON.stringify({
			type: 'outcome',
			event_id: `legacy-diagnostic-${index}`,
			timestamp: new Date().toISOString(),
			outcome: 'success',
			evidence_summary: 'diagnostic only',
		}),
	).join('\n');
	writeFileSync(
		path.join(directory, '.swarm', 'knowledge-events.jsonl'),
		`${diagnostics}\n`,
	);

	const blocked = await evaluatePhaseCriticalDirectives({
		directory,
		sessionId: 'session-fifo',
		phaseLabel: phase,
	});
	expect(blocked.unresolved).toEqual([
		{
			id: 'critical-fifo-rule',
			trace_id: 'trace-fifo',
			reason: 'no_verdict',
		},
	]);

	const terminal = await validateAndCommitTerminalBatch(directory, {
		trace_id: 'trace-fifo',
		session_id: 'session-fifo',
		items: [{ entry_id: 'critical-fifo-rule', outcome: 'applied' }],
	});
	if (!terminal.ok) throw new Error(terminal.detail);
	const passed = await evaluatePhaseCriticalDirectives({
		directory,
		sessionId: 'session-fifo',
		phaseLabel: phase,
	});
	expect(passed).toMatchObject({ blocked: false, failedClosed: false });
});
