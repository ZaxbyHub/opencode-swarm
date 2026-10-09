import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunSpawn, bunSpawnSync } from '../utils/bun-compat';

// Note: imports from build/discovery and utils removed - will be handled in opencode package

// ============ Constants ============
export const LINT_MAX_OUTPUT_BYTES = 512_000; // 512KB max output
export const MAX_COMMAND_LENGTH = 500;
export const SUPPORTED_LINTERS = ['biome', 'eslint'] as const;
export type SupportedLinter = (typeof SUPPORTED_LINTERS)[number];

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
	| 'rubocop';

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
export function containsPathTraversal(str: string): boolean {
	return /\.\.[/\\]/.test(str);
}

export function containsControlChars(str: string): boolean {
	return /[\0\t\r\n]/.test(str);
}

export function validateArgs(args: unknown): args is { mode: 'fix' | 'check' } {
	if (typeof args !== 'object' || args === null) return false;
	const obj = args as Record<string, unknown>;
	if (obj.mode !== 'fix' && obj.mode !== 'check') return false;
	return true;
}

// ============ Platform Utilities ============

/**
 * Check if a command is available on the PATH
 */
function isCommandAvailable(cmd: string): boolean {
	try {
		const result = bunSpawnSync(
			{
				cmd: process.platform === 'win32' ? ['where', cmd] : ['which', cmd],
			},
			{ stdout: 'pipe', stderr: 'pipe' },
		);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

export function getLinterCommand(
	linter: SupportedLinter,
	mode: 'fix' | 'check',
	projectDir: string,
): string[] {
	const isWindows = process.platform === 'win32';

	// Get path to local node_modules/.bin
	const binDir = path.join(projectDir, 'node_modules', '.bin');
	const biomeBin = isWindows
		? path.join(binDir, 'biome.EXE')
		: path.join(binDir, 'biome');
	const eslintBin = isWindows
		? path.join(binDir, 'eslint.cmd')
		: path.join(binDir, 'eslint');

	switch (linter) {
		case 'biome':
			// Use local biome directly (not npx) to ensure consistent version
			if (mode === 'fix') {
				return isWindows
					? [biomeBin, 'check', '--write', '.']
					: [biomeBin, 'check', '--write', '.'];
			}
			return isWindows ? [biomeBin, 'check', '.'] : [biomeBin, 'check', '.'];
		case 'eslint':
			// eslint .  or  eslint . --fix
			if (mode === 'fix') {
				return isWindows
					? [eslintBin, '.', '--fix']
					: [eslintBin, '.', '--fix'];
			}
			return isWindows ? [eslintBin, '.'] : [eslintBin, '.'];
	}
}

/**
 * Build the shell command for an additional (non-JS/TS) linter.
 * cppcheck has no --fix mode; csharp and some others behave differently.
 */
export function getAdditionalLinterCommand(
	linter: AdditionalLinter,
	mode: 'fix' | 'check',
	cwd: string,
): string[] {
	// Detect gradlew wrapper for checkstyle (use .bat extension on Windows)
	const gradlewName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
	const gradlew = fs.existsSync(path.join(cwd, gradlewName))
		? path.join(cwd, gradlewName)
		: null;

	const isCommandAvailable = (cmd: string): boolean => {
		try {
			const result = bunSpawnSync(
				{
					cmd: process.platform === 'win32' ? ['where', cmd] : ['which', cmd],
				},
				{ stdout: 'pipe', stderr: 'pipe' },
			);
			return result.exitCode === 0;
		} catch {
			return false;
		}
	};

	switch (linter) {
		case 'ruff':
			return mode === 'fix'
				? ['ruff', 'check', '--fix', '.']
				: ['ruff', 'check', '.'];
		case 'clippy':
			return mode === 'fix'
				? ['cargo', 'clippy', '--fix', '--allow-dirty']
				: ['cargo', 'clippy'];
		case 'golangci-lint':
			return mode === 'fix'
				? ['golangci-lint', 'run', '--fix']
				: ['golangci-lint', 'run'];
		case 'checkstyle':
			// Gradle project: prefer gradlew, else gradle; Maven project: mvn
			if (gradlew) {
				return [gradlew, 'checkstyleMain'];
			}
			if (isCommandAvailable('gradle')) {
				return ['gradle', 'checkstyleMain'];
			}
			return ['mvn', 'checkstyle:check'];
		case 'ktlint':
			return mode === 'fix' ? ['ktlint', '--format'] : ['ktlint'];
		case 'dotnet-format':
			return mode === 'fix'
				? ['dotnet', 'format']
				: ['dotnet', 'format', '--verify-no-changes'];
		case 'cppcheck':
			// cppcheck has no fix mode; always check
			return ['cppcheck', '--enable=all', '.'];
		case 'swiftlint':
			return mode === 'fix' ? ['swiftlint', '--fix'] : ['swiftlint'];
		case 'dart-analyze':
			return mode === 'fix' ? ['dart', 'fix'] : ['dart', 'analyze'];
		case 'rubocop': {
			// prefer bundle exec rubocop if bundler available
			const useBundle = isCommandAvailable('bundle');
			const base = useBundle ? ['bundle', 'exec', 'rubocop'] : ['rubocop'];
			return mode === 'fix' ? [...base, '-A'] : base;
		}
	}
}

// ============ Additional Linter Detectors ============

/** Detect ruff (Python fast linter) */
function detectRuff(cwd: string): boolean {
	// ruff.toml OR pyproject.toml with [tool.ruff] section OR ruff binary present
	if (fs.existsSync(path.join(cwd, 'ruff.toml')))
		return isCommandAvailable('ruff');
	try {
		const pyproject = path.join(cwd, 'pyproject.toml');
		if (fs.existsSync(pyproject)) {
			const content = fs.readFileSync(pyproject, 'utf-8');
			if (content.includes('[tool.ruff]')) return isCommandAvailable('ruff');
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
		fs.existsSync(path.join(cwd, 'Cargo.toml')) && isCommandAvailable('cargo')
	);
}

/** Detect golangci-lint (Go linter) */
function detectGolangciLint(cwd: string): boolean {
	// go.mod exists AND golangci-lint binary on PATH
	return (
		fs.existsSync(path.join(cwd, 'go.mod')) &&
		isCommandAvailable('golangci-lint')
	);
}

/** Detect checkstyle (Java linter via mvn or checkstyle jar) */
function detectCheckstyle(cwd: string): boolean {
	// Maven: pom.xml + mvn binary; Gradle: build.gradle(.kts) + gradlew or gradle binary
	const hasMaven = fs.existsSync(path.join(cwd, 'pom.xml'));
	const hasGradle =
		fs.existsSync(path.join(cwd, 'build.gradle')) ||
		fs.existsSync(path.join(cwd, 'build.gradle.kts'));
	const hasBinary =
		(hasMaven && isCommandAvailable('mvn')) ||
		(hasGradle &&
			(fs.existsSync(path.join(cwd, 'gradlew')) ||
				isCommandAvailable('gradle')));
	return (hasMaven || hasGradle) && hasBinary;
}

/** Detect ktlint (Kotlin linter) */
function detectKtlint(cwd: string): boolean {
	// build.gradle.kts, build.gradle (Groovy DSL), or .kt/.kts files in root dir
	const hasKotlin =
		fs.existsSync(path.join(cwd, 'build.gradle.kts')) ||
		fs.existsSync(path.join(cwd, 'build.gradle')) ||
		(() => {
			try {
				return fs
					.readdirSync(cwd)
					.some((f) => f.endsWith('.kt') || f.endsWith('.kts'));
			} catch {
				return false;
			}
		})();
	return hasKotlin && isCommandAvailable('ktlint');
}

/** Detect dotnet-format (C#/.NET linter) */
function detectDotnetFormat(cwd: string): boolean {
	// Note: Only scans the root directory for .csproj/.sln files.
	// Deeply nested .NET projects may require running from the solution root.
	try {
		const files = fs.readdirSync(cwd);
		const hasCsproj = files.some(
			(f) => f.endsWith('.csproj') || f.endsWith('.sln'),
		);
		return hasCsproj && isCommandAvailable('dotnet');
	} catch {
		return false;
	}
}

/** Detect cppcheck (C/C++ static analyzer) */
function detectCppcheck(cwd: string): boolean {
	// CMakeLists.txt is definitive; also scan root and common src/ subdirectory for C/C++ files
	if (fs.existsSync(path.join(cwd, 'CMakeLists.txt'))) {
		return isCommandAvailable('cppcheck');
	}
	try {
		const dirsToCheck = [cwd, path.join(cwd, 'src')];
		const hasCpp = dirsToCheck.some((dir) => {
			try {
				return fs
					.readdirSync(dir)
					.some((f) => /\.(c|cpp|cc|cxx|h|hpp)$/.test(f));
			} catch {
				return false;
			}
		});
		return hasCpp && isCommandAvailable('cppcheck');
	} catch {
		return false;
	}
}

/** Detect swiftlint (Swift linter) */
function detectSwiftlint(cwd: string): boolean {
	// Package.swift exists AND swiftlint binary on PATH
	return (
		fs.existsSync(path.join(cwd, 'Package.swift')) &&
		isCommandAvailable('swiftlint')
	);
}

/** Detect dart analyze (Dart/Flutter linter) */
function detectDartAnalyze(cwd: string): boolean {
	// pubspec.yaml exists AND dart binary on PATH
	return (
		fs.existsSync(path.join(cwd, 'pubspec.yaml')) &&
		(isCommandAvailable('dart') || isCommandAvailable('flutter'))
	);
}

/** Detect rubocop (Ruby linter) */
function detectRubocop(cwd: string): boolean {
	// Gemfile, gems.rb (Bundler 2 alternative), or .rubocop.yml config
	return (
		(fs.existsSync(path.join(cwd, 'Gemfile')) ||
			fs.existsSync(path.join(cwd, 'gems.rb')) ||
			fs.existsSync(path.join(cwd, '.rubocop.yml'))) &&
		(isCommandAvailable('rubocop') || isCommandAvailable('bundle'))
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
	| null {
	if (detectRuff(cwd)) return 'ruff';
	if (detectClippy(cwd)) return 'clippy';
	if (detectGolangciLint(cwd)) return 'golangci-lint';
	if (detectCheckstyle(cwd)) return 'checkstyle';
	if (detectKtlint(cwd)) return 'ktlint';
	if (detectDotnetFormat(cwd)) return 'dotnet-format';
	if (detectCppcheck(cwd)) return 'cppcheck';
	if (detectSwiftlint(cwd)) return 'swiftlint';
	if (detectDartAnalyze(cwd)) return 'dart-analyze';
	if (detectRubocop(cwd)) return 'rubocop';
	return null;
}

// ============ Linter Detection ============
export async function detectAvailableLinter(): Promise<SupportedLinter | null> {
	// Timeout for linter detection (in ms)
	const DETECT_TIMEOUT = 2000;

	// Try biome first (fastest, recommended)
	try {
		const biomeProc = bunSpawn(['npx', 'biome', '--version'], {
			stdout: 'pipe',
			stderr: 'pipe',
		});

		// Race with timeout
		const biomeExit = biomeProc.exited;
		const timeout = new Promise<'timeout'>((resolve) =>
			setTimeout(() => resolve('timeout'), DETECT_TIMEOUT),
		);

		const result = await Promise.race([biomeExit, timeout]);
		if (result === 'timeout') {
			biomeProc.kill();
			// biome not available or timed out
		} else if (biomeProc.exitCode === 0) {
			return 'biome';
		}
	} catch {
		// biome not available
	}

	// Try eslint
	try {
		const eslintProc = bunSpawn(['npx', 'eslint', '--version'], {
			stdout: 'pipe',
			stderr: 'pipe',
		});

		// Race with timeout
		const eslintExit = eslintProc.exited;
		const timeout = new Promise<'timeout'>((resolve) =>
			setTimeout(() => resolve('timeout'), DETECT_TIMEOUT),
		);

		const result = await Promise.race([eslintExit, timeout]);
		if (result === 'timeout') {
			eslintProc.kill();
			// eslint not available or timed out
		} else if (eslintProc.exitCode === 0) {
			return 'eslint';
		}
	} catch {
		// eslint not available
	}

	return null;
}

// ============ Lint Execution ============
export async function runLint(
	linter: SupportedLinter,
	mode: 'fix' | 'check',
	directory: string,
): Promise<LintResult> {
	const command = getLinterCommand(linter, mode, directory);

	// Validate command length for safety
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

	try {
		const proc = bunSpawn(command, {
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: directory,
			// FB-007b: bound the compat layer's buffered capture to the same
			// 512KB budget the truncation below enforces.
			maxBuffer: LINT_MAX_OUTPUT_BYTES,
		});

		const [stdout, stderr] = await Promise.all([
			proc.stdout.text(),
			proc.stderr.text(),
		]);

		const exitCode = await proc.exited;

		// Combine stdout and stderr, truncate if needed
		let output = stdout;
		if (stderr) {
			output += (output ? '\n' : '') + stderr;
		}

		// Truncate output if too large
		if (output.length > LINT_MAX_OUTPUT_BYTES) {
			output = `${output.slice(0, LINT_MAX_OUTPUT_BYTES)}\n... (output truncated)`;
		}

		const result: LintSuccessResult = {
			success: true,
			mode,
			linter,
			command,
			exitCode,
			output,
		};

		// Add helpful message based on results
		if (exitCode === 0) {
			result.message = `${linter} ${mode} completed successfully with no issues`;
		} else if (mode === 'fix') {
			result.message = `${linter} fix completed with exit code ${exitCode}. Run check mode to see remaining issues.`;
		} else {
			result.message = `${linter} check found issues (exit code ${exitCode}).`;
		}

		return result;
	} catch (error) {
		return {
			success: false,
			mode,
			linter,
			command,
			error:
				error instanceof Error
					? `Execution failed: ${error.message}`
					: 'Execution failed: unknown error',
		};
	}
}

/**
 * Run an additional (non-JS/TS) linter.
 * Follows the same structure as runLint() but uses getAdditionalLinterCommand().
 */
export async function runAdditionalLint(
	linter: AdditionalLinter,
	mode: 'fix' | 'check',
	cwd: string,
): Promise<LintResult> {
	const command = getAdditionalLinterCommand(linter, mode, cwd);

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

	try {
		const proc = bunSpawn(command, {
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			cwd,
			// FB-007b: bound the compat layer's buffered capture to the same
			// 512KB budget the truncation below enforces.
			maxBuffer: LINT_MAX_OUTPUT_BYTES,
		});

		const [stdout, stderr] = await Promise.all([
			proc.stdout.text(),
			proc.stderr.text(),
		]);

		const exitCode = await proc.exited;

		let output = stdout;
		if (stderr) {
			output += (output ? '\n' : '') + stderr;
		}

		if (output.length > LINT_MAX_OUTPUT_BYTES) {
			output = `${output.slice(0, LINT_MAX_OUTPUT_BYTES)}\n... (output truncated)`;
		}

		const result: LintSuccessResult = {
			success: true,
			mode,
			linter,
			command,
			exitCode,
			output,
		};

		if (exitCode === 0) {
			result.message = `${linter} ${mode} completed successfully with no issues`;
		} else if (mode === 'fix') {
			result.message = `${linter} fix completed with exit code ${exitCode}. Run check mode to see remaining issues.`;
		} else {
			result.message = `${linter} check found issues (exit code ${exitCode}).`;
		}

		return result;
	} catch (error) {
		return {
			success: false,
			mode,
			linter,
			command,
			error:
				error instanceof Error
					? `Execution failed: ${error.message}`
					: 'Execution failed: unknown error',
		};
	}
}
