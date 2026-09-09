import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnvironmentRunner } from './github-action-contract';
import {
	environment,
	stageTranscript,
} from './github-action-registered-fixtures';
import {
	cleanupTempRoots,
	commitAll,
	fakeBunBody,
	initRepository,
	installFakeBinary,
	installTraceOpenCode,
	makeTempRoot,
	withEnvironment,
} from './github-action-test-helpers';

afterEach(cleanupTempRoots);

describe('issue #2498 — registered immutable bindings', () => {
	test(
		'rejects a missing immutable plugin binding before agent work',
		{ timeout: 60_000 },
		async () => {
			const root = makeTempRoot();
			const repo = initRepository(root, 'missing-binding-workspace');
			fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
			const baseSha = commitAll(repo, 'base');
			fs.writeFileSync(path.join(repo, 'README.md'), 'candidate\n');
			const trace = installTraceOpenCode(root);
			installFakeBinary(root, 'fake-bun', fakeBunBody());
			const output = path.join(root, 'github-output');
			const runAction = await loadEnvironmentRunner();
			const code = await withEnvironment(
				{
					...environment(
						repo,
						trace.binDir,
						baseSha,
						output,
						trace.argsLog,
						trace.envLog,
						stageTranscript(),
						trace.binary,
						trace.script,
					),
					SWARM_ACTION_PLUGIN_REF: undefined,
					GITHUB_ACTION_REF: undefined,
				},
				runAction,
			);
			expect(code).not.toBe(0);
			expect(
				fs.existsSync(
					path.join(repo, '.swarm', 'github-action', 'artifact.json'),
				),
			).toBe(false);
		},
	);

	test(
		'rejects a loaded OpenCode version that differs from the immutable pin',
		{ timeout: 60_000 },
		async () => {
			const root = makeTempRoot();
			const repo = initRepository(root, 'version-mismatch-workspace');
			fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
			const baseSha = commitAll(repo, 'base');
			fs.writeFileSync(path.join(repo, 'README.md'), 'candidate\n');
			const trace = installTraceOpenCode(root);
			installFakeBinary(root, 'fake-bun', fakeBunBody());
			const output = path.join(root, 'github-output');
			const runAction = await loadEnvironmentRunner();
			const code = await withEnvironment(
				{
					...environment(
						repo,
						trace.binDir,
						baseSha,
						output,
						trace.argsLog,
						trace.envLog,
						stageTranscript(),
						trace.binary,
						trace.script,
					),
					FAKE_OPENCODE_VERSION: '1.18.27',
				},
				runAction,
			);
			expect(code).not.toBe(0);
			expect(
				fs.existsSync(
					path.join(repo, '.swarm', 'github-action', 'artifact.json'),
				),
			).toBe(false);
		},
	);
});
