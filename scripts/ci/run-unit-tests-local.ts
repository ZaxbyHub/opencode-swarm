#!/usr/bin/env bun
/**
 * Local CI-equivalent unit gate.
 *
 * Mirrors the GitHub Actions unit job's important semantics without depending
 * on Bash: discover unit test files, remove quarantined files, and run
 * each remaining file through run-test-with-timeout.ts with the same retry
 * budget used in CI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_RETRIES = 2;
const TEST_TIMEOUT_MS = '120000';
const KILL_TIMEOUT_SECONDS = '180';

function repoRelative(filePath: string): string {
	return filePath.split(path.sep).join('/');
}

function normalizeRequestedTest(filePath: string): string {
	return repoRelative(path.relative(process.cwd(), path.resolve(filePath)));
}

function walkTestFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...walkTestFiles(fullPath));
		} else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
			files.push(repoRelative(path.relative(process.cwd(), fullPath)));
		}
	}
	return files.sort();
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
	if (process.platform === 'darwin') {
		return 'scripts/ci/quarantined-tests-macos.txt';
	}
	if (process.platform === 'win32') {
		return 'scripts/ci/quarantined-tests-windows.txt';
	}
	return null;
}

function collectQuarantinedTests(): Set<string> {
	const files = ['scripts/ci/quarantined-tests.txt'];
	const platformFile = currentPlatformQuarantineFile();
	if (platformFile) files.push(platformFile);

	return new Set(
		files.flatMap((filePath) => readQuarantineFile(path.join(process.cwd(), filePath))),
	);
}

async function runOneTest(filePath: string): Promise<{
	exitCode: number;
	output: string;
}> {
	const wrapperPath = fileURLToPath(
		new URL('./run-test-with-timeout.ts', import.meta.url),
	);
	const child = Bun.spawn(
		[
			'bun',
			wrapperPath,
			filePath,
			'--timeout',
			TEST_TIMEOUT_MS,
			'--kill-timeout',
			KILL_TIMEOUT_SECONDS,
		],
		{
			cwd: process.cwd(),
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return {
		exitCode,
		output: [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n'),
	};
}

function collectAllTestFiles(): string[] {
	// Mirror the CI unit job's expanded glob (issue #1778 H4): src/** plus the
	// previously-orphaned test trees, EXCLUDING tests/integration, tests/security,
	// tests/smoke, and top-level test/ (owned by their own jobs).
	const roots = [
		'src',
		'tests/unit',
		'tests/adversarial',
		'tests/architect',
		'tests/cli',
		'tests/tools',
		'tests/helpers',
	];
	const collected = roots.flatMap((rel) => {
		const abs = path.join(process.cwd(), rel);
		return fs.existsSync(abs) ? walkTestFiles(abs) : [];
	});
	// Top-level tests/*.test.ts (non-recursive).
	const testsDir = path.join(process.cwd(), 'tests');
	if (fs.existsSync(testsDir)) {
		for (const entry of fs.readdirSync(testsDir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith('.test.ts')) {
				collected.push(
					repoRelative(
						path.relative(process.cwd(), path.join(testsDir, entry.name)),
					),
				);
			}
		}
	}
	return Array.from(new Set(collected)).sort();
}

async function main(): Promise<void> {
	const quarantined = collectQuarantinedTests();
	const requestedTests = process.argv.slice(2).map(normalizeRequestedTest);
	const allTests =
		requestedTests.length > 0 ? requestedTests.sort() : collectAllTestFiles();
	const gatedTests = allTests.filter((filePath) => !quarantined.has(filePath));

	if (gatedTests.length === 0) {
		console.error('No unit test files found after quarantine filtering.');
		process.exit(1);
	}

	console.log(
		`Running ${gatedTests.length} unit test file(s) individually (${quarantined.size} quarantined).`,
	);

	let failed = false;
	for (const filePath of gatedTests) {
		let result = await runOneTest(filePath);
		let attempt = 0;
		while (result.exitCode !== 0 && attempt < MAX_RETRIES) {
			attempt++;
			console.warn(
				`Attempt ${attempt} failed, retrying (${attempt}/${MAX_RETRIES}): ${filePath}`,
			);
			result = await runOneTest(filePath);
			if (result.exitCode === 0) {
				console.log(`Passed on retry ${attempt} (flaky): ${filePath}`);
			}
		}
		if (result.exitCode !== 0) {
			failed = true;
			console.error(`FAILED: ${filePath}`);
			if (result.output) {
				console.error(result.output);
			}
		} else {
			const timingLines = result.output
				.split(/\r?\n/)
				.filter((line) => line.startsWith('[TIMING]') || line.startsWith('[TIMEOUT]'));
			for (const line of timingLines) {
				console.log(line);
			}
		}
	}

	process.exit(failed ? 1 : 0);
}

main();
