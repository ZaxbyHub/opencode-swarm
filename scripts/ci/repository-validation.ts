#!/usr/bin/env bun
/**
 * Shared repository-validation authority.
 *
 * This module is intentionally import-safe.  The package command, the local
 * unit compatibility entry point, and CI callers all consume the same item
 * and terminal-result contract instead of maintaining separate shell loops.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../../src/memory/redaction';
import { resolveGitExecutable } from '../../src/utils/git-executable';

export const SURFACE_INVENTORY = [
	'quality',
	'unit',
	'integration',
	'security',
	'coverage',
	'memory-recall-regression',
	'package-check',
	'smoke',
	'php-validation',
	'rust-sandbox-runner',
] as const;

export type ValidationSurface = (typeof SURFACE_INVENTORY)[number];

export type RuntimeRequirement = 'bun' | 'node' | 'php' | 'cargo' | 'bash';

export const TERMINAL_STATUSES = [
	'passed',
	'failed',
	'crashed',
	'timed_out',
	'missing',
	'skipped',
] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type ValidationMode = 'full' | 'diff';
export type ValidationStatus = 'passed' | 'failed' | 'incomplete' | 'no_op';

export const DEFAULT_TEST_TIMEOUT_MS = 120_000;
export const DEFAULT_PER_ITEM_TIMEOUT_MS = 180_000;
export const DEFAULT_SUITE_TIMEOUT_MS = 900_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
export const DEFAULT_DIFF_BASE = 'origin/main';
const PROCESS_KILLER_TIMEOUT_MS = 5_000;
const GIT_DIFF_TIMEOUT_MS = 10_000;
const GIT_DIFF_FILTER = 'ACDMR';
const REPORT_LOCK_WAIT_MS = 5_000;
const REPORT_LOCK_RETRY_MS = 50;
const REPORT_LOCK_STALE_AFTER_MS = 30_000;

export interface RuntimeMetadata {
	bunVersion: string;
	platform: string;
	arch: string;
}

export interface ValidationItem {
	id: string;
	surface: ValidationSurface;
	file: string;
	argv: string[];
	cwd: string;
	kind: 'test' | 'surface';
	testTimeoutMs: number;
	perItemTimeoutMs: number;
	requiredRuntimes?: RuntimeRequirement[];
	skipReason?: string;
}

export interface ValidationProcessResult {
	status: TerminalStatus;
	exitCode: number | null;
	signal: string | null;
	stdout?: string;
	stderr?: string;
	durationMs?: number;
	cleanedUp?: boolean;
	reason?: string;
}

export interface ValidationResult extends ValidationProcessResult {
	id: string;
	surface: ValidationSurface;
	file: string;
	argv: string[];
	cwd: string;
	kind: ValidationItem['kind'];
	startedAt: string | null;
	endedAt: string;
}

export interface ValidationSummary {
	discovered: number;
	started: number;
	completed: number;
	passed: number;
	failed: number;
	crashed: number;
	timedOut: number;
	missing: number;
	skipped: number;
}

export interface ValidationBounds {
	testTimeoutMs: number;
	perItemTimeoutMs: number;
	suiteTimeoutMs: number;
	maxOutputBytes: number;
}

export interface ValidationReport {
	schemaVersion: 1;
	status: ValidationStatus;
	mode: ValidationMode;
	root: string;
	diffBase: string;
	runtime: RuntimeMetadata;
	inventory: ValidationSurface[];
	bounds: ValidationBounds;
	terminalStatuses: TerminalStatus[];
	summary: ValidationSummary;
	results: ValidationResult[];
	startedAt: string;
	endedAt: string;
	durationMs: number;
	reportPath?: string;
}

export interface ValidationOptions {
	root: string;
	mode: ValidationMode;
	diffBase?: string;
	surfaces?: ValidationSurface[];
	testFiles?: string[];
	runtime?: RuntimeMetadata;
	testTimeoutMs?: number;
	perItemTimeoutMs?: number;
	suiteTimeoutMs?: number;
	maxOutputBytes?: number;
	reportPath?: string;
	runProcess?: (item: ValidationItem) => Promise<ValidationProcessResult> | ValidationProcessResult;
}

export interface SurfaceCommandSpec {
	id: string;
	argv: string[];
	cwd?: string;
	requiredRuntimes: RuntimeRequirement[];
}

interface SurfaceDefinition {
	surface: ValidationSurface;
	testRoots?: string[];
	commands?: Array<{
		id: string;
		argv: (root: string) => string[];
		cwd?: (root: string) => string;
		requiredRuntimes: RuntimeRequirement[];
	}>;
}

const UNIT_TEST_ROOTS = [
	'src',
	'tests/unit',
	'tests/adversarial',
	'tests/architect',
	'tests/cli',
	'tests/tools',
	'tests/helpers',
] as const;

const PHP_TEST_FILES = [
	'tests/unit/lang/profiles-php.test.ts',
	'tests/unit/lang/framework-detector.test.ts',
	'tests/unit/build/discovery-php.test.ts',
	'tests/unit/tools/pkg-audit-composer.test.ts',
	'tests/unit/tools/sast-scan-laravel.test.ts',
	'tests/unit/lang/laravel-fixture.test.ts',
] as const;

const command = (
	id: string,
	argv: (root: string) => string[],
	requiredRuntimes: RuntimeRequirement[],
	cwd?: (root: string) => string,
) => ({ id, argv, cwd, requiredRuntimes });

const SURFACE_DEFINITIONS: SurfaceDefinition[] = [
	{
		surface: 'quality',
		commands: [
			command('typecheck', () => ['bun', 'run', 'typecheck'], ['bun']),
			command('biome', () => ['bunx', 'biome', 'ci', '.'], ['bun']),
			command('mock-cleanup', () => ['bun', 'run', 'check:mock-cleanup'], ['bun']),
			command('invariants', () => ['bun', 'run', 'check:invariants'], ['bun']),
			command('tool-registration', () => ['bun', 'run', 'scripts/check-tool-registration.ts'], ['bun']),
			command('runtime-src-refs', () => ['bun', 'run', 'check:runtime-src-refs'], ['bun']),
			command('events', () => ['bun', 'run', 'check:events'], ['bun']),
			command('retention', () => ['bun', 'run', 'check:retention'], ['bun']),
			command('registry-citations', () => ['bun', 'run', 'check:registry-citations'], ['bun']),
			command('core-events', () => ['bun', 'run', 'check:core-events'], ['bun']),
			command('shell-audit', () => ['bun', 'run', 'check:shell-audit'], ['bun']),
			command('trajectory-store', () => ['bun', 'run', 'check:trajectory-store'], ['bun']),
			command('cross-contamination', () => ['bun', 'run', 'check:cross-contamination'], ['bun']),
			command('test-clock', () => ['bun', 'run', 'check:test-clock'], ['bun']),
			command('test-file-cap', () => ['bun', 'run', 'check:test-file-cap'], ['bun']),
			command('pending-fragment', () => ['bun', 'run', 'check:pending-fragment'], ['bun']),
			command('gate-portability', () => ['bun', 'run', 'check:gate-portability'], ['bun']),
			command('bare-spawn', () => ['bun', 'run', 'check:bare-spawn'], ['bun']),
			command('error-channel-discard', () => ['bun', 'run', 'check:error-channel-discard'], ['bun']),
			command('path-identity', () => ['bun', 'run', 'check:path-identity'], ['bun']),
			command('token-formula', () => ['bun', 'run', 'check:token-formula'], ['bun']),
			command('test-tmpdir', () => ['bun', 'run', 'check:test-tmpdir'], ['bun']),
			command('bash-portability', () => ['bun', 'run', 'check:bash-portability'], ['bun']),
			command('swarm-model', () => ['node', '--test'], ['node'], (root) => path.join(root, 'scripts', 'swarm-model')),
		],
	},
	{
		surface: 'unit',
		testRoots: [...UNIT_TEST_ROOTS, 'tests:top-level'],
	},
	{
		surface: 'integration',
		testRoots: ['tests/integration', 'test'],
	},
	{
		surface: 'security',
		commands: [
			command('security-tests', (root) => ['bun', '--smol', '--preload', keepalivePath(root), 'test', path.join(root, 'tests', 'security'), '--timeout', String(DEFAULT_TEST_TIMEOUT_MS)], ['bun']),
		],
	},
	{
		surface: 'coverage',
		commands: [
			command('coverage-gate', (root) => ['bash', path.join(root, 'scripts', 'ci', 'run-coverage-gate.sh')], ['bash']),
		],
	},
	{
		surface: 'memory-recall-regression',
		commands: [
			command('memory-recall', () => ['bun', 'run', 'check:memory-recall'], ['bun']),
			command('retrieval-quality', () => ['bun', 'run', 'check:retrieval-quality'], ['bun']),
		],
	},
	{
		surface: 'package-check',
		commands: [
			command('build', () => ['bun', 'run', 'build'], ['bun']),
			command('package-smoke', () => ['bun', 'run', 'package:smoke'], ['bun', 'node']),
		],
	},
	{
		surface: 'smoke',
		commands: [
			command('smoke-tests', (root) => ['bun', '--smol', '--preload', keepalivePath(root), 'test', path.join(root, 'tests', 'smoke'), '--timeout', String(DEFAULT_TEST_TIMEOUT_MS)], ['bun']),
			command('repro-704', (root) => ['node', path.join(root, 'scripts', 'repro-704.mjs')], ['node']),
			command('repro-1873', () => ['bun', 'run', 'repro:1873'], ['bun', 'node']),
			command('repro-2487', () => ['bun', 'run', 'repro:2487'], ['bun', 'node']),
		],
	},
	{
		surface: 'php-validation',
		commands: PHP_TEST_FILES.map((file) =>
			command(file, (root) => buildTestArgv(root, path.join(root, file)), ['bun', 'php']),
		),
	},
	{
		surface: 'rust-sandbox-runner',
		commands: [
			command('fmt', () => ['cargo', 'fmt', '--check'], ['cargo'], (root) => path.join(root, 'runners', 'swarm-sandbox-runner')),
			command('clippy', () => ['cargo', 'clippy', '--all-targets', '--', '-D', 'warnings'], ['cargo'], (root) => path.join(root, 'runners', 'swarm-sandbox-runner')),
			command('test', () => ['cargo', 'test', '--all-targets'], ['cargo'], (root) => path.join(root, 'runners', 'swarm-sandbox-runner')),
			command('build', () => ['cargo', 'build', '--release'], ['cargo'], (root) => path.join(root, 'runners', 'swarm-sandbox-runner')),
			command('probe', () => [path.join('target', 'release', `swarm-sandbox-runner${process.platform === 'win32' ? '.exe' : ''}`), '--probe'], ['cargo'], (root) => path.join(root, 'runners', 'swarm-sandbox-runner')),
		],
	},
];

interface RunProcessOptions {
	root: string;
	maxOutputBytes: number;
	perItemTimeoutMs: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function validateDiffBase(value: string): string {
	if (value.length === 0 || value.startsWith('-') || value.includes('\0')) {
		throw new Error('diff base must be a non-empty git revision that does not start with "-" or contain NUL');
	}
	return value;
}

function resolveRoot(root: string): string {
	return path.resolve(root);
}

function normalizePathForIdentity(filePath: string): string {
	return path.normalize(path.resolve(filePath));
}

function toUtf8Bound(value: string, maxBytes: number): { value: string; truncated: boolean } {
	const bytes = Buffer.from(value, 'utf8');
	if (bytes.byteLength <= maxBytes) return { value, truncated: false };
	const marker = '[TRUNCATED]';
	const markerBytes = Buffer.byteLength(marker, 'utf8');
	const prefixBytes = Math.max(0, maxBytes - markerBytes);
	const prefix = bytes
		.subarray(0, prefixBytes)
		.toString('utf8')
		.replace(/\uFFFD+$/g, '');
	return { value: `${prefix}${marker}`.slice(0, maxBytes), truncated: true };
}

/** Redact first, then apply the byte bound so secrets cannot be copied verbatim. */
export function redactAndBound(value: unknown, maxBytes = DEFAULT_MAX_OUTPUT_BYTES): string {
	if (typeof value !== 'string' || value.length === 0) return '';
	const redacted = redactSecrets(value);
	return toUtf8Bound(redacted, maxBytes).value;
}

