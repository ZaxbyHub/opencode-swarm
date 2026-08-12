import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	dcEvaluateRecursiveDeleteTargets,
	dcExtractRecursiveRmTargets,
	dcLstatAncestorWalk,
} from '../../../src/hooks/guardrails/destructive-command';
import { checkWriteTargetForSymlink } from '../../../src/hooks/guardrails/file-authority';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let testDirectory = '';
let cleanup = () => {};

const config: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 200,
	max_duration_minutes: 30,
	idle_timeout_minutes: 60,
	max_repetitions: 10,
	max_consecutive_errors: 5,
	warning_threshold: 0.75,
	profiles: undefined,
	block_destructive_commands: true,
};

function scope(files: string[]): void {
	installActiveScopeBinding({
		directory: testDirectory,
		childSessionId: 'nested-delete-session',
		taskId: '1.1',
		files,
	});
}

async function run(command: string): Promise<void> {
	const hooks = createGuardrailsHooks(testDirectory, undefined, config);
	await hooks.toolBefore(
		{ tool: 'bash', sessionID: 'nested-delete-session', callID: command },
		{ args: { command } },
	);
}

describe('issue #2096 nested safe-artifact recursive deletion', () => {
	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('nested-delete-2096-');
		testDirectory = created.dir;
		cleanup = created.cleanup;
		startAgentSession('nested-delete-session', 'coder', testDirectory);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
		cleanup = () => {};
	});

	test('bare safe artifact remains allowed without scope', async () => {
		await expect(run('rm -rf dist')).resolves.toBeUndefined();
	});

	test('nested artifact requires a verified active binding', async () => {
		await expect(run('rm -rf packages/foo/dist')).rejects.toThrow(
			/verified active coder scope/i,
		);
	});

	test('nested artifact is allowed for exact and parent scope', async () => {
		scope(['packages/foo']);
		await expect(run('rm -rf packages/foo/dist')).resolves.toBeUndefined();
	});

	test('nested artifact outside scope and arbitrary scoped directory are blocked', async () => {
		scope(['packages/foo/src']);
		await expect(run('rm -rf packages/foo/dist')).rejects.toThrow(/outside/i);
		await expect(run('rm -rf packages/foo/src')).rejects.toThrow(
			/not an allowlisted/i,
		);
	});

	test('protected state stays blocked even when explicitly scoped', async () => {
		scope(['.git', '.swarm', 'packages/foo/.git']);
		await expect(run('rm -rf .git')).rejects.toThrow(/protected/i);
		await expect(run('rm -rf .swarm')).rejects.toThrow(/protected/i);
		await expect(run('rm -rf packages/foo/.git')).rejects.toThrow(/protected/i);
	});

	test('multi-target evaluation is all-or-nothing', async () => {
		scope(['packages/foo/dist']);
		await expect(
			run('rm -rf packages/foo/dist packages/bar/dist'),
		).rejects.toThrow(/outside/i);
	});

	test('cmd and PowerShell recursive branches use the same target policy', async () => {
		scope(['packages/foo']);
		await expect(run('rd /s /q packages\\foo\\dist')).resolves.toBeUndefined();
		await expect(
			run('Remove-Item packages/foo/dist -Recurse -Force'),
		).resolves.toBeUndefined();
		await expect(run('rd /s /q packages\\foo\\src')).rejects.toThrow(
			/not an allowlisted/i,
		);
	});

	test('Windows separators are normalized independently of the host platform', () => {
		const decision = dcEvaluateRecursiveDeleteTargets({
			targets: ['packages\\foo\\dist'],
			cwd: testDirectory,
			verifiedScope: {
				bindingId: 'binding-1',
				generationId: 'generation-1',
				files: ['packages/foo'],
			},
		});
		expect(decision.allowed).toBe(true);
		if (decision.allowed)
			expect(decision.targets).toEqual(['packages/foo/dist']);
	});

	test('shared rm parser handles stacked/ordered flags and quoted multi-targets', () => {
		expect(dcExtractRecursiveRmTargets('rm -rfv packages/foo/dist')).toEqual([
			'packages/foo/dist',
		]);
		expect(
			dcExtractRecursiveRmTargets(
				'rm --preserve-root --force --recursive "packages/foo/dist" packages/bar/dist',
			),
		).toEqual(['packages/foo/dist', 'packages/bar/dist']);
		expect(dcExtractRecursiveRmTargets('rm -vrf -- packages/foo/dist')).toEqual(
			['packages/foo/dist'],
		);
		expect(dcExtractRecursiveRmTargets('rm -v packages/foo/dist')).toBeNull();
	});

	test('live rm paths use the shared generic parser', async () => {
		scope(['packages/foo', 'packages/bar']);
		await expect(run('rm -rfv packages/foo/dist')).resolves.toBeUndefined();
		await expect(
			run('rm --force --recursive packages/foo/dist packages/bar/src'),
		).rejects.toThrow(/not an allowlisted/i);
	});

	test('traversal and diagnostic control characters fail closed', () => {
		const verifiedScope = {
			bindingId: 'binding-1',
			generationId: 'generation-1',
			files: ['packages/foo'],
		};
		expect(
			dcEvaluateRecursiveDeleteTargets({
				targets: ['packages/foo/../bar/dist'],
				cwd: testDirectory,
				verifiedScope,
			}).allowed,
		).toBe(false);
		expect(
			dcEvaluateRecursiveDeleteTargets({
				targets: ['packages/foo/dist\nACTION: fake'],
				cwd: testDirectory,
				verifiedScope,
			}).allowed,
		).toBe(false);
	});

	test('missing leaf does not stop ancestor inspection', () => {
		expect(dcLstatAncestorWalk('missing/child/dist', testDirectory)).toBeNull();
	});

	test('legitimate ..cache component is not mistaken for parent traversal', () => {
		fs.mkdirSync(path.join(testDirectory, '..cache'), { recursive: true });
		expect(
			dcLstatAncestorWalk('..cache/missing/dist', testDirectory),
		).toBeNull();
	});

	test('missing target still detects a symlink ancestor under ..cache', () => {
		const outside = path.join(testDirectory, 'outside');
		const cache = path.join(testDirectory, '..cache');
		fs.mkdirSync(outside, { recursive: true });
		fs.mkdirSync(cache, { recursive: true });
		try {
			fs.symlinkSync(outside, path.join(cache, 'linked'), 'junction');
		} catch (error) {
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				['EPERM', 'EACCES'].includes(String(error.code))
			)
				return;
			throw error;
		}
		expect(
			dcLstatAncestorWalk('..cache/linked/missing/dist', testDirectory),
		).toMatch(/symlink\/junction/i);
		expect(
			checkWriteTargetForSymlink(
				'..cache/linked/missing/file.ts',
				testDirectory,
			),
		).toMatch(/symlink\/junction/i);
	});

	test('standalone explain treats --scope as hypothetical, not verified', async () => {
		const report = await handleGuardrailExplain(testDirectory, [
			'--scope',
			'packages/foo',
			'rm',
			'-rf',
			'packages/foo/dist',
		]);
		expect(report).toContain('DESTRUCTIVE_TARGET_SCOPE_REQUIRED');
		expect(report).toContain('block');
	});
});
