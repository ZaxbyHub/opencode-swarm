import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { isCommandAvailable } from '../build/discovery';
import { analyzeImpact } from '../test-impact/analyzer.js';
import { classifyAndCluster } from '../test-impact/failure-classifier.js';
import {
	detectFlakyTests,
	type FlakyTestEntry,
} from '../test-impact/flaky-detector.js';
import { appendTestRun, getAllHistory } from '../test-impact/history-store.js';
import { bunSpawn } from '../utils/bun-compat';
import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

// ============ Constants ============
export const MAX_OUTPUT_BYTES = 512_000; // 512KB max output
export const MAX_COMMAND_LENGTH = 500;
export const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds default
export const MAX_TIMEOUT_MS = 300_000; // 5 minutes max
export const MAX_SAFE_TEST_FILES = 50; // Maximum resolved test files allowed in interactive session
export const MAX_SAFE_SOURCE_FILES = 1; // Maximum source files allowed for graph/impact scopes (>1 fans out to too many test files)

// Supported test frameworks
export const SUPPORTED_FRAMEWORKS = [
	'bun',
	'vitest',
	'jest',
	'mocha',
	'pytest',
	'cargo',
	'pester',
	'go-test',
	'maven',
	'gradle',
	'dotnet-test',
	'ctest',
	'swift-test',
	'dart-test',
	'rspec',
	'minitest',
] as const;

export type TestFramework = (typeof SUPPORTED_FRAMEWORKS)[number] | 'none';

// ============ Input Types ============
export interface TestRunnerArgs {
	scope?: 'all' | 'convention' | 'graph' | 'impact';
	files?: string[];
	coverage?: boolean;
	timeout_ms?: number;
	allow_full_suite?: boolean;
}

// ============ Response Types ============
export type RegressionOutcome =
	| 'pass' // tests ran and all passed
	| 'skip' // no test files resolved — nothing to run
	| 'regression' // tests ran and one or more failed
	| 'scope_exceeded' // resolved file count exceeded MAX_SAFE_TEST_FILES
	| 'error'; // unrecoverable tool error

export interface TestTotals {
	passed: number;
	failed: number;
	skipped: number;
	total: number;
}

export interface TestSuccessResult {
	success: true;
	framework: TestFramework;
	scope: 'all' | 'convention' | 'graph' | 'impact';
	command: string[];
	timeout_ms: number;
	duration_ms: number;
	totals: TestTotals;
	coveragePercent?: number;
	rawOutput?: string;
	message?: string;
	outcome?: RegressionOutcome;
}

export interface TestErrorResult {
	success: false;
	framework: TestFramework;
	scope: 'all' | 'convention' | 'graph' | 'impact';
	command?: string[];
	timeout_ms?: number;
	duration_ms?: number;
	totals?: TestTotals;
	coveragePercent?: number;
	error: string;
	rawOutput?: string;
	message?: string;
	outcome?: RegressionOutcome;
	attempted_scope?: 'graph';
}

export type TestResult = TestSuccessResult | TestErrorResult;

// ============ Validation ============

function isAbsolutePath(str: string): boolean {
	// Unix absolute path
	if (str.startsWith('/')) return true;

	// Windows drive letter (C:\, D:/, etc.)
	if (/^[a-zA-Z]:[/\\]/.test(str)) return true;

	// Windows UNC path
	if (/^\\\\/.test(str)) return true;

	// Windows device path (\\.\)
	if (/^\\\\\.\\/.test(str)) return true;

	return false;
}

