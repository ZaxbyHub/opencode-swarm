import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	actionlint_scan,
	_internals as actionlintInternals,
} from './actionlint-scan';
import type { ToolResult } from './create-tool';
import { gh_evidence, _internals as ghInternals } from './gh-evidence';
import { osv_scan, _internals as osvInternals } from './osv-scan';

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
const realResolveActionlintBinary = actionlintInternals.resolveActionlintBinary;
const realRunActionlint = actionlintInternals.runExternalTool;
const realDiscoverWorkflowFiles = actionlintInternals.discoverWorkflowFiles;
const realResolveOsvScannerBinary = osvInternals.resolveOsvScannerBinary;
const realRunOsv = osvInternals.runExternalTool;
const realResolveGhBinary = ghInternals.resolveGhBinary;
const realRunGh = ghInternals.runExternalTool;

beforeEach(() => {
	tmpDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'external-cli-test-')),
	);
});

afterEach(() => {
	actionlintInternals.resolveActionlintBinary = realResolveActionlintBinary;
	actionlintInternals.runExternalTool = realRunActionlint;
	actionlintInternals.discoverWorkflowFiles = realDiscoverWorkflowFiles;
	osvInternals.resolveOsvScannerBinary = realResolveOsvScannerBinary;
	osvInternals.runExternalTool = realRunOsv;
	ghInternals.resolveGhBinary = realResolveGhBinary;
	ghInternals.runExternalTool = realRunGh;
	rmSync(tmpDir, { recursive: true, force: true });
});

