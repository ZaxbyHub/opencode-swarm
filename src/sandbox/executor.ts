/**
 * Platform-agnostic sandbox execution abstraction.
 *
 * Provides a unified interface for sandboxed shell command execution across
 * Linux (Bubblewrap), macOS (sandbox-exec), and Windows (restricted token/Low Integrity).
 */

/**
 * Error thrown when sandbox operations fail.
 */
export class SandboxError extends Error {
	constructor(
		message: string,
		public readonly code: string,
	) {
		super(message);
		this.name = 'SandboxError';
	}
}

/**
 * Interface for platform-specific sandbox executors.
 */
export interface SandboxExecutor {
	/** Human-readable name of the sandbox mechanism */
	readonly mechanism: string;

	/** Whether this executor is available on the current platform */
	isAvailable(): boolean;

	/**
	 * Wrap a shell command with sandbox prefix.
	 * @param command - The raw shell command string to execute
	 * @param scopePaths - Absolute paths the coder is allowed to write to
	 * @param tempDir - Optional temporary directory path (platform default if omitted)
	 * @returns The wrapped command string with sandbox prefix
	 * @throws SandboxError if sandbox cannot wrap the command
	 */
	wrapCommand(command: string, scopePaths: string[], tempDir?: string): string;

	/**
	 * Get the environment variable overrides for this sandbox.
	 * Returns a record of env vars to set/unset.
	 */
	getEnvOverrides(): Record<string, string | null>;
}

// Cached executor promise — set once at first getExecutor() call.
// This ensures the capability probe runs only once even if getExecutor()
// is called multiple times.
// undefined = not yet initialized, Promise<null> = initialized but no executor available
let _cachedExecutorPromise: Promise<SandboxExecutor | null> | undefined;

/**
 * Get the platform-appropriate sandbox executor.
 *
 * Returns null if no sandbox mechanism is available for the current platform.
 * The result is cached after the first call for fast subsequent access.
 *
 * Lazily imports platform-specific executor modules to avoid import-time
 * failures on platforms where they don't exist.
 */
export async function getExecutor(): Promise<SandboxExecutor | null> {
	if (_cachedExecutorPromise !== undefined) {
		return _cachedExecutorPromise;
	}

	_cachedExecutorPromise = _createExecutor();
	return _cachedExecutorPromise;
}

/**
 * Create the appropriate executor for this platform.
 * Internal — called once and cached.
 */
async function _createExecutor(): Promise<SandboxExecutor | null> {
	const platform = process.platform;

	if (platform === 'linux') {
		return _createLinuxExecutor();
	}

	if (platform === 'darwin') {
		return _createMacOSExecutor();
	}

	if (platform === 'win32') {
		return _createWindowsExecutor();
	}

	// Unknown platform — no sandbox available
	return null;
}

async function _createLinuxExecutor(): Promise<SandboxExecutor | null> {
	// Import and run the async capability probe first to populate the sync cache
	const { SandboxCapabilityProbe, isBubblewrapAvailable } = await import(
		'./capability-probe'
	);
	await new SandboxCapabilityProbe().detect();

	if (!isBubblewrapAvailable()) {
		return null;
	}

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { BubblewrapSandboxExecutor } = require('./executors/bubblewrap');
		// F-001 fix: Pass empty scope paths array as default - actual scope paths
		// are passed at wrapCommand() time and merged with constructor paths
		return new BubblewrapSandboxExecutor([]);
	} catch {
		return null;
	}
}

async function _createMacOSExecutor(): Promise<SandboxExecutor | null> {
	// Import and run the async capability probe first to populate the sync cache
	const { SandboxCapabilityProbe, isSandboxExecAvailable } = await import(
		'./capability-probe'
	);
	await new SandboxCapabilityProbe().detect();

	if (!isSandboxExecAvailable()) {
		return null;
	}

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { MacOSSandboxExecutor } = require('./executors/macos');
		return new MacOSSandboxExecutor([]);
	} catch {
		return null;
	}
}

async function _createWindowsExecutor(): Promise<SandboxExecutor | null> {
	// Import and run the async capability probe first to populate the sync cache
	const { SandboxCapabilityProbe, isWindowsSandboxAvailable } = await import(
		'./capability-probe'
	);
	await new SandboxCapabilityProbe().detect();
	if (!isWindowsSandboxAvailable()) {
		return null;
	}

	try {
		// Primary: NativeWindowsSandboxExecutor (tries runner binary, falls back to PowerShell)
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { WindowsSandboxExecutor } = require('./executors/windows');
		return new WindowsSandboxExecutor([]);
	} catch {
		return null;
	}
}

/**
 * Reset the cached executor — useful for testing.
 * @internal
 */
export function _resetExecutorCache(): void {
	_cachedExecutorPromise = undefined;
}