// PowerShell metacharacters that could enable command injection
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security validation pattern
const POWERSHELL_METACHARACTERS = /[|;&`$(){}[\]<>"'#*?\x00-\x1f]/;

function containsPowerShellMetacharacters(str: string): boolean {
	return POWERSHELL_METACHARACTERS.test(str);
}

function validateArgs(args: unknown): args is TestRunnerArgs {
	if (typeof args !== 'object' || args === null) return false;
	const obj = args as Record<string, unknown>;

	// Validate scope
	if (obj.scope !== undefined) {
		if (
			obj.scope !== 'all' &&
			obj.scope !== 'convention' &&
			obj.scope !== 'graph' &&
			obj.scope !== 'impact'
		) {
			return false;
		}
	}

	// Validate files
	if (obj.files !== undefined) {
		if (!Array.isArray(obj.files)) return false;
		for (const f of obj.files) {
			if (typeof f !== 'string') return false;
			// Reject absolute paths
			if (isAbsolutePath(f)) return false;
			// Check for path traversal attempts (including encoded)
			if (containsPathTraversal(f)) return false;
			// Check for control characters (including LF/CR)
			if (containsControlChars(f)) return false;
			// Check for PowerShell metacharacters that could enable injection
			if (containsPowerShellMetacharacters(f)) return false;
		}
	}

	// Validate coverage
	if (obj.coverage !== undefined) {
		if (typeof obj.coverage !== 'boolean') return false;
	}

	// Validate timeout
	if (obj.timeout_ms !== undefined) {
		if (typeof obj.timeout_ms !== 'number') return false;
		if (obj.timeout_ms < 0 || obj.timeout_ms > MAX_TIMEOUT_MS) return false;
	}

	return true;
}

// ============ Framework Detection ============
function hasPackageJsonDependency(
	deps: Record<string, string>,
	...patterns: string[]
): boolean {
	for (const pattern of patterns) {
		if (deps[pattern]) return true;
	}
	return false;
}

function hasDevDependency(
	devDeps: Record<string, string> | undefined,
	...patterns: string[]
): boolean {
	if (!devDeps) return false;
	return hasPackageJsonDependency(devDeps, ...patterns);
}

// ============ Additional Test Framework Detectors ============

/** Detect Go test runner (go test ./...) */
function detectGoTest(cwd: string): boolean {
	// check: go.mod exists AND go binary on PATH
	return fs.existsSync(path.join(cwd, 'go.mod')) && isCommandAvailable('go');
}

/** Detect Java/Maven test runner (mvn test) */
function detectJavaMaven(cwd: string): boolean {
	// check: pom.xml exists AND mvn binary on PATH
	return fs.existsSync(path.join(cwd, 'pom.xml')) && isCommandAvailable('mvn');
}

/** Detect Java/Gradle or Kotlin/Gradle test runner (gradlew test) */
function detectGradle(cwd: string): boolean {
	// check: build.gradle or build.gradle.kts exists AND (gradlew script OR gradle binary)
	const hasBuildFile =
		fs.existsSync(path.join(cwd, 'build.gradle')) ||
		fs.existsSync(path.join(cwd, 'build.gradle.kts'));
	const hasGradlew =
		fs.existsSync(path.join(cwd, 'gradlew')) ||
		fs.existsSync(path.join(cwd, 'gradlew.bat'));
	return hasBuildFile && (hasGradlew || isCommandAvailable('gradle'));
}

/** Detect C#/.NET test runner (dotnet test) */
function detectDotnetTest(cwd: string): boolean {
	// check: any .csproj file exists AND dotnet binary on PATH
	try {
		const files = fs.readdirSync(cwd);
		const hasCsproj = files.some((f) => f.endsWith('.csproj'));
		return hasCsproj && isCommandAvailable('dotnet');
	} catch {
		return false;
	}
}

/** Detect C/C++ CTest runner */
function detectCTest(cwd: string): boolean {
	// ctest works from build directory; accept both source and build directories
	const hasSource = fs.existsSync(path.join(cwd, 'CMakeLists.txt'));
	const hasBuildCache =
		fs.existsSync(path.join(cwd, 'CMakeCache.txt')) ||
		fs.existsSync(path.join(cwd, 'build', 'CMakeCache.txt'));
	return (hasSource || hasBuildCache) && isCommandAvailable('ctest');
}

/** Detect Swift test runner (swift test) */
function detectSwiftTest(cwd: string): boolean {
	// check: Package.swift exists AND swift binary on PATH
	return (
		fs.existsSync(path.join(cwd, 'Package.swift')) &&
		isCommandAvailable('swift')
	);
}

/** Detect Dart/Flutter test runner (dart test or flutter test) */
function detectDartTest(cwd: string): boolean {
	// check: pubspec.yaml exists AND (dart or flutter binary on PATH)
	return (
		fs.existsSync(path.join(cwd, 'pubspec.yaml')) &&
		(isCommandAvailable('dart') || isCommandAvailable('flutter'))
	);
}

/** Detect Ruby/RSpec test runner */
function detectRSpec(cwd: string): boolean {
	// Require .rspec file OR (Gemfile + spec/ dir) for Ruby specificity
	const hasRSpecFile = fs.existsSync(path.join(cwd, '.rspec'));
	const hasGemfile = fs.existsSync(path.join(cwd, 'Gemfile'));
	const hasSpecDir = fs.existsSync(path.join(cwd, 'spec'));
	const hasRSpec = hasRSpecFile || (hasGemfile && hasSpecDir);
	return (
		hasRSpec && (isCommandAvailable('bundle') || isCommandAvailable('rspec'))
	);
}

/** Detect Ruby/Minitest test runner */
function detectMinitest(cwd: string): boolean {
	// Require test/ dir + Ruby-specific markers (Gemfile or Rakefile)
	return (
		fs.existsSync(path.join(cwd, 'test')) &&
		(fs.existsSync(path.join(cwd, 'Gemfile')) ||
			fs.existsSync(path.join(cwd, 'Rakefile'))) &&
		isCommandAvailable('ruby')
	);
}

/**
 * Phase 3 dispatch path: detect the test framework via the
 * `LanguageBackend` registry from `src/lang/dispatch.ts`. Currently
 * opt-in via `SWARM_LANG_BACKEND=dispatch`; default remains the legacy
 * `detectTestFramework` switch below. A future Phase 3b will flip the
 * default and the env var becomes `SWARM_LANG_BACKEND=legacy` for
 * one-release rollback.
 *
 * Maps `TestFrameworkSelection.name` (which mirrors the names in each
 * profile's `test.frameworks[*].name`) back to the legacy `TestFramework`
 * union string this function exists to produce. Names not in the
 * union (e.g. PHP's "Pest"/"PHPUnit") collapse to `'none'`, preserving
 * pre-Phase-3 behavior for languages whose tests the legacy path
 * couldn't detect either.
 */
const DISPATCH_FRAMEWORK_MAP: Record<string, TestFramework> = {
	'bun:test': 'bun',
	bun: 'bun',
	vitest: 'vitest',
	jest: 'jest',
	mocha: 'mocha',
	pytest: 'pytest',
	'cargo test': 'cargo',
	cargo: 'cargo',
	pester: 'pester',
	'go test': 'go-test',
	'maven-test': 'maven',
	'gradle-test': 'gradle',
	'gradle-test-groovy': 'gradle',
	'gradle-kts': 'gradle',
	'dotnet test': 'dotnet-test',
	ctest: 'ctest',
	'swift test': 'swift-test',
	'xcodebuild-test': 'swift-test',
	'flutter test': 'dart-test',
	'dart test': 'dart-test',
	rspec: 'rspec',
	minitest: 'minitest',
};

export async function detectTestFrameworkViaDispatch(
	cwd: string,
): Promise<TestFramework> {
	try {
		// Lazy-load dispatch to keep the legacy code path import-graph small.
		const { pickBackend } = await import('../lang/dispatch');
		const backend = await pickBackend(cwd);
		if (!backend?.selectTestFramework) return 'none';
		const sel = await backend.selectTestFramework(cwd);
		if (!sel) return 'none';
		return DISPATCH_FRAMEWORK_MAP[sel.name] ?? 'none';
	} catch {
		// Defensive: dispatch failures must never break the test runner. Fall
		// through to 'none' so the caller surfaces "no test framework
		// detected" with the existing message.
		return 'none';
	}
}

/**
 * Build a test command via the LanguageBackend dispatch path. Reverse-maps
 * the union TestFramework string back to the profile name and asks the
 * matching backend to produce a command. Falls back to the legacy switch
 * (via `defaultBuildTestCommand` import) when no backend is registered or
 * the backend has no `buildTestCommand` hook.
 *
 * Returns null on framework=`none` or when dispatch fails — callers (the
 * test-runner) then surface "no test command available".
 */
export async function buildTestCommandViaDispatch(
	framework: TestFramework,
	scope: 'all' | 'convention' | 'graph' | 'impact',
	files: string[],
	coverage: boolean,
	baseDir: string,
): Promise<string[] | null> {
	if (framework === 'none') return null;
	try {
		const { pickBackend } = await import('../lang/dispatch');
		const backend = await pickBackend(baseDir);
		if (backend?.buildTestCommand) {
			const cmd = backend.buildTestCommand(framework, files, baseDir, {
				scope,
				coverage,
			});
			if (cmd) return cmd;
		}
		// No backend or hook → fall back to the registry-driven default with
		// a synthesized profile lookup. Importing the default directly avoids
		// the legacy-switch ping-pong: backend.buildTestCommand IS the legacy
		// switch logic when the dispatch returns the default backend.
		return null;
	} catch {
		return null;
	}
}

/**
 * Parse test output via the LanguageBackend dispatch path. Calls
 * `backend.parseTestOutput` for the directory's resolved backend and
 * returns the legacy-shaped `{ totals, coveragePercent? }` for the
 * test-runner. Returns null when dispatch fails.
 */
export async function parseTestOutputViaDispatch(
	framework: TestFramework,
	output: string,
	baseDir: string,
): Promise<{ totals: TestTotals; coveragePercent?: number } | null> {
	if (framework === 'none') return null;
	try {
		const { pickBackend } = await import('../lang/dispatch');
		const backend = await pickBackend(baseDir);
		if (!backend?.parseTestOutput) return null;
		const summary = backend.parseTestOutput(framework, output, '', 0);
		const passed = summary.passed ?? 0;
		const failed = summary.failed ?? 0;
		const skipped = summary.skipped ?? 0;
		const total = summary.total ?? passed + failed + skipped;
		const result: { totals: TestTotals; coveragePercent?: number } = {
			totals: { passed, failed, skipped, total },
		};
		if (summary.coveragePercent !== undefined) {
			result.coveragePercent = summary.coveragePercent;
		}
		return result;
	} catch {
		return null;
	}
}

export async function detectTestFramework(cwd: string): Promise<TestFramework> {
	const baseDir = cwd;
	// Check for package.json to detect JS/TS frameworks
	try {
		const packageJsonPath = path.join(baseDir, 'package.json');
		if (fs.existsSync(packageJsonPath)) {
			const content = fs.readFileSync(packageJsonPath, 'utf-8');
			const pkg = JSON.parse(content) as {
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
				scripts?: Record<string, string>;
			};

			const _deps = pkg.dependencies || {};
			const devDeps = pkg.devDependencies || {};
			const scripts = pkg.scripts || {};

			// Check scripts first (most reliable)
			if (scripts.test?.includes('vitest')) return 'vitest';
			if (scripts.test?.includes('jest')) return 'jest';
			if (scripts.test?.includes('mocha')) return 'mocha';
			if (scripts.test?.includes('bun test')) return 'bun';

			// Check dependencies
			if (hasDevDependency(devDeps, 'vitest', '@vitest/ui')) return 'vitest';
			if (hasDevDependency(devDeps, 'jest', '@types/jest')) return 'jest';
			if (hasDevDependency(devDeps, 'mocha', '@types/mocha')) return 'mocha';

			// Check for bun.lockb or bun.lock
			if (
				fs.existsSync(path.join(baseDir, 'bun.lockb')) ||
				fs.existsSync(path.join(baseDir, 'bun.lock'))
			) {
				// Check if bun test is in scripts
				if (scripts.test?.includes('bun')) return 'bun';
			}
		}
	} catch {
		// Ignore errors, continue to other checks
	}

	// Check for Python test frameworks (pytest)
	try {
		const pyprojectTomlPath = path.join(baseDir, 'pyproject.toml');
		const setupCfgPath = path.join(baseDir, 'setup.cfg');
		const requirementsTxtPath = path.join(baseDir, 'requirements.txt');

		if (fs.existsSync(pyprojectTomlPath)) {
			const content = fs.readFileSync(pyprojectTomlPath, 'utf-8');
			if (content.includes('[tool.pytest')) return 'pytest';
			if (content.includes('pytest')) return 'pytest';
		}

		if (fs.existsSync(setupCfgPath)) {
			const content = fs.readFileSync(setupCfgPath, 'utf-8');
			if (content.includes('[pytest]')) return 'pytest';
		}

		if (fs.existsSync(requirementsTxtPath)) {
			const content = fs.readFileSync(requirementsTxtPath, 'utf-8');
			if (content.includes('pytest')) return 'pytest';
		}
	} catch {
		// Ignore errors
	}

	// Check for Cargo/Rust (Cargo.toml)
	try {
		const cargoTomlPath = path.join(baseDir, 'Cargo.toml');
		if (fs.existsSync(cargoTomlPath)) {
			const content = fs.readFileSync(cargoTomlPath, 'utf-8');
			if (content.includes('[dev-dependencies]')) {
				// Check for common test dependencies
				if (
					content.includes('tokio') ||
					content.includes('mockall') ||
					content.includes('pretty_assertions')
				) {
					return 'cargo';
				}
			}
		}
	} catch {
		// Ignore errors
	}

	// Check for PowerShell/Pester (pester.ps1, pester.config.ps1)
	try {
		const pesterConfigPath = path.join(baseDir, 'pester.config.ps1');
		const pesterConfigJsonPath = path.join(baseDir, 'pester.config.ps1.json');
		const pesterPs1Path = path.join(baseDir, 'tests.ps1');

		if (
			fs.existsSync(pesterConfigPath) ||
			fs.existsSync(pesterConfigJsonPath) ||
			fs.existsSync(pesterPs1Path)
		) {
			return 'pester';
		}
	} catch {
		// Ignore errors
	}

	// Profile-driven detection for additional languages (soft warning on missing binary)
	if (detectGoTest(baseDir)) return 'go-test';
	if (detectJavaMaven(baseDir)) return 'maven';
	if (detectGradle(baseDir)) return 'gradle';
	if (detectDotnetTest(baseDir)) return 'dotnet-test';
	if (detectCTest(baseDir)) return 'ctest';
	if (detectSwiftTest(baseDir)) return 'swift-test';
	if (detectDartTest(baseDir)) return 'dart-test';
	if (detectRSpec(baseDir)) return 'rspec';
	if (detectMinitest(baseDir)) return 'minitest';

	return 'none';
}

// ============ Test File Mapping (Convention Scope) ============
const _TEST_PATTERNS = [
	// Common test file patterns
	{ test: '.spec.', source: '.' },
	{ test: '.test.', source: '.' },
	{ test: '/__tests__/', source: '/' },
	{ test: '/tests/', source: '/' },
	{ test: '/test/', source: '/' },
	// Language-specific patterns
	{ test: '_test.go', source: '.go' }, // Go test files
];

// Compound test extensions that need special handling
const COMPOUND_TEST_EXTENSIONS = [
	'.test.ts',
	'.test.tsx',
	'.test.js',
	'.test.jsx',
	'.tests.ps1',
	'.spec.ts',
	'.spec.tsx',
	'.spec.js',
	'.spec.jsx',
	'.test.ps1',
	'.spec.ps1',
];

const TEST_DIRECTORY_NAMES = ['__tests__', 'tests', 'test', 'spec'] as const;

function isTestDirectoryPath(normalizedPath: string): boolean {
	return normalizedPath
		.split('/')
		.some((segment) =>
			TEST_DIRECTORY_NAMES.includes(
				segment as (typeof TEST_DIRECTORY_NAMES)[number],
			),
		);
}

function resolveWorkspacePath(file: string, workingDir: string): string {
	return path.isAbsolute(file)
		? path.resolve(file)
		: path.resolve(workingDir, file);
}

function toWorkspaceOutputPath(
	absolutePath: string,
	workingDir: string,
	preferRelative: boolean,
): string {
	if (!preferRelative) return absolutePath;
	return path.relative(workingDir, absolutePath);
}

function dedupePush(target: string[], value: string): void {
	if (!target.includes(value)) {
		target.push(value);
	}
}

function buildLanguageSpecificTestNames(
	nameWithoutExt: string,
	ext: string,
): string[] {
	switch (ext) {
		case '.go':
			return [`${nameWithoutExt}_test.go`];
		case '.py':
			return [`test_${nameWithoutExt}.py`, `${nameWithoutExt}_test.py`];
		case '.rb':
			return [`${nameWithoutExt}_spec.rb`];
		case '.java':
			return [
				`${nameWithoutExt}Test.java`,
				`${nameWithoutExt}Tests.java`,
				`Test${nameWithoutExt}.java`,
				`${nameWithoutExt}IT.java`,
			];
		case '.cs':
			return [`${nameWithoutExt}Test.cs`, `${nameWithoutExt}Tests.cs`];
		case '.kt':
			return [
				`${nameWithoutExt}Test.kt`,
				`${nameWithoutExt}Tests.kt`,
				`Test${nameWithoutExt}.kt`,
			];
		case '.ps1':
			return [`${nameWithoutExt}.Tests.ps1`, `${nameWithoutExt}.tests.ps1`];
		default:
			return [];
	}
}

function getRepoLevelCandidateDirectories(
	workingDir: string,
	relativePath: string,
	ext: string,
): string[] {
	const relativeDir = path.dirname(relativePath);
	const nestedRelativeDir = relativeDir === '.' ? '' : relativeDir;
	const directories = TEST_DIRECTORY_NAMES.flatMap((dirName) => {
		const rootDir = path.join(workingDir, dirName);
		return nestedRelativeDir
			? [rootDir, path.join(rootDir, nestedRelativeDir)]
			: [rootDir];
	});

	const normalizedRelativePath = relativePath.replace(/\\/g, '/');
	if (ext === '.java' && normalizedRelativePath.startsWith('src/main/java/')) {
		directories.push(
			path.join(
				workingDir,
				'src/test/java',
				path.dirname(normalizedRelativePath.slice('src/main/java/'.length)),
			),
		);
	}
	if (
		(ext === '.kt' || ext === '.java') &&
		normalizedRelativePath.startsWith('src/main/kotlin/')
	) {
		directories.push(
			path.join(
				workingDir,
				'src/test/kotlin',
				path.dirname(normalizedRelativePath.slice('src/main/kotlin/'.length)),
			),
		);
	}

	return [...new Set(directories)];
}

function hasCompoundTestExtension(filename: string): boolean {
	const lower = filename.toLowerCase();
	return COMPOUND_TEST_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Returns true when `basename` matches a language-specific test file naming
 * convention that is NOT captured by the compound-extension or dot-separated
 * `.test.`/`.spec.` checks above.
 *
 * Covered patterns (all lower-cased for comparison):
 *   Go   : <name>_test.go          (per `go test` convention)
 *   Python: test_<name>.py          (pytest discovery default)
 *           <name>_test.py          (pytest alternative)
 *   Ruby : <name>_spec.rb           (RSpec convention)
 *   Java : Test<Name>.java          (JUnit 4/5 prefix)
 *          <Name>Test.java          (JUnit 4/5 suffix)
 *          <Name>Tests.java         (JUnit 4/5 plural suffix)
 *          <Name>IT.java            (Maven Failsafe integration-test suffix)
 *   C#   : <Name>Test.cs            (xUnit/NUnit/MSTest suffix)
 *          <Name>Tests.cs           (xUnit/NUnit/MSTest plural suffix)
 *   Rust : test files are recognized by test-directory placement
 *           (for example, tests/<anything>.rs via /tests/ path detection)
 *   Kotlin: <Name>Test.kt / <Name>Tests.kt / Test<Name>.kt
 *
 * Exported for unit tests; production code uses it only through
 * getTestFilesFromConvention.
 */
export function isLanguageSpecificTestFile(basename: string): boolean {
	const lower = basename.toLowerCase();
	// Go
	if (lower.endsWith('_test.go')) return true;
	// Python
	if (
		lower.endsWith('.py') &&
		(lower.startsWith('test_') || lower.endsWith('_test.py'))
	)
		return true;
	// Ruby
	if (lower.endsWith('_spec.rb')) return true;
	// Java — convention: *Test.java, *Tests.java, Test*.java, *IT.java
	if (
		lower.endsWith('.java') &&
		(/^Test[A-Z]/.test(basename) ||
			basename.endsWith('Test.java') ||
			basename.endsWith('Tests.java') ||
			lower.endsWith('it.java'))
	)
		return true;
	// C#
	if (
		lower.endsWith('.cs') &&
		(lower.endsWith('test.cs') || lower.endsWith('tests.cs'))
	)
		return true;
	// Kotlin
	if (
		lower.endsWith('.kt') &&
		(/^Test[A-Z]/.test(basename) ||
			lower.endsWith('test.kt') ||
			lower.endsWith('tests.kt'))
	)
		return true;
	// PowerShell
	if (lower.endsWith('.tests.ps1')) return true;
	return false;
}

function isConventionTestFilePath(filePath: string): boolean {
	const normalizedPath = filePath.replace(/\\/g, '/');
	const basename = path.basename(filePath);

	return (
		hasCompoundTestExtension(basename) ||
		basename.includes('.spec.') ||
		basename.includes('.test.') ||
		isLanguageSpecificTestFile(basename) ||
		isTestDirectoryPath(normalizedPath)
	);
}

/**
 * Map source files (or already-test files) to the test files that should be
 * run for them. Handles any language whose test files follow a naming convention
 * — TS/JS, Go, Python, Ruby, Java, C#, Kotlin, PowerShell.
 *
 * Exported for unit tests.
 */
export function getTestFilesFromConvention(
	sourceFiles: string[],
	workingDir: string = process.cwd(),
): string[] {
	const testFiles: string[] = [];

	for (const file of sourceFiles) {
		const absoluteFile = resolveWorkspacePath(file, workingDir);
		const relativeFile = path.relative(workingDir, absoluteFile);
		const basename = path.basename(absoluteFile);
		const dirname = path.dirname(absoluteFile);
		const preferRelativeOutput = !path.isAbsolute(file);

		// Skip if already a test file — covers any language
		if (
			isConventionTestFilePath(relativeFile) ||
			isConventionTestFilePath(file)
		) {
			dedupePush(
				testFiles,
				toWorkspaceOutputPath(absoluteFile, workingDir, preferRelativeOutput),
			);
			continue;
		}

		// Map source files to test files by naming convention.
		// First the universal dot-separated patterns (TS/JS/PS1/etc.):
		//   utils.ts -> utils.test.ts, utils.spec.ts, __tests__/utils.ts, …
		const nameWithoutExt = basename.replace(/\.[^.]+$/, '');
		const ext = path.extname(basename);
		const genericTestNames = [
			`${nameWithoutExt}.spec${ext}`,
			`${nameWithoutExt}.test${ext}`,
		];
		const languageSpecificTestNames = buildLanguageSpecificTestNames(
			nameWithoutExt,
			ext,
		);
		const colocatedCandidates = [
			...genericTestNames,
			...languageSpecificTestNames,
		].map((candidateName) => path.join(dirname, candidateName));
		const testDirectoryNames = [
			basename,
			...genericTestNames,
			...languageSpecificTestNames,
		];
		const repoLevelDirectories = getRepoLevelCandidateDirectories(
			workingDir,
			relativeFile,
			ext,
		);

		const possibleTestFiles = [
			...colocatedCandidates,
			...TEST_DIRECTORY_NAMES.flatMap((dirName) =>
				testDirectoryNames.map((candidateName) =>
					path.join(dirname, dirName, candidateName),
				),
			),
			...repoLevelDirectories.flatMap((candidateDir) =>
				testDirectoryNames.map((candidateName) =>
					path.join(candidateDir, candidateName),
				),
			),
		];

		for (const testFile of possibleTestFiles) {
			if (fs.existsSync(testFile)) {
				dedupePush(
					testFiles,
					toWorkspaceOutputPath(testFile, workingDir, preferRelativeOutput),
				);
			}
		}
	}

	return testFiles;
}

// ============ Graph-Based Test Discovery (via imports) ============
async function getTestFilesFromGraph(
	sourceFiles: string[],
	workingDir: string,
): Promise<string[]> {
	const testFiles: string[] = [];
	const absoluteSourceFiles = sourceFiles.map((sourceFile) =>
		resolveWorkspacePath(sourceFile, workingDir),
	);

	// First, get candidate test files via convention
	const candidateTestFiles = getTestFilesFromConvention(
		sourceFiles,
		workingDir,
	);

	// If no source files to analyze, return empty
	if (sourceFiles.length === 0) {
		return testFiles;
	}

	// Analyze each candidate test file for import statements
	for (const testFile of candidateTestFiles) {
		try {
			const absoluteTestFile = resolveWorkspacePath(testFile, workingDir);
			const content = fs.readFileSync(absoluteTestFile, 'utf-8');
			const testDir = path.dirname(absoluteTestFile);

			// Look for import statements that reference source files
			// Match patterns like: import ... from "./sourceFile" or import ... from '../sourceFile'
			const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
			let match: RegExpExecArray | null;

			match = importRegex.exec(content);
			while (match !== null) {
				const importPath = match[1];

				// Resolve the import path relative to the test file
				let resolvedImport: string;
				if (importPath.startsWith('.')) {
					resolvedImport = path.resolve(testDir, importPath);
					// Try common extensions if none specified
					const existingExt = path.extname(resolvedImport);
					if (!existingExt) {
						for (const extToTry of [
							'.ts',
							'.tsx',
							'.js',
							'.jsx',
							'.mjs',
							'.cjs',
						]) {
							const withExt = resolvedImport + extToTry;
							if (
								absoluteSourceFiles.includes(withExt) ||
								fs.existsSync(withExt)
							) {
								resolvedImport = withExt;
								break;
							}
						}
					}
				} else {
					// External module, skip
					continue;
				}

				// Check if this import matches any of our source files
				const importBasename = path.basename(
					resolvedImport,
					path.extname(resolvedImport),
				);
				const importDir = path.dirname(resolvedImport);
				for (const sourceFile of absoluteSourceFiles) {
					const sourceDir = path.dirname(sourceFile);
					const sourceBasename = path.basename(
						sourceFile,
						path.extname(sourceFile),
					);
					// Match if:
					// 1. Exact path match, OR
					// 2. Same basename AND related directory (same dir, or test file in test subdir)
					const isRelatedDir =
						importDir === sourceDir ||
						importDir === path.join(sourceDir, '__tests__') ||
						importDir === path.join(sourceDir, 'tests') ||
						importDir === path.join(sourceDir, 'test') ||
						importDir === path.join(sourceDir, 'spec');
					if (
						resolvedImport === sourceFile ||
						(importBasename === sourceBasename && isRelatedDir)
					) {
						dedupePush(testFiles, testFile);
						break;
					}
				}
				match = importRegex.exec(content);
			}

			// Also check for dynamic imports or require statements
			const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
			match = requireRegex.exec(content);
			while (match !== null) {
				const importPath = match[1];
				if (importPath.startsWith('.')) {
					let resolvedImport = path.resolve(testDir, importPath);
					// Try common extensions if none specified (align with import handling)
					const existingExt = path.extname(resolvedImport);
					if (!existingExt) {
						for (const extToTry of [
							'.ts',
							'.tsx',
							'.js',
							'.jsx',
							'.mjs',
							'.cjs',
						]) {
							const withExt = resolvedImport + extToTry;
							if (
								absoluteSourceFiles.includes(withExt) ||
								fs.existsSync(withExt)
							) {
								resolvedImport = withExt;
								break;
							}
						}
					}
					const importDir = path.dirname(resolvedImport);
					const importBasename = path.basename(
						resolvedImport,
						path.extname(resolvedImport),
					);
					for (const sourceFile of absoluteSourceFiles) {
						const sourceDir = path.dirname(sourceFile);
						const sourceBasename = path.basename(
							sourceFile,
							path.extname(sourceFile),
						);
						// Match if: exact path, OR same basename with related directory
						const isRelatedDir =
							importDir === sourceDir ||
							importDir === path.join(sourceDir, '__tests__') ||
							importDir === path.join(sourceDir, 'tests') ||
							importDir === path.join(sourceDir, 'test') ||
							importDir === path.join(sourceDir, 'spec');
						if (
							resolvedImport === sourceFile ||
							(importBasename === sourceBasename && isRelatedDir)
						) {
							dedupePush(testFiles, testFile);
							break;
						}
					}
				}
				match = requireRegex.exec(content);
			}
		} catch {}
	}

	// If we found test files via import analysis, return them
	// Otherwise, empty array triggers fallback to convention
	return testFiles;
}

// ============ Test Command Building ============
function getTargetedExecutionUnsupportedReason(
	framework: TestFramework,
): string | null {
	switch (framework) {
		case 'go-test':
			return 'go test targets packages, not individual test files';
		case 'cargo':
			return 'cargo test targets crates, targets, or test names rather than file paths';
		case 'maven':
			return 'maven test selection is class-based, not file-path based';
		case 'gradle':
			return 'gradle test selection is class-based, not file-path based';
		case 'dotnet-test':
			return 'dotnet test filters by fully qualified names, not file paths';
		case 'ctest':
			return 'ctest filters named tests from the build tree, not source test files';
		case 'swift-test':
			return 'swift test filters test names, not file paths';
		default:
			return null;
	}
}

function buildTestCommand(
	framework: TestFramework,
	scope: 'all' | 'convention' | 'graph' | 'impact',
	files: string[],
	coverage: boolean,
	baseDir: string,
): string[] | null {
	switch (framework) {
		case 'bun': {
			const args: string[] = ['bun', 'test'];
			if (coverage) args.push('--coverage');
			if (scope !== 'all' && files.length > 0) {
				args.push(...files);
			}
			return args;
		}
		case 'vitest': {
			const args: string[] = ['npx', 'vitest', 'run'];
			if (coverage) args.push('--coverage');
			if (scope !== 'all' && files.length > 0) {
				args.push(...files);
			}
			return args;
		}
		case 'jest': {
			const args: string[] = ['npx', 'jest'];
			if (coverage) args.push('--coverage');
			if (scope !== 'all' && files.length > 0) {
				args.push(...files);
			}
			return args;
		}
		case 'mocha': {
			const args: string[] = ['npx', 'mocha'];
			// Mocha doesn't have built-in coverage, skip if coverage requested
			if (scope !== 'all' && files.length > 0) {
				args.push(...files);
			}
			return args;
		}
		case 'pytest': {
			const isWindows = process.platform === 'win32';
			const args: string[] = isWindows
				? ['python', '-m', 'pytest']
				: ['python3', '-m', 'pytest'];
			if (coverage) args.push('--cov=.', '--cov-report=term-missing');
			if (scope !== 'all' && files.length > 0) {
				args.push(...files);
			}
			return args;
		}
		case 'cargo': {
			const args: string[] = ['cargo', 'test'];
			if (scope !== 'all' && files.length > 0) {
				// Cargo test can accept test names
				args.push(...files);
			}
			return args;
		}
		case 'pester': {
			// Use -EncodedCommand for safe file path handling
			// This avoids command injection by passing Base64-encoded UTF-16LE command
			// rather than string interpolation in shell context
			if (scope !== 'all' && files.length > 0) {
				// Build PowerShell command that accepts file paths as array parameter
				// Using JSON serialization for safe transport
				const escapedFiles = files.map((f) =>
					f.replace(/'/g, "''").replace(/`/g, '``').replace(/\$/g, '`$'),
				);
				const psCommand = `Invoke-Pester -Path @('${escapedFiles.join("','")}')`;

				// Convert to UTF-16LE then Base64 for -EncodedCommand
				const utf16Bytes = Buffer.from(psCommand, 'utf16le');
				const base64Command = utf16Bytes.toString('base64');

				const args: string[] = ['pwsh', '-EncodedCommand', base64Command];
				return args;
			}
			return ['pwsh', '-Command', 'Invoke-Pester'];
		}
		case 'go-test':
			// Note: 'files' param not forwarded — go test does not support arbitrary file paths;
			// use package paths (./...) for full suite
			return ['go', 'test', './...'];
		case 'maven':
			return ['mvn', 'test'];
		case 'gradle': {
			const isWindows = process.platform === 'win32';
			const hasGradlewBat = fs.existsSync(path.join(baseDir, 'gradlew.bat'));
			const hasGradlew = fs.existsSync(path.join(baseDir, 'gradlew'));
			if (hasGradlewBat && isWindows) return ['gradlew.bat', 'test'];
			if (hasGradlew) return ['./gradlew', 'test'];
			return ['gradle', 'test'];
		}
		case 'dotnet-test':
			return ['dotnet', 'test'];
		case 'ctest': {
			// Detect actual build directory by looking for CMakeCache.txt in common locations
			// Fall back to 'build' (CMake default); ctest will emit a clear error if not found
			const buildDirCandidates = [
				'build',
				'_build',
				'cmake-build-debug',
				'cmake-build-release',
				'out',
			];
			const actualBuildDir =
				buildDirCandidates.find((d) =>
					fs.existsSync(path.join(baseDir, d, 'CMakeCache.txt')),
				) ?? 'build';
			return ['ctest', '--test-dir', actualBuildDir];
		}
		case 'swift-test':
			// Note: 'files' param not forwarded — swift test does not support arbitrary file paths
			return ['swift', 'test'];
		case 'dart-test':
			// Prefer flutter test for Flutter projects; fall back to dart test
			return isCommandAvailable('flutter')
				? ['flutter', 'test', ...files]
				: ['dart', 'test', ...files];
		case 'rspec': {
			// Use bundle exec when bundler is available, otherwise fall back to rspec directly
			const args = isCommandAvailable('bundle')
				? ['bundle', 'exec', 'rspec']
				: ['rspec'];
			if (scope !== 'all' && files.length > 0) {
				args.push(...files);
			}
			return args;
		}
		case 'minitest':
			if (scope !== 'all' && files.length > 0) {
				// Ruby only executes the first positional file arg; use -e with
				// require_relative to run multiple files in a single process.
				const requires = files
					.map(
						(f) =>
							`require_relative '${f.replace(/\\/g, '/').replace(/'/g, "\\'")}'`,
					)
					.join('; ');
				return ['ruby', '-Itest', '-e', requires];
			}
			return [
				'ruby',
				'-Itest',
				'-e',
				'Dir.glob("test/**/*_test.rb").sort.each { |f| require_relative f }',
			];
		default:
			return null;
	}
}

