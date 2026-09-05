import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { ToolResult } from '../../../src/tools/create-tool';
import { _internals, gh_evidence } from '../../../src/tools/gh-evidence.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalResolveGh = _internals.resolveGhBinary;
const originalRunExternalTool = _internals.runExternalTool;
const originalProgramFiles = process.env.ProgramFiles;
const originalLocalAppData = process.env.LOCALAPPDATA;

let tmpDir = '';

afterEach(() => {
	_internals.resolveGhBinary = originalResolveGh;
	_internals.runExternalTool = originalRunExternalTool;
	if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
	else process.env.ProgramFiles = originalProgramFiles;
	if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = originalLocalAppData;
	if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	tmpDir = '';
});

function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

describe('gh_evidence runtime friction regressions', () => {
	test('accepts the intuitive changed_files alias but invokes gh with changedFiles', async () => {
		// v7.139.7 rejected the REST-style spelling, forcing a needless retry before
		// the PR-review workflow could even bind its metadata.
		tmpDir = canonicalMkdtemp('gh-evidence-test-');
		let args: string[] = [];
		_internals.resolveGhBinary = () => 'gh';
		_internals.runExternalTool = async (options) => {
			args = [...options.args];
			return {
				status: 'completed',
				exitCode: 0,
				stdout: '{"changedFiles":7}',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};

		const result = (await gh_evidence.execute(
			{
				target: 'pr',
				number: 2160,
				repo: 'ZaxbyHub/opencode-swarm',
				fields: 'number,changed_files',
			},
			{ directory: tmpDir } as ToolContext,
		)) as ToolResult;
		const parsed = JSON.parse(resultToString(result));
		expect(parsed.error).toBeUndefined();
		expect(parsed.fields).toEqual(['number', 'changedFiles']);
		expect(args).toContain('number,changedFiles');
	});

	test('checks standard Windows gh locations after a stale PATH lookup', () => {
		// The plugin process in the production run could not see gh on PATH while
		// PowerShell resolved C:\Program Files\GitHub CLI\gh.exe moments later.
		process.env.ProgramFiles = 'C:\\Program Files';
		process.env.LOCALAPPDATA = 'C:\\Users\\runner\\AppData\\Local';
		const candidates = _internals.resolveGhBinaryCandidates({
			platform: 'win32',
			env: {
				ProgramFiles: process.env.ProgramFiles,
				LOCALAPPDATA: process.env.LOCALAPPDATA,
			},
		});
		// #2476 AC1: the absolute ProgramFiles candidate is now FIRST and the
		// bare 'gh' name is no longer a candidate at all (the hardened
		// resolver in src/utils/gh-executable.ts owns the bare-name terminal
		// fallback, probed LAST).
		expect(candidates[0]).toBe(
			path.join('C:\\Program Files', 'GitHub CLI', 'gh.exe'),
		);
		expect(candidates).not.toContain('gh');
		expect(candidates).toContain(
			path.join('C:\\Program Files', 'GitHub CLI', 'gh.exe'),
		);
		expect(candidates).toContain(
			path.join('C:\\Users\\runner\\AppData\\Local', 'GitHub CLI', 'gh.exe'),
		);
		expect(candidates).toContain(
			path.join(
				'C:\\Users\\runner\\AppData\\Local',
				'Programs',
				'GitHub CLI',
				'gh.exe',
			),
		);
	});
});
