/**
 * knowledge_receipt tool-level conflict rejection tests (#2965, Workstream J
 * slot J15) — split from knowledge-receipt.test.ts to respect the FR-006
 * baseline ratchet on the parent suite. These drive the REAL tool execute
 * (no validator-seam substitute) against a fresh tmpdir project root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { knowledge_receipt } from '../../../src/tools/knowledge-receipt';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ctx = (directory: string): any => ({
	directory,
	sessionID: 'sess-1',
	agent: 'coder',
});

describe('knowledge_receipt none-sentinel conflict rejections (#2965)', () => {
	let dir: string;
	beforeEach(() => {
		dir = canonicalMkdtemp('swarm-receipt-conflict-');
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('reports a conflicting none-sentinel re-file with the precise permanent reason (#2965)', async () => {
		const session = ctx(dir);
		const first = await knowledge_receipt.execute(
			{
				trace_id: 'none',
				no_relevant_knowledge: true,
				task_id: 'T1',
				phase: 'P1',
			} as never,
			session,
		);
		expect(JSON.parse(first).recorded).toBe(true);
		const second = await knowledge_receipt.execute(
			{
				trace_id: 'none',
				no_relevant_knowledge: true,
				task_id: 'T2',
				phase: 'P1',
			} as never,
			session,
		);
		const rejected = JSON.parse(second);
		expect(rejected.recorded).toBe(false);
		expect(rejected.rejected).toBe(true);
		expect(rejected.reason).toBe('wrong_task');
		expect(rejected.detail).toContain('conflicting immutable empty retrieval');
		expect(rejected.detail).toContain("recorded task 'T1'");
	});

	it('reports a conflicting none-sentinel phase with reason wrong_phase (#2965)', async () => {
		const session = ctx(dir);
		const first = await knowledge_receipt.execute(
			{
				trace_id: 'none',
				no_relevant_knowledge: true,
				task_id: 'T1',
				phase: 'P1',
			} as never,
			session,
		);
		expect(JSON.parse(first).recorded).toBe(true);
		const second = await knowledge_receipt.execute(
			{
				trace_id: 'none',
				no_relevant_knowledge: true,
				task_id: 'T1',
				phase: 'P2',
			} as never,
			session,
		);
		const rejected = JSON.parse(second);
		expect(rejected.recorded).toBe(false);
		expect(rejected.rejected).toBe(true);
		expect(rejected.reason).toBe('wrong_phase');
		expect(rejected.detail).toContain("recorded phase 'P1'");
	});

	it('reports a changed grace window with reason duplicate_conflicting_terminal (#2965)', async () => {
		const configDir = join(dir, '.opencode');
		mkdirSync(configDir, { recursive: true });
		const configPath = join(configDir, 'opencode-swarm.json');
		writeFileSync(
			configPath,
			JSON.stringify({ knowledge: { receipt_close_grace_days: 5 } }),
		);
		const session = ctx(dir);
		const first = await knowledge_receipt.execute(
			{
				trace_id: 'none',
				no_relevant_knowledge: true,
				task_id: 'T1',
				phase: 'P1',
			} as never,
			session,
		);
		expect(JSON.parse(first).recorded).toBe(true);
		writeFileSync(
			configPath,
			JSON.stringify({ knowledge: { receipt_close_grace_days: 9 } }),
		);
		const second = await knowledge_receipt.execute(
			{
				trace_id: 'none',
				no_relevant_knowledge: true,
				task_id: 'T1',
				phase: 'P1',
			} as never,
			session,
		);
		const rejected = JSON.parse(second);
		expect(rejected.recorded).toBe(false);
		expect(rejected.rejected).toBe(true);
		expect(rejected.reason).toBe('duplicate_conflicting_terminal');
		expect(rejected.detail).toContain('recorded grace_days 5');
		expect(rejected.detail).toContain('resolved 9');
	});
});
