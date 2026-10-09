/**
 * Build Discovery Module
 *
 * Discovers build commands from project configuration files.
 * Provides toolchain detection and package.json script discovery.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunSpawnSync } from '../utils/bun-compat';

// ============ Toolchain Cache ============

const toolchainCache = new Map<string, boolean>();

// ============ Types ============

/**
 * Represents a discovered build command
 */
export interface BuildCommand {
	/** The command to execute */
	command: string;
	/** Working directory for the command */
	cwd: string;
	/** Optional: ecosystem (npm, cargo, etc.) */
	ecosystem?: string;
	/** Optional: command name from package.json scripts */
	name?: string;
}

/**
 * Options for build discovery
 */
export interface BuildDiscoveryOptions {
	/** Scope: 'changed' or 'all' */
	scope: 'changed' | 'all';
	/** List of changed files when scope is 'changed' */
	changedFiles?: string[];
}

/**
 * Result of build discovery
 */
export interface BuildDiscoveryResult {
	/** Discovered build commands */
	commands: BuildCommand[];
	/** List of skipped ecosystems with reasons */
	skipped: Array<{
		ecosystem: string;
		reason: string;
	}>;
}

/**
 * Package.json scripts structure
 */
interface PackageJsonScripts {
	[key: string]: string;
}

interface PackageJson {
	scripts?: PackageJsonScripts;
}

// ============ Command Availability ============

/**
 * Check if a command exists on PATH
 * Uses 'where' on Windows, 'which' on Unix
 */
