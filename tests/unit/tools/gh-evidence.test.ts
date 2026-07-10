import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { ToolResult } from '../../../src/tools/create-tool';
import {
	gh_evidence,
	_internals as ghInternals,
} from '../../../src/tools/gh-evidence';

function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

async function executeTool(
	tool: { execute: (args: unknown, ctx: ToolContext) => Promise<unknown> },
	args: Record<string, unknown>,
	directory: string,
): Promise<Record<string, unknown>> {
	const result = await tool.execute(args, {
		directory,
	} as unknown as ToolContext);
	return JSON.parse(resultToString(result as ToolResult));
}

let tmpDir: string;
const realResolveGhBinary = ghInternals.resolveGhBinary;
const realRunGh = ghInternals.runExternalTool;

beforeEach(() => {
	tmpDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'gh-evidence-test-')),
	);
});

afterEach(() => {
	ghInternals.resolveGhBinary = realResolveGhBinary;
	ghInternals.runExternalTool = realRunGh;
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('gh_evidence — target=run', () => {
	test('run target with JSON fields builds correct gh args', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async (options) => {
			// Verify gh args are constructed correctly for run target with repo
			expect(options.args[0]).toBe('run');
			expect(options.args[1]).toBe('view');
			expect(options.args[2]).toBe('123');
			expect(options.args[3]).toBe('--json');
			// Verify --repo is included when repo is provided
			const repoIndex = options.args.indexOf('--repo');
			expect(repoIndex).toBeGreaterThan(-1);
			expect(options.args[repoIndex + 1]).toBe('owner/repo');
			return {
				status: 'completed',
				exitCode: 0,
				stdout: JSON.stringify({
					status: 'completed',
					conclusion: 'success',
					htmlUrl: 'https://github.com/owner/repo/actions/runs/123',
					headBranch: 'feat-merge-group',
					headSha: 'abc123',
				}),
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'run', number: 123, repo: 'owner/repo' },
			tmpDir,
		);

		expect(parsed.target).toBe('run');
		expect(parsed.number).toBe(123);
		expect(parsed.runStatus).toBe('completed');
		expect(parsed.runConclusion).toBe('success');
		expect(parsed.runHtmlUrl).toBe(
			'https://github.com/owner/repo/actions/runs/123',
		);
		expect(parsed.runHeadBranch).toBe('feat-merge-group');
		expect(parsed.runHeadSha).toBe('abc123');
		expect(parsed.data).toBeTruthy();
	});

	test('run target with log_failed=true uses --log-failed flag', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async (options) => {
			expect(options.args).toEqual(['run', 'view', '456', '--log-failed']);
			return {
				status: 'completed',
				exitCode: 0,
				stdout: 'Job failed: test error',
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'run', number: 456, log_failed: true },
			tmpDir,
		);

		expect(parsed.target).toBe('run');
		expect(parsed.fields).toEqual([]);
		expect(parsed.data).toBe('Job failed: test error');
		// run metadata should be absent when log_failed is used (raw text mode)
		expect(parsed.runStatus).toBeUndefined();
	});

	test('run target with custom fields validates against run allowlist', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async () => ({
			status: 'completed',
			exitCode: 0,
			stdout: JSON.stringify({ status: 'queued' }),
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		})) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{
				target: 'run',
				number: 789,
				fields: 'status,workflowId,name',
			},
			tmpDir,
		);

		expect(parsed.target).toBe('run');
		expect(parsed.error).toBeUndefined();
	});

	test('run target rejects invalid fields with error response', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async () => ({
			status: 'completed',
			exitCode: 0,
			stdout: '{}',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		})) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'run', number: 123, fields: 'invalidField' },
			tmpDir,
		);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-input');
	});

	test('run target with repo flag includes --repo in args', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async (options) => {
			expect(options.args).toContain('--repo');
			expect(options.args).toContain('owner/repo');
			return {
				status: 'completed',
				exitCode: 0,
				stdout: JSON.stringify({
					status: 'in_progress',
					conclusion: null,
				}),
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'run', number: 123, repo: 'owner/repo' },
			tmpDir,
		);

		expect(parsed.error).toBeUndefined();
	});

	test('run target extracts null conclusion correctly', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async () => ({
			status: 'completed',
			exitCode: 0,
			stdout: JSON.stringify({
				status: 'completed',
				conclusion: null,
			}),
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		})) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'run', number: 123 },
			tmpDir,
		);

		expect(parsed.runConclusion).toBeNull();
	});

	test('run target with array JSON response sets error=true', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async () => ({
			status: 'completed',
			exitCode: 0,
			stdout: JSON.stringify([{ status: 'completed' }]),
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		})) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'run', number: 123 },
			tmpDir,
		);

		expect(parsed.error).toBe(true);
		expect(parsed.runStatus).toBeUndefined();
		expect(parsed.runConclusion).toBeUndefined();
		expect(parsed.runHtmlUrl).toBeUndefined();
	});

	test('run target with empty array JSON response sets error=true', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async () => ({
			status: 'completed',
			exitCode: 0,
			stdout: JSON.stringify([]),
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		})) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'run', number: 123 },
			tmpDir,
		);

		expect(parsed.error).toBe(true);
		expect(parsed.runStatus).toBeUndefined();
	});

	test('run target with primitive JSON response sets error=true', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async () => ({
			status: 'completed',
			exitCode: 0,
			stdout: JSON.stringify('not an object'),
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		})) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'run', number: 123 },
			tmpDir,
		);

		expect(parsed.error).toBe(true);
		expect(parsed.runStatus).toBeUndefined();
	});
});

describe('gh_evidence — existing targets still work', () => {
	test('pr target still works with default fields', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async (options) => {
			expect(options.args[0]).toBe('pr');
			expect(options.args).toContain('--json');
			return {
				status: 'completed',
				exitCode: 0,
				stdout: JSON.stringify({
					number: 42,
					title: 'Test PR',
					state: 'OPEN',
				}),
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunGh;

		const parsed = await executeTool(gh_evidence, { number: 42 }, tmpDir);

		expect(parsed.target).toBe('pr');
		expect(parsed.number).toBe(42);
	});

	test('issue target still works', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async (options) => {
			expect(options.args[0]).toBe('issue');
			return {
				status: 'completed',
				exitCode: 0,
				stdout: JSON.stringify({
					number: 99,
					title: 'Bug report',
					state: 'OPEN',
				}),
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'issue', number: 99 },
			tmpDir,
		);

		expect(parsed.target).toBe('issue');
		expect(parsed.number).toBe(99);
	});
});
