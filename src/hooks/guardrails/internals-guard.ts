/**
 * PLUGIN-INTERNALS READ GUARD (issue #2063, workstream B4)
 *
 * When a fail-closed gate denies a dispatch, the observed failure mode is an
 * agent that goes looking for the answer inside the *plugin's own installed
 * files* — `node_modules/opencode-swarm/**`, `~/.cache/opencode/packages/...`,
 * `dist/index.js`. That search can never succeed: the installed bundle is not
 * the state the error names, it is not editable from the user's workspace, and
 * every minute spent in it is a minute the blocker is not surfaced to the user.
 *
 * This guard is the mechanical brake for that specific behaviour. It denies
 * `read` / `glob` / `grep` / `bash` calls whose RESOLVED target lands inside the
 * installed package directory.
 *
 * DESIGN CONSTRAINTS (all three are load-bearing):
 *
 *  1. **Explicitly best-effort.** `cd` chains, shell variables, wrapper CLIs and
 *     any other indirection evade it. The durable coverage for evasive
 *     spelunking is B5 (execution-stall) plus the A4 prompt rule; this guard
 *     exists to catch the overwhelmingly common direct form cheaply. It must
 *     therefore FAIL OPEN on every kind of resolution uncertainty — a false
 *     denial of a legitimate read is far worse than a missed evasion.
 *
 *  2. **Self-development exemption.** When the workspace root IS the
 *     opencode-swarm repository, the "installed package" and "the code the user
 *     is working on" are the same tree, and the guard would block the plugin's
 *     own maintainers from reading their own source. The exemption is keyed on
 *     `package.json#name === 'opencode-swarm'` at the workspace root.
 *
 *  3. **Runtime-derived package root.** The root is derived from this module's
 *     own location (`import.meta.url`), walking up to the nearest directory
 *     whose `package.json` is named `opencode-swarm`. It is NOT hardcoded and
 *     NOT derived from the workspace, so it is correct under every cache layout
 *     in AGENTS.md invariant 12 and under a plain `node_modules` install.
 *
 * The denial is thrown from the guardrails `tool.execute.before` chain, so it
 * flows through the B1 gate-denial tracker automatically: an agent that keeps
 * retrying the same spelunking read escalates to the STOP directive.
 */

import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { telemetry } from '../../telemetry.js';
import { normalizeToolNameLowerCase } from '../normalize-tool-name';

/**
 * The exact denial text. Exported so tests pin the wording rather than a
 * paraphrase, and so the leading `SWARM_INTERNALS_OFF_LIMITS:` token — which
 * `deriveGateDenialCode` (B1) uses as the streak key — cannot drift.
 */
export const SWARM_INTERNALS_DENIAL_MESSAGE =
	"SWARM_INTERNALS_OFF_LIMITS: the swarm plugin's installed files are never the fix for a gate error. Fix the dispatch/state the error names, or report the blocker to the user.";

/**
 * Tools whose target path this guard inspects.
 *
 * `shell` is included alongside `bash` because this repository treats them as
 * one tool everywhere else it matters (`handleTestSuiteBlocking` and the shell
 * audit log in `tool-before.ts` both test `bash || shell`). Guarding `bash`
 * alone would leave a hole that costs nothing to close.
 */
const GUARDED_TOOLS: ReadonlySet<string> = new Set([
	'read',
	'glob',
	'grep',
	'bash',
	'shell',
]);

/** Argument keys that can carry a scalar path on read/glob/grep. */
const SCALAR_PATH_KEYS = [
	'filePath',
	'file_path',
	'path',
	'file',
	'target',
] as const;

/** Ceiling on the upward walk when locating the package root. */
const MAX_PACKAGE_ROOT_WALK_DEPTH = 12;

/** Ceiling on distinct workspace roots whose self-dev status is cached. */
const MAX_CACHED_WORKSPACE_ROOTS = 32;

/**
 * Absolute path candidates inside a shell command.
 *
 * Deliberately conservative — only forms that are unambiguously absolute:
 *   - POSIX absolute (`/home/u/...`)
 *   - Windows drive-absolute (`C:\...` or `C:/...`)
 *   - home-relative (`~/...`)
 *
 * Anything else (relative paths, `$VAR` expansions, `cd` chains) yields no
 * candidate and the call is allowed. Quote characters and shell metacharacters
 * terminate a candidate so `"…/foo.ts"` and `…/foo.ts;` both resolve cleanly.
 *
 * The leading `(?:^|[…])` boundary is load-bearing: without it the matcher
 * would find `/hooks` inside the RELATIVE token `src/hooks` and resolve it to
 * the filesystem root, which could false-positive against a shallowly-installed
 * package root such as `/opt/opencode-swarm`. Group 1 is the candidate.
 */
