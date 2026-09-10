#!/usr/bin/env bun
/**
 * Fail-closed verifier for issue #2675 validation reports.
 *
 * This is intentionally a small, dependency-free CI helper. It validates the
 * durable JSON reports produced by repository-validation.ts instead of trusting
 * shell exit markers or artifact counts alone.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const TERMINAL_STATUSES = new Set(['passed', 'failed', 'crashed', 'timed_out', 'missing', 'skipped']);
const RUN_STATUSES = new Set(['passed', 'failed', 'incomplete', 'no_op']);
const DEFAULT_BOUNDS = {
	testTimeoutMs: 120_000,
	perItemTimeoutMs: 180_000,
	suiteTimeoutMs: 900_000,
	maxOutputBytes: 65_536,
} as const;

export interface VerifyOptions {
	directory: string;
	root: string;
	surface: string;
	filePrefix?: string;
	artifactPrefix?: string;
	expectedOs?: string[];
	shards?: number;
	expectedFilesPath?: string;
	inventoryFileName?: string;
	allowForeignRoots?: boolean;
}

interface JsonReport {
	schemaVersion?: unknown;
	status?: unknown;
	mode?: unknown;
	root?: unknown;
	diffBase?: unknown;
	runtime?: {
		bunVersion?: unknown;
		platform?: unknown;
		arch?: unknown;
	};
	inventory?: unknown;
	bounds?: Partial<typeof DEFAULT_BOUNDS>;
	terminalStatuses?: unknown;
	startedAt?: unknown;
	endedAt?: unknown;
	durationMs?: unknown;
	results?: JsonResult[];
	summary?: Record<string, unknown>;
}

interface JsonResult {
	id?: unknown;
	surface?: unknown;
	file?: unknown;
	status?: unknown;
	exitCode?: unknown;
	signal?: unknown;
	argv?: unknown;
	cwd?: unknown;
	startedAt?: unknown;
	endedAt?: unknown;
	durationMs?: unknown;
	cleanedUp?: unknown;
	stdout?: unknown;
	stderr?: unknown;
}

function fail(message: string): never {
	throw new Error(message);
}

function positiveInteger(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) fail(`${option} requires a positive integer`);
	return parsed;
}

function normalizeIdentity(root: string, filePath: string): string {
	return path.normalize(path.resolve(root, filePath.replace(/\\/g, '/')));
}

function isAbsolutePath(value: string): boolean {
	return path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function sameReportedPath(left: string, right: string): boolean {
	const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
	const normalizedLeft = normalize(left);
	const normalizedRight = normalize(right);
	if (path.win32.isAbsolute(left) || path.win32.isAbsolute(right)) {
		return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
	}
	return normalizedLeft === normalizedRight;
}

function relativeReportedPath(root: string, file: string): string {
	const windowsRoot = path.win32.isAbsolute(root);
	const rootPath = windowsRoot ? path.win32.normalize(root) : path.resolve(root);
	const filePath = windowsRoot ? path.win32.resolve(rootPath, file) : path.resolve(rootPath, file);
	const relative = windowsRoot ? path.win32.relative(rootPath, filePath) : path.relative(rootPath, filePath);
	if (!relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) || relative.startsWith('../') || relative.startsWith('..\\')) {
		fail(`result file escapes report root: ${file}`);
	}
	return relative;
}

function validTimestamp(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function jsonFiles(directory: string): string[] {
	if (!fs.existsSync(directory)) fail(`report directory does not exist: ${directory}`);
	const files: string[] = [];
	const visit = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) visit(fullPath);
			else if (entry.isFile() && entry.name.endsWith('.json')) files.push(fullPath);
		}
	};
	visit(directory);
	return files.sort();
}

function expectedEntries(root: string, expectedFilesPath: string, label: string, requireSorted = false): string[] {
	if (!fs.existsSync(expectedFilesPath)) fail(`${label} does not exist: ${expectedFilesPath}`);
	const rawValues = fs
		.readFileSync(expectedFilesPath, 'utf8')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('#'))
		.map((filePath) => normalizeIdentity(root, filePath));
	const values = new Set<string>();
	for (const value of rawValues) {
		if (values.has(value)) fail(`duplicate expected file in ${label}: ${value}`);
		values.add(value);
	}
	if (requireSorted) {
		const sorted = [...rawValues].sort((left, right) => left.localeCompare(right));
		if (rawValues.some((value, index) => value !== sorted[index])) fail(`${label} is not sorted`);
	}
	return rawValues;
}

function expectedFiles(root: string, expectedFilesPath?: string): Set<string> | undefined {
	if (!expectedFilesPath) return undefined;
	return new Set(expectedEntries(root, expectedFilesPath, 'expected file list'));
}

function compareFileSets(actual: Set<string>, expected: Set<string>, label: string): void {
	if (actual.size !== expected.size) fail(`${label} size mismatch: expected ${expected.size}, found ${actual.size}`);
	for (const value of expected) if (!actual.has(value)) fail(`${label} missing ${value}`);
	for (const value of actual) if (!expected.has(value)) fail(`${label} contains unexpected ${value}`);
}

function artifactCoordinates(artifact: string, prefix: string): { os: string; shard: number } {
	const remainder = artifact.slice(prefix.length);
	const match = remainder.match(/^(.*)-(\d+)$/);
	if (!match || !match[1]) fail(`artifact has no OS/shard coordinates: ${artifact}`);
	return { os: match[1], shard: Number(match[2]) };
}

function expectedStatus(results: JsonResult[], mode: unknown): string {
	const passed = results.filter((result) => result.status === 'passed').length;
	const failed = results.filter((result) => result.status === 'failed').length;
	const incomplete = results.some((result) =>
		result.status === 'crashed' || result.status === 'timed_out' || result.status === 'missing' || result.status === 'skipped',
	);
	if (mode === 'diff' && results.length === 0) return 'no_op';
	if (results.length === 0) return 'failed';
	if (incomplete) return 'incomplete';
	if (failed > 0 || passed !== results.length) return 'failed';
	return 'passed';
}

function validateSummary(report: JsonReport, results: JsonResult[], reportPath: string): void {
	if (!report.summary || typeof report.summary !== 'object') fail(`missing summary: ${reportPath}`);
	const counts = {
		discovered: results.length,
		started: results.filter((result) => ['passed', 'failed', 'crashed', 'timed_out'].includes(String(result.status))).length,
		completed: results.filter((result) => ['passed', 'failed'].includes(String(result.status))).length,
		passed: results.filter((result) => result.status === 'passed').length,
		failed: results.filter((result) => result.status === 'failed').length,
		crashed: results.filter((result) => result.status === 'crashed').length,
		timedOut: results.filter((result) => result.status === 'timed_out').length,
		missing: results.filter((result) => result.status === 'missing').length,
		skipped: results.filter((result) => result.status === 'skipped').length,
	};
	for (const [key, value] of Object.entries(counts)) {
		if (report.summary[key] !== value) fail(`summary.${key} mismatch in ${reportPath}: expected ${value}, got ${String(report.summary[key])}`);
	}
	if (report.status !== expectedStatus(results, report.mode)) fail(`run status mismatch in ${reportPath}`);
}

function validateReport(
	reportPath: string,
	options: VerifyOptions,
	seenIds: Set<string>,
	seenFiles: Set<string>,
): JsonResult[] {
	let report: JsonReport;
	try {
		report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as JsonReport;
	} catch (error) {
		fail(`invalid JSON report ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (report.schemaVersion !== 1) fail(`unsupported schemaVersion in ${reportPath}`);
	if (!RUN_STATUSES.has(String(report.status))) fail(`invalid run status in ${reportPath}`);
	if (report.status !== 'passed') fail(`validation report is not passed in ${reportPath}`);
	if (report.mode !== 'full') fail(`CI report must be full mode: ${reportPath}`);
	if (typeof report.root !== 'string' || !isAbsolutePath(report.root) || (!options.allowForeignRoots && !sameReportedPath(report.root, options.root))) {
		fail(`wrong report root in ${reportPath}`);
	}
	if (report.diffBase !== 'origin/main') fail(`CI report must use origin/main: ${reportPath}`);
	if (
		!report.runtime ||
		typeof report.runtime.bunVersion !== 'string' ||
		report.runtime.bunVersion.length === 0 ||
		typeof report.runtime.platform !== 'string' ||
		report.runtime.platform.length === 0 ||
		typeof report.runtime.arch !== 'string' ||
		report.runtime.arch.length === 0
	) {
		fail(`missing runtime metadata in ${reportPath}`);
	}
	if (!Array.isArray(report.inventory) || !report.inventory.includes(options.surface)) fail(`surface missing from inventory in ${reportPath}`);
	if (
		!Array.isArray(report.terminalStatuses) ||
		report.terminalStatuses.length !== TERMINAL_STATUSES.size ||
		new Set(report.terminalStatuses).size !== TERMINAL_STATUSES.size ||
		report.terminalStatuses.some((status) => typeof status !== 'string' || !TERMINAL_STATUSES.has(status))
	) {
		fail(`invalid terminalStatuses schema in ${reportPath}`);
	}
	if (!validTimestamp(report.startedAt) || !validTimestamp(report.endedAt) || typeof report.durationMs !== 'number' || !Number.isFinite(report.durationMs) || report.durationMs < 0) {
		fail(`invalid report timing schema in ${reportPath}`);
	}
	if (!report.bounds || Object.entries(DEFAULT_BOUNDS).some(([key, value]) => report.bounds?.[key as keyof typeof DEFAULT_BOUNDS] !== value)) {
		fail(`default bounds mismatch in ${reportPath}`);
	}
	if (!Array.isArray(report.results) || report.results.length !== 1) fail(`expected exactly one result row in ${reportPath}`);
	const results = report.results;
	for (const result of results) {
		if (result.surface !== options.surface) fail(`wrong surface in ${reportPath}`);
		if (typeof result.id !== 'string' || seenIds.has(result.id)) fail(`duplicate or missing result id in ${reportPath}`);
		seenIds.add(result.id);
		if (typeof result.file !== 'string') fail(`missing result file in ${reportPath}`);
		if (typeof result.cwd !== 'string' || !sameReportedPath(result.cwd, report.root as string)) fail(`wrong cwd in ${reportPath}`);
		const identity = normalizeIdentity(options.root, relativeReportedPath(report.root as string, result.file));
		if (seenFiles.has(identity)) fail(`duplicate result file ${result.file}`);
		seenFiles.add(identity);
		if (!TERMINAL_STATUSES.has(String(result.status))) fail(`invalid terminal status in ${reportPath}`);
		if ((result.startedAt !== null && !validTimestamp(result.startedAt)) || !validTimestamp(result.endedAt)) {
			fail(`invalid result timing schema in ${reportPath}`);
		}
		if (typeof result.durationMs !== 'number' || !Number.isFinite(result.durationMs) || result.durationMs < 0) {
			fail(`invalid result duration schema in ${reportPath}`);
		}
		if (!Array.isArray(result.argv) || result.argv.length === 0) fail(`missing argv in ${reportPath}`);
		if (typeof result.cleanedUp !== 'boolean') fail(`missing cleanup result in ${reportPath}`);
		if (result.status === 'passed' && result.cleanedUp !== true) fail(`passed result was not cleaned up in ${reportPath}`);
		for (const output of [result.stdout, result.stderr]) {
			if (typeof output === 'string' && Buffer.byteLength(output, 'utf8') > DEFAULT_BOUNDS.maxOutputBytes) fail(`unbounded output in ${reportPath}`);
		}
	}
	validateSummary(report, results, reportPath);
	return results;
}

function parseArgs(argv: string[]): VerifyOptions {
	let directory = '.swarm/repository-validation';
	let root = process.cwd();
	let surface = '';
	let filePrefix: string | undefined;
	let artifactPrefix: string | undefined;
	let expectedOs: string[] | undefined;
	let shards: number | undefined;
	let expectedFilesPath: string | undefined;
	let inventoryFileName: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const option = argv[index];
		const value = argv[++index];
		if (!value || value.startsWith('--')) fail(`${option} requires a value`);
		switch (option) {
			case '--directory': directory = value; break;
			case '--root': root = value; break;
			case '--surface': surface = value; break;
			case '--file-prefix': filePrefix = value; break;
			case '--artifact-prefix': artifactPrefix = value; break;
			case '--expected-os': expectedOs = value.split(',').filter(Boolean); break;
			case '--shards': shards = positiveInteger(value, option); break;
			case '--expected-files': expectedFilesPath = value; break;
			case '--inventory-file': inventoryFileName = value; break;
			default: fail(`unknown verifier option: ${option}`);
		}
	}
	if (!surface) fail('--surface is required');
	if (artifactPrefix && (!expectedOs || !shards)) fail('--artifact-prefix requires --expected-os and --shards');
	return { directory: path.resolve(directory), root: path.resolve(root), surface, filePrefix, artifactPrefix, expectedOs, shards, expectedFilesPath, inventoryFileName };
}

export function verifyReports(options: VerifyOptions): { reports: number; results: number } {
	const expected = expectedFiles(options.root, options.expectedFilesPath);
	if (options.artifactPrefix) {
		const expectedArtifacts = new Set(
			options.expectedOs!.flatMap((os) => Array.from({ length: options.shards! }, (_, index) => `${options.artifactPrefix}${os}-${index + 1}`)),
		);
		const artifacts = fs.readdirSync(options.directory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(options.artifactPrefix!))
			.map((entry) => entry.name);
		for (const artifact of expectedArtifacts) if (!artifacts.includes(artifact)) fail(`missing validation artifact: ${artifact}`);
		for (const artifact of artifacts) if (!expectedArtifacts.has(artifact)) fail(`unexpected validation artifact: ${artifact}`);
		const inventoryFileName = options.inventoryFileName ?? 'unit-inventory.txt';
		const canonicalInventoryByOs = new Map<string, string[]>();
		const seenIdsByOs = new Map<string, Set<string>>();
		const seenFilesByOs = new Map<string, Set<string>>();
		let reportCount = 0;
		let resultCount = 0;
		for (const artifact of artifacts.sort()) {
			const artifactDirectory = path.join(options.directory, artifact);
			const { os, shard } = artifactCoordinates(artifact, options.artifactPrefix!);
			const inventory = expectedEntries(options.root, path.join(artifactDirectory, inventoryFileName), `${artifact} canonical inventory`, true);
			const canonicalInventory = canonicalInventoryByOs.get(os);
			if (!canonicalInventory) canonicalInventoryByOs.set(os, inventory);
			else if (inventory.length !== canonicalInventory.length || inventory.some((filePath, index) => filePath !== canonicalInventory[index])) {
				fail(`canonical inventory differs across ${os} validation artifacts: ${artifact}`);
			}
			const seenIds = seenIdsByOs.get(os) ?? new Set<string>();
			const seenFiles = seenFilesByOs.get(os) ?? new Set<string>();
			seenIdsByOs.set(os, seenIds);
			seenFilesByOs.set(os, seenFiles);
			const expectedShard = new Set(inventory.filter((_filePath, index) => index % options.shards! === shard - 1));
			const shardManifest = expectedEntries(options.root, path.join(artifactDirectory, `unit-shard-${shard}-expected-files.txt`), `${artifact} shard manifest`, true);
			compareFileSets(new Set(shardManifest), expectedShard, `${artifact} shard manifest`);
			const reportPaths = jsonFiles(artifactDirectory);
			if (reportPaths.length === 0) fail(`no validation JSON reports found in ${artifact}`);
			const results = reportPaths.flatMap((reportPath) => validateReport(reportPath, { ...options, allowForeignRoots: true }, seenIds, seenFiles));
			const actualShard = new Set(results.map((result) => normalizeIdentity(options.root, relativeReportedPath(result.cwd as string, result.file as string))));
			compareFileSets(actualShard, expectedShard, `${artifact} report identities`);
			reportCount += reportPaths.length;
			resultCount += results.length;
		}
		if (canonicalInventoryByOs.size === 0) fail('no canonical unit inventory found');
		for (const [os, inventory] of canonicalInventoryByOs) {
			compareFileSets(seenFilesByOs.get(os) ?? new Set<string>(), new Set(inventory), `${os} aggregate report identities`);
		}
		return { reports: reportCount, results: resultCount };
	} else {
		const seenIds = new Set<string>();
		const seenFiles = new Set<string>();
		const reportPaths = jsonFiles(options.directory).filter((filePath) => !options.filePrefix || path.basename(filePath).startsWith(options.filePrefix));
		if (reportPaths.length === 0) fail('no validation JSON reports found');
		const results = reportPaths.flatMap((reportPath) => validateReport(reportPath, options, seenIds, seenFiles));
		if (expected) compareFileSets(seenFiles, expected, 'report identities');
		return { reports: reportPaths.length, results: results.length };
	}
}

export function main(argv = process.argv.slice(2)): number {
	try {
		const summary = verifyReports(parseArgs(argv));
		console.log(JSON.stringify({ status: 'passed', ...summary }));
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (import.meta.main) process.exit(main());
