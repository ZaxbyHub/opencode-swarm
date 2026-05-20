import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ToolContext, tool } from '@opencode-ai/plugin';
import { detectProjectLanguages } from '../lang/detector';
import { LANGUAGE_REGISTRY } from '../lang/profiles';
import { simpleGlobToRegex, warn } from '../utils';
import { bunSpawnSync } from '../utils/bun-compat';

// ============ Types ============

export interface BuildCommand {
	ecosystem: string;
	command: string;
	cwd: string;
	priority: number; // Lower = higher priority
}

export interface BuildDiscoveryResult {
	commands: BuildCommand[];
	skipped: { ecosystem: string; reason: string }[];
}

export interface BuildDiscoveryOptions {
	scope?: 'changed' | 'all';
	changedFiles?: string[];
}

// ============ Ecosystem Definitions ============

interface EcosystemConfig {
	ecosystem: string;
	buildFiles: string[];
	toolchainCommands: string[];
	commands: { command: string; priority: number }[];
	repoDefinedScripts?: string[]; // Scripts that can be defined in repo config
}

const ECOSYSTEMS: EcosystemConfig[] = [
	{
		ecosystem: 'node',
		buildFiles: ['package.json'],
		toolchainCommands: ['npm', 'yarn', 'pnpm'],
		commands: [
			{ command: 'npm run build', priority: 1 },
			{ command: 'npm run typecheck', priority: 2 },
			{ command: 'npm run check', priority: 3 },
		],
		repoDefinedScripts: ['build', 'typecheck', 'check', 'compile'],
	},
	{
		ecosystem: 'rust',
		buildFiles: ['Cargo.toml'],
		toolchainCommands: ['cargo'],
		commands: [
			{ command: 'cargo build', priority: 1 },
			{ command: 'cargo check', priority: 2 },
		],
	},
	{
		ecosystem: 'go',
		buildFiles: ['go.mod'],
		toolchainCommands: ['go'],
		commands: [{ command: 'go build ./...', priority: 1 }],
	},
	{
		ecosystem: 'python',
		buildFiles: ['pyproject.toml', 'setup.py', 'setup.cfg'],
		toolchainCommands: ['python', 'python3', 'py'],
		commands: [
			{ command: 'python -m py_compile', priority: 1 },
			{ command: 'python -m build', priority: 2 },
		],
	},
	{
		ecosystem: 'java-maven',
		buildFiles: ['pom.xml'],
		toolchainCommands: ['mvn'],
		commands: [{ command: 'mvn compile', priority: 1 }],
	},
	{
		ecosystem: 'java-gradle',
		buildFiles: ['build.gradle', 'build.gradle.kts', 'gradle.properties'],
		toolchainCommands: ['gradle', 'gradlew'],
		commands: [
			{
				command:
					process.platform === 'win32'
						? 'gradlew.bat build'
						: './gradlew build',
				priority: 1,
			},
			{ command: 'gradle build', priority: 2 },
		],
	},
	{
		ecosystem: 'dotnet',
		buildFiles: ['*.csproj', '*.fsproj', '*.vbproj'],
		toolchainCommands: ['dotnet'],
		commands: [{ command: 'dotnet build', priority: 1 }],
	},
	{
		ecosystem: 'swift',
		buildFiles: ['Package.swift'],
		toolchainCommands: ['swift'],
		commands: [{ command: 'swift build', priority: 1 }],
	},
	{
		ecosystem: 'dart',
		buildFiles: ['pubspec.yaml', 'pubspec.lock'],
		toolchainCommands: ['dart', 'flutter'],
		commands: [
			{ command: 'dart analyze', priority: 1 },
			{ command: 'dart compile', priority: 2 },
		],
	},
	{
		ecosystem: 'cpp',
		buildFiles: ['Makefile', 'CMakeLists.txt'],
		toolchainCommands: ['make', 'cmake'],
		commands: [
			{ command: 'make', priority: 1 },
			{ command: 'cmake -B build && cmake --build build', priority: 2 },
		],
	},
	{
		ecosystem: 'php-composer',
		buildFiles: ['composer.json'],
		toolchainCommands: ['composer'],
		commands: [
			{
				command: 'composer install --no-interaction --prefer-dist',
				priority: 1,
			},
		],
	},
];

/**
 * Maps LanguageProfile IDs to the ECOSYSTEMS ecosystem names they cover.
 * Used for de-duplication between profile-driven and fallback detection.
 */