function runtimeMetadata(): RuntimeMetadata {
	const bunVersion =
		typeof Bun !== 'undefined' && typeof Bun.version === 'string'
			? Bun.version
			: process.versions.bun ?? 'unavailable';
	return {
		bunVersion,
		platform: process.platform,
		arch: process.arch,
	};
}

export function getRuntimeMetadata(): RuntimeMetadata {
	return runtimeMetadata();
}

function keepalivePath(root: string): string {
	return path.join(root, 'scripts', 'ci', 'bun-32056-keepalive.ts');
}

export function buildTestArgv(
	root: string,
	file: string,
	testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS,
): string[] {
	return [
		'bun',
		'--smol',
		'--preload',
		keepalivePath(root),
		'test',
		file,
		'--timeout',
		String(testTimeoutMs),
	];
}

export function discoverTestFiles(
	root: string,
	roots: string[] = ['tests/unit'],
	optionalRoots: readonly string[] = ['tests/cli'],
): string[] {
	const discovered: string[] = [];
	const optionalRootSet = new Set(optionalRoots.map((relativeRoot) => path.normalize(relativeRoot)));
	const visit = (directory: string, optionalRoot = false): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch (error) {
			// Several CI test roots are optional across repository versions (for
			// example, tests/cli).  A missing root is an empty surface, but a
			// failure while traversing an existing root must remain fail-closed.
			if (optionalRoot && isNotFoundError(error)) return;
			throw new Error(
				`filesystem discovery failed for ${directory}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(fullPath);
			else if (entry.isFile() && entry.name.endsWith('.test.ts')) discovered.push(fullPath);
		}
	};
	for (const relativeRoot of roots) {
		visit(path.join(root, relativeRoot), optionalRootSet.has(path.normalize(relativeRoot)));
	}
	return Array.from(new Set(discovered.map(normalizePathForIdentity))).sort((a, b) =>
		a.localeCompare(b),
	);
}

function discoverTopLevelTestFiles(root: string): string[] {
	const directory = path.join(root, 'tests');
	try {
		return fs.readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
			.map((entry) => normalizePathForIdentity(path.join(directory, entry.name)))
			.sort((a, b) => a.localeCompare(b));
	} catch (error) {
		throw new Error(
			`filesystem discovery failed for ${directory}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function itemForFile(
	root: string,
	file: string,
	testTimeoutMs: number,
	perItemTimeoutMs: number,
): ValidationItem {
	const absoluteFile = path.isAbsolute(file) ? path.normalize(file) : path.resolve(root, file);
	return {
		id: `unit:${absoluteFile}`,
		surface: 'unit',
		file: absoluteFile,
		argv: buildTestArgv(root, absoluteFile, testTimeoutMs),
		cwd: root,
		kind: 'test',
		testTimeoutMs,
		perItemTimeoutMs,
	};
}

export function createValidationItems(options: {
	root: string;
	testFiles: string[];
	testTimeoutMs?: number;
	perItemTimeoutMs?: number;
}): ValidationItem[] {
	const testTimeoutMs = positiveInteger(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS);
	const perItemTimeoutMs = positiveInteger(
		options.perItemTimeoutMs,
		DEFAULT_PER_ITEM_TIMEOUT_MS,
	);
	const seen = new Set<string>();
	const items: ValidationItem[] = [];
	for (const file of options.testFiles) {
		const item = itemForFile(options.root, file, testTimeoutMs, perItemTimeoutMs);
		const identity = normalizePathForIdentity(item.file);
		if (seen.has(identity)) continue;
		seen.add(identity);
		items.push(item);
	}
	return items;
}

function runtimeAvailable(runtime: RuntimeRequirement): boolean {
	if (runtime === 'bun') return typeof Bun !== 'undefined';
	if (runtime === 'node') return typeof process.versions.node === 'string' && process.versions.node.length > 0;
	return typeof Bun !== 'undefined' && typeof Bun.which === 'function' && Bun.which(runtime) !== null;
}

type GitDiffPathsRunner = (root: string, diffBase: string) => Promise<string[]>;

async function defaultGitDiffPaths(root: string, diffBase: string): Promise<string[]> {
	const child = Bun.spawn([
		resolveGitExecutable(), '-C', root, 'diff', '--name-only', `--diff-filter=${GIT_DIFF_FILTER}`, `${diffBase}...HEAD`,
	], {
		cwd: root,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: GIT_DIFF_TIMEOUT_MS,
	});
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			_internals.readBoundedWithStatus(child.stdout, DEFAULT_MAX_OUTPUT_BYTES, GIT_DIFF_TIMEOUT_MS),
			readBounded(child.stderr, DEFAULT_MAX_OUTPUT_BYTES, GIT_DIFF_TIMEOUT_MS),
			child.exited,
		]);
		if (stdout.truncated || !stdout.complete) {
			throw new Error(
				stdout.truncated
					? `git diff output exceeded bounded buffer of ${DEFAULT_MAX_OUTPUT_BYTES} bytes`
					: 'git diff output ended before the complete changed-path set was read',
			);
		}
		if (exitCode !== 0) {
			throw new Error(`git diff failed with exit code ${exitCode}: ${redactAndBound(stderr)}`);
		}
		return stdout.value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
	} finally {
		try {
			child.kill('SIGKILL');
		} catch {
			// The child may have exited before the best-effort cleanup call.
		}
	}
}

