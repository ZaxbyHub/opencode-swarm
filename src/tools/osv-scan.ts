import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	resolveExecutableFromPath,
	runExternalTool,
} from '../utils/external-tool-runner';
import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';
import { createSwarmTool } from './create-tool';

const OSV_TIMEOUT_MS = 60_000;
const OSV_MAX_STDOUT_BYTES = 12 * 1024 * 1024;
const OSV_MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_MAX_RESULTS = 200;
const HARD_CAP_RESULTS = 2_000;

interface OsvFinding {
	id: string;
	summary?: string;
	packageName?: string;
	ecosystem?: string;
	installedVersion?: string;
	fixedVersion?: string;
	aliases?: string[];
	references?: string[];
}

interface OsvResult {
	clean: boolean;
	findings: OsvFinding[];
	total: number;
	truncated: boolean;
	command: string[];
	scanPath: string;
	outputTruncated?: boolean;
	note?: string;
}

interface OsvError {
	error: true;
	type:
		| 'osv-scanner-not-found'
		| 'invalid-input'
		| 'path-escape'
		| 'timeout'
		| 'unknown';
	message: string;
}

interface ParsedOsvOutput {
	findings: OsvFinding[];
	total: number;
	parseError: boolean;
}

function resolveOsvScannerBinary(): string | null {
	return _internals.resolveExecutableFromPath(['osv-scanner']);
}

function normalizeScanPath(value: unknown, workspace: string): string | null {
	const raw = typeof value === 'string' && value.trim() ? value.trim() : '.';
	if (containsControlChars(raw) || containsPathTraversal(raw)) return null;
	if (path.isAbsolute(raw) || /^[A-Za-z]:[/\\]/.test(raw)) return null;
	try {
		const realWorkspace = fs.realpathSync(workspace);
		const resolved = path.resolve(realWorkspace, raw);
		const realTarget = fs.realpathSync(resolved);
		const relative = path.relative(realWorkspace, realTarget);
		if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
		return relative ? relative.split(path.sep).join('/') : '.';
	} catch {
		return null;
	}
}

function firstString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

function collectReferences(
	vuln: Record<string, unknown>,
): string[] | undefined {
	const refs = Array.isArray(vuln.references) ? vuln.references : [];
	const urls = refs
		.map((ref) =>
			ref && typeof ref === 'object'
				? firstString((ref as Record<string, unknown>).url)
				: undefined,
		)
		.filter((url): url is string => Boolean(url));
	return urls.length > 0 ? urls.slice(0, 10) : undefined;
}

function parseOsvOutput(stdout: string, maxResults: number): ParsedOsvOutput {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { findings: [], total: 0, parseError: true };
	}

	const findings: OsvFinding[] = [];
	let total = 0;
	const results = Array.isArray((parsed as Record<string, unknown>)?.results)
		? ((parsed as Record<string, unknown>).results as unknown[])
		: [];

	for (const result of results) {
		const resultObj = result as Record<string, unknown>;
		const packages = Array.isArray(resultObj.packages)
			? (resultObj.packages as unknown[])
			: [];
		for (const pkg of packages) {
			const pkgObj = pkg as Record<string, unknown>;
			const pkgInfo = (pkgObj.package ?? {}) as Record<string, unknown>;
			const vulnerabilities = Array.isArray(pkgObj.vulnerabilities)
				? (pkgObj.vulnerabilities as unknown[])
				: [];
			for (const vulnerability of vulnerabilities) {
				const vuln = vulnerability as Record<string, unknown>;
				total++;
				if (findings.length >= maxResults) continue;
				const groups = Array.isArray(vuln.groups) ? vuln.groups : [];
				const fixedVersion = groups
					.flatMap((group) =>
						Array.isArray((group as Record<string, unknown>).fixed)
							? ((group as Record<string, unknown>).fixed as unknown[])
							: [],
					)
					.map(firstString)
					.find(Boolean);
				findings.push({
					id: firstString(vuln.id) ?? firstString(vuln.osv) ?? 'UNKNOWN',
					summary: firstString(vuln.summary),
					packageName:
						firstString(pkgInfo.name) ??
						firstString(pkgObj.name) ??
						firstString(pkgObj.package),
					ecosystem: firstString(pkgInfo.ecosystem),
					installedVersion:
						firstString(pkgInfo.version) ?? firstString(pkgObj.version),
					fixedVersion,
					aliases: Array.isArray(vuln.aliases)
						? vuln.aliases.filter((a): a is string => typeof a === 'string')
						: undefined,
					references: collectReferences(vuln),
				});
			}
		}
	}

	return { findings, total, parseError: false };
}