const PROFILE_TO_ECOSYSTEM_NAMES: Record<string, string[]> = {
	typescript: ['node'],
	python: ['python'],
	rust: ['rust'],
	go: ['go'],
	java: ['java-maven', 'java-gradle'],
	kotlin: ['java-gradle'],
	csharp: ['dotnet'],
	cpp: ['cpp'],
	swift: ['swift'],
	dart: ['dart'],
	ruby: [],
	php: ['php-composer'],
};

// ============ Toolchain Detection Cache ============

const toolchainCache: Map<string, boolean> = new Map();

// ============ Helper Functions ============

/**
 * Check if a command exists on PATH.
 * Uses 'where' on Windows, 'which' on Unix.
 *
 * Invariant 3 (subprocesses, AGENTS.md): every subprocess call must set
 * `cwd` explicitly, `stdin: 'ignore'` (non-interactive), `timeout`, and
 * bounded or ignored stdio. Cache hits skip the spawn entirely.
 *
 * `cwd` is set to `process.cwd()` for invariant compliance; for PATH probes
 * cwd is functionally irrelevant (`which`/`where` resolve via env PATH only),
 * but the invariant requires the option to be set explicitly so an inherited
 * cwd anomaly cannot affect later subprocess work in this tree.
 *
 * 3000ms timeout chosen to tolerate slow Windows `where` invocations under
 * corporate AV / locked-down PATH layouts (single PATH probe is amortized
 * across many calls via toolchainCache).
 */
const IS_COMMAND_AVAILABLE_TIMEOUT_MS = 3000;

export function isCommandAvailable(command: string): boolean {
	if (toolchainCache.has(command)) {
		return toolchainCache.get(command)!;
	}

	const isWindows = process.platform === 'win32';
	const cmd = isWindows ? `${command}.exe` : command;

	try {
		const result = _internals.spawnSyncImpl(
			isWindows ? ['where', cmd] : ['which', cmd],
			{
				cwd: process.cwd(),
				stdin: 'ignore',
				stdout: 'ignore',
				stderr: 'ignore',
				timeout: IS_COMMAND_AVAILABLE_TIMEOUT_MS,
			},
		);
		const available = result.success;
		toolchainCache.set(command, available);
		return available;
	} catch {
		toolchainCache.set(command, false);
		return false;
	}
}

/**
 * Check if any of the toolchain commands are available
 */
function checkToolchain(commands: string[]): boolean {
	return commands.some((cmd) => isCommandAvailable(cmd));
}

/**
 * Find build files in the given directory
 */
function findBuildFiles(workingDir: string, patterns: string[]): string | null {
	for (const pattern of patterns) {
		// Handle glob-like patterns
		if (pattern.includes('*')) {
			// For simple patterns like *.csproj
			const dir = workingDir;
			try {
				const files = fs.readdirSync(dir);
				const regex = simpleGlobToRegex(pattern);
				const matches = files.filter((f) => regex.test(f));
				if (matches.length > 0) {
					return path.join(dir, matches[0]);
				}
			} catch {
				// Ignore errors
			}
		} else {
			// Exact file match
			const filePath = path.join(workingDir, pattern);
			if (fs.existsSync(filePath)) {
				return filePath;
			}
		}
	}
	return null;
}

/**
 * Get repo-defined build scripts from package.json
 */
function getRepoDefinedScripts(
	workingDir: string,
	scripts: string[],
): { script: string; priority: number }[] {
	const packageJsonPath = path.join(workingDir, 'package.json');

	if (!fs.existsSync(packageJsonPath)) {
		return [];
	}

	try {
		const content = fs.readFileSync(packageJsonPath, 'utf-8');
		const pkg = JSON.parse(content);

		if (!pkg.scripts || typeof pkg.scripts !== 'object') {
			return [];
		}

		const found: { script: string; priority: number }[] = [];

		for (const scriptName of scripts) {
			if (pkg.scripts[scriptName]) {
				found.push({
					script: `npm run ${scriptName}`,
					priority: 0, // Repo-defined scripts have highest priority
				});
			}
		}

		return found;
	} catch {
		return [];
	}
}

/**
 * Filter files by scope (changed or all)
 */
function filterByScope(
	workingDir: string,
	scope: 'changed' | 'all',
	changedFiles?: string[],
): string[] {
	if (scope === 'all') {
		// Return all files in the directory (recursively find build files)
		return findAllBuildFiles(workingDir);
	}

	if (!changedFiles || changedFiles.length === 0) {
		return [];
	}

	// For 'changed' scope, filter changed files to only those in relevant paths
	return changedFiles;
}