export const _internals: {
	runtimeAvailable: typeof runtimeAvailable;
	gitDiffPaths: GitDiffPathsRunner;
	diffCommandArgv: typeof diffCommandArgv;
	discoverTestFiles: typeof discoverTestFiles;
	discoverTopLevelTestFiles: typeof discoverTopLevelTestFiles;
	readBoundedWithStatus: typeof readBoundedWithStatus;
} = {
	runtimeAvailable,
	gitDiffPaths: defaultGitDiffPaths,
	diffCommandArgv,
	discoverTestFiles,
	discoverTopLevelTestFiles,
	readBoundedWithStatus,
};

function commandItem(
	root: string,
	surface: ValidationSurface,
	spec: SurfaceCommandSpec,
	testTimeoutMs: number,
	perItemTimeoutMs: number,
): ValidationItem {
	return {
		id: `${surface}:${spec.id}`,
		surface,
		file: `surface:${surface}/${spec.id}`,
		argv: [...spec.argv],
		cwd: path.resolve(spec.cwd ?? root),
		kind: 'surface',
		testTimeoutMs,
		perItemTimeoutMs,
		requiredRuntimes: [...spec.requiredRuntimes],
	};
}

/** Expand the selected host-supported surfaces into deterministic work items. */
export function buildSurfaceItems(options: {
	root: string;
	surfaces?: ValidationSurface[];
	testFiles?: string[];
	testTimeoutMs?: number;
	perItemTimeoutMs?: number;
}): ValidationItem[] {
	const root = resolveRoot(options.root);
	const testTimeoutMs = positiveInteger(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS);
	const perItemTimeoutMs = positiveInteger(options.perItemTimeoutMs, DEFAULT_PER_ITEM_TIMEOUT_MS);
	const requested = options.surfaces ?? [...SURFACE_INVENTORY];
	const items: ValidationItem[] = [];
	const seen = new Set<ValidationSurface>();
	for (const surface of requested) {
		if (seen.has(surface)) continue;
		seen.add(surface);
		const definition = SURFACE_DEFINITIONS.find((candidate) => candidate.surface === surface);
		if (!definition) throw new Error(`unknown validation surface: ${surface}`);
		if (definition.testRoots) {
			const files = options.testFiles && (surface === 'unit' || surface === 'integration')
				? options.testFiles
				: definition.testRoots.flatMap((testRoot) => {
					if (testRoot === 'tests:top-level') return _internals.discoverTopLevelTestFiles(root);
					return _internals.discoverTestFiles(root, [testRoot]);
				});
			const uniqueFiles = Array.from(new Set(files.map((file) => normalizePathForIdentity(file)))).sort((a, b) => a.localeCompare(b));
			if (uniqueFiles.length === 0) {
				items.push({
					id: `${surface}:no-test-files`,
					surface,
					file: `surface:${surface}/no-test-files`,
					argv: [],
					cwd: root,
					kind: 'surface',
					testTimeoutMs,
					perItemTimeoutMs,
					requiredRuntimes: ['bun'],
					skipReason: 'no test files discovered for surface',
				});
			} else {
				for (const file of uniqueFiles) {
					const base = itemForFile(root, file, testTimeoutMs, perItemTimeoutMs);
					items.push({ ...base, id: `${surface}:${base.file}`, surface });
				}
			}
			continue;
		}
		for (const definitionCommand of definition.commands ?? []) {
			items.push(commandItem(root, surface, {
				id: definitionCommand.id,
				argv: definitionCommand.argv(root),
				cwd: definitionCommand.cwd?.(root),
				requiredRuntimes: definitionCommand.requiredRuntimes,
			}, testTimeoutMs, perItemTimeoutMs));
		}
	}
	return items;
}

