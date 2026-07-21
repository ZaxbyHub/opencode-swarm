import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Creates a temp directory and redirects config, data, and home environment
 * roots so all test-owned global path resolution lands in the temp dir.
 * Returns a cleanup function that restores original env vars and
 * removes the temp dir.
 */
export function createIsolatedTestEnv(): {
	configDir: string;
	cleanup: () => void;
} {
	const configDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-')),
	);

	// Save original values
	const originalEnv: Record<string, string | undefined> = {
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		XDG_DATA_HOME: process.env.XDG_DATA_HOME,
		APPDATA: process.env.APPDATA,
		LOCALAPPDATA: process.env.LOCALAPPDATA,
		HOME: process.env.HOME,
	};

	// Set isolated config paths
	process.env.XDG_CONFIG_HOME = configDir;
	process.env.XDG_DATA_HOME = configDir;
	process.env.APPDATA = configDir;
	process.env.LOCALAPPDATA = configDir;
	process.env.HOME = configDir;

	const cleanup = (): void => {
		// Restore original environment
		if (originalEnv.XDG_CONFIG_HOME === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
		}

		if (originalEnv.XDG_DATA_HOME === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = originalEnv.XDG_DATA_HOME;
		}

		if (originalEnv.APPDATA === undefined) {
			delete process.env.APPDATA;
		} else {
			process.env.APPDATA = originalEnv.APPDATA;
		}

		if (originalEnv.LOCALAPPDATA === undefined) {
			delete process.env.LOCALAPPDATA;
		} else {
			process.env.LOCALAPPDATA = originalEnv.LOCALAPPDATA;
		}

		if (originalEnv.HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalEnv.HOME;
		}

		// Remove temp directory
		fs.rmSync(configDir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	};

	return { configDir, cleanup };
}

/**
 * Throws immediately if the given path resolves under the user's
 * real home directory (os.homedir()) and is NOT under os.tmpdir().
 * Use as a safety check before any fs.writeFileSync / fs.rmSync in tests.
 */
export function assertSafeForWrite(targetPath: string): void {
	const resolvedPath = path.resolve(targetPath);
	const homeDir = os.homedir();
	const tmpDir = os.tmpdir();

	const resolvedHome = path.resolve(homeDir);
	const resolvedTmp = path.resolve(tmpDir);

	// Check if path is under home directory
	if (
		resolvedPath.startsWith(resolvedHome + path.sep) ||
		resolvedPath === resolvedHome
	) {
		// Check if it's also under tmpdir (allowed)
		if (
			resolvedPath.startsWith(resolvedTmp + path.sep) ||
			resolvedPath === resolvedTmp
		) {
			// Safe: it's under tmpdir even if tmpdir is under homedir
			return;
		}
		// Not safe: under homedir but not under tmpdir
		throw new Error(
			`Unsafe write target: ${targetPath} resolves to ${resolvedPath} which is under the user's home directory (${resolvedHome}) and not under os.tmpdir() (${resolvedTmp}). Use createIsolatedTestEnv() or write to os.tmpdir() instead.`,
		);
	}
}