// ============ Test Output Parsing ============
function parseTestOutput(
	framework: TestFramework,
	output: string,
): { totals: TestTotals; coveragePercent?: number } {
	const totals: TestTotals = {
		passed: 0,
		failed: 0,
		skipped: 0,
		total: 0,
	};
	let coveragePercent: number | undefined;

	switch (framework) {
		case 'vitest':
		case 'jest':
		case 'bun': {
			// Try to parse JSON output first (vitest --json-like)
			const jsonMatch = output.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
			if (jsonMatch) {
				try {
					const parsed = JSON.parse(jsonMatch[0]);
					if (parsed.numTotalTests !== undefined) {
						totals.passed = parsed.numPassedTests || 0;
						totals.failed = parsed.numFailedTests || 0;
						totals.skipped = parsed.numPendingTests || 0;
						totals.total = parsed.numTotalTests || 0;
					}
					if (parsed.coverage !== undefined) {
						coveragePercent = parsed.coverage;
					}
				} catch {
					// Fall back to regex parsing
				}
			}

			// Regex fallback
			if (totals.total === 0) {
				const passMatch = output.match(/(\d+)\s+pass(ing|ed)?/);
				const failMatch = output.match(/(\d+)\s+fail(ing|ed)?/);
				const skipMatch = output.match(/(\d+)\s+skip(ping|ped)?/);

				if (passMatch) totals.passed = parseInt(passMatch[1], 10);
				if (failMatch) totals.failed = parseInt(failMatch[1], 10);
				if (skipMatch) totals.skipped = parseInt(skipMatch[1], 10);
				totals.total = totals.passed + totals.failed + totals.skipped;
			}

			// Parse coverage from vitest/jest output
			const coverageMatch = output.match(/All files[^\d]*(\d+\.?\d*)\s*%/);
			if (!coveragePercent && coverageMatch) {
				coveragePercent = parseFloat(coverageMatch[1]);
			}
			break;
		}
		case 'mocha': {
			const passMatch = output.match(/(\d+)\s+passing/);
			const failMatch = output.match(/(\d+)\s+failing/);
			const pendingMatch = output.match(/(\d+)\s+pending/);

			if (passMatch) totals.passed = parseInt(passMatch[1], 10);
			if (failMatch) totals.failed = parseInt(failMatch[1], 10);
			if (pendingMatch) totals.skipped = parseInt(pendingMatch[1], 10);
			totals.total = totals.passed + totals.failed + totals.skipped;
			break;
		}
		case 'pytest': {
			const passMatch = output.match(/(\d+)\s+passed/);
			const failMatch = output.match(/(\d+)\s+failed/);
			const skipMatch = output.match(/(\d+)\s+skipped/);

			if (passMatch) totals.passed = parseInt(passMatch[1], 10);
			if (failMatch) totals.failed = parseInt(failMatch[1], 10);
			if (skipMatch) totals.skipped = parseInt(skipMatch[1], 10);
			totals.total = totals.passed + totals.failed + totals.skipped;

			// Parse coverage
			const coverageMatch = output.match(/TOTAL\s+(\d+\.?\d*)\s*%/);
			if (coverageMatch) {
				coveragePercent = parseFloat(coverageMatch[1]);
			}
			break;
		}
		case 'cargo': {
			const passMatch = output.match(/test result: ok\. (\d+) passed/);
			const failMatch = output.match(
				/test result: FAILED\. (\d+) passed; (\d+) failed/,
			);

			if (failMatch) {
				totals.passed = parseInt(failMatch[1], 10);
				totals.failed = parseInt(failMatch[2], 10);
			} else if (passMatch) {
				totals.passed = parseInt(passMatch[1], 10);
			}
			totals.total = totals.passed + totals.failed;
			break;
		}
		case 'pester': {
			// Pester output parsing
			const passMatch = output.match(/Passed:\s*(\d+)/);
			const failMatch = output.match(/Failed:\s*(\d+)/);
			const skipMatch = output.match(/Skipped:\s*(\d+)/);

			if (passMatch) totals.passed = parseInt(passMatch[1], 10);
			if (failMatch) totals.failed = parseInt(failMatch[1], 10);
			if (skipMatch) totals.skipped = parseInt(skipMatch[1], 10);
			totals.total = totals.passed + totals.failed + totals.skipped;
			break;
		}
		case 'go-test': {
			// Go test: "--- PASS: TestFoo" / "--- FAIL: TestFoo" / "ok  pkg  0.001s"
			const passMatches = [...output.matchAll(/--- PASS:/g)];
			const failMatches = [...output.matchAll(/--- FAIL:/g)];
			const skipMatches = [...output.matchAll(/--- SKIP:/g)];
			totals.passed = passMatches.length;
			totals.failed = failMatches.length;
			totals.skipped = skipMatches.length;
			totals.total = totals.passed + totals.failed + totals.skipped;
			// coverage: "coverage: 83.3% of statements"
			const covMatch = output.match(/coverage:\s*(\d+\.?\d*)\s*%/);
			if (covMatch) coveragePercent = parseFloat(covMatch[1]);
			break;
		}
		case 'maven': {
			// Maven surefire: "Tests run: 10, Failures: 0, Errors: 0, Skipped: 0"
			const mavenMatch = output.match(
				/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/,
			);
			if (mavenMatch) {
				const total = parseInt(mavenMatch[1], 10);
				const failures = parseInt(mavenMatch[2], 10);
				const errors = parseInt(mavenMatch[3], 10);
				const skipped = parseInt(mavenMatch[4], 10);
				totals.failed = failures + errors;
				totals.skipped = skipped;
				totals.passed = total - totals.failed - skipped;
				totals.total = total;
			}
			break;
		}
		case 'gradle': {
			// Gradle: "X tests completed, Y failed, Z skipped"
			const gradleMatch = output.match(
				/(\d+) tests? completed(?:,\s*(\d+) failed)?(?:,\s*(\d+) skipped)?/,
			);
			if (gradleMatch) {
				totals.total = parseInt(gradleMatch[1], 10);
				totals.failed = gradleMatch[2] ? parseInt(gradleMatch[2], 10) : 0;
				totals.skipped = gradleMatch[3] ? parseInt(gradleMatch[3], 10) : 0;
				totals.passed = totals.total - totals.failed - totals.skipped;
			}
			break;
		}
		case 'dotnet-test': {
			// dotnet test: "Passed: 5, Failed: 0, Skipped: 0"
			const passMatch = output.match(/Passed[!:]?\s*(\d+)/i);
			const failMatch = output.match(/Failed[!:]?\s*(\d+)/i);
			const skipMatch = output.match(/Skipped[!:]?\s*(\d+)/i);
			if (passMatch) totals.passed = parseInt(passMatch[1], 10);
			if (failMatch) totals.failed = parseInt(failMatch[1], 10);
			if (skipMatch) totals.skipped = parseInt(skipMatch[1], 10);
			totals.total = totals.passed + totals.failed + totals.skipped;
			break;
		}
		case 'ctest': {
			// CTest: "X% tests passed, Y tests failed out of Z"
			const ctestMatch = output.match(/(\d+) tests? failed out of (\d+)/);
			if (ctestMatch) {
				totals.failed = parseInt(ctestMatch[1], 10);
				totals.total = parseInt(ctestMatch[2], 10);
				totals.passed = totals.total - totals.failed;
			} else {
				const allPassMatch = output.match(/100% tests passed.*?(\d+) tests?/);
				if (allPassMatch) {
					totals.total = parseInt(allPassMatch[1], 10);
					totals.passed = totals.total;
				}
			}
			break;
		}
		case 'swift-test': {
			// Swift: "Test Suite ... passed ... (X tests, Y failures)"
			const swiftMatch = output.match(
				/Executed (\d+) tests?,\s*with (\d+) failures?/,
			);
			if (swiftMatch) {
				totals.total = parseInt(swiftMatch[1], 10);
				totals.failed = parseInt(swiftMatch[2], 10);
				totals.passed = totals.total - totals.failed;
			}
			break;
		}
		case 'dart-test': {
			// Dart: "+X: All tests passed!" or "+X -Y: Some tests failed"
			const dartPassMatch = output.match(/\+(\d+):\s*All tests passed/);
			const dartMixMatch = output.match(/\+(\d+)\s+-(\d+):/);
			if (dartPassMatch) {
				totals.passed = parseInt(dartPassMatch[1], 10);
				totals.total = totals.passed;
			} else if (dartMixMatch) {
				totals.passed = parseInt(dartMixMatch[1], 10);
				totals.failed = parseInt(dartMixMatch[2], 10);
				totals.total = totals.passed + totals.failed;
			}
			break;
		}
		case 'rspec': {
			// RSpec: "X examples, Y failures" or "X examples, Y failures, Z pending"
			const rspecMatch = output.match(
				/(\d+) examples?,\s*(\d+) failures?(?:,\s*(\d+) pending)?/,
			);
			if (rspecMatch) {
				totals.total = parseInt(rspecMatch[1], 10);
				totals.failed = parseInt(rspecMatch[2], 10);
				totals.skipped = rspecMatch[3] ? parseInt(rspecMatch[3], 10) : 0;
				totals.passed = totals.total - totals.failed - totals.skipped;
			}
			break;
		}
		case 'minitest': {
			// Minitest: "X runs, Y assertions, Z failures, W errors, V skips"
			const minitestMatch = output.match(
				/(\d+) runs?,\s*\d+ assertions?,\s*(\d+) failures?,\s*(\d+) errors?,\s*(\d+) skips?/,
			);
			if (minitestMatch) {
				totals.total = parseInt(minitestMatch[1], 10);
				totals.failed =
					parseInt(minitestMatch[2], 10) + parseInt(minitestMatch[3], 10);
				totals.skipped = parseInt(minitestMatch[4], 10);
				totals.passed = totals.total - totals.failed - totals.skipped;
			}
			break;
		}
		default:
			break;
	}

	return { totals, coveragePercent };
}

