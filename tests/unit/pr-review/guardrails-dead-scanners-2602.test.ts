import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('issue #2602: dead guardrail scanners are removed instead of kept as test-only exports', () => {
	const guardrailsPath = resolve(
		import.meta.dir,
		'../../../src/pr-review/guardrails.ts',
	);
	const source = existsSync(guardrailsPath)
		? readFileSync(guardrailsPath, 'utf8')
		: '';

	// These scanners have no production caller. Keeping their implementation
	// and public exports makes a test-only guardrail look runtime-wired.
	expect(source).not.toContain('scanObserverTerminalization');
	expect(source).not.toContain('scanParallelCircuitRuleConstruction');
});
