#!/usr/bin/env node
/**
 * release-notes-fragments.mjs (8.x `next` line) — aggregate per-PR
 * release-note fragments into the release-please PR body and the GitHub
 * Release bodies, then clean up consumed fragments.
 *
 * Ported from the main line's `scripts/release-notes-fragments.mjs`
 * (issue #3228) trimmed to the modes the 8.x release path wires:
 *
 *   node scripts/release-notes-fragments.mjs update-pr
 *   node scripts/release-notes-fragments.mjs update-release
 *   node scripts/release-notes-fragments.mjs cleanup
 *
 * Contract preserved verbatim from the main line: the marker block
 * (`<!-- custom-release-notes:start/end -->`), `docs/releases/pending`,
 * the `\n\n---\n\n` separator, idempotent upsert-in-place, added-per-PR
 * fragment selection, and consume-and-remove cleanup semantics.
 *
 * 8.x adaptations (deliberate, recorded):
 * - Component tags (`core-v8.0.2-beta.0`): tags are passed through
 *   verbatim; no bare-`v` tag parsing exists on the wired paths (the
 *   main-line RELEASE_TAG_RE machinery is main-history-shaped and stays
 *   unported).
 * - `update-release` reads the component's OWN
 *   `packages/<component>/CHANGELOG.md` as the empty-body fallback
 *   (component parsed from the `<component>-v<version>` tag).
 * - Provenance verification against `docs/releases/manifests/` is not
 *   ported: this branch has no archived manifests; the deletion oracle is
 *   the published release body itself.
 * - `cleanup` deletes only fragments whose rendered content is present in
 *   the re-fetched published body AND whose bytes still hash-match the
 *   entry captured at collection time (this script's checkout = the
 *   release merge SHA); a fragment changed after publication is RETAINED.
 *
 * Dependencies: Node built-ins + the `gh` CLI (present on GitHub-hosted
 * runners). No npm dependencies.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Stable contract — byte-identical to the main line. Never change these
// strings: release bodies in the wild rely on them for idempotent replace.
// -----------------------------------------------------------------------------
export const MARKER_START = '<!-- custom-release-notes:start -->';
export const MARKER_END = '<!-- custom-release-notes:end -->';
export const FRAGMENT_DIR = 'docs/releases/pending';
export const FRAGMENT_SEPARATOR = '\n\n---\n\n';

export const MAX_RELEASE_CANDIDATES = 1_000;
export const MAX_CHANGELOG_FALLBACK_BYTES = 2 * 1024 * 1024;
export const MAX_FALLBACK_CANDIDATES = 50;
export const MAX_FRAGMENT_ENTRIES = 5_000;
export const MAX_FRAGMENT_BYTES = 256 * 1024;
export const MAX_PR_DIGITS = 7;
export const FRONTMATTER_MAX_LINES = 32;
export const GH_TIMEOUT_MS = 30_000;
export const SUBPROCESS_MAX_BUFFER = 16 * 1024 * 1024;

/** The four lockstep components from release-please-config.json. */
export const COMPONENTS = ['opencode', 'core', 'claude-code', 'telemetry'];
/** Component -> package path (also the release-please manifest key). */
export const COMPONENT_PATHS = {
	opencode: 'packages/opencode',
	core: 'packages/core',
	'claude-code': 'packages/claude-code',
	telemetry: 'packages/telemetry',
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveRepoRoot() {
	return REPO_ROOT;
}

function log(message) {
	console.log(`[release-notes] ${message}`);
}

// -----------------------------------------------------------------------------
// gh/git subprocess wrappers (bounded, per repo subprocess invariants).
// -----------------------------------------------------------------------------
function ghJson(args) {
	return JSON.parse(
		execFileSync('gh', args, {
			cwd: resolveRepoRoot(),
			encoding: 'utf8',
			maxBuffer: SUBPROCESS_MAX_BUFFER,
			timeout: GH_TIMEOUT_MS,
			stdio: ['ignore', 'pipe', 'pipe'],
		}),
	);
}

function ghInput(args, input) {
	return execFileSync('gh', args, {
		cwd: resolveRepoRoot(),
		input,
		encoding: 'utf8',
		maxBuffer: SUBPROCESS_MAX_BUFFER,
		timeout: GH_TIMEOUT_MS,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
}

function tryGhJson(args) {
	try {
		return { ok: true, value: ghJson(args) };
	} catch (err) {
		return { ok: false, err };
	}
}

// -----------------------------------------------------------------------------
// Pure helpers — exported for unit tests. No I/O.
// -----------------------------------------------------------------------------
export function stripCustomReleaseNotesBlock(body) {
	if (typeof body !== 'string' || body.length === 0) return body ?? '';
	const startIdx = body.indexOf(MARKER_START);
	const endIdx = body.lastIndexOf(MARKER_END);
	if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
		const before = body.slice(0, startIdx);
		const after = body.slice(endIdx + MARKER_END.length);
		return `${before}${after}`;
	}
	return body;
}

export function customReleaseNotesPayload(body) {
	if (typeof body !== 'string') return null;
	const startIdx = body.indexOf(MARKER_START);
	const endIdx = body.lastIndexOf(MARKER_END);
	if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
	return body.slice(startIdx + MARKER_START.length, endIdx).trim();
}

export function extractCommitShasFromBody(body) {
	if (typeof body !== 'string' || body.length === 0) return [];
	const seen = new Set();
	const out = [];
	// Full 40-hex SHAs from /commit/ URLs only; short labels are not reliable.
	const re = /\/commit\/([0-9a-f]{40})\b/gi;
	for (const m of body.matchAll(re)) {
		const sha = m[1].toLowerCase();
		if (!seen.has(sha)) {
			seen.add(sha);
			out.push(sha);
		}
	}
	return out;
}

export function extractCandidatePrNumbers(body) {
	if (typeof body !== 'string' || body.length === 0) return [];
	const seen = new Set();
	const out = [];
	const digits = `\\d{1,${MAX_PR_DIGITS}}`;
	const patterns = [
		new RegExp(`\\(#(${digits})\\)`, 'g'),
		new RegExp(`\\[#(${digits})\\]`, 'g'),
		new RegExp(`\\/pull\\/(${digits})\\b`, 'g'),
		new RegExp(`(?<![\\w/])#(${digits})\\b`, 'g'),
	];
	for (const re of patterns) {
		for (const m of body.matchAll(re)) {
			const raw = m[1];
			if (raw.length === MAX_PR_DIGITS) {
				const after = body[m.index + m[0].length];
				if (after && /\d/.test(after)) continue;
			}
			const n = Number.parseInt(raw, 10);
			if (Number.isFinite(n) && n > 0 && !seen.has(n)) {
				seen.add(n);
				out.push(n);
			}
		}
	}
	return out;
}

export function filterPendingFragmentPaths(files) {
	if (!Array.isArray(files)) return [];
	const out = [];
	for (const entry of files) {
		// Main-line #3519 parity (review Z-F3): a DELETED entry is a
		// consumed fragment's removal record, not a content candidate.
		const changeType = typeof entry === 'object' && typeof entry.changeType === 'string' ? entry.changeType.toLowerCase() : '';
		if (changeType === 'deleted' || changeType === 'removed') continue;
		const filePath = typeof entry === 'string' ? entry : entry?.path;
		if (typeof filePath !== 'string' || filePath.length === 0) continue;
		const posix = filePath.replace(/\\/g, '/');
		if (!posix.startsWith(`${FRAGMENT_DIR}/`)) continue;
		if (!posix.endsWith('.md')) continue;
		// Path-traversal rejection: the listing is attacker-controllable
		// (PR authors control their file paths) and this path is later
		// resolved against the repo root for reading.
		if (posix.split('/').includes('..')) continue;
		// Full control-character range (main-line parity): a NUL-only
		// check lets an embedded newline survive and later split the
		// newline-delimited cleanup plan into unrelated paths.
		if (/[^\x20-\x7e]/.test(posix)) continue;
		if (posix.startsWith('/')) continue;
		if (/^[A-Za-z]:/.test(posix)) continue;
		out.push(posix);
	}
	return out;
}

function neutralizeMarkers(text) {
	return text
		.replace(/<!-- custom-release-notes:start -->/g, '<!-- custom-release-notes-start (literal) -->')
		.replace(/<!-- custom-release-notes:end -->/g, '<!-- custom-release-notes-end (literal) -->');
}

function isYamlFrontmatterLine(line) {
	if (line.trim() === '' || line.trimStart().startsWith('#')) return true;
	return /^(?:"[^"]*"|'[^']*'|[A-Za-z_][A-Za-z0-9_. -]*)(?:\s*:(?:\s|$))/.test(line);
}

/** Strip a leading YAML frontmatter block for RENDERING only (issue #2899). */
export function renderFragmentBody(content) {
	if (typeof content !== 'string' || content.length === 0) return content ?? '';
	const lines = content.split('\n');
	if (lines[0].trimEnd() !== '---') return content;
	let close = -1;
	for (let i = 1; i < lines.length && i <= FRONTMATTER_MAX_LINES + 1; i += 1) {
		const line = lines[i].trimEnd();
		if (line === '---') {
			close = i;
			break;
		}
		if (!isYamlFrontmatterLine(line)) return content;
	}
	if (close === -1) return content;
	const rest = lines.slice(close + 1);
	while (rest.length > 0 && rest[0].trim() === '') rest.shift();
	return rest.join('\n');
}

function combineOrderedFragments(entries, render, skipEmpty = false) {
	if (!Array.isArray(entries) || entries.length === 0) return '';
	const dedup = new Map();
	for (const e of entries) {
		if (!e || typeof e.content !== 'string') continue;
		if (typeof e.filePath !== 'string') continue;
		if (!dedup.has(e.filePath)) dedup.set(e.filePath, e);
	}
	const sorted = [...dedup.values()].sort((a, b) => {
		const pa = Number.isFinite(a.prNumber) ? a.prNumber : Number.MAX_SAFE_INTEGER;
		const pb = Number.isFinite(b.prNumber) ? b.prNumber : Number.MAX_SAFE_INTEGER;
		if (pa !== pb) return pa - pb;
		return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
	});
	const parts = [];
	for (const entry of sorted) {
		const part = render(entry.content).replace(/\s+$/, '');
		if (skipEmpty && part === '') continue;
		parts.push(part);
	}
	return parts.join(FRAGMENT_SEPARATOR);
}

export function combineFragments(entries) {
	return combineOrderedFragments(entries, (content) => content);
}

export function combineRenderedFragments(entries) {
	return combineOrderedFragments(entries, renderFragmentBody, true);
}

/**
 * Insert or replace the custom-release-notes marker block in a body.
 * Idempotent; absorbs accidentally-nested markers (first start through
 * LAST end); prepends when absent; returns the original when `combined`
 * is empty.
 */
export function upsertReleaseNotesBlock(body, combined) {
	const original = typeof body === 'string' ? body : '';
	const rawNotes = typeof combined === 'string' ? combined.trim() : '';
	if (rawNotes.length === 0) return original;
	const notes = neutralizeMarkers(rawNotes);
	const block = `${MARKER_START}\n${notes}\n${MARKER_END}`;
	const startIdx = original.indexOf(MARKER_START);
	const endIdx = original.lastIndexOf(MARKER_END);
	if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
		const before = original.slice(0, startIdx);
		const after = original.slice(endIdx + MARKER_END.length);
		return `${before}${block}${after}`;
	}
	if (original.length === 0) return block;
	return `${block}\n\n${original}`;
}

/** Exported (test-only) pure digest helper used by the deletion planner. */
export function sha256Hex(value) {
	return sha256(value);
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

// -----------------------------------------------------------------------------
// Candidate resolution (direct PR refs + commit-SHA -> PR via gh api).
// -----------------------------------------------------------------------------
function selectValidPrNumbers(prs) {
	if (!Array.isArray(prs)) return [];
	return prs
		.filter((pr) => pr && typeof pr === 'object' && Number.isInteger(pr.number) && pr.number > 0)
		.map((pr) => pr.number);
}

function resolveCommitShasToPrNumbers(shas, logFn) {
	const repoSlug = process.env.GITHUB_REPOSITORY;
	if (!repoSlug) {
		logFn('GITHUB_REPOSITORY not set — cannot resolve commit SHAs to PR numbers');
		return [];
	}
	const seen = new Set();
	const out = [];
	for (const sha of shas) {
		const res = tryGhJson(['api', '--paginate', '--slurp', `repos/${repoSlug}/commits/${sha}/pulls`]);
		if (!res.ok || !Array.isArray(res.value)) {
			// Fail closed on provenance lookup failure (review Z-F2): an
			// empty result from a silently-failed lookup would drop the
			// commit's fragments from the notes with green CI.
			throw new Error(
				`incomplete release provenance: commit ${sha.slice(0, 7)} lookup failed: ${res.err instanceof Error ? res.err.message : String(res.err)}`,
			);
		}
		const prs = res.value.flat();
		for (const n of selectValidPrNumbers(prs)) {
			if (!seen.has(n)) {
				seen.add(n);
				out.push(n);
			}
		}
	}
	return out;
}

export function resolveAllCandidates(strippedBody, logFn) {
	const directCandidates = extractCandidatePrNumbers(strippedBody);
	if (directCandidates.length > MAX_RELEASE_CANDIDATES) {
		throw new Error('release candidate PR cap exceeded');
	}
	logFn(`found ${directCandidates.length} direct PR ref(s) in body`);
	const commitShas = extractCommitShasFromBody(strippedBody);
	if (commitShas.length > MAX_RELEASE_CANDIDATES) {
		throw new Error('release commit SHA candidate cap exceeded');
	}
	let shaResolved = [];
	if (commitShas.length > 0) {
		shaResolved = resolveCommitShasToPrNumbers(commitShas, logFn);
		logFn(`resolved ${shaResolved.length} PR number(s) from commit SHAs`);
	}
	const merged = [...directCandidates];
	for (const n of shaResolved) {
		if (!merged.includes(n)) merged.push(n);
	}
	return merged;
}

// -----------------------------------------------------------------------------
// Fragment collection (per included PR's OWN files, main-line semantics).
// -----------------------------------------------------------------------------
/**
 * Containment + regular-file guard for a pending-fragment path (main-line
 * parity: containedPendingPath + safeRepositoryFilePath). PR-authored
 * paths are attacker-controllable: a path that escapes the repository root
 * or names a symlink must never be followed - the fragment bytes are
 * published verbatim into release bodies, so a symlink (e.g. to
 * .git/config holding the job token) would be a disclosure channel.
 * Throws on any violation; returns the resolved absolute path.
 */
/** Exported for unit tests (reparse-point ancestry / containment legs). */
export function guardFragmentPath(repoRoot, relativePath) {
	const resolvedRoot = path.resolve(repoRoot);
	const resolvedTarget = path.resolve(repoRoot, relativePath);
	if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
		throw new Error(`fragment escapes the repository root: ${relativePath}`);
	}
	// Walk the EXISTING components from the root and reject any reparse
	// point (symlink or junction) in the ancestry: the final-component
	// lstat alone cannot see an intermediate junction that redirects an
	// ancestor directory outside the repository (review Z-F1; main-line
	// assertSafeDirectoryChain parity).
	const relativeInside = path.relative(resolvedRoot, resolvedTarget);
	const segments = relativeInside.split(path.sep).filter((segment) => segment !== '' && segment !== '.');
	let cursor = resolvedRoot;
	for (const segment of segments) {
		cursor = path.join(cursor, segment);
		let ancestorStat;
		try {
			ancestorStat = lstatSync(cursor);
		} catch (error) {
			if (error.code === 'ENOENT') break;
			throw error;
		}
		if (ancestorStat.isSymbolicLink()) {
			throw new Error(`unsafe release fragment path (reparse point in ancestry): ${relativePath}`);
		}
	}
	const stat = lstatSync(resolvedTarget);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error(`unsafe release fragment (not a regular file): ${relativePath}`);
	}
	return resolvedTarget;
}