// ============ Test Execution ============
/**
 * Read a ReadableStream with a hard byte limit.
 * Stops reading once maxBytes is reached to prevent unbounded memory allocation.
 * This is critical for scope "all" where test output can be many MB/GB.
 */
async function readBoundedStream(
	stream: { getReader(): ReadableStreamDefaultReader<Uint8Array> },
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	let truncated = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			if (totalBytes + value.length > maxBytes) {
				// Take only what fits within the limit
				const remaining = maxBytes - totalBytes;
				if (remaining > 0) {
					chunks.push(value.slice(0, remaining));
				}
				totalBytes = maxBytes;
				truncated = true;
				// Cancel the rest of the stream to release backpressure
				reader.cancel().catch(() => {});
				break;
			}

			chunks.push(value);
			totalBytes += value.length;
		}
	} catch {
		// Stream error (process killed, pipe closed) — return what we have
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Already released
		}
	}

	const decoder = new TextDecoder('utf-8', { fatal: false });
	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}

	return { text: decoder.decode(combined), truncated };
}

export async function runTests(
	framework: TestFramework,
	scope: 'all' | 'convention' | 'graph' | 'impact',
	files: string[],
	coverage: boolean,
	timeout_ms: number,
	cwd: string,
): Promise<TestResult> {
	if (scope !== 'all' && files.length > 0) {
		const unsupportedReason = getTargetedExecutionUnsupportedReason(framework);
		if (unsupportedReason) {
			return {
				success: false,
				framework,
				scope,
				error: `Framework "${framework}" does not support targeted test-file execution`,
				message: `The resolved test selection cannot be run safely because ${unsupportedReason}. Use a framework-native selector manually or let the architect handle the broader sweep.`,
				outcome: 'error',
			};
		}
	}

	// Build the command. Phase 3b: route through dispatch by default; the
	// resolved backend's `buildTestCommand` is the SAME logic as the legacy
	// switch below (both delegate to `defaultBuildTestCommand` in
	// `src/lang/default-backend.ts`). `SWARM_LANG_BACKEND=legacy` falls back
	// to the inline switch for rollback parity.
	const useDispatchBuild = process.env.SWARM_LANG_BACKEND !== 'legacy';
	const command = useDispatchBuild
		? ((await buildTestCommandViaDispatch(
				framework,
				scope,
				files,
				coverage,
				cwd,
			)) ?? buildTestCommand(framework, scope, files, coverage, cwd))
		: buildTestCommand(framework, scope, files, coverage, cwd);

	if (!command) {
		return {
			success: false,
			framework,
			scope,
			error: `No test command available for framework: ${framework}`,
			message: 'Install a supported test framework to run tests',
			outcome: 'error',
		};
	}

	// Validate command length
	const commandStr = command.join(' ');
	if (commandStr.length > MAX_COMMAND_LENGTH) {
		return {
			success: false,
			framework,
			scope,
			command,
			error: 'Command exceeds maximum allowed length',
			outcome: 'error',
		};
	}

	const startTime = Date.now();

	try {
		const proc = bunSpawn(command, {
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: cwd,
		});

		// Race with timeout — but read streams CONCURRENTLY with waiting for exit.
		// Previous code awaited proc.exited first, then read streams. This caused a
		// pipe deadlock: if child output exceeded the OS pipe buffer (~64KB), the child
		// blocked on write, proc.exited never resolved, and the session froze for up
		// to timeout_ms (60s default).
		//
		// Fix: read bounded streams in parallel with exit/timeout, so the pipe is
		// always being drained. readBoundedStream caps memory at MAX_OUTPUT_BYTES
		// per stream, preventing OOM from unbounded test output.
		const timeoutPromise = new Promise<number>((resolve) =>
			setTimeout(() => {
				proc.kill();
				resolve(-1); // Timeout indicator
			}, timeout_ms),
		);

		const [exitCode, stdoutResult, stderrResult] = await Promise.all([
			Promise.race([proc.exited, timeoutPromise]),
			readBoundedStream(proc.stdout, MAX_OUTPUT_BYTES),
			readBoundedStream(proc.stderr, MAX_OUTPUT_BYTES),
		]);

		const duration_ms = Date.now() - startTime;

		// Combine stdout and stderr
		let output = stdoutResult.text;
		if (stderrResult.text) {
			output += (output ? '\n' : '') + stderrResult.text;
		}

		// Add truncation notice if either stream was capped
		if (stdoutResult.truncated || stderrResult.truncated) {
			output += '\n... (output truncated at stream read limit)';
		}

		// Parse the output. Phase 3b: route through dispatch by default. The
		// dispatch path delegates to the same `defaultParseTestOutput` switch
		// the legacy path uses, so totals/coveragePercent shape is identical.
		const useDispatchParse = process.env.SWARM_LANG_BACKEND !== 'legacy';
		const parsed = useDispatchParse
			? ((await parseTestOutputViaDispatch(framework, output, cwd)) ??
				parseTestOutput(framework, output))
			: parseTestOutput(framework, output);
		const { totals, coveragePercent } = parsed;

		// Determine success based on exit code and failures
		const isTimeout = exitCode === -1;
		const testPassed = exitCode === 0 && totals.failed === 0;

		if (testPassed) {
			const result: TestSuccessResult = {
				success: true,
				framework,
				scope,
				command,
				timeout_ms,
				duration_ms,
				totals,
				rawOutput: output,
				outcome: 'pass',
			};

			if (coveragePercent !== undefined) {
				result.coveragePercent = coveragePercent;
			}

			result.message = `${framework} tests passed (${totals.passed}/${totals.total})`;
			if (coveragePercent !== undefined) {
				result.message += ` with ${coveragePercent}% coverage`;
			}

			return result;
		} else {
			const result: TestErrorResult = {
				success: false,
				framework,
				scope,
				command,
				timeout_ms,
				duration_ms,
				totals,
				rawOutput: output,
				error: isTimeout
					? `Tests timed out after ${timeout_ms}ms`
					: `Tests failed with ${totals.failed} failures`,
				message: isTimeout
					? `${framework} tests timed out after ${timeout_ms}ms`
					: `${framework} tests failed (${totals.failed}/${totals.total} failed)`,
				outcome: isTimeout ? 'error' : 'regression',
			};

			if (coveragePercent !== undefined) {
				result.coveragePercent = coveragePercent;
			}

			return result;
		}
	} catch (error) {
		const duration_ms = Date.now() - startTime;

		return {
			success: false,
			framework,
			scope,
			command,
			timeout_ms,
			duration_ms,
			error:
				error instanceof Error
					? `Execution failed: ${error.message}`
					: 'Execution failed: unknown error',
			outcome: 'error',
		};
	}
}

