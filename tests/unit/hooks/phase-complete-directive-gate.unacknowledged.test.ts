/** Legacy `unacknowledged` diagnostics never satisfy a V2 critical receipt. */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { appendKnowledgeEvent } from '../../../src/hooks/knowledge-events.js';
import {
	commitDisplayedMembership,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { evaluatePhaseCriticalDirectives } from '../../../src/hooks/phase-complete-directive-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const PHASE = 'Canonical phase';
const ENTRY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
let directory: string;

beforeEach(async () => {
	directory = canonicalMkdtemp('phase-unack-v2-');
	writeFileSync(path.join(directory, '.git'), 'gitdir: fixture');
	const displayed = await commitDisplayedMembership(directory, {
		trace_id: 'trace-unack',
		session_id: 'session-a',
		phase: PHASE,
		entries: [{ entry_id: ENTRY, critical: true }],
	});
	if (!displayed.ok) throw new Error(displayed.detail);
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

async function diagnostic(): Promise<void> {
	await appendKnowledgeEvent(directory, {
		type: 'unacknowledged',
		trace_id: 'trace-unack',
		knowledge_id: ENTRY,
		session_id: 'session-a',
		agent: 'coder',
		source: 'delegate',
		reason: 'no_ack_marker',
	});
}

test('unacknowledged diagnostic does not close a pending critical pair', async () => {
	await diagnostic();

	const result = await evaluatePhaseCriticalDirectives({
		directory,
		sessionId: 'session-a',
		phaseLabel: PHASE,
	});

	expect(result.unresolved).toEqual([
		{ id: ENTRY, trace_id: 'trace-unack', reason: 'no_verdict' },
	]);
});

test('unacknowledged diagnostic does not remediate a V2 violation', async () => {
	const terminal = await validateAndCommitTerminalBatch(directory, {
		trace_id: 'trace-unack',
		session_id: 'session-a',
		items: [{ entry_id: ENTRY, outcome: 'violated', reason: 'defect' }],
	});
	if (!terminal.ok) throw new Error(terminal.detail);
	await diagnostic();

	const result = await evaluatePhaseCriticalDirectives({
		directory,
		sessionId: 'session-a',
		phaseLabel: PHASE,
	});

	expect(result.unresolved).toEqual([
		{
			id: ENTRY,
			trace_id: 'trace-unack',
			reason: 'unremediated_violation',
		},
	]);
});

test('control: an authoritative applied terminal closes the pair', async () => {
	const terminal = await validateAndCommitTerminalBatch(directory, {
		trace_id: 'trace-unack',
		session_id: 'session-a',
		items: [{ entry_id: ENTRY, outcome: 'applied' }],
	});
	if (!terminal.ok) throw new Error(terminal.detail);

	const result = await evaluatePhaseCriticalDirectives({
		directory,
		sessionId: 'session-a',
		phaseLabel: PHASE,
	});
	expect(result.blocked).toBe(false);
});