const SHELL_PATH_CANDIDATE_PATTERN =
	/(?:^|[\s'"`;|&<>()=,])((?:~|[A-Za-z]:)?[\\/][^\s'"`;|&<>()]*)/g;

/** Ceiling on shell path candidates considered for one command. */
const MAX_SHELL_PATH_CANDIDATES = 64;

/** Ceiling on the shell command length scanned for path candidates. */
const MAX_SCANNED_COMMAND_LENGTH = 8192;

interface PackageRootResolution {
	root: string | null;
}

let cachedPackageRoot: PackageRootResolution | undefined;
const selfDevelopmentWorkspaces = new Map<string, boolean>();

/**
 * Read `package.json#name` at `dir`. Returns `null` for a missing, unreadable,
 * or malformed manifest — every failure is indistinguishable from "not the
 * plugin package" for this guard's purposes, and all of them must fail open.
 */
function readPackageName(dir: string): string | null {
	try {
		const manifestPath = path.join(dir, 'package.json');
		if (!_internals.existsSync(manifestPath)) return null;
		const parsed = JSON.parse(_internals.readFileSync(manifestPath, 'utf-8'));
		const name = (parsed as { name?: unknown } | null)?.name;
		return typeof name === 'string' ? name : null;
	} catch {
		return null;
	}
}

/**
 * Locate the installed opencode-swarm package root from this module's own
 * location. Computed once (including the `null` "could not determine" result)
 * and cached for the process lifetime — the plugin's own location cannot change
 * while it is loaded.
 */
function resolvePackageRoot(): string | null {
	if (cachedPackageRoot !== undefined) return cachedPackageRoot.root;
	let root: string | null = null;
	try {
		let dir = path.dirname(fileURLToPath(_internals.moduleUrl()));
		for (let depth = 0; depth < MAX_PACKAGE_ROOT_WALK_DEPTH; depth++) {
			if (readPackageName(dir) === 'opencode-swarm') {
				root = dir;
				break;
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		root = null;
	}
	cachedPackageRoot = { root };
	return root;
}

/**
 * True when `directory` is an opencode-swarm checkout, i.e. the guard must be
 * inert. Cached per workspace root with a hard size cap (invariant 8).
 */
function isSelfDevelopmentWorkspace(directory: string): boolean {
	if (!directory) return false;
	let resolved: string;
	try {
		resolved = path.resolve(directory);
	} catch {
		return false;
	}
	const cached = selfDevelopmentWorkspaces.get(resolved);
	if (cached !== undefined) return cached;
	const isSelfDev = readPackageName(resolved) === 'opencode-swarm';
	if (selfDevelopmentWorkspaces.size >= MAX_CACHED_WORKSPACE_ROOTS) {
		const oldest = selfDevelopmentWorkspaces.keys().next().value;
		if (oldest !== undefined) selfDevelopmentWorkspaces.delete(oldest);
	}
	selfDevelopmentWorkspaces.set(resolved, isSelfDev);
	return isSelfDev;
}

/** Windows path comparison is case-insensitive; POSIX is not. */
function comparablePath(value: string): string {
	return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * True when `target` is `root` or lies beneath it. Pure string containment on
 * already-resolved paths — no `realpath`, because a symlink probe is filesystem
 * I/O on a hot hook path and this guard is explicitly best-effort.
 */
export function isInsidePackageRoot(root: string, target: string): boolean {
	try {
		const rel = path.relative(comparablePath(root), comparablePath(target));
		if (rel === '') return true;
		if (rel.startsWith('..')) return false;
		return !path.isAbsolute(rel);
	} catch {
		return false;
	}
}

/** Expand a leading `~` using the real home directory. */
function expandHome(candidate: string): string | null {
	if (!candidate.startsWith('~')) return candidate;
	const home = _internals.homedir();
	if (!home) return null;
	const rest = candidate.slice(1).replace(/^[\\/]/, '');
	return rest ? path.join(home, rest) : home;
}

/**
 * Extract the path candidates this guard is willing to reason about.
 *
 * Returns ONLY candidates that are unambiguously absolute (or `~`-anchored).
 * A relative path is deliberately dropped: resolving it would require guessing
 * a base directory, and a wrong guess produces a false denial.
 */
export function extractGuardedPathCandidates(
	normalizedTool: string,
	args: unknown,
): string[] {
	const argsObj = (args ?? {}) as Record<string, unknown>;
	const raw: string[] = [];

	if (normalizedTool === 'bash' || normalizedTool === 'shell') {
		const command =
			typeof argsObj.command === 'string'
				? argsObj.command.slice(0, MAX_SCANNED_COMMAND_LENGTH)
				: undefined;
		if (command) {
			// A fresh matcher each call: the /g regex carries lastIndex state.
			const matcher = new RegExp(
				SHELL_PATH_CANDIDATE_PATTERN.source,
				SHELL_PATH_CANDIDATE_PATTERN.flags,
			);
			for (const match of command.matchAll(matcher)) {
				const token = match[1];
				// A bare `/` carries no target; skip it rather than resolving root.
				if (token && token.length > 1) raw.push(token);
				if (raw.length >= MAX_SHELL_PATH_CANDIDATES) break;
			}
		}
	} else {
		for (const key of SCALAR_PATH_KEYS) {
			const value = argsObj[key];
			if (typeof value === 'string' && value.length > 0) raw.push(value);
		}
	}

	const resolved: string[] = [];
	for (const candidate of raw) {
		const expanded = expandHome(candidate);
		if (!expanded) continue;
		// Fail open on anything not unambiguously absolute after expansion.
		if (!path.isAbsolute(expanded)) continue;
		try {
			resolved.push(path.resolve(expanded));
		} catch {
			/* unresolvable — fail open */
		}
	}
	return resolved;
}

export interface InternalsGuardOptions {
	/**
	 * `guardrails.enabled`. Mirrors `GateDenialOptions.enabled` (B1): when the
	 * user turns guardrails off, every guardrails behaviour must be inert or the
	 * config surface lies. Defaults to enabled.
	 */
	enabled?: boolean;
}

/**
 * Deny a read/glob/grep/bash call that targets the installed plugin package.
 *
 * Throws `SWARM_INTERNALS_OFF_LIMITS: …` on a positive match; returns normally
 * (fail open) in every other case, including:
 *   - guardrails disabled,
 *   - the tool is not one of the guarded five,
 *   - the workspace is an opencode-swarm checkout,
 *   - the package root could not be derived,
 *   - no unambiguously-absolute candidate could be extracted.
 */
export function enforceInternalsGuard(params: {
	sessionID: string;
	tool: string;
	args: unknown;
	directory: string;
	options?: InternalsGuardOptions;
}): void {
	const { sessionID, tool, args, directory, options } = params;
	if (options?.enabled === false) return;

	const normalizedTool = normalizeToolNameLowerCase(tool ?? '');
	if (!GUARDED_TOOLS.has(normalizedTool)) return;

	let match: string | null = null;
	let relativeTarget = '';
	try {
		const packageRoot = _internals.resolvePackageRoot();
		if (!packageRoot) return;
		if (_internals.isSelfDevelopmentWorkspace(directory)) return;
		// Second inert case, and the one with the catastrophic failure mode: if
		// the WORKSPACE ROOT itself resolves inside the package root, then every
		// path in that workspace is inside the package root and the guard would
		// deny read/glob/grep/bash outright. That happens whenever `directory`
		// points at a SUBDIRECTORY of a checkout (no `package.json` there, so the
		// self-dev check above cannot see it) or anywhere under an install. A
		// guard that can deny a whole workspace must refuse to arm there.
		if (
			directory &&
			isInsidePackageRoot(packageRoot, path.resolve(directory))
		) {
			return;
		}

		for (const candidate of extractGuardedPathCandidates(
			normalizedTool,
			args,
		)) {
			if (isInsidePackageRoot(packageRoot, candidate)) {
				match = candidate;
				relativeTarget =
					path.relative(packageRoot, candidate).replace(/\\/g, '/') ||
					'<package root>';
				break;
			}
		}
	} catch {
		// Any failure inside detection is resolution uncertainty: fail open.
		return;
	}

	if (!match) return;

	try {
		telemetry.swarmInternalsReadDenied(
			sessionID,
			normalizedTool,
			relativeTarget,
		);
	} catch {
		/* telemetry is fire-and-forget and must never change the denial */
	}
	throw new Error(SWARM_INTERNALS_DENIAL_MESSAGE);
}

/**
 * Test/DI seam (AGENTS.md invariant 7). `moduleUrl`, `existsSync`,
 * `readFileSync` and `homedir` are indirected so a test can stand up a FAKE
 * installed-package tree without `mock.module` on `node:fs`; the two resolvers
 * are indirected so a test can pin a package root without a real install.
 *
 * `resetCaches` exists because both resolutions are memoized for the process
 * lifetime — without it a test that swaps `moduleUrl` would read a value
 * computed by an earlier test.
 */
export const _internals = {
	moduleUrl: (): string => import.meta.url,
	existsSync: (p: string): boolean => fsSync.existsSync(p),
	readFileSync: (p: string, enc: 'utf-8'): string =>
		fsSync.readFileSync(p, enc),
	homedir: (): string => os.homedir(),
	resolvePackageRoot,
	isSelfDevelopmentWorkspace,
	resetCaches: (): void => {
		cachedPackageRoot = undefined;
		selfDevelopmentWorkspaces.clear();
	},
};
