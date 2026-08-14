/** Tool-facing smoke coverage for the V2 phase directive gate. */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	commitDisplayedMembership,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import {
	evaluatePhaseCriticalDirectives,
	recordDirectiveOverrides,
} from '../../../src/hooks/phase-complete-directive-gate.js';

const PHASE = 'Implementation and verification';
const ENTRY = 'critical-tool-rule';
let directory: string;

beforeEach(async () => {
	directory = mkdtempSync(path.join(tmpdir(), 'phase-tool-gate-v2-'));
	writeFileSync(path.join(directory, '.git'), 'gitdir: fixture');
	const displayed = await commitDisplayedMembership(directory, {
		trace_id: 'trace-tool',
		session_id: 'session-tool',
		phase: PHASE,
		entries: [{ entry_id: ENTRY, critical: true }],
	});
	if (!displayed.ok) throw new Error(displayed.detail);
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

test('blocks phase completion while the exact membership is pending', async () => {
	const result = await evaluatePhaseCriticalDirectives({
		directory,
		sessionId: 'session-tool',
		phaseLabel: PHASE,
	});
	expect(result.unresolved).toEqual([
		{ id: ENTRY, trace_id: 'trace-tool', reason: 'no_verdict' },
	]);
});

test('passes after an authoritative applied terminal', async () => {
	const terminal = await validateAndCommitTerminalBatch(directory, {
		trace_id: 'trace-tool',
		session_id: 'session-tool',
		items: [{ entry_id: ENTRY, outcome: 'applied' }],
	});
	if (!terminal.ok) throw new Error(terminal.detail);

	const result = await evaluatePhaseCriticalDirectives({
		directory,
		sessionId: 'session-tool',
		phaseLabel: PHASE,
	});
	expect(result.blocked).toBe(false);
});

test('accepts a violation only after its override is durably authorized', async () => {
	const terminal = await validateAndCommitTerminalBatch(directory, {
		trace_id: 'trace-tool',
		session_id: 'session-tool',
		items: [{ entry_id: ENTRY, outcome: 'violated', reason: 'known risk' }],
	});
	if (!terminal.ok) throw new Error(terminal.detail);

	const before = await evaluatePhaseCriticalDirectives({
		directory,
		sessionId: 'session-tool',
		phaseLabel: PHASE,
	});
	expect(before.blocked).toBe(true);

	await recordDirectiveOverrides(
		directory,
		[ENTRY],
		'Architect explicitly accepts this phase risk',
		'session-tool',
		PHASE,
	);
	const after = await evaluatePhaseCriticalDirectives({
		directory,
		sessionId: 'session-tool',
		phaseLabel: PHASE,
	});
	expect(after).toMatchObject({ blocked: false, overridden: [ENTRY] });
});