function readFragmentFromWorkspace(repoRoot, relativePath) {
	let absolute;
	try {
		absolute = guardFragmentPath(repoRoot, relativePath);
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
	// Bounded read: cap BEFORE slurping (main-line readBoundedFragmentBytes
	// parity) so an oversized target cannot be read into memory whole.
	const size = lstatSync(absolute).size;
	if (size > MAX_FRAGMENT_BYTES) {
		throw new Error(`fragment exceeds byte cap: ${relativePath}`);
	}
	const content = readFileSync(absolute, 'utf8');
	return { content, sha256: sha256(content) };
}

/**
 * Classify an issues-API record (pure; exported for unit tests). An issue
 * reference in a release body is NORMAL (this repo's own healing-release
 * body references #3150/#3151/#3228/#3229), so classification must NOT
 * depend on gh's error text - which varies across gh versions and
 * misclassified issues with review Z-F2's regex (review FC-10; main-line
 * parity: classify via the issues API's pull_request field).
 * Returns 'pr' | 'non-pr' | null (null = malformed record -> caller throws).
 */
export function classifyCandidateRecord(record) {
	if (!record || typeof record !== 'object') return null;
	return record.pull_request ? 'pr' : 'non-pr';
}

function verifyPr(num) {
	// Classification probe: the issues API answers for both issues and PRs
	// and carries a pull_request object only for PRs.
	const issuesRes = tryGhJson(['api', `repos/${process.env.GITHUB_REPOSITORY ?? ''}/issues/${num}`]);
	if (!issuesRes.ok) {
		throw new Error(`candidate lookup failed for PR #${num}: ${issuesRes.err instanceof Error ? issuesRes.err.message : String(issuesRes.err)}`);
	}
	const kind = classifyCandidateRecord(issuesRes.value);
	if (kind !== 'pr') {
		return { kind: 'non-pr' };
	}
	// It is a PR: fetch its changed files for fragment selection.
	const prRes = tryGhJson(['pr', 'view', String(num), '--json', 'number,files']);
	if (!prRes.ok) {
		throw new Error(`candidate file lookup failed for PR #${num}: ${prRes.err instanceof Error ? prRes.err.message : String(prRes.err)}`);
	}
	return prRes.value;
}

export function collectFragmentsForPrs(candidates, repoRoot, logFn, options = {}) {
	if (!Array.isArray(candidates) || candidates.length > MAX_RELEASE_CANDIDATES) {
		throw new Error('release candidate PR cap exceeded');
	}
	const { verifyCandidate = verifyPr, readFragment = readFragmentFromWorkspace, requireComplete = false } = options;
	const entries = [];
	const seenPaths = new Set();
	for (const num of candidates) {
		const pr = verifyCandidate(num);
		if (pr?.kind === 'non-pr') {
			logFn(`skip #${num} — reference is an issue, not a PR`);
			continue;
		}
		if (!pr || !Array.isArray(pr.files)) {
			if (requireComplete) {
				throw new Error(`incomplete release provenance: failed to resolve candidate PR #${num}`);
			}
			logFn(`skip #${num} — not a PR or no files`);
			continue;
		}
		const fragPaths = filterPendingFragmentPaths(pr.files);
		if (fragPaths.length > MAX_FRAGMENT_ENTRIES) {
			throw new Error(`release fragment entry cap exceeded for #${num}`);
		}
		if (fragPaths.length === 0) continue;
		for (const fp of fragPaths) {
			if (seenPaths.has(fp)) continue;
			seenPaths.add(fp);
			const fragment = readFragment(repoRoot, fp);
			if (fragment === null) {
				if (requireComplete) {
					throw new Error(`incomplete release provenance: fragment ${fp} referenced by #${num} is unavailable`);
				}
				logFn(`fragment ${fp} referenced by #${num} not found in workspace`);
				continue;
			}
			entries.push({ prNumber: num, filePath: fp, ...fragment });
			if (entries.length > MAX_FRAGMENT_ENTRIES) {
				throw new Error('release fragment entry cap exceeded');
			}
		}
	}
	return entries;
}

// -----------------------------------------------------------------------------
// Mode: update-pr — enrich the open release-please PR body.
// -----------------------------------------------------------------------------
async function modeUpdatePr(logFn) {
	const repoRoot = resolveRepoRoot();
	const prList = tryGhJson([
		'pr',
		'list',
		'--label',
		'autorelease: pending',
		'--base',
		'next',
		'--json',
		'number',
		'--limit',
		'5',
	]);
	if (!prList.ok) {
		// Fail closed on a lookup FAILURE (rate limit, timeout, auth): a
		// silent exit 0 would leave the release PR un-enriched with green CI.
		logFn(`gh pr list failed: ${prList.err instanceof Error ? prList.err.message : String(prList.err)}`);
		return 1;
	}
	if (!Array.isArray(prList.value) || prList.value.length === 0) {
		logFn('No autorelease PR found — exiting 0');
		return 0;
	}
	const releasePr = prList.value[0];
	const settleDelayMs = Number.parseInt(process.env.FRAGMENT_SETTLE_DELAY_MS ?? '45000', 10);
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	// One read-extract-upsert-edit pass; retry once after a settle delay if
	// an external rewrite (release-please regenerating the body) clobbers
	// the block. Always re-fetches the CURRENT body per attempt.
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		const bodyRes = tryGhJson(['pr', 'view', String(releasePr.number), '--json', 'body']);
		if (!bodyRes.ok) {
			logFn(`gh pr view failed for #${releasePr.number}: ${bodyRes.err instanceof Error ? bodyRes.err.message : String(bodyRes.err)}`);
			return 1;
		}
		const body = bodyRes.value?.body ?? '';
		const strippedBody = stripCustomReleaseNotesBlock(body);
		const allCandidates = resolveAllCandidates(strippedBody, logFn);
		if (allCandidates.length === 0) {
			logFn('Release PR body has no PR references (direct or via commit SHAs) — nothing to inject');
			return 0;
		}
		logFn(`collecting fragments for ${allCandidates.length} candidate PR(s): ${allCandidates.map((n) => `#${n}`).join(', ')}`);
		const entries = collectFragmentsForPrs(allCandidates, repoRoot, logFn);
		if (entries.length === 0) {
			logFn('No pending fragments found across referenced PRs');
			return 0;
		}
		const combined = combineRenderedFragments(entries);
		const newBody = upsertReleaseNotesBlock(body, combined);
		let edited = false;
		if (newBody !== body) {
			ghInput(['pr', 'edit', String(releasePr.number), '--body-file', '-'], newBody);
			edited = true;
			logFn(`Updated release PR #${releasePr.number} with ${entries.length} fragment(s)`);
		} else {
			logFn('Release PR body already up to date');
		}
		// Verify the block survived. The settle delay applies only after an
		// actual edit (a no-op pass verifies immediately). A FAILED verify
		// read (API error) is not a clobber: retry the READ with a short
		// backoff instead of conflating it with the missing-block path.
		if (edited) {
			await sleep(settleDelayMs);
		}
		let afterBody = null;
		for (let readAttempt = 1; readAttempt <= 3; readAttempt += 1) {
			const afterRes = tryGhJson(['pr', 'view', String(releasePr.number), '--json', 'body']);
			if (afterRes.ok) {
				afterBody = afterRes.value?.body ?? '';
				break;
			}
			if (readAttempt < 3) {
				await sleep(2000);
			}
		}
		if (afterBody === null) {
			logFn(`verify read failed after retries for #${releasePr.number} — failing closed`);
			return 1;
		}
		if (customReleaseNotesPayload(afterBody) !== null) return 0;
		logFn(`marker block missing after edit (attempt ${attempt}) — retrying`);
	}
	logFn('marker block did not survive after retries — failing closed (fix the body and re-run)');
	return 1;
}

/**
 * Extract exactly this tag's section from a release-please CHANGELOG.md
 * (main-line parity: version-scoped fallback + byte cap instead of
 * scanning the whole file, which drags every historical PR into the
 * candidate set). The heading is `## [<version>]` optionally followed by
 * a compare link; the section runs to the next `## [` heading or EOF,
 * capped at MAX_CHANGELOG_FALLBACK_BYTES. Returns '' when the version
 * has no section. Exported for unit tests.
 */
export function extractChangelogSection(changelogText, version) {
	if (typeof changelogText !== 'string' || typeof version !== 'string' || version.length === 0) return '';
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const headingRe = new RegExp(`^## \\[${escaped}\\]`, 'm');
	const match = headingRe.exec(changelogText);
	if (!match) return '';
	const rest = changelogText.slice(match.index);
	const bodyStart = rest.indexOf('\n');
	if (bodyStart === -1) return '';
	const afterHeading = rest.slice(bodyStart + 1);
	const nextHeading = afterHeading.search(/^## \[/m);
	const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
	return section.slice(0, MAX_CHANGELOG_FALLBACK_BYTES);
}

// -----------------------------------------------------------------------------
// Mode: update-release — keep a GitHub Release body in sync after a tag.
// -----------------------------------------------------------------------------
function parseComponentTag(tagName) {
	const match = /^([a-z-]+)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tagName ?? '');
	if (!match) return null;
	return { component: match[1], version: match[2] };
}

async function modeUpdateRelease(logFn) {
	const tagName = process.env.TAG_NAME;
	if (!tagName) {
		logFn('TAG_NAME env var not set — exiting 0');
		return 0;
	}
	const parsedTag = parseComponentTag(tagName);
	if (!parsedTag) {
		logFn(`tag ${tagName} is not a component tag (<component>-v<version>) — exiting 0`);
		return 0;
	}
	const repoRoot = resolveRepoRoot();
	const rel = tryGhJson(['release', 'view', tagName, '--json', 'body,tagName']);
	if (!rel.ok) {
		// Distinguish a genuinely missing release (expected during a
		// recovery dispatch) from a TRANSIENT gh failure (rate limit,
		// timeout): the latter must fail closed, not silently skip the
		// release-body update.
		const stderr = String(rel.err?.stderr ?? '');
		if (/not found/i.test(stderr)) {
			logFn(`Release ${tagName} not found — exiting 0`);
			return 0;
		}
		logFn(`gh release view failed for ${tagName}: ${rel.err instanceof Error ? rel.err.message : String(rel.err)}`);
		return 1;
	}
	const releaseBody = rel.value.body || '';
	const strippedBody = stripCustomReleaseNotesBlock(releaseBody);
	let allCandidates = resolveAllCandidates(strippedBody, logFn);

	// Fallback for an EMPTY release body (release-please has been observed
	// creating those): the component's own CHANGELOG.md carries the tagged
	// VERSION's section with /commit/<40-hex> links. Version-scoped with a
	// byte cap (main parity) — a whole-file scan would drag every
	// historical PR into the candidate set.
	if (allCandidates.length === 0) {
		const changelogPath = path.join(
			repoRoot,
			COMPONENT_PATHS[parsedTag.component] ?? 'packages',
			'CHANGELOG.md',
		);
		if (existsSync(changelogPath)) {
			const section = extractChangelogSection(readFileSync(changelogPath, 'utf8'), parsedTag.version);
			if (section !== '') {
				allCandidates = resolveAllCandidates(section, logFn);
				if (allCandidates.length > MAX_FALLBACK_CANDIDATES) {
					logFn(`CHANGELOG fallback clamped ${allCandidates.length} -> ${MAX_FALLBACK_CANDIDATES} candidates (main parity)`);
					allCandidates = allCandidates.slice(0, MAX_FALLBACK_CANDIDATES);
				}
				if (allCandidates.length > 0) {
					logFn(`resolved ${allCandidates.length} candidate PR(s) from ${parsedTag.component} CHANGELOG section ${parsedTag.version}`);
				}
			}
		}
	}
	logFn(`collecting fragments for ${allCandidates.length} candidate PR(s)`);
	const entries = collectFragmentsForPrs(allCandidates, repoRoot, logFn, { requireComplete: true });
	if (entries.length === 0) {
		logFn('No pending fragments found across referenced PRs — exiting 0');
		return 0;
	}
	const combined = combineRenderedFragments(entries);
	const newBody = upsertReleaseNotesBlock(releaseBody, combined);
	if (newBody === releaseBody) {
		logFn('Release body already up to date');
		return 0;
	}
	ghInput(['release', 'edit', tagName, '--notes-file', '-'], newBody);
	logFn(`Updated release ${tagName} with ${entries.length} fragment(s)`);
	return 0;
}

// -----------------------------------------------------------------------------
// Mode: cleanup — consume-and-remove fragments proven published.
// -----------------------------------------------------------------------------
/**
 * Pure deletion planner. A fragment is deletable iff BOTH hold:
 *  1. its rendered content appears in the CURRENT published body's marker
 *     payload (re-fetched — not the body captured at injection time). THIS
 *     is the operative oracle: a fragment whose bytes differ from what the
 *     release published renders differently and is RETAINED (review F-5).
 *  2. its workspace bytes still hash-match the entry captured at collection
 *     time — a same-run integrity guard (defense in depth: fires if the
 *     pending tree is mutated between collection and deletion inside one
 *     run; in the current single-checkout workflow topology the bytes are
 *     the same commit by construction, so this leg cannot fire there —
 *     pinned by unit fixtures, honestly disclosed as such).
 * Exported for unit tests.
 */
export function planFragmentDeletions(publishedBody, entries, readCurrentBytes) {
	const payload = customReleaseNotesPayload(publishedBody);
	if (payload === null) {
		return {
			deletable: [],
			retained: entries.map((e) => ({ entry: e, reason: 'no marker block in published body' })),
		};
	}
	const publishedParts = payload.split(FRAGMENT_SEPARATOR).map((part) => part.trim());
	const deletable = [];
	const retained = [];
	for (const entry of entries) {
		// Compose the EXPECTED published form exactly the way the writer
		// does (renderFragmentBody, marker neutralization, trailing-trim)
		// and require a consecutive-subsequence match on trimmed parts: a
		// fragment CONTAINING a markdown horizontal rule spans consecutive
		// payload parts, the writer trims the joined string (so the first
		// part loses leading whitespace), and a fragment quoting the marker
		// literal arrives neutralized. Plain membership fails all three
		// shapes and strands the fragment forever (review PRR-005).
		const rendered = neutralizeMarkers(renderFragmentBody(entry.content)).replace(/\s+$/, '');
		const expectedParts = rendered.split(FRAGMENT_SEPARATOR).map((part) => part.trim()).filter((part) => part !== '');
		if (expectedParts.length === 0 || !matchesConsecutiveSubsequence(publishedParts, expectedParts)) {
			retained.push({ entry, reason: 'rendered content not present in published body' });
			continue;
		}
		const currentBytes = readCurrentBytes(entry.filePath);
		if (currentBytes === null || sha256(currentBytes) !== entry.sha256) {
			retained.push({ entry, reason: 'file unreadable or mutated between collection and deletion (same-run integrity)' });
			continue;
		}
		deletable.push(entry);
	}
	return { deletable, retained };
}

/**
 * True when `needle` appears in `haystack` as a CONSECUTIVE run of
 * elements (elementwise equality). Pure; exported for unit tests.
 */
export function matchesConsecutiveSubsequence(haystack, needle) {
	if (!Array.isArray(haystack) || !Array.isArray(needle) || needle.length === 0) return false;
	if (needle.length > haystack.length) return false;
	outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
		for (let offset = 0; offset < needle.length; offset += 1) {
			if (haystack[start + offset] !== needle[offset]) continue outer;
		}
		return true;
	}
	return false;
}