// ============ Source File Discovery ============
const SOURCE_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.py',
	'.rs',
	'.ps1',
	'.psm1',
	// Additional language support (Tier 1 & 2)
	'.go',
	'.java',
	'.kt',
	'.kts',
	'.cs',
	'.c',
	'.h',
	'.cpp',
	'.hpp',
	'.cc',
	'.cxx',
	'.swift',
	'.dart',
	'.rb',
	'.pyi',
]);

const SKIP_DIRECTORIES = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'out',
	'coverage',
	'.next',
	'.nuxt',
	'.cache',
	'vendor',
	'.svn',
	'.hg',
	'__pycache__',
	'.pytest_cache',
	'target',
	// Additional language build/cache directories
	'.gradle',
	'.dart_tool',
	'.build',
	'Pods',
	'bin',
	'obj',
	'.bundle',
	'.tox',
]);

function _findSourceFiles(dir: string, files: string[] = []): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return files;
	}

	// Sort for deterministic order
	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

	for (const entry of entries) {
		if (SKIP_DIRECTORIES.has(entry)) continue;

		const fullPath = path.join(dir, entry);

		let stat: import('node:fs').Stats;
		try {
			stat = fs.statSync(fullPath);
		} catch {
			continue;
		}

		if (stat.isDirectory()) {
			_findSourceFiles(fullPath, files);
		} else if (stat.isFile()) {
			const ext = path.extname(fullPath).toLowerCase();
			if (SOURCE_EXTENSIONS.has(ext)) {
				files.push(fullPath);
			}
		}
	}

	return files;
}

