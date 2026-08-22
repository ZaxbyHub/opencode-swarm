/**
 * macOS sandbox-exec sandbox executor.
 *
 * Wraps shell commands with sandbox-exec(8) to enforce file-write containment.
 *
 * Profile scope:
 *   - Non-file operations (network, IPC, process creation, sysctl reads) are
 *     ALLOWED via `(allow default)`. This executor enforces file-write
 *     containment only — it is not a full-process sandbox.
 *   - Read-only access to essential system paths (/usr, /bin, /sbin, /lib)
 *   - Read-write access to each scope path and the temp directory
 *   - All other file writes are denied
 */

import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { warn } from '../../utils/logger';
import { isValidEnvKey, SandboxError, type SandboxExecutor } from '../executor';

/**
 * Error codes from spawnSync that indicate sandbox-exec is unavailable.
 */
const SANDBOX_UNAVAILABLE_CODES = new Set(['ENOENT', 'EACCES', 'ENOSPC']);

/**
 * Base-OS location of sandbox-exec. Preferred over the bare name so the
 * probe and every real invocation resolve the actual Seatbelt binary rather
 * than whatever `sandbox-exec` PATH resolution turns up first (e.g. an
 * xcode-select shim that fails after a successful spawn with an unrelated
 * `xcrun: error` — see the P1 hardening class in issue #2236 RC1-LEGACY).
 */
const SANDBOX_EXEC_ABSOLUTE = '/usr/bin/sandbox-exec';

/** Base-OS location of the `true` utility used as the probe's target command. */
const TRUE_ABSOLUTE = '/usr/bin/true';

/**
 * Resolve a binary to its base-OS absolute path when present, falling back
 * to the bare name (PATH resolution) otherwise. Never throws.
 *
 * The existence check goes through `_internals.exists` rather than calling
 * `existsSync` directly so BOTH branches are reachable from a test on ANY
 * host. Against the real filesystem the outcome is decided by the host:
 * `/usr/bin/true` exists on Linux and macOS but not on Windows, and
 * `/usr/bin/sandbox-exec` exists only on macOS — so a test that asserts one
 * branch without this seam is really asserting which OS is running it, and
 * fails on the others (issue #2236 CI: ubuntu shard 2, macos shard 2).
 */
function resolveBinary(absolutePath: string, bareName: string): string {
	try {
		if (_internals.exists(absolutePath)) {
			return absolutePath;
		}
	} catch {
		// fall through to bare-name fallback
	}
	return bareName;
}

/** Resolve the sandbox-exec binary: absolute base-OS path, bare-name fallback. */
function resolveSandboxExecBinary(): string {
	return resolveBinary(SANDBOX_EXEC_ABSOLUTE, 'sandbox-exec');
}

/** Resolve the probe's target command: absolute base-OS path, bare-name fallback. */
function resolveProbeTargetBinary(): string {
	return resolveBinary(TRUE_ABSOLUTE, 'true');
}

/**
 * Build the SBPL profile used ONLY for availability probing.
 *
 * F6a item 2 (issue #2236): this deliberately shares the same primitives and
 * ordering as buildSandboxProfile's production profile — a blanket
 * `(deny file-write*)` followed by a scoped `(allow file-write* (subpath …))`,
 * plus a `(setenv …)`/`(unsetenv …)` pair (F6b) — so that probe success
 * implies the production profile's primitives actually parse under this
 * host's sandbox-exec. A trivial `(allow default)`-only probe would pass
 * even when the production profile is unparseable, which is the exact
 * probe-passes/production-fails failure mode this guards against.
 */
function buildProbeProfile(tempDir: string): string {
	return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "${sbplEscapePath(tempDir)}"))
