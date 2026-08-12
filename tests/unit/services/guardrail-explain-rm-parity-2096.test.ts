import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	dcEvaluateRecursiveDeleteTargets,
	dcExtractRecursiveRmTargets,
} from '../../../src/hooks/guardrails/destructive-command';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function workspace(): string {
	const root = canonicalMkdtemp('guardrail-explain-rm-');
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('issue #2096 live/explain recursive rm parity', () => {
	test.each([
		['rm -rfv packages/foo/src', ['rm', '-rfv', 'packages/foo/src']],
		['rm -vrf packages/foo/src', ['rm', '-vrf', 'packages/foo/src']],
		[
			'rm --force --recursive packages/foo/src',
			['rm', '--force', '--recursive', 'packages/foo/src'],
		],
		[
			'rm -rf -- packages/foo/src packages/bar/dist',
			['rm', '-rf', '--', 'packages/foo/src', 'packages/bar/dist'],
		],
	] as const)('blocks %s in both live policy and explain', async (command, args) => {
		const cwd = workspace();
		const targets = dcExtractRecursiveRmTargets(command);
		expect(targets).not.toBeNull();
		expect(
			dcEvaluateRecursiveDeleteTargets({ targets: targets ?? [], cwd }).allowed,
		).toBe(false);
		const explained = await handleGuardrailExplain(cwd, [...args]);
		expect(explained).toMatch(/\| *Decision *\| *block */i);
		expect(explained).toContain('DESTRUCTIVE_TARGET_NOT_SAFE_ARTIFACT');
	});
});
