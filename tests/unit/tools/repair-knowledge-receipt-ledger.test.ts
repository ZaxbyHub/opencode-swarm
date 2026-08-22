import { afterEach, expect, test } from 'bun:test';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { commitDisplayedMembership } from '../../../src/hooks/knowledge-receipt-ledger.js';
import { executeRepairKnowledgeReceiptLedger } from '../../../src/tools/repair-knowledge-receipt-ledger.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function project(prefix: string): string {
	const fixture = createSafeTestDir(prefix);
	cleanups.push(fixture.cleanup);
	fs.mkdirSync(path.join(fixture.dir, '.git'));
	return fixture.dir;
}

test('executeRepairKnowledgeReceiptLedger validates a readable projection from the resolved working directory', async () => {
	const directory = project('repair-knowledge-receipt-ledger-tool-');
	const committed = await commitDisplayedMembership(directory, {
		trace_id: 'trace-a',
		session_id: 'session-a',
		phase: 'phase-a',
		task_id: 'task-a',
		entries: [{ entry_id: 'entry-a', critical: true }],
	});
	if (!committed.ok) throw new Error(committed.detail);

	const result = await executeRepairKnowledgeReceiptLedger(
		{
			phase: 'phase-a',
			session_id: 'session-a',
			task_id: 'task-a',
			reason: 'tool validation path',
			working_directory: directory,
		},
		directory,
	);

	expect(result).toMatchObject({
		success: true,
		status: 'validated_projection',
		pending_re_evaluation: false,
	});
});

test('executeRepairKnowledgeReceiptLedger rejects a different invoking session', async () => {
	const directory = project('repair-knowledge-receipt-ledger-session-');
	const result = await executeRepairKnowledgeReceiptLedger(
		{
			phase: 'phase-a',
			session_id: 'session-a',
			reason: 'validate the exact repaired scope',
			working_directory: directory,
		},
		directory,
		{ sessionID: 'session-b', agent: 'architect' } as never,
	);

	expect(result).toMatchObject({
		success: false,
		errors: ['RECEIPT_REPAIR_SESSION_MISMATCH'],
	});
	expect(fs.existsSync(path.join(directory, '.swarm'))).toBe(false);
});

test('executeRepairKnowledgeReceiptLedger rejects a generic repair reason without mutating state', async () => {
	const directory = project('repair-knowledge-receipt-ledger-reason-');
	const result = await executeRepairKnowledgeReceiptLedger(
		{
			phase: 'phase-a',
			session_id: 'session-a',
			reason: 'repair',
			working_directory: directory,
		},
		directory,
	);

	expect(result).toMatchObject({ success: false, code: 'store_unavailable' });
});

test('executeRepairKnowledgeReceiptLedger rejects a non-architect runtime caller', async () => {
	const directory = project('repair-knowledge-receipt-ledger-agent-');
	const result = await executeRepairKnowledgeReceiptLedger(
		{
			phase: 'phase-a',
			session_id: 'session-a',
			reason: 'validate ledger authority safely',
		},
		directory,
		{ agent: 'reviewer' } as ToolContext,
	);

	expect(result.success).toBe(false);
	expect(result.errors).toEqual(['RECEIPT_REPAIR_ARCHITECT_ONLY']);
});