(setenv SWARM_SANDBOX_PROBE "1")
(unsetenv SWARM_SANDBOX_PROBE)`;
}

/**
 * Check whether the sandbox-exec binary is present and functional.
 * Uses spawnSync to probe synchronously without throwing.
 *
 * F6 (issue #2236 RC2): sandbox-exec(8) has NO `--version` flag — its
 * synopsis is `sandbox-exec [-f file | -n name | -p string] [-D k=v]
 * command [args...]` (BSD getopt, short options only). The previous probe
 * invoked `sandbox-exec --version`, which is consumed as an invalid option
 * and fails on EVERY macOS host regardless of whether Seatbelt actually
 * works. The corrected probe runs a real invocation
 * (`sandbox-exec -p <profile> <target>`) and gates on **exit code 0 ONLY**.
 * stderr is deliberately never consulted — modern macOS prints a
 * deprecation notice to stderr on every sandbox-exec call, and that is not
 * a failure. Empty stdout with exit 0 IS success (sandbox-exec prints
 * nothing on a clean run of `true`).
 */
function probeSandboxExec(): boolean {
	try {
		const binary = resolveSandboxExecBinary();
		const target = resolveProbeTargetBinary();
		const profile = buildProbeProfile(os.tmpdir());
		const result = _internals.spawnSync(binary, ['-p', profile, target], {
			windowsHide: true,
			encoding: 'utf-8',
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'pipe'] as SpawnSyncOptions['stdio'],
		} satisfies SpawnSyncOptions);

		if (result.error) {
			const code = (result.error as NodeJS.ErrnoException).code as
				| string
				| undefined;
			if (code && SANDBOX_UNAVAILABLE_CODES.has(code)) {
				warn(
					`Sandbox disabled: sandbox-exec error (${code}). Falling through to tool-layer enforcement.`,
				);
				return false;
			}
			warn(
				`Sandbox disabled: spawn error (${result.error.message}). Falling through to tool-layer enforcement.`,
			);
			return false;
		}

		// Exit code 0 is the ONLY success criterion. stdout/stderr content is
		// never consulted (see function doc above).
		return result.status === 0;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		warn(
			`Sandbox disabled: probe threw (${message}). Falling through to tool-layer enforcement.`,
		);
		return false;
	}
}

/**
 * F6a item 1 (issue #2236): memoize the probe.
 *
 * Prior to F6, `wrapCommand()` re-ran `probeSandboxExec()` on EVERY call, but
 * that spawn never actually fired in production because the (broken) probe
 * always reported the executor unavailable, so the executor was never
 * constructed. Once F6 corrects the probe, an unmemoized re-probe becomes a
 * synchronous `sandbox-exec` spawn on every bash tool call. Discipline
 * mirrors the git-binary resolver (F1): a successful probe is memoized for
 * the process lifetime; a failed probe is memoized for a 60s TTL and then
 * re-probed (so a transiently-broken sandbox-exec — e.g. mid-OS-update —
 * recovers without requiring a process restart).
 */
const PROBE_FAILURE_TTL_MS = 60_000;

interface ProbeMemo {
	result: boolean;
	expiresAt: number;
}

let _probeMemo: ProbeMemo | undefined;

function probeSandboxExecMemoized(): boolean {
	const now = Date.now();
	if (_probeMemo && now < _probeMemo.expiresAt) {
		return _probeMemo.result;
	}
	const result = _internals.probeSandboxExec();
	_probeMemo = {
		result,
		expiresAt: result ? Number.POSITIVE_INFINITY : now + PROBE_FAILURE_TTL_MS,
	};
	return result;
}

/** Clear the probe memo. Test-only — production never needs to reset it mid-process. */
function resetProbeMemo(): void {
	_probeMemo = undefined;
}

/**
 * DI seam for testability. Exposes probeSandboxExec so tests can simulate
 * ENOENT / EACCES / ENOSPC error conditions without requiring a real sandbox-exec binary.
 */
export const _internals: {
	probeSandboxExec: typeof probeSandboxExec;
	probeSandboxExecMemoized: typeof probeSandboxExecMemoized;
	resetProbeMemo: typeof resetProbeMemo;
	buildSandboxProfile: typeof buildSandboxProfile;
	buildProbeProfile: typeof buildProbeProfile;
	resolveSandboxExecBinary: typeof resolveSandboxExecBinary;
	resolveProbeTargetBinary: typeof resolveProbeTargetBinary;
	exists: typeof existsSync;
	spawnSync: typeof spawnSync;
} = {
	probeSandboxExec,
	probeSandboxExecMemoized,
	resetProbeMemo,
	buildSandboxProfile,
	buildProbeProfile,
	resolveSandboxExecBinary,
	resolveProbeTargetBinary,
	exists: existsSync,
	spawnSync,
} as const;

/**
 * Escape a string for safe embedding inside a single-quoted shell string.
 * Replaces single quotes with the four-character sequence: '\''
 */
function shellEscape(s: string): string {
	return s.replace(/'/g, "'\\''");
}

/**
 * Escape a path string for safe embedding inside a double-quoted SBPL string.
 * SBPL uses double-quoted strings similar to Scheme/Lisp.
 * - Backslashes must be escaped first to avoid double-escaping
 * - Double quotes must be escaped to avoid breaking the string literal
 * - Control characters (newlines, tabs, etc.) are removed as they have no
 *   valid use in file paths and would break the profile structure
 */
function sbplEscapePath(path: string): string {
	// Remove control characters (ASCII 0-31 and DEL 127) that cannot appear
	// in valid file paths and would break the SBPL profile structure.
	// newline (10), carriage return (13), and tab (9) are the primary concerns.
	const withoutControlChars = path
		.split('')
		.filter((ch) => {
			const cp = ch.codePointAt(0)!;
			return cp >= 32 && cp !== 127; // printable ASCII + Unicode beyond ASCII
		})
		.join('');

	return withoutControlChars
		.replace(/\\/g, '\\\\') // Escape backslashes first
		.replace(/"/g, '\\"'); // Escape double quotes
}

/**
 * Build a sandbox-exec profile string for the given scope paths, temp dir, and optional env overrides.
 */
function buildSandboxProfile(
	scopePaths: string[],
	tempDir: string,
	envOverrides?: Record<string, string | null>,
): string {
	// Collect unique paths to allow read-write
	const rwPaths = [...scopePaths];
	if (tempDir) {
		rwPaths.push(tempDir);
	}

	// Build (allow file-write* (subpath "...")) lines for each rw path
	// F-003 fix: escape scope paths to prevent SBPL profile injection
	const rwAllowLines = rwPaths
		.map((p) => `(allow file-write* (subpath "${sbplEscapePath(p)}"))`)
		.join('\n');

	// Build SBPL env override primitives.
	// (setenv KEY "VALUE") sets a var; (unsetenv KEY) removes it.
	// Keys are validated to prevent SBPL syntax injection (parentheses, etc.).
	// Values are embedded inside a double-quoted SBPL string, so escape double quotes.
	const envLines: string[] = [];
	if (envOverrides) {
		for (const [key, value] of Object.entries(envOverrides)) {
			// Reject invalid env var names silently — invalid keys cannot be safely
			// interpolated into SBPL syntax.
			if (!isValidEnvKey(key)) {
				continue;
			}
			if (value === null) {
				envLines.push(`(unsetenv ${key})`);
			} else {
				// Escape double quotes and backslashes for SBPL double-quoted string
				const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
				envLines.push(`(setenv ${key} "${escaped}")`);
			}
		}
	}

	// Core profile: allow non-file ops (network, IPC, process creation) via
	// (allow default), allow system read-only paths, then confine writes to the
	// declared scope.
	//
	// SBPL is LAST-MATCH-WINS. The blanket `(deny file-write*)` MUST therefore
	// appear BEFORE the scoped `(allow file-write* (subpath ...))` lines: an
	// in-scope write matches both the deny and the later scoped allow, so the
	// allow (last) wins and the write succeeds (AC-001); an out-of-scope write
	// matches only the deny, so it is rejected (AC-002, fail-closed). The
	// previous ordering placed the blanket deny LAST, which overrode the scoped
	// allow and denied every write — including in-scope writes (issue #1778 H2).
	//
	// NOTE: reasoned from documented SBPL last-match-wins semantics; not
	// empirically re-verified on a macOS host in this environment.
	const profile = `(version 1)
