import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { isCommandAvailable } from '../build/discovery';
import { warn } from '../utils';
import {
	type ExternalToolRunOptions,
	type ExternalToolRunResult,
	resolveExecutableFromPath,
	runExternalTool,
} from '../utils/external-tool-runner';
import { createSwarmTool } from './create-tool';

// ============ Constants ============
export const MAX_OUTPUT_BYTES = 512_000; // 512KB max output
export const MAX_COMMAND_LENGTH = 500;
export const SUPPORTED_LINTERS = ['biome', 'eslint'] as const;
export type SupportedLinter = (typeof SUPPORTED_LINTERS)[number];

const LINTER_DETECT_TIMEOUT_MS = 2_000;
const LINTER_RUN_TIMEOUT_MS = 30_000;
const OUTPUT_TRUNCATION_SUFFIX = '\n... (output truncated)';
const NODE_MODULES = 'node_modules';
const BIN_DIRECTORY = '.bin';
const MAX_PACKAGE_MANIFEST_BYTES = 256 * 1024;
const MAX_PATH_SHIM_BYTES = 64 * 1024;
const UNSAFE_SHELL_WRAPPER_EXTENSIONS = new Set(['.bat', '.cmd', '.ps1']);
const WINDOWS_BATCH_WRAPPER_EXTENSIONS = ['.cmd', '.bat'] as const;
// Node quotes array-form cmd.exe tokens, keeping spaces and parentheses opaque.
// Reject shell separators, quoting, expansion markers, and line breaks instead
// of attempting to escape them into an executable command string.
const WINDOWS_CMD_UNSAFE_TOKEN = /["%!^&|<>\r\n]/;

const LINTER_PACKAGES: Record<SupportedLinter, string> = {
	biome: '@biomejs/biome',
	eslint: 'eslint',
};

type ResolvedLinterSource =
	| 'local-native'
	| 'local-shim'
	| 'safe-package-bin'
	| 'path-native'
	| 'path-shim'
	| 'legacy-test-probe';

export interface ResolvedLinterCommand {
	linter: SupportedLinter;
	executable: string;
	argsPrefix: string[];
	displayPrefix: string[];
	source: ResolvedLinterSource;
}

// Additional linter types (non-JS/TS)
export type AdditionalLinter =
	| 'ruff'
	| 'clippy'
	| 'golangci-lint'
	| 'checkstyle'
	| 'ktlint'
	| 'dotnet-format'
	| 'cppcheck'
	| 'swiftlint'
	| 'dart-analyze'
	| 'rubocop'
	| 'phpstan'
	| 'pint'
	| 'php-cs-fixer'
	| 'phpcs';

// ============ Response Types ============
export interface LintSuccessResult {
	success: true;
	mode: 'fix' | 'check';
	linter: SupportedLinter | AdditionalLinter;
	command: string[];
	exitCode: number;
	output: string;
	message?: string;
}

export interface LintErrorResult {
	success: false;
	mode: 'fix' | 'check';
	linter?: SupportedLinter | AdditionalLinter;
	command?: string[];
	exitCode?: number;
	output?: string;
	error: string;
	message?: string;
}

export type LintResult = LintSuccessResult | LintErrorResult;

// ============ Validation ============
export {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';

export function validateArgs(args: unknown): args is { mode: 'fix' | 'check' } {
	if (typeof args !== 'object' || args === null) return false;
	const obj = args as Record<string, unknown>;
	if (obj.mode !== 'fix' && obj.mode !== 'check') return false;
	return true;
}

function normalizeCaseForPlatform(
	value: string,
	platform: NodeJS.Platform,
): string {
	return platform === 'win32' ? value.toLowerCase() : value;
}

function normalizeRelativePathForPlatform(
	value: string,
	platform: NodeJS.Platform,
): string {
	return normalizeCaseForPlatform(
		value.replaceAll('\\', '/').replace(/\/+/g, '/'),
		platform,
	);
}

function isRegularFile(candidate: string): boolean {
	try {
		return _internals.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function readTextFileBounded(
	filePath: string,
	maxBytes: number,
): string | null {
	let fd: number | undefined;
	try {
		fd = _internals.openSync(filePath, 'r');
		const stats = _internals.fstatSync(fd);
		if (
			!stats.isFile() ||
			!Number.isSafeInteger(stats.size) ||
			stats.size < 0 ||
			stats.size > maxBytes
		) {
			return null;
		}

		const bytes = Buffer.alloc(stats.size);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const bytesRead = _internals.readSync(
				fd,
				bytes,
				offset,
				bytes.byteLength - offset,
				null,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}

		// Re-check through the same descriptor so growth after fstat cannot make a
		// bounded metadata read silently accept a larger file.
		const overflowProbe = Buffer.alloc(1);
		if (_internals.readSync(fd, overflowProbe, 0, 1, null) > 0) return null;
		return bytes.subarray(0, offset).toString('utf8');
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				_internals.closeSync(fd);
			} catch {
				// best effort
			}
		}
	}
}

function toAbsoluteDirectory(directory: string): string {
	return path.isAbsolute(directory) ? directory : path.resolve(directory);
}

function getAncestorDirectories(directory: string): string[] {
	const resolved = path.resolve(directory);
	const roots: string[] = [];
	let current = resolved;
	for (;;) {
		roots.push(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return roots;
}

function getTrustedShimNames(
	linter: SupportedLinter,
	platform = _internals.platform(),
): string[] {
	const isWindows = platform === 'win32';
	if (linter === 'biome') {
		return isWindows ? ['biome.exe', 'biome.cmd', 'biome.ps1'] : ['biome'];
	}
	return isWindows ? ['eslint.exe', 'eslint.cmd', 'eslint.ps1'] : ['eslint'];
}

function getExpectedPackageBinRelativePath(linter: SupportedLinter): string {
	return linter === 'biome' ? 'bin/biome' : 'bin/eslint.js';
}

function getPackageRootFromSearchRoot(
	searchRoot: string,
	linter: SupportedLinter,
): string {
	return path.join(
		searchRoot,
		NODE_MODULES,
		...LINTER_PACKAGES[linter].split('/'),
	);
}

function getPackageManifestPath(
	searchRoot: string,
	linter: SupportedLinter,
): string {
	return path.join(
		getPackageRootFromSearchRoot(searchRoot, linter),
		'package.json',
	);
}

function getPackageDisplayPath(
	searchRoot: string,
	linter: SupportedLinter,
): string {
	return path.join(
		searchRoot,
		NODE_MODULES,
		BIN_DIRECTORY,
		linter === 'biome'
			? _internals.platform() === 'win32'
				? 'biome.exe'
				: 'biome'
			: _internals.platform() === 'win32'
				? 'eslint'
				: 'eslint',
	);
}

function getBiomeNativePackage(
	platform: NodeJS.Platform,
	arch: string,
): string | null {
	const archMap =
		platform === 'darwin'
			? { arm64: '@biomejs/cli-darwin-arm64', x64: '@biomejs/cli-darwin-x64' }
			: platform === 'linux'
				? {
						arm64: '@biomejs/cli-linux-arm64',
						arm: '@biomejs/cli-linux-arm',
						x64: '@biomejs/cli-linux-x64',
					}
				: platform === 'win32'
					? {
							arm64: '@biomejs/cli-win32-arm64',
							x64: '@biomejs/cli-win32-x64',
						}
					: null;
	if (!archMap) return null;
	return archMap[arch as keyof typeof archMap] ?? null;
}

function getBiomeNativeExecutable(
	searchRoot: string,
	platform = _internals.platform(),
	arch = _internals.arch(),
): string | null {
	const nativePackage = getBiomeNativePackage(platform, arch);
	if (!nativePackage) return null;
	const executableName = platform === 'win32' ? 'biome.exe' : 'biome';
	const candidate = path.join(
		searchRoot,
		NODE_MODULES,
		...nativePackage.split('/'),
		executableName,
	);
	return isRegularFile(candidate) ? candidate : null;
}

function resolvePackageBinEntry(
	manifestPath: string,
	linter: SupportedLinter,
): string | null {
	try {
		const contents = readTextFileBounded(
			manifestPath,
			MAX_PACKAGE_MANIFEST_BYTES,
		);
		if (contents === null) return null;
		const manifest = JSON.parse(contents) as {
			bin?: string | Record<string, string>;
		};
		if (typeof manifest.bin === 'string') {
			return manifest.bin;
		}
		if (manifest.bin && typeof manifest.bin === 'object') {
			const key = linter === 'biome' ? 'biome' : 'eslint';
			const entry = manifest.bin[key];
			return typeof entry === 'string' ? entry : null;
		}
	} catch {
		// Ignore unreadable manifests.
	}
	return null;
}

function resolveCanonicalPackageCommand(
	searchRoot: string,
	linter: SupportedLinter,
	source: ResolvedLinterSource,
): ResolvedLinterCommand | null {
	const manifestPath = getPackageManifestPath(searchRoot, linter);
	if (!isRegularFile(manifestPath)) return null;

	const relativeBinPath = resolvePackageBinEntry(manifestPath, linter);
	if (!relativeBinPath) return null;

	let canonicalPackageRoot: string;
	let canonicalCandidate: string;
	try {
		const packageRoot = path.dirname(manifestPath);
		canonicalPackageRoot = _internals.realpathSync(packageRoot);
		canonicalCandidate = _internals.realpathSync(
			path.resolve(packageRoot, relativeBinPath),
		);
	} catch {
		return null;
	}
	const relativeToPackage = path.relative(
		canonicalPackageRoot,
		canonicalCandidate,
	);
	if (
		relativeToPackage === '' ||
		relativeToPackage.startsWith('..') ||
		path.isAbsolute(relativeToPackage)
	) {
		return null;
	}
	if (!isRegularFile(canonicalCandidate)) return null;

	return {
		linter,
		executable: _internals.execPath(),
		argsPrefix: [canonicalCandidate],
		displayPrefix: [getPackageDisplayPath(searchRoot, linter)],
		source,
	};
}

function hasTrustedLocalShim(
	searchRoot: string,
	linter: SupportedLinter,
): boolean {
	const binRoot = path.join(searchRoot, NODE_MODULES, BIN_DIRECTORY);
	for (const name of getTrustedShimNames(linter)) {
		if (isRegularFile(path.join(binRoot, name))) {
			return true;
		}
	}
	return false;
}

function resolveLocalLinterCommand(
	linter: SupportedLinter,
	directory: string,
): ResolvedLinterCommand | null {
	const roots = getAncestorDirectories(directory);
	for (const root of roots) {
		if (linter === 'biome') {
			const nativeExecutable = getBiomeNativeExecutable(root);
			if (nativeExecutable) {
				return {
					linter,
					executable: nativeExecutable,
					argsPrefix: [],
					displayPrefix: [nativeExecutable],
					source: 'local-native',
				};
			}
		}

		if (hasTrustedLocalShim(root, linter)) {
			const resolvedFromShim = resolveCanonicalPackageCommand(
				root,
				linter,
				'local-shim',
			);
			if (resolvedFromShim) return resolvedFromShim;
		}

		const resolvedPackage = resolveCanonicalPackageCommand(
			root,
			linter,
			'safe-package-bin',
		);
		if (resolvedPackage) return resolvedPackage;
	}

	return null;
}

function findPathShimCandidate(
	linter: SupportedLinter,
	envPath = _internals.pathEnv(),
	platform = _internals.platform(),
): string | null {
	const entries = envPath.split(path.delimiter).filter(Boolean);
	const shimNames = getTrustedShimNames(linter, platform).filter(
		(name) =>
			name.endsWith('.cmd') || name.endsWith('.ps1') || platform !== 'win32',
	);
	for (const entry of entries) {
		for (const shimName of shimNames) {
			const candidate = path.join(entry, shimName);
			if (isRegularFile(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}

function getExpectedShimSuffixes(linter: SupportedLinter): string[] {
	const packageParts = LINTER_PACKAGES[linter].split('/');
	const packageSuffix = path.join(
		'..',
		...packageParts,
		...getExpectedPackageBinRelativePath(linter).split('/'),
	);
	const nestedNodeModulesSuffix = path.join(
		'..',
		NODE_MODULES,
		...packageParts,
		...getExpectedPackageBinRelativePath(linter).split('/'),
	);
	const packageOnlySuffix = path.join(
		...packageParts,
		...getExpectedPackageBinRelativePath(linter).split('/'),
	);
	const nodeModulesPackageOnlySuffix = path.join(
		NODE_MODULES,
		...packageParts,
		...getExpectedPackageBinRelativePath(linter).split('/'),
	);
	return [
		normalizeRelativePathForPlatform(packageSuffix, 'win32'),
		normalizeRelativePathForPlatform(nestedNodeModulesSuffix, 'win32'),
		normalizeRelativePathForPlatform(packageOnlySuffix, 'win32'),
		normalizeRelativePathForPlatform(nodeModulesPackageOnlySuffix, 'win32'),
		normalizeRelativePathForPlatform(packageSuffix, 'linux'),
		normalizeRelativePathForPlatform(nestedNodeModulesSuffix, 'linux'),
		normalizeRelativePathForPlatform(packageOnlySuffix, 'linux'),
		normalizeRelativePathForPlatform(nodeModulesPackageOnlySuffix, 'linux'),
	];
}

function resolvePathShimTarget(
	shimPath: string,
	linter: SupportedLinter,
	platform = _internals.platform(),
): string | null {
	const contents = readTextFileBounded(shimPath, MAX_PATH_SHIM_BYTES);
	if (contents === null) return null;

	const ext = path.extname(shimPath).toLowerCase();
	let relativeTarget: string | null = null;

	if (ext === '.cmd') {
		const regex = /"%(?:dp0%|~dp0)(?<suffix>(?:\\[^"%]+)+)"/gi;
		for (const match of contents.matchAll(regex)) {
			const suffix = match.groups?.suffix;
			if (!suffix) continue;
			const normalized = normalizeRelativePathForPlatform(suffix, 'win32');
			if (
				getExpectedShimSuffixes(linter).some((expected) =>
					normalized.endsWith(expected),
				)
			) {
				relativeTarget = suffix;
				break;
			}
		}
	} else if (ext === '.ps1') {
		const regex = /"\$basedir(?:_win)?\/(?<suffix>\.\.\/[^"\r\n]+)"/gi;
		for (const match of contents.matchAll(regex)) {
			const suffix = match.groups?.suffix;
			if (!suffix) continue;
			const normalized = normalizeRelativePathForPlatform(suffix, platform);
			if (
				getExpectedShimSuffixes(linter).some((expected) =>
					normalized.endsWith(expected),
				)
			) {
				relativeTarget = suffix;
				break;
			}
		}
	} else {
		const regex = /"\$basedir(?:_win)?\/(?<suffix>\.\.\/[^"\r\n]+)"/gi;
		for (const match of contents.matchAll(regex)) {
			const suffix = match.groups?.suffix;
			if (!suffix) continue;
			const normalized = normalizeRelativePathForPlatform(suffix, platform);
			if (
				getExpectedShimSuffixes(linter).some((expected) =>
					normalized.endsWith(expected),
				)
			) {
				relativeTarget = suffix;
				break;
			}
		}
	}

	if (!relativeTarget) return null;
	let canonicalShimDir: string;
	try {
		canonicalShimDir = _internals.realpathSync(path.dirname(shimPath));
	} catch {
		return null;
	}
	const resolvedTarget = path.resolve(
		canonicalShimDir,
		relativeTarget.replaceAll('\\', path.sep).replace(/^[\\/]+/, ''),
	);
	if (!isRegularFile(resolvedTarget)) return null;

	let canonicalTarget: string;
	try {
		canonicalTarget = _internals.realpathSync(resolvedTarget);
	} catch {
		return null;
	}
	const targetPackageMarker = path.join(
		NODE_MODULES,
		...LINTER_PACKAGES[linter].split('/'),
	);
	if (
		!normalizeCaseForPlatform(canonicalTarget, platform).includes(
			normalizeCaseForPlatform(targetPackageMarker, platform),
		)
	) {
		return null;
	}

	let canonicalShimParent: string;
	try {
		canonicalShimParent = _internals.realpathSync(
			path.dirname(canonicalShimDir),
		);
	} catch {
		return null;
	}
	const allowedRoots = [canonicalShimDir, canonicalShimParent];
	const isContained = allowedRoots.some((root) => {
		const relative = path.relative(root, canonicalTarget);
		return (
			relative === '' ||
			(!relative.startsWith('..') && !path.isAbsolute(relative))
		);
	});
	if (!isContained) return null;

	return canonicalTarget;
}

function resolvePathLinterCommand(
	linter: SupportedLinter,
	directory: string,
): ResolvedLinterCommand | null {
	const platform = _internals.platform();
	const envPath = _internals.pathEnv();
	const nativeNames =
		platform === 'win32'
			? linter === 'biome'
				? ['biome.exe']
				: ['eslint.exe']
			: linter === 'biome'
				? ['biome']
				: ['eslint'];

	const nativeExecutable = resolveExecutableFromPath(
		nativeNames,
		envPath,
		platform,
	);
	if (nativeExecutable) {
		return {
			linter,
			executable: nativeExecutable,
			argsPrefix: [],
			displayPrefix: [nativeExecutable],
			source: 'path-native',
		};
	}

	const shimCandidate = findPathShimCandidate(linter, envPath, platform);
	if (!shimCandidate) return null;

	const shimTarget = resolvePathShimTarget(shimCandidate, linter, platform);
	if (!shimTarget) return null;

	return {
		linter,
		executable: _internals.execPath(),
		argsPrefix: [shimTarget],
		displayPrefix: [path.join(directory, NODE_MODULES, BIN_DIRECTORY, linter)],
		source: 'path-shim',
	};
}

export function getBiomeBinPath(directory: string): string {
	const isWindows = _internals.platform() === 'win32';
	return path.join(
		directory,
		NODE_MODULES,
		BIN_DIRECTORY,
		isWindows ? 'biome.EXE' : 'biome',
	);
}

export function getEslintBinPath(directory: string): string {
	const isWindows = _internals.platform() === 'win32';
	return path.join(
		directory,
		NODE_MODULES,
		BIN_DIRECTORY,
		isWindows ? 'eslint' : 'eslint',
	);
}

// ============ Platform Utilities ============
export function getLinterCommand(
	linter: SupportedLinter,
	mode: 'fix' | 'check',
	projectDir: string,
): string[] {
	if (!SUPPORTED_LINTERS.includes(linter)) return undefined as never;
	return [
		linter === 'biome'
			? getBiomeBinPath(projectDir)
			: getEslintBinPath(projectDir),
		...getLintModeArgs(linter, mode),
	];
}

export function resolveLinterBinPath(
	linter: SupportedLinter,
	projectDir: string,
): string {
	const resolved =
		resolveLocalLinterCommand(linter, projectDir) ??
		resolvePathLinterCommand(linter, projectDir);
	return (
		resolved?.displayPrefix[0] ??
		getLinterCommand(linter, 'check', projectDir)[0]
	);
}

function getLintModeArgs(
	linter: SupportedLinter,
	mode: 'fix' | 'check',
): string[] {
	if (linter === 'biome') {
		return mode === 'fix' ? ['check', '--write', '.'] : ['check', '.'];
	}
	return mode === 'fix' ? ['.', '--fix'] : ['.'];
}

function combineOutput(result: ExternalToolRunResult): string {
	let output = result.stdout;
	if (result.stderr) {
		output += `${output ? '\n' : ''}${result.stderr}`;
	}

	const shouldTruncate =
		result.stdoutTruncated ||
		result.stderrTruncated ||
		output.length > MAX_OUTPUT_BYTES;
	if (!shouldTruncate) return output;

	const trimmed = output.slice(0, MAX_OUTPUT_BYTES);
	return `${trimmed}${OUTPUT_TRUNCATION_SUFFIX}`;
}

function buildExecutionError(
	mode: 'fix' | 'check',
	command: string[],
	linter: SupportedLinter | AdditionalLinter,
	result: ExternalToolRunResult,
): LintErrorResult {
	const reason =
		result.message ??
		(result.status === 'timeout'
			? 'command timed out'
			: result.status === 'cancelled'
				? 'command was cancelled'
				: 'unknown error');

	return {
		success: false,
		mode,
		linter,
		command,
		exitCode: result.exitCode ?? undefined,
		output: combineOutput(result),
		error: `Execution failed: ${reason}`,
	};
}

async function probeResolvedCommand(
	command: ResolvedLinterCommand,
	cwd: string,
	abortSignal?: AbortSignal,
): Promise<boolean> {
	const result = await _internals.runExternalTool({
		executable: command.executable,
		args: [...command.argsPrefix, '--version'],
		cwd,
		timeoutMs: LINTER_DETECT_TIMEOUT_MS,
		maxStdoutBytes: 4_096,
		maxStderrBytes: 4_096,
		abortSignal,
	});
	return result.status === 'completed' && result.exitCode === 0;
}

export async function resolveLinterCommand(
	linter: SupportedLinter,
	directory: string,
): Promise<ResolvedLinterCommand | null> {
	const cwd = toAbsoluteDirectory(directory);
	return (
		resolveLocalLinterCommand(linter, cwd) ??
		resolvePathLinterCommand(linter, cwd)
	);
}

export async function detectResolvedLinter(
	directory?: string,
	abortSignal?: AbortSignal,
): Promise<ResolvedLinterCommand | null> {
	if (!directory) return null;
	if (!_internals.existsSync(directory)) return null;

	const cwd = toAbsoluteDirectory(directory);
	for (const linter of SUPPORTED_LINTERS) {
		const resolved = await resolveLinterCommand(linter, cwd);
		if (!resolved) continue;
		if (await probeResolvedCommand(resolved, cwd, abortSignal)) {
			return resolved;
		}
	}

	return null;
}

// ============ Additional Linter Detectors ============

/** Detect ruff (Python fast linter) */
function detectRuff(cwd: string): boolean {
	// ruff.toml OR pyproject.toml with [tool.ruff] section OR ruff binary present
	if (_internals.existsSync(path.join(cwd, 'ruff.toml')))
		return hasAdditionalCommand('ruff');
	try {
		const pyproject = path.join(cwd, 'pyproject.toml');
		if (_internals.existsSync(pyproject)) {
			const content = _internals.readFileSync(pyproject, 'utf-8');
			if (content.includes('[tool.ruff]')) return hasAdditionalCommand('ruff');
		}
	} catch {
		// ignore
	}
	return false;
}

/** Detect clippy (Rust linter) */
function detectClippy(cwd: string): boolean {
	// Cargo.toml exists AND cargo binary on PATH (clippy is a cargo subcommand)
	return (
		_internals.existsSync(path.join(cwd, 'Cargo.toml')) &&
		hasAdditionalCommand('cargo')
	);
}

/** Detect golangci-lint (Go linter) */
function detectGolangciLint(cwd: string): boolean {
	// go.mod exists AND golangci-lint binary on PATH
	return (
		_internals.existsSync(path.join(cwd, 'go.mod')) &&
		hasAdditionalCommand('golangci-lint')
	);
}

function readTextFileSafe(filePath: string): string {
	try {
		return _internals.readFileSync(filePath, 'utf-8');
	} catch {
		return '';
	}
}

function resolveAdditionalExecutable(name: string): string | null {
	const platform = _internals.platform();
	if (platform !== 'win32') {
		return _internals.isCommandAvailable(name) ? name : null;
	}
	return resolveExecutableFromPath(
		[`${name}.exe`],
		_internals.pathEnv(),
		platform,
	);
}

function resolveWindowsCommandInterpreter(): string | null {
	const candidate = _internals.comSpec();
	if (
		!candidate ||
		!path.isAbsolute(candidate) ||
		path.basename(candidate).toLowerCase() !== 'cmd.exe' ||
		!isRegularFile(candidate)
	) {
		return null;
	}
	try {
		const canonical = _internals.realpathSync(candidate);
		return path.basename(canonical).toLowerCase() === 'cmd.exe'
			? canonical
			: null;
	} catch {
		return null;
	}
}

function buildWindowsBatchCommand(
	wrapperPath: string,
	args: string[],
): string[] | null {
	const interpreter = resolveWindowsCommandInterpreter();
	if (!interpreter) return null;

	let canonicalWrapper: string;
	try {
		canonicalWrapper = _internals.realpathSync(wrapperPath);
	} catch {
		return null;
	}
	if (
		!isRegularFile(canonicalWrapper) ||
		!WINDOWS_BATCH_WRAPPER_EXTENSIONS.includes(
			path.extname(canonicalWrapper).toLowerCase() as '.cmd' | '.bat',
		)
	) {
		return null;
	}

	const tokens = [canonicalWrapper, ...args];
	if (tokens.some((token) => WINDOWS_CMD_UNSAFE_TOKEN.test(token))) return null;
	const command = `call ${tokens.map((token) => `"${token}"`).join(' ')}`;
	return [interpreter, '/d', '/s', '/v:off', '/c', command];
}

function resolveWindowsBatchCommandFromPath(
	name: string,
	args: string[],
): string[] | null {
	if (_internals.platform() !== 'win32') return null;
	const wrapper = resolveExecutableFromPath(
		WINDOWS_BATCH_WRAPPER_EXTENSIONS.map((extension) => `${name}${extension}`),
		_internals.pathEnv(),
		'win32',
	);
	return wrapper ? buildWindowsBatchCommand(wrapper, args) : null;
}

function resolveContainedWindowsBatchCommand(
	cwd: string,
	fileName: string,
	args: string[],
): string[] | null {
	if (_internals.platform() !== 'win32') return null;
	const candidate = path.join(cwd, fileName);
	if (!isRegularFile(candidate)) return null;

	let canonicalCwd: string;
	let canonicalCandidate: string;
	try {
		canonicalCwd = _internals.realpathSync(cwd);
		canonicalCandidate = _internals.realpathSync(candidate);
	} catch {
		return null;
	}
	const relative = path.relative(canonicalCwd, canonicalCandidate);
	if (
		relative === '' ||
		relative.startsWith('..') ||
		path.isAbsolute(relative)
	) {
		return null;
	}
	return buildWindowsBatchCommand(canonicalCandidate, args);
}

function buildAdditionalCommand(name: string, args: string[]): string[] | null {
	const executable = resolveAdditionalExecutable(name);
	if (executable) return [executable, ...args];
	return resolveWindowsBatchCommandFromPath(name, args);
}

function hasAdditionalCommand(name: string): boolean {
	return buildAdditionalCommand(name, []) !== null;
}

function resolvePhpVendorCommand(cwd: string, name: string): string[] | null {
	const relativeProxy = path.join('vendor', 'bin', name);
	if (!_internals.existsSync(path.join(cwd, relativeProxy))) return null;
	if (_internals.platform() !== 'win32') return [relativeProxy];
	const phpExecutable = resolveAdditionalExecutable('php');
	return phpExecutable ? [phpExecutable, relativeProxy] : null;
}

function hasCheckstyleGradleSignal(cwd: string): boolean {
	const gradleFiles = ['build.gradle', 'build.gradle.kts']
		.map((file) => path.join(cwd, file))
		.filter((file) => _internals.existsSync(file));
	return (
		_internals.existsSync(path.join(cwd, 'checkstyle.xml')) ||
		_internals.existsSync(
			path.join(cwd, 'config', 'checkstyle', 'checkstyle.xml'),
		) ||
		gradleFiles.some((file) => /\bcheckstyle\b/i.test(readTextFileSafe(file)))
	);
}

function resolveCheckstyleCommand(cwd: string): string[] | null {
	const hasMavenProject = _internals.existsSync(path.join(cwd, 'pom.xml'));
	const hasGradleSignal = hasCheckstyleGradleSignal(cwd);

	if (hasGradleSignal) {
		if (_internals.platform() === 'win32') {
			// F-005: the prior native-only resolver silently dropped standard
			// gradlew.bat projects. Launch only the exact contained wrapper through
			// a validated cmd.exe; the shared runner never receives a batch file as
			// its executable.
			const gradlew = resolveContainedWindowsBatchCommand(cwd, 'gradlew.bat', [
				'checkstyleMain',
			]);
			if (gradlew) return gradlew;
		} else {
			const gradlew = path.join(cwd, 'gradlew');
			if (_internals.existsSync(gradlew)) return [gradlew, 'checkstyleMain'];
		}
		const gradle = buildAdditionalCommand('gradle', ['checkstyleMain']);
		if (gradle) {
			return gradle;
		}
	}

	const maven = buildAdditionalCommand('mvn', ['checkstyle:check']);
	if (hasMavenProject && maven) {
		return maven;
	}

	return null;
}

function isUnsafeShellWrapperExecutable(
	executable: string,
	platform = _internals.platform(),
): boolean {
	return (
		platform === 'win32' &&
		UNSAFE_SHELL_WRAPPER_EXTENSIONS.has(path.extname(executable).toLowerCase())
	);
}

/** Detect checkstyle (Java linter via mvn or checkstyle jar) */
function detectCheckstyle(cwd: string): boolean {
	return resolveCheckstyleCommand(cwd) !== null;
}

function hasRootKotlinFile(cwd: string): boolean {
	try {
		return _internals
			.readdirSync(cwd)
			.some((f) => f.endsWith('.kt') || f.endsWith('.kts'));
	} catch {
		return false;
	}
}

function buildGradleHasKotlinSignal(cwd: string): boolean {
	const content = readTextFileSafe(path.join(cwd, 'build.gradle'));
	return /\b(kotlin|org\.jetbrains\.kotlin|ktlint)\b/i.test(content);
}

/** Detect ktlint (Kotlin linter) */
function detectKtlint(cwd: string): boolean {
	// build.gradle.kts is Kotlin DSL. Groovy build.gradle needs a Kotlin signal.
	const hasKotlin =
		_internals.existsSync(path.join(cwd, 'build.gradle.kts')) ||
		(_internals.existsSync(path.join(cwd, 'build.gradle')) &&
			buildGradleHasKotlinSignal(cwd)) ||
		hasRootKotlinFile(cwd);
	return hasKotlin && hasAdditionalCommand('ktlint');
}

/** Detect PHP linters from config + local Composer vendor binaries */
function detectPhpLinter(cwd: string): AdditionalLinter | null {
	if (
		(_internals.existsSync(path.join(cwd, 'phpstan.neon')) ||
			_internals.existsSync(path.join(cwd, 'phpstan.neon.dist'))) &&
		resolvePhpVendorCommand(cwd, 'phpstan') !== null
	) {
		return 'phpstan';
	}
	if (
		_internals.existsSync(path.join(cwd, 'pint.json')) &&
		resolvePhpVendorCommand(cwd, 'pint') !== null
	) {
		return 'pint';
	}
	if (
		_internals.existsSync(path.join(cwd, '.php-cs-fixer.php')) &&
		resolvePhpVendorCommand(cwd, 'php-cs-fixer') !== null
	) {
		return 'php-cs-fixer';
	}
	if (
		_internals.existsSync(path.join(cwd, 'phpcs.xml')) &&
		resolvePhpVendorCommand(cwd, 'phpcs') !== null
	) {
		return 'phpcs';
	}
	return null;
}

/** Detect dotnet-format (C#/.NET linter) */
function detectDotnetFormat(cwd: string): boolean {
	// Note: Only scans the root directory for .csproj/.sln files.
	// Deeply nested .NET projects may require running from the solution root.
	try {
		const files = _internals.readdirSync(cwd);
		const hasCsproj = files.some(
			(f) => f.endsWith('.csproj') || f.endsWith('.sln'),
		);
		return hasCsproj && hasAdditionalCommand('dotnet');
	} catch {
		return false;
	}
}

/** Detect cppcheck (C/C++ static analyzer) */
function detectCppcheck(cwd: string): boolean {
	// CMakeLists.txt is definitive; also scan root and common src/ subdirectory for C/C++ files
	if (_internals.existsSync(path.join(cwd, 'CMakeLists.txt'))) {
		return hasAdditionalCommand('cppcheck');
	}
	try {
		const dirsToCheck = [cwd, path.join(cwd, 'src')];
		const hasCpp = dirsToCheck.some((dir) => {
			try {
				return _internals
					.readdirSync(dir)
					.some((f) => /\.(c|cpp|cc|cxx|h|hpp)$/.test(f));
			} catch {
				return false;
			}
		});
		return hasCpp && hasAdditionalCommand('cppcheck');
	} catch {
		return false;
	}
}

/** Detect swiftlint (Swift linter) */
function detectSwiftlint(cwd: string): boolean {
	// Package.swift exists AND swiftlint binary on PATH
	return (
		_internals.existsSync(path.join(cwd, 'Package.swift')) &&
		hasAdditionalCommand('swiftlint')
	);
}

/** Detect dart analyze (Dart/Flutter linter) */
function detectDartAnalyze(cwd: string): boolean {
	// pubspec.yaml exists AND dart binary on PATH
	return (
		_internals.existsSync(path.join(cwd, 'pubspec.yaml')) &&
		hasAdditionalCommand('dart')
	);
}

/** Detect rubocop (Ruby linter) */
function detectRubocop(cwd: string): boolean {
	// Gemfile, gems.rb (Bundler 2 alternative), or .rubocop.yml config
	return (
		(_internals.existsSync(path.join(cwd, 'Gemfile')) ||
			_internals.existsSync(path.join(cwd, 'gems.rb')) ||
			_internals.existsSync(path.join(cwd, '.rubocop.yml'))) &&
		(hasAdditionalCommand('rubocop') || hasAdditionalCommand('bundle'))
	);
}

/**
 * Detect the first available additional (non-JS/TS) linter for the current project.
 * Returns null when no additional linter is detected or its binary is unavailable.
 */
export function detectAdditionalLinter(
	cwd: string,
):
	| 'ruff'
	| 'clippy'
	| 'golangci-lint'
	| 'checkstyle'
	| 'ktlint'
	| 'dotnet-format'
	| 'cppcheck'
	| 'swiftlint'
	| 'dart-analyze'
	| 'rubocop'
	| 'phpstan'
	| 'pint'
	| 'php-cs-fixer'
	| 'phpcs'
	| null {
	if (detectRuff(cwd)) return 'ruff';
	if (detectClippy(cwd)) return 'clippy';
	if (detectGolangciLint(cwd)) return 'golangci-lint';
	const phpLinter = detectPhpLinter(cwd);
	if (phpLinter) return phpLinter;
	if (detectKtlint(cwd)) return 'ktlint';
	if (detectCheckstyle(cwd)) return 'checkstyle';
	if (detectDotnetFormat(cwd)) return 'dotnet-format';
	if (detectCppcheck(cwd)) return 'cppcheck';
	if (detectSwiftlint(cwd)) return 'swiftlint';
	if (detectDartAnalyze(cwd)) return 'dart-analyze';
	if (detectRubocop(cwd)) return 'rubocop';
	return null;
}

// ============ Linter Detection ============
export async function detectAvailableLinter(
	directory?: string,
): Promise<SupportedLinter | null> {
	const resolved = await detectResolvedLinter(directory);
	return resolved?.linter ?? null;
}

/** Internal implementation — accepts pre-computed binary paths for testability. */
export async function _detectAvailableLinter(
	projectDir: string,
	biomeBin: string,
	eslintBin: string,
): Promise<SupportedLinter | null> {
	const cwd = toAbsoluteDirectory(projectDir);
	const probes: ResolvedLinterCommand[] = [
		{
			linter: 'biome',
			executable: biomeBin,
			argsPrefix: [],
			displayPrefix: [biomeBin],
			source: 'legacy-test-probe',
		},
		{
			linter: 'eslint',
			executable: eslintBin,
			argsPrefix: [],
			displayPrefix: [eslintBin],
			source: 'legacy-test-probe',
		},
	];

	for (const probe of probes) {
		if (await probeResolvedCommand(probe, cwd)) {
			return probe.linter;
		}
	}
	return null;
}

async function runResolvedLint(
	command: ResolvedLinterCommand,
	mode: 'fix' | 'check',
	directory: string,
	abortSignal?: AbortSignal,
): Promise<LintResult> {
	const lintArgs = getLintModeArgs(command.linter, mode);
	const displayCommand = [...command.displayPrefix, ...lintArgs];
	const commandStr = displayCommand.join(' ');
	if (commandStr.length > MAX_COMMAND_LENGTH) {
		return {
			success: false,
			mode,
			linter: command.linter,
			command: displayCommand,
			error: 'Command exceeds maximum allowed length',
		};
	}

	const runResult = await _internals.runExternalTool({
		executable: command.executable,
		args: [...command.argsPrefix, ...lintArgs],
		cwd: toAbsoluteDirectory(directory),
		timeoutMs: LINTER_RUN_TIMEOUT_MS,
		maxStdoutBytes: MAX_OUTPUT_BYTES,
		maxStderrBytes: MAX_OUTPUT_BYTES,
		abortSignal,
	});

	if (runResult.status !== 'completed') {
		return buildExecutionError(mode, displayCommand, command.linter, runResult);
	}

	const exitCode = runResult.exitCode ?? 0;
	const result: LintSuccessResult = {
		success: true,
		mode,
		linter: command.linter,
		command: displayCommand,
		exitCode,
		output: combineOutput(runResult),
	};

	if (exitCode === 0) {
		result.message = `${command.linter} ${mode} completed successfully with no issues`;
	} else if (mode === 'fix') {
		result.message = `${command.linter} fix completed with exit code ${exitCode}. Run check mode to see remaining issues.`;
	} else {
		result.message = `${command.linter} check found issues (exit code ${exitCode}).`;
	}

	return result;
}

// ============ Additional Linter Command Construction ============
/**
 * Build the shell command for an additional (non-JS/TS) linter.
 * cppcheck has no --fix mode; csharp and some others behave differently.
 */
export function getAdditionalLinterCommand(
	linter: AdditionalLinter,
	mode: 'fix' | 'check',
	cwd: string,
): string[] | null {
	switch (linter) {
		case 'ruff':
			return buildAdditionalCommand(
				'ruff',
				mode === 'fix' ? ['check', '--fix', '.'] : ['check', '.'],
			);
		case 'clippy':
			return buildAdditionalCommand(
				'cargo',
				mode === 'fix' ? ['clippy', '--fix', '--allow-dirty'] : ['clippy'],
			);
		case 'golangci-lint':
			return buildAdditionalCommand(
				'golangci-lint',
				mode === 'fix' ? ['run', '--fix'] : ['run'],
			);
		case 'checkstyle':
			return resolveCheckstyleCommand(cwd);
		case 'ktlint':
			return buildAdditionalCommand(
				'ktlint',
				mode === 'fix' ? ['--format'] : [],
			);
		case 'dotnet-format':
			return buildAdditionalCommand(
				'dotnet',
				mode === 'fix' ? ['format'] : ['format', '--verify-no-changes'],
			);
		case 'cppcheck':
			// cppcheck has no fix mode; always check
			return buildAdditionalCommand('cppcheck', ['--enable=all', '.']);
		case 'swiftlint':
			return buildAdditionalCommand(
				'swiftlint',
				mode === 'fix' ? ['--fix'] : [],
			);
		case 'dart-analyze':
			return buildAdditionalCommand(
				'dart',
				mode === 'fix' ? ['fix'] : ['analyze'],
			);
		case 'rubocop': {
			// Prefer bundle exec rubocop when Bundler has any safely resolved native
			// or constrained Windows wrapper command.
			const bundle = buildAdditionalCommand('bundle', [
				'exec',
				'rubocop',
				...(mode === 'fix' ? ['-A'] : []),
			]);
			if (bundle) {
				return bundle;
			}
			return buildAdditionalCommand('rubocop', mode === 'fix' ? ['-A'] : []);
		}
		case 'phpstan': {
			const base = resolvePhpVendorCommand(cwd, 'phpstan');
			return base ? [...base, 'analyse'] : null;
		}
		case 'pint': {
			const base = resolvePhpVendorCommand(cwd, 'pint');
			return base ? (mode === 'fix' ? base : [...base, '--test']) : null;
		}
		case 'php-cs-fixer': {
			const base = resolvePhpVendorCommand(cwd, 'php-cs-fixer');
			return base
				? mode === 'fix'
					? [...base, 'fix']
					: [...base, 'fix', '--dry-run', '--diff']
				: null;
		}
		case 'phpcs':
			return resolvePhpVendorCommand(cwd, 'phpcs');
	}
}

// ============ Lint Execution ============
export async function runLint(
	linter: SupportedLinter,
	mode: 'fix' | 'check',
	directory: string,
	abortSignal?: AbortSignal,
): Promise<LintResult> {
	const resolved = await _internals.resolveLinterCommand(linter, directory);
	if (!resolved) {
		return {
			success: false,
			mode,
			linter,
			error: `No safely resolved ${linter} executable found`,
		};
	}
	return runResolvedLint(resolved, mode, directory, abortSignal);
}

/**
 * Run an additional (non-JS/TS) linter.
 * Follows the same structure as runLint() but uses getAdditionalLinterCommand().
 */
export async function runAdditionalLint(
	linter: AdditionalLinter,
	mode: 'fix' | 'check',
	cwd: string,
	abortSignal?: AbortSignal,
): Promise<LintResult> {
	const command = getAdditionalLinterCommand(linter, mode, cwd);
	if (!command) {
		return {
			success: false,
			mode,
			linter,
			error: `No safely executable ${linter} command found`,
		};
	}

	const commandStr = command.join(' ');
	if (commandStr.length > MAX_COMMAND_LENGTH) {
		return {
			success: false,
			mode,
			linter,
			command,
			error: 'Command exceeds maximum allowed length',
		};
	}

	const [executable, ...args] = command;
	if (isUnsafeShellWrapperExecutable(executable)) {
		return {
			success: false,
			mode,
			linter,
			command,
			error: `No safely executable ${linter} command found`,
		};
	}
	const runResult = await _internals.runExternalTool({
		executable,
		args,
		cwd: toAbsoluteDirectory(cwd),
		timeoutMs: LINTER_RUN_TIMEOUT_MS,
		maxStdoutBytes: MAX_OUTPUT_BYTES,
		maxStderrBytes: MAX_OUTPUT_BYTES,
		abortSignal,
		windowsVerbatimArguments:
			_internals.platform() === 'win32' &&
			path.basename(executable).toLowerCase() === 'cmd.exe',
	});

	if (runResult.status !== 'completed') {
		return buildExecutionError(mode, command, linter, runResult);
	}

	const exitCode = runResult.exitCode ?? 0;
	const result: LintSuccessResult = {
		success: true,
		mode,
		linter,
		command,
		exitCode,
		output: combineOutput(runResult),
	};

	if (exitCode === 0) {
		result.message = `${linter} ${mode} completed successfully with no issues`;
	} else if (mode === 'fix') {
		result.message = `${linter} fix completed with exit code ${exitCode}. Run check mode to see remaining issues.`;
	} else {
		result.message = `${linter} check found issues (exit code ${exitCode}).`;
	}

	return result;
}

// ============ Tool Definition ============
export const lint: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Run project linter in check or fix mode. Supports biome, eslint (JS/TS), ruff (Python), clippy (Rust), golangci-lint (Go), checkstyle (Java), ktlint (Kotlin), dotnet-format (C#), cppcheck (C/C++), swiftlint (Swift), dart analyze (Dart), and rubocop (Ruby). Returns JSON with success status, exit code, and output for architect pre-reviewer gate. Use check mode for CI/linting and fix mode to automatically apply fixes.',
	args: {
		mode: z
			.enum(['fix', 'check'])
			.describe(
				'Linting mode: "check" for read-only lint check, "fix" to automatically apply fixes',
			),
	},
	async execute(args: unknown, directory: string, ctx): Promise<string> {
		// Validate arguments
		if (!validateArgs(args)) {
			const errorResult: LintErrorResult = {
				success: false,
				mode: 'check',
				error: 'Invalid arguments: mode must be "fix" or "check"',
			};
			return JSON.stringify(errorResult, null, 2);
		}

		if (
			!directory ||
			typeof directory !== 'string' ||
			directory.trim() === ''
		) {
			const errorResult: LintErrorResult = {
				success: false,
				mode: 'check',
				error: 'project directory is required but was not provided',
			};
			return JSON.stringify(errorResult, null, 2);
		}

		const { mode } = args;
		const cwd = directory;

		// Primary: detect Biome or ESLint (JS/TS projects)
		const resolvedLinter = await _internals.detectResolvedLinter(
			directory,
			ctx?.abort,
		);
		if (resolvedLinter) {
			const result = await _internals.runResolvedLint(
				resolvedLinter,
				mode,
				directory,
				ctx?.abort,
			);
			return JSON.stringify(result, null, 2);
		}

		// Fallback: detect additional language linters (Python, Rust, Go, Java, Kotlin, C#, C/C++, Swift, Dart, Ruby)
		const additionalLinter = _internals.detectAdditionalLinter(cwd);
		if (additionalLinter) {
			warn(`[lint] Using ${additionalLinter} linter for this project`);
			const result = await _internals.runAdditionalLint(
				additionalLinter,
				mode,
				cwd,
				ctx?.abort,
			);
			return JSON.stringify(result, null, 2);
		}

		// No linter found
		const errorResult: LintErrorResult = {
			success: false,
			mode,
			error:
				'No linter found. Install biome or eslint for JS/TS projects, or a supported linter for your language (ruff, cargo clippy, golangci-lint, ktlint, dotnet format, cppcheck, swiftlint, dart analyze, rubocop).',
			message:
				'For JS/TS: npm install -D @biomejs/biome eslint\nFor Python: pip install ruff\nFor Rust: rustup component add clippy',
		};
		return JSON.stringify(errorResult, null, 2);
	},
});

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	MAX_PACKAGE_MANIFEST_BYTES: number;
	MAX_PATH_SHIM_BYTES: number;
	arch: () => string;
	closeSync: typeof fs.closeSync;
	comSpec: () => string | undefined;
	detectAdditionalLinter: typeof detectAdditionalLinter;
	detectAvailableLinter: typeof detectAvailableLinter;
	detectResolvedLinter: typeof detectResolvedLinter;
	execPath: () => string;
	existsSync: typeof fs.existsSync;
	fstatSync: typeof fs.fstatSync;
	isCommandAvailable: typeof isCommandAvailable;
	openSync: typeof fs.openSync;
	pathEnv: () => string;
	platform: () => NodeJS.Platform;
	readFileSync: typeof fs.readFileSync;
	readSync: typeof fs.readSync;
	readdirSync: typeof fs.readdirSync;
	realpathSync: typeof fs.realpathSync;
	resolveLinterCommand: typeof resolveLinterCommand;
	runAdditionalLint: typeof runAdditionalLint;
	runExternalTool: (
		options: ExternalToolRunOptions,
	) => Promise<ExternalToolRunResult>;
	runLint: typeof runLint;
	runResolvedLint: typeof runResolvedLint;
	statSync: typeof fs.statSync;
} = {
	MAX_PACKAGE_MANIFEST_BYTES,
	MAX_PATH_SHIM_BYTES,
	arch: () => process.arch,
	closeSync: fs.closeSync,
	comSpec: () => process.env.ComSpec,
	detectAdditionalLinter,
	detectAvailableLinter,
	detectResolvedLinter,
	execPath: () => process.execPath,
	existsSync: fs.existsSync,
	fstatSync: fs.fstatSync,
	isCommandAvailable,
	openSync: fs.openSync,
	pathEnv: () => process.env.PATH ?? '',
	platform: () => process.platform,
	readFileSync: fs.readFileSync,
	readSync: fs.readSync,
	readdirSync: fs.readdirSync,
	realpathSync: fs.realpathSync,
	resolveLinterCommand,
	runAdditionalLint,
	runExternalTool,
	runLint,
	runResolvedLint,
	statSync: fs.statSync,
} as const;
