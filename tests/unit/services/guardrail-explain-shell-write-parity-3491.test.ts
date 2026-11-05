/**
 * Explain/enforcement parity for the #3491 W1/W2/W4 shell-write grammar
 * changes: `/swarm guardrail explain` must agree with the live gate now that
 * (a) cd word forms resolve-or-withdraw through the sole DirectoryState
 * model, (b) chdir-bearing env/sudo wrapper segments rewrite as quoted
 * subshells (child-scoped cwd, destructive targets relocated from the child
 * cwd), and (c) the sh -c payload extractor follows sh's argv[2] contract.
 * Explain shares dcPreprocessWrappers/dcExpandDestructiveSegments with the
 * gate, so these rows pin that sharing against drift.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const roots: string[] = [];

function workspace(): string {
	const root = canonicalMkdtemp('guardrail-explain-3491-');
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		removeTreeWithRetry(root);
	}
});

describe('issue #3491 explain/enforcement shell-write parity', () => {
	test.each([
		['env -C .. sh -c "mkdir -p src && echo x > src/a"'],
		['env -S \'-C .. sh -c "echo x > src/a"\''],
		['sudo -D .. sh -c "echo x > src/a"'],
		['env -C .. rm -rf dist'],
		['sudo -D .. rm -rf dist'],
		["env -C .. sh -c 'cd src; rm -rf dist'"],
	])('%s explains as block (child cwd escapes the scope)', async (command) => {
		const explained = await handleGuardrailExplain(workspace(), [
			'--scope',
			'src/',
			...command.split(' '),
		]);
		expect(explained).toMatch(/\| *Decision *\| *block */i);
	});

	// Review round 1 (F-3): explain must mirror the gate's
	// withdrawal/dynamic-target deny — a null-path write is a BLOCK, not a
	// category. These legs answered allow before the mirror while the gate
	// denied every one of them (the resolvedWrites loop treated them as a
	// write category only).
	test.each([
		['cd -; echo x > f'],
		["env -C '$D' sh -c 'echo x > src/f'"],
		['popd; echo x > src/f'],
	])('%s explains as block (withdrawn/dynamic write target)', async (command) => {
		const explained = await handleGuardrailExplain(workspace(), [
			'--scope',
			'src/',
			...command.split(' '),
		]);
		expect(explained).toMatch(/\| *Decision *\| *block */i);
	});

	test.each([
		['sh -c "mkdir -p src && echo x > src/a"'],
		['env -C .. true'],
	])('%s explains as allow (no escaping write)', async (command) => {
		const explained = await handleGuardrailExplain(workspace(), [
			'--scope',
			'src/',
			...command.split(' '),
		]);
		expect(explained).toMatch(/\| *Decision *\| *allow */i);
	});
});