function createTestFile(relativePath: string, content: string): void {
	const fullPath = path.join(tmpDir, relativePath);
	mkdirSync(path.dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
}

describe('actionlint_scan', () => {
	test('returns missing-binary guidance without probing during init', async () => {
		createTestFile('.github/workflows/ci.yml', 'name: ci\n');
		actionlintInternals.resolveActionlintBinary = () => null;

		const parsed = await executeTool(actionlint_scan, {}, tmpDir);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('actionlint-not-found');
		expect(String(parsed.message)).toContain('Install actionlint');
	});

	test('uses bounded runner argv and parses JSON findings', async () => {
		createTestFile('.github/workflows/ci.yml', 'name: ci\n');
		const executable = path.join(
			tmpDir,
			process.platform === 'win32' ? 'actionlint.exe' : 'actionlint',
		);
		let captured: Parameters<typeof realRunActionlint>[0] | undefined;
		actionlintInternals.resolveActionlintBinary = () => executable;
		actionlintInternals.runExternalTool = mock(async (options) => {
			captured = options;
			return {
				status: 'completed',
				exitCode: 1,
				stdout: `${JSON.stringify({
					filepath: path.join(tmpDir, '.github', 'workflows', 'ci.yml'),
					line: 3,
					column: 5,
					end_column: 12,
					kind: 'syntax-check',
					message: 'bad workflow',
				})}\n`,
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunActionlint;

		const parsed = await executeTool(
			actionlint_scan,
			{ max_results: 10 },
			tmpDir,
		);

		expect(captured?.cwd).toBe(tmpDir);
		expect(captured?.timeoutMs).toBe(15000);
		expect(captured?.args).toEqual([
			'-format',
			'{{json .}}',
			'./.github/workflows/ci.yml',
		]);
		expect(parsed.clean).toBe(false);
		expect(parsed.total).toBe(1);
		expect(parsed.findings).toEqual([
			{
				file: '.github/workflows/ci.yml',
				line: 3,
				column: 5,
				endColumn: 12,
				kind: 'syntax-check',
				message: 'bad workflow',
			},
		]);
	});

	test('rejects unsafe requested workflow paths', async () => {
		const parsed = await executeTool(
			actionlint_scan,
			{ files: ['../ci.yml'] },
			tmpDir,
		);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');
	});

	test('does not report clean when workflow discovery is truncated', async () => {
		actionlintInternals.discoverWorkflowFiles = () => ({
			files: [],
			truncated: true,
		});

		const parsed = await executeTool(actionlint_scan, {}, tmpDir);

		expect(parsed.clean).toBe(false);
		expect(parsed.truncated).toBe(true);
		expect(String(parsed.note)).toContain('result is incomplete');
	});
});

describe('osv_scan', () => {
	test('uses bounded runner argv and parses OSV vulnerabilities', async () => {
		const executable = path.join(
			tmpDir,
			process.platform === 'win32' ? 'osv-scanner.exe' : 'osv-scanner',
		);
		let captured: Parameters<typeof realRunOsv>[0] | undefined;
		osvInternals.resolveOsvScannerBinary = () => executable;
		osvInternals.runExternalTool = mock(async (options) => {
			captured = options;
			return {
				status: 'completed',
				exitCode: 1,
				stdout: JSON.stringify({
					results: [
						{
							packages: [
								{
									package: {
										name: 'left-pad',
										ecosystem: 'npm',
										version: '1.0.0',
									},
									vulnerabilities: [
										{
											id: 'GHSA-test',
											summary: 'test vuln',
											aliases: ['CVE-2026-0001'],
											references: [{ url: 'https://example.com/vuln' }],
											groups: [{ fixed: ['1.0.1'] }],
										},
									],
								},
							],
						},
					],
				}),
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunOsv;

		const parsed = await executeTool(osv_scan, {}, tmpDir);

		expect(captured?.cwd).toBe(tmpDir);
		expect(captured?.timeoutMs).toBe(60000);
		expect(captured?.args).toEqual(['scan', '--format', 'json', '.']);
		expect(parsed.clean).toBe(false);
		expect(parsed.total).toBe(1);
		expect(parsed.findings).toEqual([
			{
				id: 'GHSA-test',
				summary: 'test vuln',
				packageName: 'left-pad',
				ecosystem: 'npm',
				installedVersion: '1.0.0',
				fixedVersion: '1.0.1',
				aliases: ['CVE-2026-0001'],
				references: ['https://example.com/vuln'],
			},
		]);
	});

	test('rejects unsafe scan paths and reports missing binary', async () => {
		let parsed = await executeTool(
			osv_scan,
			{ scan_path: '../outside' },
			tmpDir,
		);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('path-escape');

		osvInternals.resolveOsvScannerBinary = () => null;
		parsed = await executeTool(osv_scan, {}, tmpDir);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('osv-scanner-not-found');
	});

	test('does not report clean on malformed or truncated OSV JSON', async () => {
		osvInternals.resolveOsvScannerBinary = () => 'osv-scanner';
		osvInternals.runExternalTool = mock(async () => ({
			status: 'completed',
			exitCode: 0,
			stdout: '{not json',
			stderr: '',
			stdoutTruncated: true,
			stderrTruncated: false,
		})) as typeof realRunOsv;

		const parsed = await executeTool(osv_scan, {}, tmpDir);

		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('unknown');
		expect(String(parsed.message)).toContain('truncated');
	});
});

describe('gh_evidence', () => {
	test('uses bounded runner argv and parses PR evidence', async () => {
		const executable = path.join(
			tmpDir,
			process.platform === 'win32' ? 'gh.exe' : 'gh',
		);
		let captured: Parameters<typeof realRunGh>[0] | undefined;
		ghInternals.resolveGhBinary = () => executable;
		ghInternals.runExternalTool = mock(async (options) => {
			captured = options;
			return {
				status: 'completed',
				exitCode: 0,
				stdout: JSON.stringify({
					number: 42,
					title: 'Add tool',
					body: 'x'.repeat(25_000),
				}),
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ number: 42, repo: 'owner/repo', fields: 'number,title,body' },
			tmpDir,
		);

		expect(captured?.cwd).toBe(tmpDir);
		expect(captured?.timeoutMs).toBe(20000);
		expect(captured?.args).toEqual([
			'pr',
			'view',
			'42',
			'--json',
			'number,title,body',
			'--repo',
			'owner/repo',
		]);
		expect(parsed.target).toBe('pr');
		expect((parsed.data as { body: string }).body).toEndWith('... [truncated]');
	});

	test('rejects invalid gh inputs and reports missing binary', async () => {
		let parsed = await executeTool(gh_evidence, { number: 0 }, tmpDir);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-input');

		parsed = await executeTool(
			gh_evidence,
			{ number: 1, repo: 'bad repo' },
			tmpDir,
		);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('invalid-input');

		ghInternals.resolveGhBinary = () => null;
		parsed = await executeTool(gh_evidence, { number: 1 }, tmpDir);
		expect(parsed.error).toBe(true);
		expect(parsed.type).toBe('gh-not-found');
	});
});