(allow default)
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/sbin"))
(allow file-read* (subpath "/lib"))
(allow file-read* (subpath "/lib64"))
(deny file-write*)
${rwAllowLines}
${envLines.join('\n')}`;

	return profile;
}

/**
 * macOS sandbox-exec sandbox executor.
 */
export class MacOSSandboxExecutor implements SandboxExecutor {
	/** Human-readable mechanism identifier */
	public readonly mechanism = 'sandbox-exec';

	private readonly _scopePaths: string[];
	private readonly _tempDir: string | undefined;
	private _available: boolean;
	private _disabledReason: string | null;

	/**
	 * @param scopePaths - Absolute paths the sandboxed process may write to
	 * @param tempDir   - Optional temp directory path (defaults to system temp)
	 */
	constructor(scopePaths: string[] = [], tempDir?: string) {
		// Throw early on non-macOS to clearly communicate platform requirement
		if (process.platform !== 'darwin') {
			throw new Error('MacOSSandboxExecutor not yet implemented');
		}

		this._scopePaths = scopePaths;
		this._tempDir = tempDir;
		this._available = false;
		this._disabledReason = null;

		try {
			if (!_internals.probeSandboxExecMemoized()) {
				this._disabledReason = 'sandbox-exec not available or not functional';
				warn(
					`Sandbox disabled: ${this._disabledReason}. Falling through to tool-layer enforcement.`,
				);
			} else {
				this._available = true;
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this._disabledReason = `constructor threw: ${message}`;
			this._available = false;
			warn(
				`Sandbox disabled: ${this._disabledReason}. Falling through to tool-layer enforcement.`,
			);
		}
	}

	/**
	 * Returns true when sandbox-exec is available and the sandbox has not been disabled.
	 */
	isAvailable(): boolean {
		return this._available;
	}

	/**
	 * Disable the sandbox with a reason.
	 */
	disable(reason: string): void {
		this._disabledReason = reason;
		this._available = false;
		warn(
			`Sandbox disabled: ${reason}. Falling through to tool-layer enforcement.`,
		);
	}

	/**
	 * Wrap a shell command string with sandbox-exec.
	 *
	 * @param command   - Raw shell command to execute inside the sandbox
	 * @param scopePaths - Additional scope paths to bind (merged with constructor scope)
	 * @param tempDir   - Optional temp directory override
	 * @param envOverrides - Optional per-call env overrides: string sets the var, null unsets it.
	 *                      When omitted, no per-call env override is applied.
	 * @returns A sandbox-exec wrapped command string ready for shell execution,
	 *          or the raw command string when the sandbox is unavailable (passthrough mode)
	 */
	wrapCommand(
		command: string,
		scopePaths: string[],
		tempDir?: string,
		envOverrides?: Record<string, string | null>,
	): string {
		// Re-check availability before each wrap
		if (!this._available) {
			throw new SandboxError('Sandbox not available', 'SANDBOX_UNAVAILABLE');
		}

		if (!_internals.probeSandboxExecMemoized()) {
			this._available = false;
			this._disabledReason = 'sandbox-exec became unavailable between calls';
			warn(
				`Sandbox disabled: ${this._disabledReason}. Falling through to tool-layer enforcement.`,
			);
			throw new SandboxError('Sandbox not available', 'SANDBOX_UNAVAILABLE');
		}

		const temp = tempDir ?? this._tempDir ?? os.tmpdir();
		const allScopes = [...this._scopePaths, ...scopePaths];

		const profile = buildSandboxProfile(allScopes, temp, envOverrides);

		// Write profile to a dedicated temp directory (mkdtempSync ensures a unique dir per call)
		let profilePath: string;
		try {
			const profileDir = mkdtempSync(path.join(os.tmpdir(), 'sandbox-'));
			profilePath = path.join(
				profileDir,
				`profile-${process.pid}-${Date.now()}.sb`,
			);
			writeFileSync(profilePath, profile, { mode: 0o600 });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			warn(
				`Sandbox disabled: failed to write profile (${message}). Falling through to tool-layer enforcement.`,
			);
			throw new SandboxError('Sandbox not available', 'SANDBOX_UNAVAILABLE');
		}

		// <sandbox-exec> -f <profile> bash -c '<command>'
		// Resolved to the base-OS absolute path (F6) so this can never resolve
		// to a broken PATH shim (e.g. an xcode-select stub that fails after a
		// successful spawn with an unrelated `xcrun: error`).
		// Profile file persists for the lifetime of the spawned process.
		// Note: profile files accumulate in os.tmpdir() over time. This is
		// acceptable — they are small text files with allowlist rules, no secrets.
		const binary = _internals.resolveSandboxExecBinary();
		const escapedCommand = shellEscape(command);
		const escapedProfilePath = shellEscape(profilePath);
		return `${binary} -f '${escapedProfilePath}' bash -c '${escapedCommand}'`;
	}

	/**
	 * Return environment variable overrides required for the macOS sandbox.
	 *
	 * DYLD_INSERT_LIBRARIES, DYLD_LIBRARY_PATH, DYLD_FRAMEWORK_PATH, and
	 * DYLD_ROOT_PATH can be used to bypass sandbox restrictions by injecting
	 * dynamic libraries. Unsetting them improves sandbox enforcement (defense in depth).
	 */
	getEnvOverrides(): Record<string, string | null> {
		return {
			DYLD_INSERT_LIBRARIES: null,
			DYLD_LIBRARY_PATH: null,
			DYLD_FRAMEWORK_PATH: null,
			DYLD_ROOT_PATH: null,
			PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
		};
	}
}
