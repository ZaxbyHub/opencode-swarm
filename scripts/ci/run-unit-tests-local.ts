#!/usr/bin/env bun
/**
 * Compatibility entry point for the historical `test:unit:ci` command.
 *
 * The repository-validation module owns discovery, process execution, terminal
 * statuses, bounds, and report semantics. This caller only retains the old
 * positional-file, quarantine, and bounded-retry behavior used by local users.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildSurfaceItems,
	DEFAULT_MAX_OUTPUT_BYTES,
	DEFAULT_PER_ITEM_TIMEOUT_MS,
	DEFAULT_SUITE_TIMEOUT_MS,
	DEFAULT_TEST_TIMEOUT_MS,
	exitCodeForValidationStatus,
	validateRepository,
	type ValidationReport,
} from './repository-validation';

const MAX_RETRIES = 2;

function repoRelative(filePath: string): string {
	return filePath.split(path.sep).join('/');
}

function normalizeRequestedTest(filePath: string, root: string): string {
	return repoRelative(path.relative(root, path.resolve(root, filePath)));
}

function readQuarantineFile(filePath: string): string[] {
	if (!fs.existsSync(filePath)) return [];
	return fs
		.readFileSync(filePath, 'utf8')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('#'))
		.map((line) => line.replace(/\\/g, '/'));
}

function currentPlatformQuarantineFile(): string | null {
	if (process.platform === 'darwin') return 'scripts/ci/quarantined-tests-macos.txt';
	if (process.platform === 'win32') return 'scripts/ci/quarantined-tests-windows.txt';
	return null;
}

function collectQuarantinedTests(root: string): Set<string> {
	const files = ['scripts/ci/quarantined-tests.txt'];
	const platformFile = currentPlatformQuarantineFile();
	if (platformFile) files.push(platformFile);
	return new Set(files.flatMap((filePath) => readQuarantineFile(path.join(root, filePath))));
}

function collectAllTestFiles(root: string): string[] {
	// The shared authority owns the expanded CI unit roots and deterministic
	// discovery. Keep only test items here; surface command items are not part
	// of this historical compatibility entry point.
	return buildSurfaceItems({ root, surfaces: ['unit'] })
		.filter((item) => item.kind === 'test')
		.map((item) => repoRelative(path.relative(root, item.file)))
		.sort();
}

async function runOneTest(root: string, filePath: string): Promise<ValidationReport> {
	return validateRepository({
		root,
		mode: 'full',
		surfaces: ['unit'],
		testFiles: [filePath],
		testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
		perItemTimeoutMs: DEFAULT_PER_ITEM_TIMEOUT_MS,
		suiteTimeoutMs: DEFAULT_SUITE_TIMEOUT_MS,
		maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
	});
}

function reportOutput(report: ValidationReport): string {
	return report.results
		.flatMap((result) => [result.stdout ?? '', result.stderr ?? '', result.reason ?? ''])
		.filter(Boolean)
		.join('\n');
}

async function main(): Promise<void> {
	const root = process.cwd();
	const quarantined = collectQuarantinedTests(root);
	const requestedTests = process.argv.slice(2).map((filePath) => normalizeRequestedTest(filePath, root));
	const allTests = requestedTests.length > 0 ? requestedTests.sort() : collectAllTestFiles(root);
	const gatedTests = allTests.filter((filePath) => !quarantined.has(filePath));

	if (gatedTests.length === 0) {
		console.error('No unit test files found after quarantine filtering.');
		process.exit(1);
	}

	console.log(`Running ${gatedTests.length} unit test file(s) individually (${quarantined.size} quarantined).`);
	let failed = false;
	for (const filePath of gatedTests) {
		let report = await runOneTest(root, filePath);
		let attempt = 0;
		while (exitCodeForValidationStatus(report.status) !== 0 && attempt < MAX_RETRIES) {
			attempt++;
			console.warn(`Attempt ${attempt} failed, retrying (${attempt}/${MAX_RETRIES}): ${filePath}`);
			report = await runOneTest(root, filePath);
			if (exitCodeForValidationStatus(report.status) === 0) console.log(`Passed on retry ${attempt} (flaky): ${filePath}`);
		}
		if (exitCodeForValidationStatus(report.status) !== 0) {
			failed = true;
			console.error(`FAILED: ${filePath}`);
			const output = reportOutput(report);
			if (output) console.error(output);
		} else {
			for (const result of report.results) {
				if (result.durationMs !== undefined) console.log(`[TIMING] ${JSON.stringify({ file: filePath, durationMs: result.durationMs, status: result.status })}`);
			}
		}
	}
	process.exit(failed ? 1 : 0);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
