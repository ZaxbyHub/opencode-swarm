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

// Added here instead of gh-evidence.test.ts (487/500 lines, FR-006 cap) to
// cover the runExternalTool 'timeout' and 'spawn-error' result statuses, which
// are distinct early-return branches in gh-evidence.ts from the gh-not-found
// path (resolveGhBinary() returning null before runExternalTool is ever
// invoked) and had no prior test coverage.

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
		mkdtempSync(path.join(os.tmpdir(), 'gh-evidence-runner-errors-test-')),
	);
});

afterEach(() => {
	ghInternals.resolveGhBinary = realResolveGhBinary;
	ghInternals.runExternalTool = realRunGh;
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('gh_evidence — runExternalTool timeout status', () => {
	test('timeout status returns a type=timeout error naming the configured timeout', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async () => ({
			status: 'timeout',
			exitCode: null,
			stdout: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		})) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'pr', number: 5 },
			tmpDir,
		);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('timeout');
		expect(parsed.message).toBe('gh pr view timed out after 20000ms');
	});
});

describe('gh_evidence — runExternalTool spawn-error status', () => {
	test('spawn-error status surfaces the runner message as type=unknown', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async () => ({
			status: 'spawn-error',
			exitCode: null,
			stdout: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
			message: 'spawn gh ENOENT',
		})) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'pr', number: 5 },
			tmpDir,
		);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('unknown');
		expect(parsed.message).toBe('spawn gh ENOENT');
	});

	test('spawn-error status without a runner message falls back to a default message', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		ghInternals.runExternalTool = mock(async () => ({
			status: 'spawn-error',
			exitCode: null,
			stdout: '',
			stderr: '',
			stdoutTruncated: false,
			stderrTruncated: false,
		})) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'pr', number: 5 },
			tmpDir,
		);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('unknown');
		expect(parsed.message).toBe('gh failed to start');
	});
});
