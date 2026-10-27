/**
 * #3346 gate/explain parity under an OBSERVED host shell — the
 * implementation-review round-1 finding-1 legs. The gate's resolver call
 * site and BOTH `/swarm guardrail explain` resolver call sites read the
 * observed-host-shell store; these legs are the only tests that drive
 * handleGuardrailExplain with a recorded shell, so deleting the
 * explain-side store read (silently reverting explain to the platform
 * interim while the gate keys on the host report) fails here:
 * - with cmd.exe recorded, the out-of-scope `copy` reads as a Windows-grammar
 *   write and explain must BLOCK (on POSIX runners this leg is the
 *   discriminating one — the platform interim alone sees no Windows grammar);
 * - with Git Bash recorded, the same command is a POSIX-executor no-write
 *   and explain must ALLOW (on win32 runners this leg is the discriminating
 *   one — the platform interim would inherit cmd grammar and block).
 * GREEN after the fix; RED when either explain call site ignores the store.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	recordObservedHostShell,
	resetObservedHostShell,
} from '../../../src/hooks/shell-executor-context';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function extractDecision(markdown: string): 'allow' | 'block' | null {
	const match = markdown.match(/\|\s*Decision\s*\|\s*(\w+)\s*\|/i);
	return match ? (match[1]!.toLowerCase() as 'allow' | 'block') : null;
}

describe('guardrail explain host-shell parity (#3346)', () => {
	const tempDir = canonicalMkdtemp('explain-host-shell-');

	beforeEach(() => {
		resetObservedHostShell();
	});

	afterEach(() => {
		resetObservedHostShell();
	});

	test('cmd.exe observed: out-of-scope copy explains as BLOCK', async () => {
		recordObservedHostShell('C:\\Windows\\system32\\cmd.exe');
		const result = await handleGuardrailExplain(tempDir, [
			'copy a.txt ..\\outside.txt',
		]);
		expect(extractDecision(result)).toBe('block');
	});

	test('Git Bash observed: the same copy explains as ALLOW (POSIX executor, no write)', async () => {
		recordObservedHostShell('C:\\Program Files\\Git\\bin\\bash.exe');
		const result = await handleGuardrailExplain(tempDir, [
			'copy a.txt ..\\outside.txt',
		]);
		expect(extractDecision(result)).toBe('allow');
	});
});
