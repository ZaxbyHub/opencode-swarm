import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals } from '../../../src/tools/pre-check-batch';
import type { ExternalToolRunOptions } from '../../../src/utils/external-tool-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalRunExternalTool = _internals.runExternalTool;
let directory: string;
let calls: ExternalToolRunOptions[];

beforeEach(() => {
	directory = canonicalMkdtemp('pre-check-lint-arguments-');
	calls = [];
	_internals.runExternalTool = async (options) => {
		calls.push(options);
		return {
			status: 'completed',
			exitCode: 0,
			stdout: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		};
	};
});

afterEach(() => {
	_internals.runExternalTool = originalRunExternalTool;
	fs.rmSync(directory, { recursive: true, force: true });
});

test('keeps adversarial filenames as one opaque linter argument', async () => {
	const relativeFile = "odd & | % (paren) 'quote' 日本語.ts";
	const absoluteFile = path.join(directory, relativeFile);

	const result = await _internals.runLintOnFiles(
		{
			linter: 'eslint',
			executable: process.execPath,
			argsPrefix: ['eslint-entry.js'],
			displayPrefix: ['eslint'],
			source: 'safe-package-bin',
		},
		[absoluteFile],
		directory,
	);

	expect(result.success).toBe(true);
	expect(calls).toHaveLength(1);
	expect(calls[0]).toMatchObject({
		executable: process.execPath,
		cwd: directory,
		args: ['eslint-entry.js', absoluteFile],
	});
});