/**
 * Find all potential build files in directory tree
 */
function findAllBuildFiles(workingDir: string): string[] {
	const allBuildFiles = new Set<string>();

	for (const ecosystem of ECOSYSTEMS) {
		for (const pattern of ecosystem.buildFiles) {
			if (pattern.includes('*')) {
				// Glob pattern - search recursively
				const regex = simpleGlobToRegex(pattern);
				findFilesRecursive(workingDir, regex, allBuildFiles);
			} else {
				// Exact file
				const filePath = path.join(workingDir, pattern);
				if (fs.existsSync(filePath)) {
					allBuildFiles.add(filePath);
				}
			}
		}
	}

	return Array.from(allBuildFiles);
}

/**
 * Recursively find files matching a regex
 */
function findFilesRecursive(
	dir: string,
	regex: RegExp,
	results: Set<string>,
): void {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);

			// Skip node_modules and other common ignore directories
			if (
				entry.isDirectory() &&
				!['node_modules', '.git', 'dist', 'build', 'target'].includes(
					entry.name,
				)
			) {
				findFilesRecursive(fullPath, regex, results);
			} else if (entry.isFile() && regex.test(entry.name)) {
				results.add(fullPath);
			}
		}
	} catch {
		// Ignore permission errors
	}
}

// ============ Profile-Driven Build Discovery ============

/**
 * Discover build commands using language profiles (primary detection path)
 */
// `spawnSyncImpl` is a DI seam used by `isCommandAvailable`; tests override it
// to spy on the spawn options and verify Invariant 3 (subprocess) properties
// without spawning a real process. Restore in afterEach. See
// .claude/skills/engineering-conventions/SKILL.md for the rationale (mock.module
// leaks across test files in Bun's shared test-runner process; DI is preferred).
export const _internals: {
	isCommandAvailable: typeof isCommandAvailable;
	discoverBuildCommandsFromProfiles: typeof discoverBuildCommandsFromProfiles;
	discoverBuildCommands: typeof discoverBuildCommands;
	clearToolchainCache: typeof clearToolchainCache;
	getEcosystems: typeof getEcosystems;
	spawnSyncImpl: typeof bunSpawnSync;
} = {
	isCommandAvailable,
	discoverBuildCommandsFromProfiles,
	discoverBuildCommands,
	clearToolchainCache,
	getEcosystems,
	spawnSyncImpl: bunSpawnSync,
};

export async function discoverBuildCommandsFromProfiles(
	workingDir: string,
): Promise<BuildDiscoveryResult> {
	const commands: BuildCommand[] = [];
	const skipped: { ecosystem: string; reason: string }[] = [];

	// Get detected profiles sorted by tier (lower tier = higher confidence)
	const detectedProfiles = await detectProjectLanguages(workingDir);

	for (const profile of detectedProfiles) {
		// Get the full profile from registry
		const fullProfile = LANGUAGE_REGISTRY.get(profile.id);
		if (!fullProfile) {
			warn(
				`[build-discovery] profile ${profile.id} not found in registry, skipping`,
			);
			continue;
		}

		// Sort commands by priority (lower = higher priority)
		const sortedCommands = [...fullProfile.build.commands].sort(
			(a, b) => a.priority - b.priority,
		);

		// Find first available binary
		let foundCommand = false;
		for (const cmd of sortedCommands) {
			// Skip command if its detectFile is specified but not present
			if (cmd.detectFile) {
				const detectFilePath = path.join(workingDir, cmd.detectFile);
				if (!fs.existsSync(detectFilePath)) {
					continue;
				}
			}
			// Check if binary is available on PATH
			// Derive binary name from first word of command string
			const binaryName = cmd.cmd.split(' ')[0];
			if (isCommandAvailable(binaryName)) {
				commands.push({
					ecosystem: fullProfile.id,
					command: cmd.cmd,
					cwd: workingDir,
					priority: cmd.priority,
				});
				foundCommand = true;
				break; // Only pick the first/highest-priority available binary
			}
		}

		if (!foundCommand) {
			const triedBinaries = sortedCommands
				.map((c) => c.name || c.cmd.split(' ')[0])
				.join(', ');
			const reason = `No binary available for profile ${fullProfile.id}: tried ${triedBinaries}`;
			skipped.push({
				ecosystem: fullProfile.id,
				reason,
			});
			warn(
				`[build-discovery] profile ${fullProfile.id}: no binary available, skipping`,
			);
		}
	}

	return { commands, skipped };
}

