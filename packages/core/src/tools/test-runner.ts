import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunSpawn, bunSpawnSync } from '../utils/bun-compat';

// Simple command availability check - no external dependencies
const toolchainCache = new Map<string, boolean>();

/**
 * Check if a command exists on PATH
 * Uses 'where' on Windows, 'which' on Unix
 */
function isCommandAvailable(command: string): boolean {
	// Check cache first
	if (toolchainCache.has(command)) {
		return toolchainCache.get(command)!;
	}

	const isWindows = process.platform === 'win32';
	const cmd = isWindows ? `${command}.exe` : command;

	try {
		const result = bunSpawnSync(
			{
				cmd: isWindows ? ['where', cmd] : ['which', cmd],
			},
			{ stdout: 'pipe', stderr: 'pipe' },
		);

		const available = result.success;
		toolchainCache.set(command, available);
		return available;
	} catch {
		toolchainCache.set(command, false);
		return false;
	}
}

// ============ Constants ============
export const MAX_OUTPUT_BYTES = 512_000; // 512KB max output
export const MAX_COMMAND_LENGTH = 500;
export const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds default
export const MAX_TIMEOUT_MS = 300_000; // 5 minutes max
export const MAX_SAFE_TEST_FILES = 50; // Maximum resolved test files allowed in interactive session

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
	scope?: 'all' | 'convention' | 'graph';
	files?: string[];
	coverage?: boolean;
	timeout_ms?: number;
}

// ============ Response Types ============
export interface TestTotals {
	passed: number;
	failed: number;
	skipped: number;
	total: number;
}

export interface TestSuccessResult {
	success: true;
	framework: TestFramework;
	scope: 'all' | 'convention' | 'graph';
	command: string[];
	timeout_ms: number;
	duration_ms: number;
	totals: TestTotals;
	coveragePercent?: number;
	rawOutput?: string;
	message?: string;
}

export interface TestErrorResult {
	success: false;
	framework: TestFramework;
	scope: 'all' | 'convention' | 'graph';
	command?: string[];
	timeout_ms?: number;
	duration_ms?: number;
	totals?: TestTotals;
	coveragePercent?: number;
	error: string;
	rawOutput?: string;
	message?: string;
}

export type TestResult = TestSuccessResult | TestErrorResult;

// ============ Validation ============
export function containsPathTraversal(str: string): boolean {
	// Check for basic path traversal patterns
	if (/\.\.[/\\]/.test(str)) return true;

	// Check for isolated double dots (at start or after separator)
	if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(str)) return true;

	// Check for URL-encoded traversal patterns
	if (/%2e%2e/i.test(str)) return true; // .. URL encoded
	if (/%2e\./i.test(str)) return true; // .%2e
	if (/%2e/i.test(str) && /\.\./.test(str)) return true; // Mixed encoding
	if (/%252e%252e/i.test(str)) return true; // Double encoded ..

	// Check for Unicode/Unicode-like traversal attempts
	// Fullwidth dot (U+FF0E) - looks like dot but isn't
	if (/\uff0e/.test(str)) return true;
	// Ideographic full stop (U+3002)
	if (/\u3002/.test(str)) return true;
	// Halfwidth katakana middle dot (U+FF65)
	if (/\uff65/.test(str)) return true;

	// Check for path separator variants
	// Forward slash encoded as %2f
	if (/%2f/i.test(str)) return true;
	// Backslash encoded as %5c
	if (/%5c/i.test(str)) return true;

	return false;
}