export const createSurfaceItems = buildSurfaceItems;

function discoveryFailureItem(
	root: string,
	surface: ValidationSurface,
	testTimeoutMs: number,
	perItemTimeoutMs: number,
	error: unknown,
): ValidationItem {
	return {
		id: `${surface}:discovery`,
		surface,
		file: `surface:${surface}/discovery`,
		argv: [],
		cwd: root,
		kind: 'surface',
		testTimeoutMs,
		perItemTimeoutMs,
		skipReason: `filesystem discovery failed: ${error instanceof Error ? error.message : String(error)}`,
	};
}

function changedTestFilesBySurface(root: string, changedPaths: string[]): {
	unit: string[];
	integration: string[];
} {
	const unit: string[] = [];
	const integration: string[] = [];
	for (const changedPath of changedPaths) {
		if (!changedPath.endsWith('.test.ts')) continue;
		const absolute = path.resolve(root, changedPath);
		const relative = path.relative(root, absolute);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
		const normalized = relative.split(path.sep).join('/');
		if (normalized.startsWith('tests/integration/') || normalized.startsWith('test/')) integration.push(absolute);
		else unit.push(absolute);
	}
	return {
		unit: Array.from(new Set(unit)).sort((a, b) => a.localeCompare(b)),
		integration: Array.from(new Set(integration)).sort((a, b) => a.localeCompare(b)),
	};
}

function diffCommandArgv(root: string, diffBase: string): string[] {
	return [resolveGitExecutable(), '-C', root, 'diff', '--name-only', `--diff-filter=${GIT_DIFF_FILTER}`, `${diffBase}...HEAD`];
}

interface BoundedReadResult {
	value: string;
	truncated: boolean;
	complete: boolean;
}

async function readBoundedWithStatus(
	stream: ReadableStream<Uint8Array> | null | undefined,
	maxBytes: number,
	deadlineMs = PROCESS_KILLER_TIMEOUT_MS,
	stopSignal?: AbortSignal,
): Promise<BoundedReadResult> {
	if (!stream) return { value: '', truncated: false, complete: true };
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let retained = 0;
	let truncated = false;
	let complete = false;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((resolve) => {
		deadlineTimer = setTimeout(() => {
			resolve();
		}, Math.max(1, deadlineMs));
	});
	let abortListener: (() => void) | undefined;
	const stopped = new Promise<void>((resolve) => {
		if (!stopSignal) return;
		abortListener = resolve;
		if (stopSignal.aborted) resolve();
		else stopSignal.addEventListener('abort', resolve, { once: true });
	});
	try {
		while (true) {
			const next = await Promise.race([
				reader.read().then(
					(value) => ({ kind: 'read' as const, value }),
					() => ({ kind: 'stopped' as const }),
				),
				deadline.then(() => ({ kind: 'deadline' as const })),
				stopped.then(() => ({ kind: 'stopped' as const })),
			]);
			if (next.kind !== 'read') {
				// Do not await cancellation: an inherited pipe can keep the reader's
				// promise pending even after the process tree has been killed or the
				// bounded stream deadline has elapsed.
				void reader.cancel().catch(() => undefined);
				break;
			}
			if (next.value.done) {
				complete = true;
				break;
			}
			if (!next.value.value) continue;
			const remaining = maxBytes - retained;
			if (remaining > 0) {
				const chunk = next.value.value.byteLength > remaining
					? next.value.value.subarray(0, remaining)
					: next.value.value;
				chunks.push(chunk);
				retained += chunk.byteLength;
			}
			if (next.value.value.byteLength > remaining) truncated = true;
		}
	} finally {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		if (stopSignal && abortListener) stopSignal.removeEventListener('abort', abortListener);
		// Cancellation is best-effort and deliberately not awaited; see above.
		void reader.cancel().catch(() => undefined);
	}
	const output = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
	return { value: output, truncated, complete };
}

