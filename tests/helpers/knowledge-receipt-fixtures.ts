import {
	commitDisplayedMembership,
	validateAndCommitTerminalBatch,
} from '../../src/hooks/knowledge-receipt-ledger.js';

export async function seedReceiptHistory(
	directory: string,
	entryId: string,
	outcome: 'applied' | 'violated',
	count: number,
	prefix: string,
): Promise<void> {
	for (let i = 0; i < count; i++) {
		const traceId = `00000000-0000-4000-8003-${String(i).padStart(12, '0')}`;
		const displayed = await commitDisplayedMembership(directory, {
			trace_id: traceId,
			session_id: `${prefix}-session`,
			agent: 'coder',
			exposure_kind: 'delegate',
			entries: [{ entry_id: entryId, critical: false }],
		});
		if (!displayed.ok) throw new Error(displayed.detail);
		const terminal = await validateAndCommitTerminalBatch(directory, {
			trace_id: traceId,
			session_id: `${prefix}-session`,
			items: [{ entry_id: entryId, outcome, reason: 'test receipt' }],
		});
		if (!terminal.ok || terminal.rejected.length > 0) {
			throw new Error(
				terminal.ok ? terminal.rejected[0]?.reason : terminal.detail,
			);
		}
	}
}
