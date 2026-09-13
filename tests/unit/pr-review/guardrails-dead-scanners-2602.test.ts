import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('issue #2602: dead guardrail scanners are removed instead of kept as test-only exports', () => {
	const guardrailsPath = resolve(
		import.meta.dir,
		'../../../src/pr-review/guardrails.ts',
	);

	// These scanners have no production caller. Keeping their implementation
	// and public exports makes a test-only guardrail look runtime-wired. Assert
	// the module's absence directly so a missing file cannot turn this into a
	// vacuous empty-string scan; reintroducing the production module fails here.
	expect(existsSync(guardrailsPath)).toBe(false);

	// The scanners remain test-owned, where their synthetic bite tests can keep
	// the recurrence checks executable without shipping dead runtime exports.
	const helperPath = resolve(import.meta.dir, 'guardrail-scanner-helpers.ts');
	const helperSource = readFileSync(helperPath, 'utf8');
	expect(helperSource).toContain('scanObserverTerminalization');
	expect(helperSource).toContain('scanParallelCircuitRuleConstruction');
});