// ============ Test History Integration ============
interface TestHistoryReport {
	flakyTests: FlakyTestEntry[];
	failureClusters: Array<{
		rootCause: string;
		affectedFiles: string[];
		classification: string;
	}>;
	quarantinedFailures: string[];
}

function recordAndAnalyzeResults(
	result: TestResult,
	testFiles: string[],
	workingDir: string,
	sourceFiles?: string[],
): void {
	// Only record if we have meaningful results
	if (!result.totals || result.totals.total === 0) return;

	const now = new Date().toISOString();
	const changedFiles = (
		sourceFiles && sourceFiles.length > 0 ? sourceFiles : testFiles
	).map((f) => f.replace(/\\/g, '/'));

	// Record aggregate result for each test file
	for (const testFile of testFiles) {
		try {
			appendTestRun(
				{
					timestamp: now,
					taskId: 'auto',
					testFile: testFile.replace(/\\/g, '/'),
					testName: '(aggregate)',
					result: result.success ? 'pass' : 'fail',
					durationMs: result.duration_ms || 0,
					changedFiles,
				},
				workingDir,
			);
		} catch {
			// History recording failure should not block test results
		}
	}
}

function analyzeFailures(workingDir: string): TestHistoryReport {
	const report: TestHistoryReport = {
		flakyTests: [],
		failureClusters: [],
		quarantinedFailures: [],
	};

	try {
		const history = getAllHistory(workingDir);
		if (history.length === 0) return report;

		// Detect flaky tests
		report.flakyTests = detectFlakyTests(history);

		// Classify and cluster failures
		const failingResults = history.filter((r) => r.result === 'fail');
		if (failingResults.length > 0) {
			const { clusters } = classifyAndCluster(failingResults, history);
			report.failureClusters = clusters.map((c) => ({
				rootCause: c.rootCause,
				affectedFiles: c.affectedTestFiles,
				classification: c.classification,
			}));
		}

		// Identify quarantined test files
		for (const entry of report.flakyTests) {
			if (entry.isQuarantined) {
				report.quarantinedFailures.push(`${entry.testFile}: ${entry.testName}`);
			}
		}
	} catch {
		// Analysis failure should not block test results
	}

	return report;
}