async function modeCleanup(logFn) {
	const tagName = process.env.TAG_NAME;
	if (!tagName) {
		logFn('TAG_NAME env var not set — cleanup requires a component tag');
		return 1;
	}
	const parsedTag = parseComponentTag(tagName);
	if (!parsedTag) {
		logFn(`tag ${tagName} is not a component tag — exiting 0`);
		return 0;
	}
	const repoRoot = resolveRepoRoot();
	const rel = tryGhJson(['release', 'view', tagName, '--json', 'body,tagName']);
	if (!rel.ok) {
		const stderr = String(rel.err?.stderr ?? '');
		if (/not found/i.test(stderr)) {
			logFn(`Release ${tagName} not found — exiting 0`);
			return 0;
		}
		logFn(`gh release view failed for ${tagName}: ${rel.err instanceof Error ? rel.err.message : String(rel.err)}`);
		return 1;
	}
	const strippedBody = stripCustomReleaseNotesBlock(rel.value.body || '');
	let allCandidates = resolveAllCandidates(strippedBody, logFn);
	// Same CHANGELOG fallback as update-release: an empty-body release
	// publishes fragments through the fallback, so cleanup must resolve the
	// same candidate set or nothing is ever consumed (review PRR-006).
	if (allCandidates.length === 0) {
		const changelogPath = path.join(
			repoRoot,
			COMPONENT_PATHS[parsedTag.component] ?? 'packages',
			'CHANGELOG.md',
		);
		if (existsSync(changelogPath)) {
			const section = extractChangelogSection(readFileSync(changelogPath, 'utf8'), parsedTag.version);
			if (section !== '') {
				allCandidates = resolveAllCandidates(section, logFn);
				if (allCandidates.length > MAX_FALLBACK_CANDIDATES) {
					logFn(`CHANGELOG fallback clamped ${allCandidates.length} -> ${MAX_FALLBACK_CANDIDATES} candidates (main parity)`);
					allCandidates = allCandidates.slice(0, MAX_FALLBACK_CANDIDATES);
				}
				if (allCandidates.length > 0) {
					logFn(`resolved ${allCandidates.length} candidate PR(s) from ${parsedTag.component} CHANGELOG section ${parsedTag.version}`);
				}
			}
		}
	}
	if (allCandidates.length === 0) {
		logFn('No PR references in release body — nothing to clean up');
		return 0;
	}
	const entries = collectFragmentsForPrs(allCandidates, repoRoot, logFn, { requireComplete: true });
	if (entries.length === 0) {
		logFn('No pending fragments referenced by this release — nothing to clean up');
		return 0;
	}
	const plan = planFragmentDeletions(rel.value.body || '', entries, (filePath) => {
		// Same containment/regular-file guard as collection (review PRR-002):
		// the hash comparison reads attacker-controllable paths too.
		try {
			const absolute = guardFragmentPath(repoRoot, filePath);
			return readFileSync(absolute, 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT') return null;
			throw error;
		}
	});
	for (const r of plan.retained) {
		logFn(`RETAIN ${r.entry.filePath}: ${r.reason}`);
	}
	if (plan.deletable.length === 0) {
		logFn('No deletable fragments (all retained) — done');
		return 0;
	}
	// Deletable paths go to CLEANUP_PLAN_FILE when set (append; the
	// workflow aggregates across component tags), else stdout — one path
	// per line. Paths are POSIX repo-relative with no newlines by
	// construction.
	const planFile = process.env.CLEANUP_PLAN_FILE;
	const lines = plan.deletable.map((entry) => `${entry.filePath}\n`).join('');
	if (planFile) {
		appendFileSync(planFile, lines);
	} else {
		process.stdout.write(lines);
	}
	logFn(`${plan.deletable.length} fragment(s) eligible for deletion`);
	return 0;
}

// -----------------------------------------------------------------------------
// Manifest lockstep check (fail-closed; used by the workflow before tag
// derivation). Exported for tests.
// -----------------------------------------------------------------------------
export function readLockstepVersion(manifestJson) {
	let manifest;
	try {
		manifest = JSON.parse(manifestJson);
	} catch {
		throw new Error('release manifest is not valid JSON');
	}
	const versions = new Map();
	for (const component of COMPONENTS) {
		const pkgPath = COMPONENT_PATHS[component];
		const version = manifest?.[pkgPath];
		if (typeof version !== 'string' || version.length === 0) {
			throw new Error(`manifest missing version for ${pkgPath} (${component})`);
		}
		versions.set(component, version);
	}
	const distinct = new Set(versions.values());
	if (distinct.size !== 1) {
		const detail = [...versions.entries()].map(([c, v]) => `${c}=${v}`).join(' ');
		throw new Error(`lockstep violation — refusing to derive tags from a partially bumped manifest: ${detail}`);
	}
	const version = [...distinct][0];
	const tags = COMPONENTS.map((component) => `${component}-v${version}`);
	return { version, tags };
}

// -----------------------------------------------------------------------------
// Mode entry points — exported as the script's public API (the CLI dispatch
// and the workflow jobs both route through these; tests import them to
// exercise the mode guards without shelling out).
// -----------------------------------------------------------------------------
export async function updatePr(logFn = log) {
	return modeUpdatePr(logFn);
}

export async function updateRelease(logFn = log) {
	return modeUpdateRelease(logFn);
}

export async function cleanup(logFn = log) {
	return modeCleanup(logFn);
}

// -----------------------------------------------------------------------------
// Entry point.
// -----------------------------------------------------------------------------
async function main() {
	const mode = process.argv[2];
	const logFn = log;
	switch (mode) {
		case 'update-pr':
			return updatePr();
		case 'update-release':
			return updateRelease();
		case 'cleanup':
			return cleanup();
		case 'lockstep-tags': {
			// Workflow helper: read the manifest, print version + tags.
			const manifestPath = path.join(resolveRepoRoot(), '.release-please-manifest.json');
			const result = readLockstepVersion(readFileSync(manifestPath, 'utf8'));
			process.stdout.write(`${result.version}\n${result.tags.join('\n')}\n`);
			return 0;
		}
		default:
			console.error('usage: release-notes-fragments.mjs <update-pr|update-release|cleanup|lockstep-tags>');
			return 2;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(`[release-notes] fatal: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		});
}
