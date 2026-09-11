/** Project Identity Management for opencode-swarm.
 * Handles creation and retrieval of project identity files.
 */

import * as child_process from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { getPlatformConfigDir } from '../hooks/knowledge-store.js';
import { resolveGitExecutable } from '../utils/git-executable.js';

// ============================================================================
// Types
// ============================================================================

export interface ProjectIdentity {
	projectHash: string;
	projectName: string;
	repoUrl?: string;
	absolutePath: string;
	createdAt: string;
	swarmVersion: string;
}

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Get identity file path for a project hash.
 * Path: {platform-config-dir}/projects/{projectHash}/identity.json
 */
export function resolveIdentityPath(projectHash: string): string {
	const platformDir = getPlatformConfigDir();
	return path.join(platformDir, 'projects', projectHash, 'identity.json');
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Derive a deterministic project hash from a directory.
 *
 * @deprecated Since issue #1846. This synchronous helper is retained for
 * backward compatibility (and its existing test coverage) but the canonical,
 * normalization-correct, subprocess-compliant resolver is
 * {@link resolveCohortId} in `./cohort-identity.ts`. New callers MUST use
 * `resolveCohortId`; it normalizes equivalent remotes (SSH/scp/HTTPS, `.git`,
 * case, slashes, percent-encoding, NFC), falls back through
 * `git rev-parse --git-common-dir` before the path, and uses the compliant
 * array-form subprocess contract. This legacy helper is kept only so existing
 * imports keep compiling; it delegates to the legacy un-normalized logic.
 *
 * Worktrees of the same repository share a git remote, so they derive the same
 * hash — which is what lets `/swarm link` (with no name) tie them to one shared
 * knowledge store by default. (Note: this legacy form does NOT normalize
 * equivalent remote spellings; `resolveCohortId` does.)
 */
export function deriveProjectHash(directory: string): string {
	const absolutePath = path.resolve(directory);
	let hashInput: string;

	try {
		// Try to get git remote URL. Bounded with a timeout (Invariant 3 — no
		// unbounded subprocess); a missing/hung remote falls back to the path.
		const gitExecutable = resolveGitExecutable();
		const remoteUrl = child_process
			.execFileSync(gitExecutable, ['-C', '.', 'remote', 'get-url', 'origin'], {
				cwd: directory,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: 1500,
			})
			.trim();
		hashInput = remoteUrl.length > 0 ? remoteUrl : absolutePath;
	} catch {
		// No git remote, fall back to absolute path
		hashInput = absolutePath;
	}

	const hash = createHash('sha256').update(hashInput).digest('hex');
	return hash.slice(0, 12);
}

/**
 * Get the swarm version from package.json
 */
async function getSwarmVersion(directory?: string): Promise<string> {
	if (!directory) {
		throw new Error(
			'[identity] No directory provided — ctx.directory is required',
		);
	}
	const baseDir = directory;
	try {
		// Find package.json in the opencode-swarm package
		const packageJsonPath = path.join(
			baseDir,
			'node_modules',
			'opencode-swarm',
			'package.json',
		);

		// Try package.json in node_modules first
		if (existsSync(packageJsonPath)) {
			const content = await readFile(packageJsonPath, 'utf-8');
			const pkg = JSON.parse(content);
			return pkg.version || 'unknown';
		}

		// Fall back to local package.json
		const localPackageJsonPath = path.join(baseDir, 'package.json');
		if (existsSync(localPackageJsonPath)) {
			const content = await readFile(localPackageJsonPath, 'utf-8');
			const pkg = JSON.parse(content);
			return pkg.version || 'unknown';
		}

		return 'unknown';
	} catch {
		return 'unknown';
	}
}

/**
 * Get git remote URL for a directory.
 *
 * #2674 (AGENTS.md invariant 3): bounded, non-interactive, killable. A hung
 * git (credential prompt, AV interception, stalled filesystem) previously
 * blocked the caller's event loop forever — `execFileSync` is synchronous, so
 * the freeze was host-wide, not per-await. The option set mirrors the
 * compliant exemplars (`gitExec` in src/git/branch.ts, `detectGitRemote` in
 * src/commands/_shared/url-security.ts): explicit `env` with
 * `GIT_TERMINAL_PROMPT=0` both prevents the credential-prompt hang class
 * outright and restores live-env semantics under Bun (whose spawn inherits a
 * process-start env snapshot when no `env` is passed — oven-sh/bun#29237
 * class, see src/utils/git-executable.ts).
 */
const GIT_REMOTE_URL_TIMEOUT_MS = 5_000;
const GIT_REMOTE_URL_MAX_BUFFER_BYTES = 64 * 1024;

function getGitRemoteUrl(directory: string): string | undefined {
	try {
		const gitExecutable = resolveGitExecutable();
		const remoteUrl = child_process
			.execFileSync(gitExecutable, ['remote', 'get-url', 'origin'], {
				cwd: directory,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: GIT_REMOTE_URL_TIMEOUT_MS,
				// POSIX: a SIGTERM-trapping child must not defeat the bound. On
				// Windows this is identical to the default TerminateProcess
				// coercion (documented in docs/engineering-invariants.md §3).
				killSignal: 'SIGKILL',
				maxBuffer: GIT_REMOTE_URL_MAX_BUFFER_BYTES,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			})
			.trim();
		return remoteUrl;
	} catch {
		return undefined;
	}
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Read existing identity.json or return null if it doesn't exist.
 */
export async function readProjectIdentity(
	projectHash: string,
): Promise<ProjectIdentity | null> {
	const identityPath = resolveIdentityPath(projectHash);

	if (!existsSync(identityPath)) {
		return null;
	}

	try {
		const content = await readFile(identityPath, 'utf-8');
		const identity = JSON.parse(content) as ProjectIdentity;
		return identity;
	} catch {
		// If file is corrupted or invalid JSON, return null
		return null;
	}
}

/**
 * Create or update identity.json for a project.
 * Uses atomic write pattern (write to temp file, then rename).
 */
export async function writeProjectIdentity(
	directory: string,
	projectHash: string,
	projectName: string,
): Promise<ProjectIdentity> {
	const identityPath = resolveIdentityPath(projectHash);
	const identityDir = path.dirname(identityPath);

	// Ensure directory exists
	await mkdir(identityDir, { recursive: true });

	// Get repository URL (optional)
	const repoUrl = getGitRemoteUrl(directory);

	// Get absolute path
	const absolutePath = path.resolve(directory);

	// Get current timestamp
	const createdAt = new Date().toISOString();

	// Get swarm version
	const swarmVersion = await getSwarmVersion(directory);

	const identity: ProjectIdentity = {
		projectHash,
		projectName,
		repoUrl,
		absolutePath,
		createdAt,
		swarmVersion,
	};

	// Atomic write: write to temp file first, then rename
	const tempPath = `${identityPath}.tmp.${Date.now()}.${process.pid}`;
	await writeFile(tempPath, JSON.stringify(identity, null, 2), 'utf-8');

	// Rename temp file to actual path (atomic on most filesystems)
	await rename(tempPath, identityPath);

	return identity;
}