// ============ Tool Definition ============
export const test_runner: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Run project tests with framework detection. Supports bun, vitest, jest, mocha, pytest, cargo, pester, go-test, maven, gradle, dotnet-test, ctest, swift-test, dart-test, rspec, and minitest. Returns deterministic normalized JSON with framework, scope, command, totals, coverage, duration, success status, and failures. Use scope "all" for full suite, "convention" to accept direct test files or map source files to test files, "graph" to find related tests via imports from source files, or "impact" to find tests covering changed source files using test-impact analysis.',
	args: {
		scope: z
			.enum(['all', 'convention', 'graph', 'impact'])
			.optional()
			.describe(
				'Test scope: "all" runs full suite, "convention" accepts direct test files or maps source files to tests by naming, "graph" finds related tests via imports from source files, "impact" finds tests covering changed source files via test-impact analysis',
			),
		files: z
			.array(z.string())
			.optional()
			.describe(
				'Specific files to test. For "convention", pass source files or direct test files. For "graph" and "impact", pass source files only.',
			),
		coverage: z
			.boolean()
			.optional()
			.describe('Enable coverage reporting if supported'),
		timeout_ms: z
			.number()
			.optional()
			.describe('Timeout in milliseconds (default 60000, max 300000)'),
		allow_full_suite: z
			.boolean()
			.optional()
			.describe(
				'Explicit opt-in for scope "all". Required because full-suite output can destabilize SSE streaming.',
			),
		working_directory: z
			.string()
			.optional()
			.describe(
				'Explicit project root directory. When provided, tests run relative to this path instead of the plugin context directory. Use this when CWD differs from the actual project root.',
			),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		// Resolve effective directory: explicit working_directory > injected directory
		let workingDirInput: string | undefined;
		if (args && typeof args === 'object') {
			const obj = args as Record<string, unknown>;
			workingDirInput =
				typeof obj.working_directory === 'string'
					? obj.working_directory
					: undefined;
		}
		const dirResult = resolveWorkingDirectory(workingDirInput, directory);
		if (!dirResult.success) {
			const errorResult: TestErrorResult = {
				success: false,
				framework: 'none',
				scope: 'all',
				error: dirResult.message,
				outcome: 'error',
			};
			return JSON.stringify(errorResult, null, 2);
		}
		// resolveWorkingDirectory already validated via realpathSync — use directly
		const workingDir = dirResult.directory;
		// Validate workingDir to prevent path traversal, injection, and abuse
		// Length check FIRST — before any regex operations (defense against ReDoS)
		if (workingDir.length > 4096) {
			const errorResult: TestErrorResult = {
				success: false,
				framework: 'none',
				scope: 'all',
				error: 'Invalid working directory',
				outcome: 'error',
			};
			return JSON.stringify(errorResult, null, 2);
		}
		// Reject UNC paths (\\server\share, //server/share) and Windows device paths (\\.\ or \\?\)
		if (/^[/\\]{2}/.test(workingDir)) {
			const errorResult: TestErrorResult = {
				success: false,
				framework: 'none',
				scope: 'all',
				error: 'Invalid working directory',
				outcome: 'error',
			};
			return JSON.stringify(errorResult, null, 2);
		}
		if (containsControlChars(workingDir)) {
			const errorResult: TestErrorResult = {
				success: false,
				framework: 'none',
				scope: 'all',
				error: 'Invalid working directory',
				outcome: 'error',
			};
			return JSON.stringify(errorResult, null, 2);
		}
		if (containsPathTraversal(workingDir)) {
			const errorResult: TestErrorResult = {
				success: false,
				framework: 'none',
				scope: 'all',
				error: 'Invalid working directory',
				outcome: 'error',
			};
			return JSON.stringify(errorResult, null, 2);
		}
		// Validate arguments
		if (!validateArgs(args)) {
			const errorResult: TestErrorResult = {
				success: false,
				framework: 'none',
				scope: 'all',
				error: 'Invalid arguments',
				message:
					'scope must be "all", "convention", "graph", or "impact"; files must be array of strings; coverage must be boolean; timeout_ms must be a positive number',
				outcome: 'error',
			};
			return JSON.stringify(errorResult, null, 2);
		}

		const scope = args.scope || 'all';

		// Guard 1: scope === 'all' requires explicit opt-in via allow_full_suite flag
		// Rationale: Full-suite output is one of the largest SSE payloads the swarm produces.
		// Opencode's SSE pipeline has known issues with large payloads causing session wedge,
		// memory leaks, and OOM crashes (anomalyco/opencode #17977, #15645, #17908).
		// This guard ensures full-suite runs are a deliberate architect decision, not accidental.
		//
		// IMPORTANT: The error message must NOT instruct the caller to add allow_full_suite.
		// LLMs follow such instructions literally, defeating the guard entirely.
		if (scope === 'all') {
			if (!args.allow_full_suite) {
				const errorResult: TestErrorResult = {
					success: false,
					framework: 'none',
					scope: 'all',
					error:
						'scope "all" is blocked for agent use. Use scope "convention" with specific test files, or scope "graph" with exactly one source file.',
					message:
						'The full test suite is blocked in agent context. Use scope "convention" with specific test files, or scope "graph" with exactly one source file. Example: { scope: "convention", files: ["src/tools/test-runner.ts"] }',
					outcome: 'error',
				};
				return JSON.stringify(errorResult, null, 2);
			}
			// Allow through — caller explicitly opted in
		}

		// Hard guard: convention, graph, and impact scopes require explicit files to prevent unsafe full-project discovery
		if (
			(scope === 'convention' || scope === 'graph' || scope === 'impact') &&
			(!args.files || args.files.length === 0)
		) {
			const errorResult: TestErrorResult = {
				success: false,
				framework: 'none',
				scope,
				error:
					'scope "convention" and "graph" require explicit files array - omitting files causes unsafe full-project discovery',
				message:
					'When using scope "convention" or "graph", you must provide a non-empty "files" array. Use scope "all" for full project test suite without specifying files.',
				outcome: 'error',
			};
			return JSON.stringify(errorResult, null, 2);
		}

		const _files = args.files || [];
		const coverage = args.coverage || false;
		const timeout_ms = Math.min(
			args.timeout_ms || DEFAULT_TIMEOUT_MS,
			MAX_TIMEOUT_MS,
		);

		// Detect the test framework. Phase 3b of language-agnostic refactor:
		// DISPATCH IS THE DEFAULT. `SWARM_LANG_BACKEND=legacy` opts out for
		// one release as a rollback path. The dispatch + legacy paths share
		// the same buildTestCommand and parseTestOutput logic (the legacy
		// switches in this file delegate to `defaultBuildTestCommand` /
		// `defaultParseTestOutput` in `src/lang/default-backend.ts` — single
		// source of truth).
		//
		// Dispatch+legacy composition: when dispatch returns `'none'`, fall
		// through to the legacy switch as a backstop. This:
		//   - Covers languages with no profile (PowerShell/Pester).
		//   - Recovers the legacy permissive behavior for Python projects
		//     where pytest is declared in pyproject.toml but not on PATH at
		//     plugin-load time (venv not activated).
		//   - Recovers Rust projects where Cargo.toml lacks
		//     `[dev-dependencies]` content but the manifest still warrants
		//     cargo test.
		// The parity test
		// (`tests/unit/tools/test-runner-dispatch-parity.test.ts`) asserts
		// no FALSE POSITIVES — dispatch never returns a non-'none' framework
		// the legacy detection disagrees with.
		const useDispatch = process.env.SWARM_LANG_BACKEND !== 'legacy';
		let framework: TestFramework;
		if (useDispatch) {
			framework = await detectTestFrameworkViaDispatch(workingDir);
			if (framework === 'none') {
				framework = await detectTestFramework(workingDir);
			}
		} else {
			framework = await detectTestFramework(workingDir);
		}

		if (framework === 'none') {
			const result: TestErrorResult = {
				success: false,
				framework: 'none',
				scope,
				error: 'No test framework detected',
				message:
					'No supported test framework found. Install bun, vitest, jest, mocha, pytest, cargo, pester, or a supported language test runner (go test, maven, gradle, dotnet test, ctest, swift test, dart test, rspec, minitest).',
				totals: {
					passed: 0,
					failed: 0,
					skipped: 0,
					total: 0,
				},
				outcome: 'error',
			};
			return JSON.stringify(result, null, 2);
		}

		// Handle different scopes: 'convention' accepts direct test files or source-file discovery;
		// 'graph' and 'impact' accept source files only; 'all' skips discovery entirely.
		let testFiles: string[] = [];
		let graphFallbackReason: string | undefined;
		let effectiveScope: 'all' | 'convention' | 'graph' | 'impact' = scope as
			| 'all'
			| 'convention'
			| 'graph'
			| 'impact';

		// scope "all" — skip file discovery, let the test framework run its full suite
		if (scope === 'all') {
			// effectiveScope is already 'all', testFiles stays empty
			// Fall through to runTests which handles empty files for scope 'all'
		} else if (scope === 'convention') {
			const directTestFiles = args.files!.filter((file) =>
				isConventionTestFilePath(file),
			);
			const sourceFiles = args.files!.filter((file) => {
				if (directTestFiles.includes(file)) return false;
				const ext = path.extname(file).toLowerCase();
				return SOURCE_EXTENSIONS.has(ext);
			});
			const invalidFiles = args.files!.filter(
				(file) =>
					!directTestFiles.includes(file) && !sourceFiles.includes(file),
			);

			if (directTestFiles.length === 0 && sourceFiles.length === 0) {
				const errorResult: TestErrorResult = {
					success: false,
					framework,
					scope,
					error:
						'Provided files contain no recognized source files or direct test files',
					message:
						'The files array must contain at least one source file with a recognized extension (.ts, .tsx, .js, .jsx, .py, .rs, .ps1, etc.) or a direct test file in a supported test location/naming convention.',
					outcome: 'error',
				};
				return JSON.stringify(errorResult, null, 2);
			}

			if (invalidFiles.length > 0) {
				const errorResult: TestErrorResult = {
					success: false,
					framework,
					scope,
					error:
						'Provided files include entries that are neither recognized source files nor direct test files',
					message: `These files are not valid for targeted test discovery: ${invalidFiles.join(', ')}`,
					outcome: 'error',
				};
				return JSON.stringify(errorResult, null, 2);
			}

			// Guard: Reject when too many source files would cause fan-out to many test files.
			// Direct test files are exempt — they are explicitly named and don't fan out.
			if (sourceFiles.length > MAX_SAFE_SOURCE_FILES) {
				const errorResult: TestErrorResult = {
					success: false,
					framework,
					scope,
					error: `scope "convention" accepts at most ${MAX_SAFE_SOURCE_FILES} source file for discovery (got ${sourceFiles.length}). Treat this as SKIP without retry.`,
					message: `Too many source files for scope "convention" discovery (${sourceFiles.length} provided, limit is ${MAX_SAFE_SOURCE_FILES}). Call test_runner once per source file, or pass direct test file paths instead of source files.`,
					outcome: 'scope_exceeded',
				};
				return JSON.stringify(errorResult, null, 2);
			}

			testFiles = [
				...directTestFiles,
				...getTestFilesFromConvention(sourceFiles, workingDir),
			].filter((file, index, items) => items.indexOf(file) === index);
		} else if (scope === 'graph') {
			// Try to find related tests via import analysis
			// args.files is guaranteed non-empty by the guard above
			const sourceFiles = args.files!.filter((f) => {
				if (isConventionTestFilePath(f)) {
					return false;
				}
				const ext = path.extname(f).toLowerCase();
				return SOURCE_EXTENSIONS.has(ext);
			});

			// Guard: If args.files was provided but all entries are non-source files, reject
			if (sourceFiles.length === 0) {
				const errorResult: TestErrorResult = {
					success: false,
					framework,
					scope,
					error:
						'Provided files contain no source files with recognized extensions',
					message:
						'The files array for scope "graph" must contain at least one source file with a recognized extension (.ts, .tsx, .js, .jsx, .py, .rs, .ps1, etc.). Direct test files belong in scope "convention".',
					outcome: 'error',
				};
				return JSON.stringify(errorResult, null, 2);
			}

			// Guard: Reject before any I/O when too many source files are provided.
			// graph discovery fans out: each source file can match many test files, easily
			// exceeding MAX_SAFE_TEST_FILES and triggering a scope_exceeded cascade that
			// causes LLMs to retry with scope "all", freezing the OpenCode SSE session.
			if (sourceFiles.length > MAX_SAFE_SOURCE_FILES) {
				const errorResult: TestErrorResult = {
					success: false,
					framework,
					scope,
					error: `scope "graph" accepts at most ${MAX_SAFE_SOURCE_FILES} source file (got ${sourceFiles.length}). Treat this as SKIP without retry.`,
					message: `Too many source files for scope "graph" (${sourceFiles.length} provided, limit is ${MAX_SAFE_SOURCE_FILES}). Call test_runner once per source file, or use scope "convention" with direct test file paths.`,
					outcome: 'scope_exceeded',
				};
				return JSON.stringify(errorResult, null, 2);
			}

			// Try graph-based discovery via imports (best effort)
			const graphTestFiles = await getTestFilesFromGraph(
				sourceFiles,
				workingDir,
			);
			if (graphTestFiles.length > 0) {
				testFiles = graphTestFiles;
			} else {
				// Fallback to convention with clear reason
				graphFallbackReason =
					'imports resolution returned no results, falling back to convention';
				effectiveScope = 'convention';
				testFiles = getTestFilesFromConvention(sourceFiles, workingDir);
			}
		} else if (scope === 'impact') {
			// Impact scope: use test-impact analyzer to find tests covering changed files
			// args.files is guaranteed non-empty by the guard above
			const sourceFiles = args.files!.filter((f) => {
				if (isConventionTestFilePath(f)) {
					return false;
				}
				const ext = path.extname(f).toLowerCase();
				return SOURCE_EXTENSIONS.has(ext);
			});

			if (sourceFiles.length === 0) {
				const errorResult: TestErrorResult = {
					success: false,
					framework,
					scope,
					error:
						'Provided files contain no source files with recognized extensions',
					message:
						'The files array for scope "impact" must contain at least one source file with a recognized extension (.ts, .tsx, .js, .jsx, .py, .rs, .ps1, etc.). Direct test files belong in scope "convention".',
					outcome: 'error',
				};
				return JSON.stringify(errorResult, null, 2);
			}

			// Guard: Reject before any I/O when too many source files are provided.
			// impact analysis fans out through the import graph, then may fall back to graph
			// discovery; either path can exceed MAX_SAFE_TEST_FILES and cause LLMs to cascade
			// to scope "all", freezing the OpenCode SSE session.
			if (sourceFiles.length > MAX_SAFE_SOURCE_FILES) {
				const errorResult: TestErrorResult = {
					success: false,
					framework,
					scope,
					error: `scope "impact" accepts at most ${MAX_SAFE_SOURCE_FILES} source file (got ${sourceFiles.length}). Treat this as SKIP without retry.`,
					message: `Too many source files for scope "impact" (${sourceFiles.length} provided, limit is ${MAX_SAFE_SOURCE_FILES}). Call test_runner once per source file, or use scope "convention" with direct test file paths.`,
					outcome: 'scope_exceeded',
				};
				return JSON.stringify(errorResult, null, 2);
			}

			try {
				const impactResult = await analyzeImpact(sourceFiles, workingDir);
				if (impactResult.impactedTests.length > 0) {
					// Convert absolute paths from impact map to relative paths for test framework
					testFiles = impactResult.impactedTests.map((absPath) => {
						const relativePath = path.relative(workingDir, absPath);
						return path.isAbsolute(relativePath) ? absPath : relativePath;
					});
				} else {
					// Cold start: no impact map or no matches — fall back to graph scope
					graphFallbackReason =
						'no impacted tests found via impact analysis, falling back to graph';
					effectiveScope = 'graph';
					const graphTestFiles = await getTestFilesFromGraph(
						sourceFiles,
						workingDir,
					);
					if (graphTestFiles.length > 0) {
						testFiles = graphTestFiles;
					} else {
						graphFallbackReason =
							'imports resolution returned no results, falling back to convention';
						effectiveScope = 'convention';
						testFiles = getTestFilesFromConvention(sourceFiles, workingDir);
					}
				}
			} catch {
				// Impact analysis failed — fall back to graph scope
				graphFallbackReason = 'impact analysis failed, falling back to graph';
				effectiveScope = 'graph';
				const graphTestFiles = await getTestFilesFromGraph(
					sourceFiles,
					workingDir,
				);
				if (graphTestFiles.length > 0) {
					testFiles = graphTestFiles;
				} else {
					graphFallbackReason =
						'imports resolution returned no results, falling back to convention';
					effectiveScope = 'convention';
					testFiles = getTestFilesFromConvention(sourceFiles, workingDir);
				}
			}
		}

		// Guard: Reject when source files resolve to zero test files (prevents accidental full-suite run)
		// Skip for scope 'all' — full-suite execution deliberately has no file filter
		if (scope !== 'all' && testFiles.length === 0) {
			const baseMessage =
				'No matching test files found for the provided source files. Check that test files exist with matching naming conventions (.spec.*, .test.*, .Tests.ps1, __tests__/, tests/, test/, spec/).';
			const errorResult: TestErrorResult = {
				success: false,
				framework,
				scope: effectiveScope,
				error: 'Provided source files resolved to zero test files',
				message: graphFallbackReason
					? `${baseMessage} (${graphFallbackReason})`
					: baseMessage,
				outcome: 'skip',
				...(scope === 'graph' && { attempted_scope: 'graph' }),
				...(scope === 'impact' && { attempted_scope: 'graph' }),
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Guard 2: Reject execution when resolved test-file count exceeds safe maximum
		// Skip for scope 'all' — full-suite has no resolved file list
		if (scope !== 'all' && testFiles.length > MAX_SAFE_TEST_FILES) {
			// List first few resolved filenames for debugging
			const sampleFiles = testFiles.slice(0, 5);
			const errorResult: TestErrorResult = {
				success: false,
				framework,
				scope: effectiveScope,
				error: `Resolved test file count (${testFiles.length}) exceeds safe maximum (${MAX_SAFE_TEST_FILES})`,
				message: `Too many test files resolved (${testFiles.length}). Maximum allowed is ${MAX_SAFE_TEST_FILES}. Treat this as SKIP without retry. Provide more specific source files to narrow down test scope. First few resolved: ${sampleFiles.join(', ')}`,
				outcome: 'scope_exceeded',
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Run the tests
		const result = await runTests(
			framework,
			effectiveScope,
			testFiles,
			coverage,
			timeout_ms,
			workingDir,
		);

		// Record results to history and analyze failures
		recordAndAnalyzeResults(
			result,
			testFiles,
			workingDir,
			_files.length > 0 ? _files : undefined,
		);

		// If test failed, add failure analysis to the result message
		let historyReport: TestHistoryReport | undefined;
		if (!result.success && result.totals && result.totals.failed > 0) {
			historyReport = analyzeFailures(workingDir);
			if (historyReport.quarantinedFailures.length > 0) {
				result.message =
					(result.message || '') +
					` | QUARANTINED (flaky): ${historyReport.quarantinedFailures.join(', ')}`;
			}
			if (historyReport.failureClusters.length > 0) {
				const clusterSummary = historyReport.failureClusters
					.slice(0, 3)
					.map((c) => `${c.classification}: ${c.rootCause.substring(0, 80)}`)
					.join('; ');
				result.message = `${result.message || ''} | FAILURE ANALYSIS: ${clusterSummary}`;
			}
		}

		// Add graph fallback message if applicable
		if (graphFallbackReason && result.message) {
			result.message = `${result.message} (${graphFallbackReason})`;
		}

		return JSON.stringify(result, null, 2);
	},
});