async function readBounded(
	stream: ReadableStream<Uint8Array> | null | undefined,
	maxBytes: number,
	deadlineMs = PROCESS_KILLER_TIMEOUT_MS,
	stopSignal?: AbortSignal,
): Promise<string> {
	return (await readBoundedWithStatus(stream, maxBytes, deadlineMs, stopSignal)).value;
}

async function killProcessTree(child: { pid?: number; kill: (signal?: number | string) => void }, root: string): Promise<boolean> {
	let cleaned = true;
	try {
		if (child.pid && process.platform !== 'win32') {
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				// The process may have exited between the timer and this call.
			}
		} else if (child.pid && process.platform === 'win32') {
			const killer = Bun.spawn(['taskkill', '/T', '/F', '/PID', String(child.pid)], {
				cwd: root,
				stdin: 'ignore',
				stdout: 'ignore',
				stderr: 'ignore',
				timeout: PROCESS_KILLER_TIMEOUT_MS,
			});
			try {
				await Promise.race([
					killer.exited,
					new Promise<number>((resolve) => setTimeout(() => resolve(1), PROCESS_KILLER_TIMEOUT_MS)),
				]);
			} finally {
				try {
					killer.kill('SIGKILL');
				} catch {
					cleaned = false;
				}
			}
		}
	} catch {
		cleaned = false;
	} finally {
		try {
			child.kill('SIGKILL');
		} catch {
			cleaned = false;
		}
	}
	return cleaned;
}

async function runDefaultProcess(item: ValidationItem, options: RunProcessOptions): Promise<ValidationProcessResult> {
	if (item.kind === 'test' && !fs.existsSync(item.file)) {
		return {
			status: 'missing',
			exitCode: null,
			signal: null,
			cleanedUp: true,
			reason: 'discovered file was not present at execution time',
		};
	}

	const started = Date.now();
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(item.argv, {
			cwd: item.cwd,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			detached: true,
			// Keep Bun's native timeout as a kill-backup. The explicit timer below
			// owns classification so a native kill cannot race into `crashed`.
			timeout: options.perItemTimeoutMs + PROCESS_KILLER_TIMEOUT_MS,
		});
	} catch (error) {
		return {
			status: 'crashed',
			exitCode: null,
			signal: null,
			cleanedUp: true,
			reason: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - started,
		};
	}

	let timedOut = false;
	let cleanedUp = true;
	let treeCleanupSucceeded = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const outputStop = new AbortController();
	const timeout = new Promise<number>((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			void killProcessTree(child, options.root).then((succeeded) => {
				treeCleanupSucceeded = succeeded;
				outputStop.abort();
			}).finally(() => resolve(124));
		}, options.perItemTimeoutMs);
	});
	const stdoutPromise = readBounded(
		child.stdout,
		options.maxOutputBytes,
		options.perItemTimeoutMs + PROCESS_KILLER_TIMEOUT_MS,
		outputStop.signal,
	);
	const stderrPromise = readBounded(
		child.stderr,
		options.maxOutputBytes,
		options.perItemTimeoutMs + PROCESS_KILLER_TIMEOUT_MS,
		outputStop.signal,
	);
	let rawExitCode: number | null = null;
	try {
		rawExitCode = await Promise.race([child.exited, timeout]);
	} catch {
		rawExitCode = timedOut ? 124 : null;
	} finally {
		if (timer) clearTimeout(timer);
		try {
			child.kill('SIGKILL');
		} catch {
			if (timedOut) cleanedUp = false;
		}
	}
	if (timedOut && !treeCleanupSucceeded) cleanedUp = false;
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
	const signal = (child as unknown as { signalCode?: string | null }).signalCode ?? null;
	const durationMs = Date.now() - started;
	const abnormalExit = signal !== null || rawExitCode === null;
	return {
		status: timedOut ? 'timed_out' : abnormalExit ? 'crashed' : rawExitCode === 0 ? 'passed' : 'failed',
		exitCode: timedOut ? 124 : rawExitCode,
		signal: timedOut ? signal ?? 'SIGKILL' : signal,
		stdout: redactAndBound(stdout, options.maxOutputBytes),
		stderr: redactAndBound(stderr, options.maxOutputBytes),
		durationMs,
		cleanedUp,
	};
}

function statusResult(
	item: ValidationItem,
	result: ValidationProcessResult,
	startedAt: string | null,
	endedAt: string,
	maxOutputBytes: number,
): ValidationResult {
	let status = result.status;
	if (!TERMINAL_STATUSES.includes(status)) status = 'crashed';
	// A callback cannot promote a nonzero process to passed by returning a
	// contradictory status.  Failure terminals always remain failure terminals.
	if (status === 'passed' && (result.exitCode !== 0 || result.signal !== null)) {
		status = result.signal !== null ? 'crashed' : 'failed';
	}
	return {
		...result,
		status,
		id: item.id,
		surface: item.surface,
		file: item.file,
		argv: [...item.argv],
		cwd: item.cwd,
		kind: item.kind,
		startedAt,
		endedAt,
		stdout: redactAndBound(result.stdout ?? '', maxOutputBytes),
		stderr: redactAndBound(result.stderr ?? '', maxOutputBytes),
		durationMs: Number.isFinite(result.durationMs) && result.durationMs !== undefined ? result.durationMs : 0,
		cleanedUp: result.cleanedUp ?? false,
	};
}

function deadlineResult(item: ValidationItem, reason: string, maxOutputBytes: number): ValidationResult {
	const endedAt = new Date().toISOString();
	return statusResult(
		item,
		{
			status: 'timed_out',
			exitCode: 124,
			signal: 'SIGKILL',
			cleanedUp: true,
			reason,
		},
		null,
		endedAt,
		maxOutputBytes,
	);
}

