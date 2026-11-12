/**
 * Explain/enforcement switch-tokenization parity for issue #3495: the
 * `/swarm guardrail-explain` dry-run must agree with the destructive gate
 * after the gate stopped matching `/s` and `-r` SUBSTRINGS inside path
 * operands. Path-operand deletes explain as ALLOW; genuine switches
 * (leading, trailing, clustered, PowerShell) explain as BLOCK.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const roots: string[] = [];

function workspace(): string {
	const root = canonicalMkdtemp('guardrail-explain-switch-');
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		removeTreeWithRetry(root);
	}
});

describe('issue #3495 explain/enforcement switch parity', () => {
	// `del` stays allow: not a write-bearing command in the explain
	// analysis, so #3616 D2 (no-scope coder write → scope_unevaluated
	// block, parity with the live gate's SCOPE_NOT_DECLARED) does not
	// fire. The rm/rmdir twins below ARE write-bearing, so their no-scope
	// explains render block with the same D2 firing rule — re-pinned from
	// the pre-D2 split-brain allow (CI round 1 of PR #3651, review r20).
	test.each([
		['del', 'a/share/b'],
	])('%s %s explains as allow (path operand, not a switch)', async (...args) => {
		const explained = await handleGuardrailExplain(workspace(), [...args]);
		expect(explained).toMatch(/\| *Decision *\| *allow */i);
	});
	test.each([
		['rmdir', 'keg/share/opencode2'],
		['rmdir', 'a/share/b'],
		['rm', 'some-r/x'],
		['rm', 'x-Recurse/y'],
	])('%s %s explains as block (#3616 D2: no-scope write → scope_unevaluated)', async (...args) => {
		const explained = await handleGuardrailExplain(workspace(), [...args]);
		expect(explained).toMatch(/\| *Decision *\| *block */i);
		expect(explained).toMatch(/scope_unevaluated/);
	});

	test.each([
		['rmdir /s x', ['rmdir', '/s', 'x']],
		['rd x /s (trailing switch)', ['rd', 'x', '/s']],
		['rmdir /s/q x (cluster)', ['rmdir', '/s/q', 'x']],
		['del /s build-dir', ['del', '/s', 'build-dir']],
		['rd zzz/s (attached switch)', ['rd', 'zzz/s']],
		['del /s"file.txt" (glued quoted operand)', ['del', '/s"file.txt"']],
		['rm -r dir', ['rm', '-r', 'dir']],
		['Remove-Item x -Recurse', ['Remove-Item', 'x', '-Recurse']],
	])('%s explains as block (genuine switch)', async (label, args) => {
		const explained = await handleGuardrailExplain(workspace(), [...args]);
		expect(explained).toMatch(/\| *Decision *\| *block */i);
	});
});
