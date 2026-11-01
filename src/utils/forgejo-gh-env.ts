/**
 * Optional bridge: point the real `gh` CLI at Forgejo using the same token
 * material as `fj` when `forge.gh_forgejo.enabled` is `on` or `auto`.
 *
 * Default is **off**. Forgejo has no GitHub GraphQL; many `gh` subcommands
 * fail (405) against Forgejo. Prefer `repo` / `fj` for Forgejo until federated
 * two-way sync may make `gh` viable again.
 *
 * When enabled, sets `GH_HOST` + `GH_ENTERPRISE_TOKEN` (and optional `GH_REPO`)
 * for child processes. Token order matches home-manager forgejo-token-sync:
 * runtime file, static forgejo copy, fj config.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectGitRemote, parseGitRemoteUrl } from '../commands/_shared/url-security.js';
import { loadPluginConfig } from '../config/loader.js';
import { findRepoRoot } from '../vcs/repo-facade.js';

export const DEFAULT_FORGEJO_GH_HOST = 'git.centralcloud.net';

export type ForgejoGhBridgeMode = 'auto' | 'on' | 'off';

export interface ForgejoGhBridgeConfig {
	enabled?: ForgejoGhBridgeMode;
	host?: string;
}

const TOKEN_FILE_CANDIDATES = [
	() => process.env.FORGEJO_TOKEN_FILE,
	() => path.join(os.homedir(), '.config', 'forgejo', 'token'),
] as const;

function isSafeTokenFile(filePath: string): boolean {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return false;
		const mode = stat.mode & 0o777;
		return mode === 0o600 || mode === 0o400;
	} catch {
		return false;
	}
}

function readTokenFile(filePath: string): string | null {
	if (!isSafeTokenFile(filePath)) return null;
	try {
		const raw = fs.readFileSync(filePath, 'utf-8').trim();
		return raw.length > 0 ? raw : null;
	} catch {
		return null;
	}
}

/** Read fj's host block token without executing fj (0600 config only). */
function readFjConfigToken(host: string): string | null {
	const configPath = path.join(os.homedir(), '.config', 'fj', 'config.toml');
	if (!isSafeTokenFile(configPath)) return null;
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, 'utf-8');
	} catch {
		return null;
	}
	const hostKey = `[hosts."https://${host}"]`;
	const start = raw.indexOf(hostKey);
	if (start < 0) return null;
	const slice = raw.slice(start, start + 512);
	const match = slice.match(/^\s*token\s*=\s*"([^"]+)"/m);
	const token = match?.[1]?.trim();
	return token && token.length > 0 ? token : null;
}

export function readForgejoApiToken(host = DEFAULT_FORGEJO_GH_HOST): string | null {
	for (const candidate of TOKEN_FILE_CANDIDATES) {
		const p = candidate();
		if (typeof p === 'string' && p.length > 0) {
			const token = readTokenFile(p);
			if (token) return token;
		}
	}
	return readFjConfigToken(host);
}

function loadBridgeConfig(directory: string): Required<ForgejoGhBridgeConfig> {
	const hostFromEnv =
		typeof process.env.FORGEJO_HOST === 'string' &&
		process.env.FORGEJO_HOST.length > 0
			? process.env.FORGEJO_HOST
			: DEFAULT_FORGEJO_GH_HOST;
	try {
		const config = loadPluginConfig(directory) as {
			forge?: { gh_forgejo?: ForgejoGhBridgeConfig };
		};
		const block = config.forge?.gh_forgejo;
		return {
			enabled: block?.enabled ?? 'off',
			host: block?.host ?? hostFromEnv,
		};
	} catch {
		return { enabled: 'off', host: hostFromEnv };
	}
}

function remoteTargetsForgejoHost(directory: string, host: string): boolean {
	const remote = detectGitRemote(directory, undefined);
	if (!remote) return false;
	const lower = remote.toLowerCase();
	if (lower.includes(host.toLowerCase())) return true;
	const parsed = parseGitRemoteUrl(remote);
	if (parsed && parsed.owner && parsed.repo) {
		return lower.includes(host.toLowerCase());
	}
	return false;
}

export function shouldUseForgejoGh(
	directory: string,
	config?: ForgejoGhBridgeConfig,
): boolean {
	const loaded = config
		? {
				enabled: config.enabled ?? 'off',
				host: config.host ?? DEFAULT_FORGEJO_GH_HOST,
			}
		: loadBridgeConfig(directory);
	if (loaded.enabled === 'off') return false;
	if (loaded.enabled === 'on') return true;
	if (remoteTargetsForgejoHost(directory, loaded.host)) return true;
	const root = findRepoRoot(directory);
	if (root && remoteTargetsForgejoHost(root, loaded.host)) return true;
	return false;
}

function resolveGhRepoSlug(directory: string, host: string): string | null {
	const remote = detectGitRemote(directory, undefined);
	if (!remote) return null;
	const https = remote.match(/^https:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
	if (https) {
		const remoteHost = https[1].toLowerCase();
		if (remoteHost !== host.toLowerCase()) return null;
		const slug = https[2].replace(/\.git$/i, '');
		return `${host}/${slug}`;
	}
	const ssh = remote.match(/^git@([^:/]+):(.+?)(?:\.git)?$/i);
	if (ssh) {
		const remoteHost = ssh[1].toLowerCase();
		if (remoteHost !== host.toLowerCase()) return null;
		return `${host}/${ssh[2].replace(/\.git$/i, '')}`;
	}
	return null;
}

/**
 * Env overrides for `gh` spawns and bash `args.env`. Null values unset keys so
 * GitHub.com `GH_TOKEN` does not win over `GH_ENTERPRISE_TOKEN`.
 */
export function resolveForgejoGhEnvOverrides(
	directory: string,
	config?: ForgejoGhBridgeConfig,
): Record<string, string | null> | null {
	if (!shouldUseForgejoGh(directory, config)) return null;
	const { host } = loadBridgeConfig(directory);
	const token = readForgejoApiToken(host);
	if (!token) return null;

	const overrides: Record<string, string | null> = {
		GH_HOST: host,
		GH_ENTERPRISE_TOKEN: token,
		GITHUB_ENTERPRISE_TOKEN: token,
		GH_TOKEN: null,
		GITHUB_TOKEN: null,
	};
	const ghRepo = resolveGhRepoSlug(directory, host);
	if (ghRepo) overrides.GH_REPO = ghRepo;
	return overrides;
}

export function bashCommandUsesGh(command: string): boolean {
	return /\bgh\b/.test(command);
}

export const _internals = {
	readTokenFile,
	readFjConfigToken,
	isSafeTokenFile,
};