function summarize(results: ValidationResult[]): ValidationSummary {
	const summary: ValidationSummary = {
		discovered: results.length,
		started: 0,
		completed: 0,
		passed: 0,
		failed: 0,
		crashed: 0,
		timedOut: 0,
		missing: 0,
		skipped: 0,
	};
	for (const result of results) {
		switch (result.status) {
			case 'passed':
				summary.started++;
				summary.completed++;
				summary.passed++;
				break;
			case 'failed':
				summary.started++;
				summary.completed++;
				summary.failed++;
				break;
			case 'crashed':
				summary.started++;
				summary.crashed++;
				break;
			case 'timed_out':
				summary.started++;
				summary.timedOut++;
				break;
			case 'missing':
				summary.missing++;
				break;
			case 'skipped':
				summary.skipped++;
				break;
		}
	}
	return summary;
}

function deriveStatus(mode: ValidationMode, summary: ValidationSummary): ValidationStatus {
	if (mode === 'diff' && summary.discovered === 0) return 'no_op';
	if (summary.discovered === 0) return 'failed';
	const hasIncompleteTerminals =
		summary.crashed > 0 ||
		summary.timedOut > 0 ||
		summary.missing > 0 ||
		summary.skipped > 0;
	// A run containing both an ordinary test failure and an unresolved terminal
	// is incomplete: the failed row is known, but the run cannot claim a
	// complete verdict while crash/timeout/missing/skipped work remains.
	if (hasIncompleteTerminals) return 'incomplete';
	if (summary.failed > 0 || summary.passed !== summary.discovered) return 'failed';
	return 'passed';
}

export async function validateRepository(options: ValidationOptions): Promise<ValidationReport> {
	const root = resolveRoot(options.root);
	const testTimeoutMs = positiveInteger(options.testTimeoutMs, DEFAULT_TEST_TIMEOUT_MS);
	const perItemTimeoutMs = positiveInteger(options.perItemTimeoutMs, DEFAULT_PER_ITEM_TIMEOUT_MS);
	const suiteTimeoutMs = positiveInteger(options.suiteTimeoutMs, DEFAULT_SUITE_TIMEOUT_MS);
	const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
	const diffBase = validateDiffBase(options.diffBase ?? DEFAULT_DIFF_BASE);
	const selectedSurfaces: ValidationSurface[] = options.surfaces
		? Array.from(new Set(options.surfaces))
		: options.testFiles !== undefined ? ['unit'] : [...SURFACE_INVENTORY];
	let items: ValidationItem[];
	if (options.mode === 'diff' && options.testFiles === undefined) {
		try {
			const changedPaths = await _internals.gitDiffPaths(root, diffBase);
			const changed = changedTestFilesBySurface(root, changedPaths);
			const changedTestsOnly = changedPaths.length > 0 &&
				changedPaths.every((entry) => entry.endsWith('.test.ts')) &&
				(changed.unit.length > 0 || changed.integration.length > 0);
			if (!changedPaths.length) {
				items = [];
			} else if (changedTestsOnly && selectedSurfaces.some((surface) => surface === 'unit' || surface === 'integration')) {
				items = [];
				if (selectedSurfaces.includes('unit') && changed.unit.length > 0) {
					items.push(...buildSurfaceItems({ root, surfaces: ['unit'], testFiles: changed.unit, testTimeoutMs, perItemTimeoutMs }));
				}
				if (selectedSurfaces.includes('integration') && changed.integration.length > 0) {
					items.push(...buildSurfaceItems({ root, surfaces: ['integration'], testFiles: changed.integration, testTimeoutMs, perItemTimeoutMs }));
				}
			} else {
				// Any non-test change conservatively runs the requested matrix. A
				// source/config/docs change must never be mistaken for a clean no-op.
				items = buildSurfaceItems({ root, surfaces: selectedSurfaces, testTimeoutMs, perItemTimeoutMs });
			}
		} catch (error) {
			items = [{
				id: 'diff:git-discovery',
				surface: 'unit',
				file: 'surface:diff/git-discovery',
				argv: diffCommandArgv(root, diffBase),
				cwd: root,
				kind: 'surface',
				testTimeoutMs,
				perItemTimeoutMs,
				skipReason: `git diff discovery failed: ${error instanceof Error ? error.message : String(error)}`,
			}];
		}
	} else {
		try {
			if (options.testFiles !== undefined && selectedSurfaces.every((surface) => surface === 'unit')) {
				items = createValidationItems({ root, testFiles: options.testFiles, testTimeoutMs, perItemTimeoutMs });
			} else {
				items = buildSurfaceItems({ root, surfaces: selectedSurfaces, testFiles: options.testFiles, testTimeoutMs, perItemTimeoutMs });
			}
		} catch (error) {
			items = [discoveryFailureItem(
				root,
				selectedSurfaces[0] ?? 'unit',
				testTimeoutMs,
				perItemTimeoutMs,
				error,
			)];
		}
	}
	const startedAt = new Date().toISOString();
	const startedClock = Date.now();
	const runProcess = options.runProcess ?? ((item: ValidationItem) =>
		runDefaultProcess(item, { root, maxOutputBytes, perItemTimeoutMs }));
	const results: ValidationResult[] = [];

	for (const item of items) {
		const missingRuntime = item.requiredRuntimes?.filter((runtime) => !_internals.runtimeAvailable(runtime)) ?? [];
		if (item.skipReason || missingRuntime.length > 0) {
			results.push(statusResult(item, {
				status: 'skipped',
				exitCode: null,
				signal: null,
				cleanedUp: true,
				reason: item.skipReason ?? `required runtime unavailable: ${missingRuntime.join(', ')}`,
			}, null, new Date().toISOString(), maxOutputBytes));
			continue;
		}
		if (Date.now() - startedClock >= suiteTimeoutMs) {
			results.push(deadlineResult(item, 'whole-run deadline elapsed before item start', maxOutputBytes));
			continue;
		}
		const itemStarted = new Date().toISOString();
		const itemStartClock = Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		try {
			const remainingSuiteMs = Math.max(1, suiteTimeoutMs - (Date.now() - startedClock));
			const timeoutMs = Math.min(perItemTimeoutMs, remainingSuiteMs);
			const usesInjectedRunner = options.runProcess !== undefined;
			const processResult = new Promise<ValidationProcessResult>((resolve, reject) => {
				const run = usesInjectedRunner
					? options.runProcess(item)
					: runDefaultProcess(item, { root, maxOutputBytes, perItemTimeoutMs: timeoutMs });
				Promise.resolve(run).then(resolve, reject);
			});
			let processResultValue: ValidationProcessResult;
			if (usesInjectedRunner) {
				const timeout = new Promise<ValidationProcessResult>((resolve) => {
					timer = setTimeout(() => {
						timedOut = true;
						resolve({
							status: 'timed_out',
							exitCode: 124,
							signal: 'SIGKILL',
							cleanedUp: false,
							reason: 'per-item or whole-run deadline elapsed',
							durationMs: Date.now() - itemStartClock,
						});
					}, timeoutMs);
				});
				processResultValue = await Promise.race([processResult, timeout]);
			} else {
				// The real runner owns its timeout and process-tree cleanup. Do not
				// let a duplicate outer timer publish a row before that cleanup ends.
				processResultValue = await processResult;
			}
			results.push(statusResult(item, processResultValue, itemStarted, new Date().toISOString(), maxOutputBytes));
		} catch (error) {
			results.push(
				statusResult(
					item,
					{
						status: timedOut ? 'timed_out' : 'crashed',
						exitCode: timedOut ? 124 : null,
						signal: timedOut ? 'SIGKILL' : null,
						cleanedUp: false,
						reason: error instanceof Error ? error.message : String(error),
						durationMs: Date.now() - itemStartClock,
					},
					itemStarted,
					new Date().toISOString(),
					maxOutputBytes,
				),
			);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	const summary = summarize(results);
	const endedAt = new Date().toISOString();
	const report: ValidationReport = {
		schemaVersion: 1,
		status: deriveStatus(options.mode, summary),
		mode: options.mode,
		root,
		diffBase,
		runtime: options.runtime ?? runtimeMetadata(),
		inventory: options.surfaces ? [...selectedSurfaces] : [...SURFACE_INVENTORY],
		bounds: { testTimeoutMs, perItemTimeoutMs, suiteTimeoutMs, maxOutputBytes },
		terminalStatuses: [...TERMINAL_STATUSES],
		summary,
		results,
		startedAt,
		endedAt,
		durationMs: Date.now() - startedClock,
	};
	if (options.reportPath) {
		report.reportPath = await writeValidationReport(report, options.reportPath);
	}
	return report;
}

function reportPathWithinRoot(root: string, requested?: string): string {
	const defaultPath = path.join(root, '.swarm', 'repository-validation.json');
	const destination = path.resolve(requested ?? defaultPath);
	const swarmRoot = path.resolve(root, '.swarm');
	const relative = path.relative(swarmRoot, destination);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`repository validation report must remain under ${swarmRoot}`);
	}
	return destination;
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

/** Reject symlink/junction components before any report write can follow them. */
async function assertSafeReportPath(root: string, destination: string): Promise<void> {
	const swarmRoot = path.resolve(root, '.swarm');
	const relative = path.relative(swarmRoot, destination);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`repository validation report must remain under ${swarmRoot}`);
	}

	let current = swarmRoot;
	let canonicalSwarmRoot: string | undefined;
	for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
		if (component) current = path.join(current, component);
		let stats: fs.Stats;
		try {
			stats = await fsp.lstat(current);
		} catch (error) {
			if (isNotFoundError(error)) break;
			throw error;
		}
		if (stats.isSymbolicLink()) {
			throw new Error(`repository validation report path contains a symlink or junction: ${current}`);
		}
		if (!canonicalSwarmRoot) canonicalSwarmRoot = await fsp.realpath(swarmRoot);
		const canonicalCurrent = await fsp.realpath(current);
		const canonicalRelative = path.relative(canonicalSwarmRoot, canonicalCurrent);
		if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
			throw new Error(`repository validation report path escapes ${swarmRoot}: ${current}`);
		}
	}
}