export function isCommandAvailable(command: string): boolean {
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

// ============ Build Command Discovery ============

/**
 * Detect ecosystem from project files
 */
function detectEcosystems(workingDir: string): string[] {
	const ecosystems: string[] = [];

	// Check for package.json -> npm
	if (fs.existsSync(path.join(workingDir, 'package.json'))) {
		ecosystems.push('npm');
	}

	// Check for Cargo.toml -> cargo
	if (fs.existsSync(path.join(workingDir, 'Cargo.toml'))) {
		ecosystems.push('cargo');
	}

	// Check for go.mod -> go
	if (fs.existsSync(path.join(workingDir, 'go.mod'))) {
		ecosystems.push('go');
	}

	// Check for pyproject.toml or requirements.txt -> pip
	if (
		fs.existsSync(path.join(workingDir, 'pyproject.toml')) ||
		fs.existsSync(path.join(workingDir, 'requirements.txt'))
	) {
		ecosystems.push('pip');
	}

	// Check for .csproj or .sln -> dotnet
	try {
		const files = fs.readdirSync(workingDir);
		if (files.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) {
			ecosystems.push('dotnet');
		}
	} catch {
		// ignore unreadable directory
	}

	return ecosystems;
}

/**
 * Get build-related scripts from package.json
 */
function getBuildScripts(
	pkg: PackageJson,
): Array<{ name: string; command: string }> {
	const scripts: Array<{ name: string; command: string }> = [];

	if (!pkg.scripts) {
		return scripts;
	}

	// Map of script keywords to identify build/typecheck/test commands
	const scriptPatterns: Array<{ keywords: string[]; prefix: string }> = [
		{ keywords: ['build', 'compile', 'bundle'], prefix: 'build' },
		{
			keywords: ['typecheck', 'type-check', 'tsc', 'check', 'type'],
			prefix: 'typecheck',
		},
		{ keywords: ['test', 'spec', 'test:watch'], prefix: 'test' },
	];

	for (const [scriptName, scriptCommand] of Object.entries(pkg.scripts)) {
		// Skip common non-build scripts
		if (
			scriptName === 'start' ||
			scriptName === 'dev' ||
			scriptName === 'serve' ||
			scriptName === 'lint' ||
			scriptName === 'format'
		) {
			continue;
		}

		// Check if script matches build-related patterns
		for (const { keywords, prefix } of scriptPatterns) {
			const lowerName = scriptName.toLowerCase();
			const matchesKeyword = keywords.some(
				(k) =>
					lowerName === k ||
					lowerName.startsWith(`${k}:`) ||
					lowerName.includes(`-${k}`),
			);

			if (matchesKeyword) {
				scripts.push({ name: scriptName, command: scriptCommand });
			}
		}
	}

	return scripts;
}

/**
 * Discover build commands for npm projects
 */
async function discoverNpmCommands(
	workingDir: string,
	_options: BuildDiscoveryOptions,
): Promise<{
	commands: BuildCommand[];
	skipped: BuildDiscoveryResult['skipped'];
}> {
	const commands: BuildCommand[] = [];
	const skipped: BuildDiscoveryResult['skipped'] = [];

	const packageJsonPath = path.join(workingDir, 'package.json');

	if (!fs.existsSync(packageJsonPath)) {
		skipped.push({ ecosystem: 'npm', reason: 'No package.json found' });
		return { commands, skipped };
	}

	try {
		const content = fs.readFileSync(packageJsonPath, 'utf-8');
		const pkg = JSON.parse(content) as PackageJson;

		const buildScripts = getBuildScripts(pkg);

		if (buildScripts.length === 0) {
			skipped.push({
				ecosystem: 'npm',
				reason: 'No build scripts found in package.json',
			});
			return { commands, skipped };
		}

		// Add npm run prefix to scripts
		for (const script of buildScripts) {
			commands.push({
				command: `npm run ${script.name}`,
				cwd: workingDir,
				ecosystem: 'npm',
				name: script.name,
			});
		}
	} catch (error) {
		skipped.push({
			ecosystem: 'npm',
			reason: `Error reading package.json: ${error instanceof Error ? error.message : 'Unknown error'}`,
		});
	}

	return { commands, skipped };
}

/**
 * Discover build commands for Cargo/Rust projects
 */
async function discoverCargoCommands(
	workingDir: string,
	_options: BuildDiscoveryOptions,
): Promise<{
	commands: BuildCommand[];
	skipped: BuildDiscoveryResult['skipped'];
}> {
	const commands: BuildCommand[] = [];
	const skipped: BuildDiscoveryResult['skipped'] = [];

	const cargoTomlPath = path.join(workingDir, 'Cargo.toml');

	if (!fs.existsSync(cargoTomlPath)) {
		skipped.push({ ecosystem: 'cargo', reason: 'No Cargo.toml found' });
		return { commands, skipped };
	}

	// Check if cargo is available
	if (!isCommandAvailable('cargo')) {
		skipped.push({ ecosystem: 'cargo', reason: 'cargo command not available' });
		return { commands, skipped };
	}

	// Add cargo build command
	commands.push({
		command: 'cargo build',
		cwd: workingDir,
		ecosystem: 'cargo',
		name: 'build',
	});

	// Check for clippy (linting)
	if (isCommandAvailable('cargo-clippy') || isCommandAvailable('clippy')) {
		commands.push({
			command: 'cargo clippy -- -D warnings',
			cwd: workingDir,
			ecosystem: 'cargo',
			name: 'clippy',
		});
	}

	// Add cargo test command
	commands.push({
		command: 'cargo test',
		cwd: workingDir,
		ecosystem: 'cargo',
		name: 'test',
	});

	return { commands, skipped };
}

/**
 * Discover build commands for Go projects
 */
async function discoverGoCommands(
	workingDir: string,
	_options: BuildDiscoveryOptions,
): Promise<{
	commands: BuildCommand[];
	skipped: BuildDiscoveryResult['skipped'];
}> {
	const commands: BuildCommand[] = [];
	const skipped: BuildDiscoveryResult['skipped'] = [];

	const goModPath = path.join(workingDir, 'go.mod');

	if (!fs.existsSync(goModPath)) {
		skipped.push({ ecosystem: 'go', reason: 'No go.mod found' });
		return { commands, skipped };
	}

	// Check if go is available
	if (!isCommandAvailable('go')) {
		skipped.push({ ecosystem: 'go', reason: 'go command not available' });
		return { commands, skipped };
	}

	// Add go build command
	commands.push({
		command: 'go build ./...',
		cwd: workingDir,
		ecosystem: 'go',
		name: 'build',
	});

	// Add go test command
	commands.push({
		command: 'go test ./...',
		cwd: workingDir,
		ecosystem: 'go',
		name: 'test',
	});

	// Add go vet command
	commands.push({
		command: 'go vet ./...',
		cwd: workingDir,
		ecosystem: 'go',
		name: 'vet',
	});

	return { commands, skipped };
}

/**
 * Discover build commands for Python projects
 */
async function discoverPipCommands(
	workingDir: string,
	_options: BuildDiscoveryOptions,
): Promise<{
	commands: BuildCommand[];
	skipped: BuildDiscoveryResult['skipped'];
}> {
	const commands: BuildCommand[] = [];
	const skipped: BuildDiscoveryResult['skipped'] = [];

	const hasPyproject = fs.existsSync(path.join(workingDir, 'pyproject.toml'));
	const hasRequirements = fs.existsSync(
		path.join(workingDir, 'requirements.txt'),
	);

	if (!hasPyproject && !hasRequirements) {
		skipped.push({
			ecosystem: 'pip',
			reason: 'No pyproject.toml or requirements.txt found',
		});
		return { commands, skipped };
	}

	// Check for build tools
	if (isCommandAvailable('python') || isCommandAvailable('python3')) {
		const pythonCmd = isCommandAvailable('python') ? 'python' : 'python3';

		// Check for setup.py or pyproject.toml build
		if (fs.existsSync(path.join(workingDir, 'setup.py')) || hasPyproject) {
			commands.push({
				command: `${pythonCmd} -m build`,
				cwd: workingDir,
				ecosystem: 'pip',
				name: 'build',
			});
		}

		// Check for pytest
		if (isCommandAvailable('pytest')) {
			commands.push({
				command: 'pytest',
				cwd: workingDir,
				ecosystem: 'pip',
				name: 'test',
			});
		}

		// Check for mypy
		if (isCommandAvailable('mypy')) {
			commands.push({
				command: 'mypy .',
				cwd: workingDir,
				ecosystem: 'pip',
				name: 'typecheck',
			});
		}

		// Check for ruff (linting + formatting)
		if (isCommandAvailable('ruff')) {
			commands.push({
				command: 'ruff check .',
				cwd: workingDir,
				ecosystem: 'pip',
				name: 'lint',
			});
		}
	} else {
		skipped.push({ ecosystem: 'pip', reason: 'Python not available' });
	}

	if (commands.length === 0 && skipped.length === 0) {
		skipped.push({ ecosystem: 'pip', reason: 'No build tools available' });
	}

	return { commands, skipped };
}

/**
 * Discover build commands for .NET projects
 */
async function discoverDotnetCommands(
	workingDir: string,
	_options: BuildDiscoveryOptions,
): Promise<{
	commands: BuildCommand[];
	skipped: BuildDiscoveryResult['skipped'];
}> {
	const commands: BuildCommand[] = [];
	const skipped: BuildDiscoveryResult['skipped'] = [];

	// Check for .csproj or .sln files
	const hasCsproj = fs
		.readdirSync(workingDir)
		.some((f) => f.endsWith('.csproj'));
	const hasSln = fs.readdirSync(workingDir).some((f) => f.endsWith('.sln'));

	if (!hasCsproj && !hasSln) {
		skipped.push({
			ecosystem: 'dotnet',
			reason: 'No .csproj or .sln files found',
		});
		return { commands, skipped };
	}

	// Check if dotnet is available
	if (!isCommandAvailable('dotnet')) {
		skipped.push({
			ecosystem: 'dotnet',
			reason: 'dotnet command not available',
		});
		return { commands, skipped };
	}

	// Add dotnet build command
	commands.push({
		command: 'dotnet build',
		cwd: workingDir,
		ecosystem: 'dotnet',
		name: 'build',
	});

	// Add dotnet test command
	commands.push({
		command: 'dotnet test',
		cwd: workingDir,
		ecosystem: 'dotnet',
		name: 'test',
	});

	return { commands, skipped };
}

/**
 * Main discovery function - discovers build commands for all detected ecosystems
 */
export async function discoverBuildCommands(
	workingDir: string,
	options: BuildDiscoveryOptions,
): Promise<BuildDiscoveryResult> {
	const allCommands: BuildCommand[] = [];
	const allSkipped: BuildDiscoveryResult['skipped'] = [];

	// Detect ecosystems in the working directory
	const ecosystems = detectEcosystems(workingDir);

	// Discover commands for each ecosystem
	for (const ecosystem of ecosystems) {
		let result: {
			commands: BuildCommand[];
			skipped: BuildDiscoveryResult['skipped'];
		};

		switch (ecosystem) {
			case 'npm':
				result = await discoverNpmCommands(workingDir, options);
				break;
			case 'cargo':
				result = await discoverCargoCommands(workingDir, options);
				break;
			case 'go':
				result = await discoverGoCommands(workingDir, options);
				break;
			case 'pip':
				result = await discoverPipCommands(workingDir, options);
				break;
			case 'dotnet':
				result = await discoverDotnetCommands(workingDir, options);
				break;
			default:
				result = { commands: [], skipped: [] };
		}

		allCommands.push(...result.commands);
		allSkipped.push(...result.skipped);
	}

	// If no ecosystems detected
	if (ecosystems.length === 0) {
		allSkipped.push({
			ecosystem: 'unknown',
			reason:
				'No recognized project files found (package.json, Cargo.toml, go.mod, etc.)',
		});
	}

	return {
		commands: allCommands,
		skipped: allSkipped,
	};
}