export function isAbsolutePath(str: string): boolean {
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

export function containsControlChars(str: string): boolean {
	// Expanded control character check beyond \0, \t
	// Includes all C0 control codes (0x00-0x1f) except tab which is checked separately
	// Also includes DEL (0x7f), C1 control codes (0x80-0x9f), and explicitly LF/CR
	// LF (\n, 0x0a) and CR (\r, 0x0d) must be explicitly rejected for security
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security validation pattern
	return /[\x00-\x08\x0a\x0b\x0c\x0d\x0e-\x1f\x7f\x80-\x9f]/.test(str);
}

// PowerShell metacharacters that could enable command injection
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security validation pattern
const POWERSHELL_METACHARACTERS = /[|;&`$(){}[\]<>"'#*?\x00-\x1f]/;

export function containsPowerShellMetacharacters(str: string): boolean {
	return POWERSHELL_METACHARACTERS.test(str);
}

export function validateArgs(args: unknown): args is TestRunnerArgs {
	if (typeof args !== 'object' || args === null) return false;
	const obj = args as Record<string, unknown>;

	// Validate scope
	if (obj.scope !== undefined) {
		if (
			obj.scope !== 'all' &&
			obj.scope !== 'convention' &&
			obj.scope !== 'graph'
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
export function detectGoTest(cwd: string): boolean {
	// check: go.mod exists AND go binary on PATH
	return fs.existsSync(path.join(cwd, 'go.mod')) && isCommandAvailable('go');
}

/** Detect Java/Maven test runner (mvn test) */
export function detectJavaMaven(cwd: string): boolean {
	// check: pom.xml exists AND mvn binary on PATH
	return fs.existsSync(path.join(cwd, 'pom.xml')) && isCommandAvailable('mvn');
}

/** Detect Java/Gradle or Kotlin/Gradle test runner (gradlew test) */
export function detectGradle(cwd: string): boolean {
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
export function detectDotnetTest(cwd: string): boolean {
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
export function detectCTest(cwd: string): boolean {
	// ctest works from build directory; accept both source and build directories
	const hasSource = fs.existsSync(path.join(cwd, 'CMakeLists.txt'));
	const hasBuildCache =
		fs.existsSync(path.join(cwd, 'CMakeCache.txt')) ||
		fs.existsSync(path.join(cwd, 'build', 'CMakeCache.txt'));
	return (hasSource || hasBuildCache) && isCommandAvailable('ctest');
}

/** Detect Swift test runner (swift test) */
export function detectSwiftTest(cwd: string): boolean {
	// check: Package.swift exists AND swift binary on PATH
	return (
		fs.existsSync(path.join(cwd, 'Package.swift')) &&
		isCommandAvailable('swift')
	);
}

/** Detect Dart/Flutter test runner (dart test or flutter test) */
export function detectDartTest(cwd: string): boolean {
	// check: pubspec.yaml exists AND (dart or flutter binary on PATH)
	return (
		fs.existsSync(path.join(cwd, 'pubspec.yaml')) &&
		(isCommandAvailable('dart') || isCommandAvailable('flutter'))
	);
}

/** Detect Ruby/RSpec test runner */
export function detectRSpec(cwd: string): boolean {
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
export function detectMinitest(cwd: string): boolean {
	// Require test/ dir + Ruby-specific markers (Gemfile or Rakefile)
	return (
		fs.existsSync(path.join(cwd, 'test')) &&
		(fs.existsSync(path.join(cwd, 'Gemfile')) ||
			fs.existsSync(path.join(cwd, 'Rakefile'))) &&
		isCommandAvailable('ruby')
	);
}

export async function detectTestFramework(
	cwd?: string,
): Promise<TestFramework> {
	const baseDir = cwd || process.cwd();
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
const TEST_PATTERNS = [
	// Common test file patterns
	{ test: '.spec.', source: '.' },
	{ test: '.test.', source: '.' },
	{ test: '/__tests__/', source: '/' },
	{ test: '/tests/', source: '/' },
	{ test: '/test/', source: '/' },
];

// Compound test extensions that need special handling
const COMPOUND_TEST_EXTENSIONS = [
	'.test.ts',
	'.test.tsx',
	'.test.js',
	'.test.jsx',
	'.spec.ts',
	'.spec.tsx',
	'.spec.js',
	'.spec.jsx',
	'.test.ps1',
	'.spec.ps1',
];

export function hasCompoundTestExtension(filename: string): boolean {
	const lower = filename.toLowerCase();
	return COMPOUND_TEST_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function getTestFilesFromConvention(sourceFiles: string[]): string[] {
	const testFiles: string[] = [];

	for (const file of sourceFiles) {
		const normalizedPath = file.replace(/\\/g, '/');
		const basename = path.basename(file);
		const dirname = path.dirname(file);

		// Skip if already a test file
		if (
			hasCompoundTestExtension(basename) ||
			basename.includes('.spec.') ||
			basename.includes('.test.') ||
			normalizedPath.includes('/__tests__/') ||
			normalizedPath.includes('/tests/') ||
			normalizedPath.includes('/test/')
		) {
			if (!testFiles.includes(file)) {
				testFiles.push(file);
			}
			continue;
		}

		// Map source files to test files by naming convention
		// e.g., utils.ts -> utils.test.ts, utils.spec.ts
		for (const _pattern of TEST_PATTERNS) {
			// Try common test file names for the source file
			const nameWithoutExt = basename.replace(/\.[^.]+$/, '');
			const ext = path.extname(basename);

			const possibleTestFiles = [
				path.join(dirname, `${nameWithoutExt}.spec${ext}`),
				path.join(dirname, `${nameWithoutExt}.test${ext}`),
				path.join(dirname, '__tests__', `${nameWithoutExt}${ext}`),
				path.join(dirname, 'tests', `${nameWithoutExt}${ext}`),
				path.join(dirname, 'test', `${nameWithoutExt}${ext}`),
			];

			for (const testFile of possibleTestFiles) {
				if (fs.existsSync(testFile) && !testFiles.includes(testFile)) {
					testFiles.push(testFile);
				}
			}
		}
	}

	return testFiles;
}

// ============ Graph-Based Test Discovery (via imports) ============
export async function getTestFilesFromGraph(
	sourceFiles: string[],
): Promise<string[]> {
	const testFiles: string[] = [];

	// First, get candidate test files via convention
	const candidateTestFiles = getTestFilesFromConvention(sourceFiles);

	// If no source files to analyze, return empty
	if (sourceFiles.length === 0) {
		return testFiles;
	}

	// Analyze each candidate test file for import statements
	for (const testFile of candidateTestFiles) {
		try {
			const content = fs.readFileSync(testFile, 'utf-8');
			const testDir = path.dirname(testFile);

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
							if (sourceFiles.includes(withExt) || fs.existsSync(withExt)) {
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
				for (const sourceFile of sourceFiles) {
					const sourceDir = path.dirname(sourceFile);
					const sourceBasename = path.basename(
						sourceFile,
						path.extname(sourceFile),
					);
					// Match if: exact path match, OR same basename AND related directory (same dir, or test file in test subdir)
					const isRelatedDir =
						importDir === sourceDir ||
						importDir === path.join(sourceDir, '__tests__') ||
						importDir === path.join(sourceDir, 'tests') ||
						importDir === path.join(sourceDir, 'test');
					if (
						resolvedImport === sourceFile ||
						(importBasename === sourceBasename && isRelatedDir)
					) {
						if (!testFiles.includes(testFile)) {
							testFiles.push(testFile);
						}
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
							if (sourceFiles.includes(withExt) || fs.existsSync(withExt)) {
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
					for (const sourceFile of sourceFiles) {
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
							importDir === path.join(sourceDir, 'test');
						if (
							resolvedImport === sourceFile ||
							(importBasename === sourceBasename && isRelatedDir)
						) {
							if (!testFiles.includes(testFile)) {
								testFiles.push(testFile);
							}
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
export function buildTestCommand(
	framework: TestFramework,
	scope: 'all' | 'convention' | 'graph',
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
			// Note: 'files' param not forwarded — dart/flutter test use package-level filtering only
			return isCommandAvailable('flutter')
				? ['flutter', 'test']
				: ['dart', 'test'];
		case 'rspec':
			// Use bundle exec when bundler is available, otherwise fall back to rspec directly
			return isCommandAvailable('bundle')
				? ['bundle', 'exec', 'rspec']
				: ['rspec'];
		case 'minitest':
			// Use ruby -e with Dir.glob to avoid platform-specific shell glob expansion
			// Note: 'files' param not forwarded — minitest uses directory-level glob patterns
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
export function parseTestOutput(
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
export async function runTests(
	framework: TestFramework,
	scope: 'all' | 'convention' | 'graph',
	files: string[],
	coverage: boolean,
	timeout_ms: number,
	cwd?: string,
): Promise<TestResult> {
	// Build the command
	const command = buildTestCommand(
		framework,
		scope,
		files,
		coverage,
		cwd ?? process.cwd(),
	);

	if (!command) {
		return {
			success: false,
			framework,
			scope,
			error: `No test command available for framework: ${framework}`,
			message: 'Install a supported test framework to run tests',
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
		};
	}

	const startTime = Date.now();

	try {
		const proc = bunSpawn(command, {
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: cwd || process.cwd(),
		});

		// Race with timeout
		const exitPromise = proc.exited;
		const timeoutPromise = new Promise<number>((resolve) =>
			setTimeout(() => {
				proc.kill();
				resolve(-1); // Timeout indicator
			}, timeout_ms),
		);

		const exitCode = await Promise.race([exitPromise, timeoutPromise]);

		const duration_ms = Date.now() - startTime;

		const [stdout, stderr] = await Promise.all([
			proc.stdout.text(),
			proc.stderr.text(),
		]);

		// Combine stdout and stderr
		let output = stdout;
		if (stderr) {
			output += (output ? '\n' : '') + stderr;
		}

		// Truncate output if too large (byte-aware to avoid corrupting UTF-8)
		const outputBytes = Buffer.byteLength(output, 'utf-8');
		if (outputBytes > MAX_OUTPUT_BYTES) {
			// Find the truncation point that doesn't split a multi-byte character
			let truncIndex = MAX_OUTPUT_BYTES;
			while (truncIndex > 0) {
				const truncated = output.slice(0, truncIndex);
				if (Buffer.byteLength(truncated, 'utf-8') <= MAX_OUTPUT_BYTES) {
					break;
				}
				truncIndex--;
			}
			output = `${output.slice(0, truncIndex)}\n... (output truncated)`;
		}

		// Parse the output
		const { totals, coveragePercent } = parseTestOutput(framework, output);

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

export function findSourceFiles(dir: string, files: string[] = []): string[] {
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
			findSourceFiles(fullPath, files);
		} else if (stat.isFile()) {
			const ext = path.extname(fullPath).toLowerCase();
			if (SOURCE_EXTENSIONS.has(ext)) {
				files.push(fullPath);
			}
		}
	}

	return files;
}