interface ReportLockOwner {
	pid: number;
	token: string;
	createdAt: number;
}

interface HeldReportLock {
	handle: fsp.FileHandle;
	token: string;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = typeof error === 'object' && error !== null && 'code' in error
			? (error as { code?: string }).code
			: undefined;
		// EPERM means the process exists but this host cannot probe it. Fail
		// closed and leave the lock in place rather than stealing live work.
		return code !== 'ESRCH';
	}
}

async function readReportLockOwner(lockPath: string): Promise<ReportLockOwner | null> {
	try {
		const raw = await fsp.readFile(lockPath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const owner = parsed as Partial<ReportLockOwner>;
		if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') return null;
		return {
			pid: owner.pid,
			token: owner.token,
			createdAt: typeof owner.createdAt === 'number' ? owner.createdAt : 0,
		};
	} catch {
		return null;
	}
}

async function reportLockIsStale(lockPath: string): Promise<boolean> {
	let stats: Awaited<ReturnType<typeof fsp.stat>>;
	try {
		stats = await fsp.stat(lockPath);
	} catch {
		return false;
	}
	const owner = await readReportLockOwner(lockPath);
	if (owner) return !isProcessAlive(owner.pid);
	return Date.now() - stats.mtimeMs >= REPORT_LOCK_STALE_AFTER_MS;
}

async function acquireReportLock(lockPath: string): Promise<HeldReportLock> {
	const started = Date.now();
	while (true) {
		let handle: fsp.FileHandle | undefined;
		try {
			handle = await fsp.open(lockPath, 'wx');
			const token = randomUUID();
			const owner: ReportLockOwner = { pid: process.pid, token, createdAt: Date.now() };
			await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
			return { handle, token };
		} catch (error) {
			if (handle) {
				await handle.close().catch(() => undefined);
				await fsp.unlink(lockPath).catch(() => undefined);
				throw error;
			}
			const code = typeof error === 'object' && error !== null && 'code' in error
				? (error as { code?: string }).code
				: undefined;
			if (code !== 'EEXIST') throw error;
			if (await reportLockIsStale(lockPath)) {
				await fsp.unlink(lockPath).catch(() => undefined);
				continue;
			}
			const elapsed = Date.now() - started;
			if (elapsed >= REPORT_LOCK_WAIT_MS) {
				throw new Error(`repository validation report lock busy: ${lockPath}`);
			}
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(REPORT_LOCK_RETRY_MS, REPORT_LOCK_WAIT_MS - elapsed)));
		}
	}
}