// ============ Main Discovery Function ============

/**
 * Discover build commands for a given working directory
 */
export async function discoverBuildCommands(
	workingDir: string,
	options?: BuildDiscoveryOptions,
): Promise<BuildDiscoveryResult> {
	const scope = options?.scope ?? 'all';
	const changedFiles = options?.changedFiles ?? [];

	// Get files to check based on scope
	const _filesToCheck = filterByScope(workingDir, scope, changedFiles);

	// ============ Profile-driven detection (primary path) ============
	const profileResult =
		await _internals.discoverBuildCommandsFromProfiles(workingDir);
	const profileCommands = profileResult.commands;
	const profileSkipped = profileResult.skipped;

	// Build the set of ecosystem names already covered by profile detection
	const coveredEcosystems = new Set<string>();
	for (const cmd of profileCommands) {
		const ecosystemNames = PROFILE_TO_ECOSYSTEM_NAMES[cmd.ecosystem] ?? [];
		for (const name of ecosystemNames) {
			coveredEcosystems.add(name);
		}
	}

	// ============ Ecosystem-based detection (fallback) ============
	const commands: BuildCommand[] = [...profileCommands];
	const skipped: { ecosystem: string; reason: string }[] = [...profileSkipped];

	// Process each ecosystem, skipping those already covered by profiles
	for (const ecosystem of ECOSYSTEMS) {
		// Skip if this ecosystem is already handled by profile detection
		if (coveredEcosystems.has(ecosystem.ecosystem)) {
			// Still surface the ecosystem in skipped so callers can detect it was found
			skipped.push({
				ecosystem: ecosystem.ecosystem,
				reason: `Covered by profile detection`,
			});
			continue;
		}

		// Check if toolchain is available
		if (!checkToolchain(ecosystem.toolchainCommands)) {
			skipped.push({
				ecosystem: ecosystem.ecosystem,
				reason: `Toolchain not found: ${ecosystem.toolchainCommands.join(
					' or ',
				)} not on PATH`,
			});
			continue;
		}

		// Check for build files
		const buildFile = findBuildFiles(workingDir, ecosystem.buildFiles);

		if (!buildFile) {
			skipped.push({
				ecosystem: ecosystem.ecosystem,
				reason: `No build file found: ${ecosystem.buildFiles.join(', ')}`,
			});
			continue;
		}

		// For Node.js, check for repo-defined scripts first
		let availableCommands: { command: string; priority: number }[] =
			ecosystem.commands;

		if (ecosystem.repoDefinedScripts) {
			const repoScripts = getRepoDefinedScripts(
				workingDir,
				ecosystem.repoDefinedScripts,
			);
			if (repoScripts.length > 0) {
				availableCommands = repoScripts.map((s) => ({
					command: s.script,
					priority: s.priority,
				}));
			}
		}

		// Add commands for this ecosystem
		for (const cmd of availableCommands) {
			commands.push({
				ecosystem: ecosystem.ecosystem,
				command: cmd.command,
				cwd: workingDir,
				priority: cmd.priority,
			});
		}
	}

	// Sort by priority (lower = higher priority)
	commands.sort((a, b) => a.priority - b.priority);

	return { commands, skipped };
}

/**
 * Clear the toolchain cache (useful for testing)
 */
export function clearToolchainCache(): void {
	toolchainCache.clear();
}

/**
 * Get ecosystem info for display
 */
export function getEcosystems(): string[] {
	return ECOSYSTEMS.map((e) => e.ecosystem);
}

// ============ Tool Definition ============

export const build_discovery: ReturnType<typeof tool> = tool({
	description:
		'Discover build commands for various ecosystems in a project directory',
	args: {
		workingDir: tool.schema
			.string()
			.describe(
				'Directory to scan for build commands (defaults to current directory)',
			),
		scope: tool.schema
			.string()
			.optional()
			.describe(
				'Scope of detection: "all" for all build files, "changed" for only changed files',
			),
		changedFiles: tool.schema
			.array(tool.schema.string())
			.optional()
			.describe('List of changed files when scope is "changed"'),
	},
	async execute(
		args: {
			workingDir: string;
			scope?: 'changed' | 'all';
			changedFiles?: string[];
		},
		_context: ToolContext,
	): Promise<string> {
		const result = await discoverBuildCommands(args.workingDir, {
			scope: args.scope ?? 'all',
			changedFiles: args.changedFiles ?? [],
		});

		return JSON.stringify(result, null, 2);
	},
});
