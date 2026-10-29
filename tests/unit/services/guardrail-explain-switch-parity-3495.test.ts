/**
 * Explain/enforcement switch-tokenization parity for issue #3495: the
 * `/swarm guardrail-explain` dry-run must agree with the destructive gate
 * after the gate stopped matching `/s` and `-r` SUBSTRINGS inside path
 * operands. Path-operand deletes explain as ALLOW; genuine switches
 * (leading, trailing, clustered, PowerShell) explain as BLOCK.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function workspace(): string {
	const root = canonicalMkdtemp('guardrail-explain-switch-');
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('issue #3495 explain/enforcement switch parity', () => {
	test.each([
		['rmdir', 'keg/share/opencode2'],
		['rmdir', 'a/share/b'],
		['del', 'a/share/b'],
		['rm', 'some-r/x'],
		['rm', 'x-Recurse/y'],
	])('%s %s explains as allow (path operand, not a switch)', async (...args) => {
		const explained = await handleGuardrailExplain(workspace(), [...args]);
		expect(explained).toMatch(/\| *Decision *\| *allow */i);
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