async function releaseReportLock(lockPath: string, lock: HeldReportLock): Promise<void> {
	await lock.handle.close().catch(() => undefined);
	const owner = await readReportLockOwner(lockPath);
	if (owner?.token === lock.token) await fsp.unlink(lockPath).catch(() => undefined);
}

export async function writeValidationReport(report: ValidationReport, requestedPath?: string): Promise<string> {
	const destination = reportPathWithinRoot(report.root, requestedPath);
	await assertSafeReportPath(report.root, destination);
	await fsp.mkdir(path.dirname(destination), { recursive: true });
	await assertSafeReportPath(report.root, destination);
	const lockPath = `${destination}.lock`;
	let lock: HeldReportLock | undefined;
	let temporaryPath: string | undefined;
	try {
		lock = await acquireReportLock(lockPath);
		temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
		await assertSafeReportPath(report.root, destination);
		const payload = `${JSON.stringify({ ...report, reportPath: destination }, null, 2)}\n`;
		await fsp.writeFile(temporaryPath, payload, { encoding: 'utf8', flag: 'wx' });
		await fsp.rename(temporaryPath, destination);
		return destination;
	} finally {
		if (lock) await releaseReportLock(lockPath, lock);
		if (temporaryPath) await fsp.unlink(temporaryPath).catch(() => undefined);
	}
}

export const writeValidationReportAtomic = writeValidationReport;

export function describeHistoricalCount(input: {
	completed: number;
	discovered: number;
	provenance: string | null;
}): string {
	const count = `${input.completed.toLocaleString('en-US')}/${input.discovered.toLocaleString('en-US')}`;
	if (!input.provenance) return `${count} (unconfirmed historical count; no retained raw provenance)`;
	return `${count} (confirmed result; provenance: ${input.provenance})`;
}

export function exitCodeForValidationStatus(status: ValidationStatus): number {
	return status === 'passed' || status === 'no_op' ? 0 : 1;
}

export interface ValidationCliOptions {
	root: string;
	mode: ValidationMode;
	diffBase: string;
	reportPath?: string;
	surfaces?: ValidationSurface[];
	testFiles: string[];
	testTimeoutMs: number;
	perItemTimeoutMs: number;
	suiteTimeoutMs: number;
	maxOutputBytes: number;
}

function parsePositiveIntegerOption(option: string, value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${option} requires a positive integer, got ${JSON.stringify(value)}`);
	}
	return parsed;
}

function parseSurface(value: string): ValidationSurface {
	if ((SURFACE_INVENTORY as readonly string[]).includes(value)) return value as ValidationSurface;
	throw new Error(`unknown validation surface: ${value}`);
}

export function parseValidationArgs(argv: string[]): ValidationCliOptions {
	let root = process.cwd();
	let mode: ValidationMode = 'full';
	let diffBase = DEFAULT_DIFF_BASE;
	let reportPath: string | undefined;
	const surfaces: ValidationSurface[] = [];
	let testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS;
	let perItemTimeoutMs = DEFAULT_PER_ITEM_TIMEOUT_MS;
	let suiteTimeoutMs = DEFAULT_SUITE_TIMEOUT_MS;
	let maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
	const testFiles: string[] = [];
	let positionalOnly = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === '--') {
			positionalOnly = true;
			continue;
		}
		if (positionalOnly) {
			testFiles.push(arg);
			continue;
		}
		if (!arg.startsWith('--')) {
			testFiles.push(arg);
			continue;
		}
		const equalsIndex = arg.indexOf('=');
		const option = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
		let value = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
		const takesValue = new Set([
			'--root', '--mode', '--diff-base', '--report', '--surface', '--surfaces',
			'--timeout', '--kill-timeout', '--suite-timeout', '--max-output-bytes',
		]);
		if (!takesValue.has(option)) throw new Error(`unknown validation option: ${arg}`);
		if (value === undefined) {
			value = argv[++index];
			if (value === undefined || value === '--' ||
				(value.startsWith('--') && !['--timeout', '--kill-timeout', '--suite-timeout', '--max-output-bytes'].includes(option))) {
				throw new Error(`${option} requires a value`);
			}
		}
		if (value.length === 0) throw new Error(`${option} requires a non-empty value`);
		switch (option) {
			case '--root':
				root = value;
				break;
			case '--mode':
				if (value !== 'full' && value !== 'diff') throw new Error(`--mode must be full or diff, got ${JSON.stringify(value)}`);
				mode = value;
				break;
			case '--diff-base':
				diffBase = validateDiffBase(value);
				break;
			case '--report':
				reportPath = value;
				break;
			case '--surface':
				surfaces.push(parseSurface(value));
				break;
			case '--surfaces':
				for (const surface of value.split(',')) {
					if (surface.length === 0) throw new Error('--surfaces contains an empty surface');
					surfaces.push(parseSurface(surface));
				}
				break;
			case '--timeout':
				testTimeoutMs = parsePositiveIntegerOption(option, value);
				break;
			case '--kill-timeout':
				perItemTimeoutMs = parsePositiveIntegerOption(option, value);
				break;
			case '--suite-timeout':
				suiteTimeoutMs = parsePositiveIntegerOption(option, value);
				break;
			case '--max-output-bytes':
				maxOutputBytes = parsePositiveIntegerOption(option, value);
				break;
			default:
				throw new Error(`unknown validation option: ${option}`);
		}
	}
	return {
		root,
		mode,
		diffBase,
		reportPath,
		surfaces: surfaces.length > 0 ? Array.from(new Set(surfaces)) : undefined,
		testFiles,
		testTimeoutMs,
		perItemTimeoutMs,
		suiteTimeoutMs,
		maxOutputBytes,
	};
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const parsed = parseValidationArgs(argv);
	const report = await validateRepository({
		...parsed,
		surfaces: parsed.surfaces,
		testFiles: parsed.testFiles.length > 0 ? parsed.testFiles : undefined,
	});
	const reportPath = report.reportPath ?? reportPathWithinRoot(report.root);
	if (!report.reportPath) await writeValidationReport(report, reportPath);
	console.log(JSON.stringify({
		status: report.status,
		summary: report.summary,
		report: reportPath,
	}, null, 2));
	return exitCodeForValidationStatus(report.status);
}

if (import.meta.main) {
	main().then((code) => process.exit(code)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