function sanitizeMaxResults(value: unknown): number {
	const numeric =
		typeof value === 'number' && Number.isFinite(value)
			? value
			: DEFAULT_MAX_RESULTS;
	return Math.min(Math.max(0, numeric), HARD_CAP_RESULTS);
}

export const osv_scan: ToolDefinition = createSwarmTool({
	description:
		'Run OSV-Scanner against a workspace path and return structured dependency vulnerability findings. Read-only; resolves osv-scanner lazily.',
	args: {
		scan_path: z
			.string()
			.default('.')
			.describe('Workspace-relative path to scan, default "."'),
		max_results: z
			.number()
			.default(DEFAULT_MAX_RESULTS)
			.describe('Maximum vulnerabilities to return'),
	},
	execute: async (args: unknown, directory: string) => {
		const obj = (
			typeof args === 'object' && args !== null ? args : {}
		) as Record<string, unknown>;
		const scanPath = normalizeScanPath(obj.scan_path, directory);
		if (!scanPath) {
			return JSON.stringify(
				{
					error: true,
					type: 'path-escape',
					message: 'scan_path must be an existing workspace-relative path',
				} satisfies OsvError,
				null,
				2,
			);
		}
		const maxResults = sanitizeMaxResults(obj.max_results);
		const executable = _internals.resolveOsvScannerBinary();
		if (!executable) {
			return JSON.stringify(
				{
					error: true,
					type: 'osv-scanner-not-found',
					message:
						'osv-scanner executable not found. Install OSV-Scanner and ensure osv-scanner is on PATH.',
				} satisfies OsvError,
				null,
				2,
			);
		}

		const target = scanPath === '.' ? '.' : `./${scanPath}`;
		const osvArgs = ['scan', '--format', 'json', target];
		const run = await _internals.runExternalTool({
			executable,
			args: osvArgs,
			cwd: directory,
			timeoutMs: OSV_TIMEOUT_MS,
			maxStdoutBytes: OSV_MAX_STDOUT_BYTES,
			maxStderrBytes: OSV_MAX_STDERR_BYTES,
		});

		if (run.status === 'timeout') {
			return JSON.stringify(
				{
					error: true,
					type: 'timeout',
					message: `osv-scanner timed out after ${OSV_TIMEOUT_MS}ms`,
				} satisfies OsvError,
				null,
				2,
			);
		}
		if (run.status === 'spawn-error') {
			return JSON.stringify(
				{
					error: true,
					type: 'unknown',
					message: run.message ?? 'osv-scanner failed to start',
				} satisfies OsvError,
				null,
				2,
			);
		}

		const { findings, total, parseError } = parseOsvOutput(
			run.stdout,
			maxResults,
		);
		if (parseError) {
			return JSON.stringify(
				{
					error: true,
					type: 'unknown',
					message:
						run.stdoutTruncated || run.stderrTruncated
							? 'osv-scanner JSON output was truncated and could not be parsed'
							: 'osv-scanner output was not valid JSON',
				} satisfies OsvError,
				null,
				2,
			);
		}
		if (run.exitCode !== 0 && findings.length === 0 && run.stderr) {
			return JSON.stringify(
				{
					error: true,
					type: 'unknown',
					message: run.stderr.split('\n')[0],
				} satisfies OsvError,
				null,
				2,
			);
		}

		return JSON.stringify(
			{
				clean: total === 0 && !run.stdoutTruncated && !run.stderrTruncated,
				findings,
				total,
				truncated:
					total > maxResults || run.stdoutTruncated || run.stderrTruncated,
				command: ['osv-scanner', ...osvArgs],
				scanPath,
				outputTruncated: run.stdoutTruncated || run.stderrTruncated,
				note:
					run.exitCode !== 0 && total > 0
						? `osv-scanner exited ${run.exitCode} after finding vulnerabilities`
						: run.stdoutTruncated || run.stderrTruncated
							? 'osv-scanner output was truncated; result is incomplete.'
							: undefined,
			} satisfies OsvResult,
			null,
			2,
		);
	},
});

export const _internals: {
	resolveExecutableFromPath: typeof resolveExecutableFromPath;
	resolveOsvScannerBinary: typeof resolveOsvScannerBinary;
	runExternalTool: typeof runExternalTool;
	parseOsvOutput: typeof parseOsvOutput;
} = {
	resolveExecutableFromPath,
	resolveOsvScannerBinary,
	runExternalTool,
	parseOsvOutput,
};
