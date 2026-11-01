/**
 * Fleet publication routing: pick repo vs fj vs gh from cwd/remotes without
 * mixing lifecycle execution into reflection menus.
 */

import { detectGitRemote } from '../commands/_shared/url-security.js';
import {
	repoIssueCreateRoutingHint,
	repoPrCreateRoutingHint,
} from '../vcs/repo-lifecycle.js';
import { findRepoRoot } from '../vcs/repo-facade.js';
import { FLEET_FORGEJO_HOST, parseForgeRemoteUrl } from './forge-provider.js';

export type ForgePublicationTool = 'repo' | 'fj' | 'gh';

const STATIC_PUBLICATION_PRIORITY =
	'Publication routing: repo (Engine facade) → fj (Forgejo) → gh (GitHub mirror only)';

const FJ_ISSUE_CREATE_HINT =
	'fj issue create --title "<title>" [--body "<body>"]';
const FJ_PR_CREATE_HINT =
	'fj pr create --title "<title>" [--body "<body>"]';
const GH_ISSUE_CREATE_HINT =
	'gh issue create --title "<title>" [--body "<body>"]';
const GH_PR_CREATE_HINT = 'gh pr create --title "<title>" [--body "<body>"]';

export function resolveForgePublicationTool(
	directory: string,
): ForgePublicationTool {
	if (findRepoRoot(directory)) {
		return 'repo';
	}
	const remote = detectGitRemote(directory, undefined);
	if (!remote) {
		return 'gh';
	}
	const parsed = parseForgeRemoteUrl(remote);
	if (parsed?.provider === 'github') {
		return 'gh';
	}
	if (parsed?.provider === 'forgejo') {
		return 'fj';
	}
	const lower = remote.toLowerCase();
	if (lower.includes(FLEET_FORGEJO_HOST)) {
		return 'fj';
	}
	if (lower.includes('github.com')) {
		return 'gh';
	}
	return 'gh';
}

export function forgeIssueCreateRoutingHint(directory?: string): string {
	if (!directory) {
		return `${STATIC_PUBLICATION_PRIORITY}. Issue: ${repoIssueCreateRoutingHint()} · ${FJ_ISSUE_CREATE_HINT} · ${GH_ISSUE_CREATE_HINT}`;
	}
	switch (resolveForgePublicationTool(directory)) {
		case 'repo':
			return repoIssueCreateRoutingHint();
		case 'fj':
			return FJ_ISSUE_CREATE_HINT;
		case 'gh':
			return GH_ISSUE_CREATE_HINT;
	}
}

export function forgePrCreateRoutingHint(
	directory?: string,
	laneName = '<lane>',
	base = 'main',
): string {
	if (!directory) {
		return `${STATIC_PUBLICATION_PRIORITY}. PR: ${repoPrCreateRoutingHint(laneName, base)} · ${FJ_PR_CREATE_HINT} · ${GH_PR_CREATE_HINT}`;
	}
	switch (resolveForgePublicationTool(directory)) {
		case 'repo':
			return repoPrCreateRoutingHint(laneName, base);
		case 'fj':
			return FJ_PR_CREATE_HINT;
		case 'gh':
			return GH_PR_CREATE_HINT;
	}
}
