#!/usr/bin/env node
/**
 * release-notes-fragments.mjs — aggregate per-PR release-note fragments
 * into the release-please PR body (and the GitHub Release body on tag).
 *
 * Background: every PR that ships a user-visible change drops a unique
 * file under `docs/releases/pending/<slug>.md`. release-please decides the
 * actual version. This script reads the release-please PR body (or the
 * GitHub Release body after a tag is cut), discovers which source PRs are
 * included, gathers their pending fragments, and injects the combined
 * content inside a stable marker block:
 *
 *     <!-- custom-release-notes:start -->
 *     ...combined notes...
 *     <!-- custom-release-notes:end -->
 *
 * Idempotent: re-running replaces the existing block in place.
 *
 * Modes:
 *   node scripts/release-notes-fragments.mjs update-pr
 *   node scripts/release-notes-fragments.mjs update-release
 *
 * Dependencies: Node built-ins + the `gh` CLI already present on
 * GitHub-hosted runners. No npm dependencies.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Stable marker block — never change these strings without considering that
// older release PR bodies in the wild rely on them for idempotent replace.
// -----------------------------------------------------------------------------
export const MARKER_START = '<!-- custom-release-notes:start -->';
export const MARKER_END = '<!-- custom-release-notes:end -->';
export const FRAGMENT_DIR = 'docs/releases/pending';

// -----------------------------------------------------------------------------
// Pure helpers — exported for unit tests. No I/O, no gh CLI.
// -----------------------------------------------------------------------------

/**
 * Maximum PR-number magnitude accepted by the extractor. GitHub PR numbers
 * are sequential per-repo and 7 digits is comfortably above any realistic
 * monorepo. Anything larger is almost certainly garbage in the body text
 * (timestamps, IDs from other systems) or an attempt to coerce the
 * extractor into looking up unrelated PRs.
 */
const MAX_PR_DIGITS = 7;

/**
 * Strip any previously-injected custom-release-notes block from a body
 * before scanning it for PR references. Without this, every re-run would
 * re-extract PR numbers that appear *inside* our own injected fragment
 * prose (e.g. `(#885)` cited as context for another change) and treat
 * them as new source PRs, polluting the next aggregation with unrelated
 * fragments.
 *
 * Exported for testability. Uses the SAME `lastIndexOf` strategy as
 * `upsertReleaseNotesBlock` so any nested markers from prior buggy runs
 * are absorbed by the strip too.
 */
export function stripCustomReleaseNotesBlock(body) {
	if (typeof body !== 'string' || body.length === 0) return '';
	const startIdx = body.indexOf(MARKER_START);
	const endIdx = body.lastIndexOf(MARKER_END);
	if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return body;
	return body.slice(0, startIdx) + body.slice(endIdx + MARKER_END.length);
}

/**
 * Extract full (40-character) commit SHAs from GitHub commit URLs in a body.
 *
 * release-please with `changelog-notes-type: "github"` frequently generates
 * changelog entries that link directly to the merge commit instead of the
 * source PR, e.g.:
 *
 *   * description ([ba948b4](https://github.com/owner/repo/commit/ba948b40...))
 *
 * These commit URLs contain a 40-hex SHA that can be used to look up the
 * associated PR(s) via the GitHub API. Short (7-char) SHA labels shown in
 * the link text are NOT extracted — only the full 40-char SHA embedded in
 * the URL is reliable.
 *
 * Returns deduplicated SHAs in first-seen order. Does not perform any I/O.
 * Exported for unit tests.
 */
export function extractCommitShasFromBody(body) {
	if (typeof body !== 'string' || body.length === 0) return [];
	const seen = new Set();
	const out = [];
	// Match /commit/<40-hex> anywhere in the body. The word boundary \b after
	// the SHA ensures we don't partially match a longer hex string.
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

/**
 * Extract candidate PR numbers from a release-please body string.
 *
 * release-please writes changelog entries that reference source PRs as
 * `(#886)`, `[#886](url)`, or `https://github.com/owner/repo/pull/886`.
 * We capture every numeric reference and de-duplicate while preserving
 * first-seen order.
 *
 * Numbers returned are *candidates*. The caller must verify each one is
 * actually a PR via `gh pr view`. Issues live in the same numeric
 * namespace, and third-party URLs in the body (e.g. dependency-bump
 * citations pointing at upstream repos) would otherwise leak in.
 */
export function extractCandidatePrNumbers(body) {
	if (typeof body !== 'string' || body.length === 0) return [];
	const seen = new Set();
	const out = [];
	// Each pattern captures the numeric portion in group 1. The `\d{1,N}`
	// cap keeps `parseInt` from silently rounding very large values and
	// blocks the most obvious "shove a giant number into the extractor"
	// attack from a malicious release-please body.
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
			// Defense in depth: reject if a longer digit run extends past
			// the capture (e.g. `#12345678` would match the first 7 but
			// the trailing `8` makes it not a clean reference).
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

/**
 * Filter changed-files entries down to pending release-note fragments.
 *
 * Accepts entries shaped like `{ path: '...' }` (gh pr view --json files).
 * Returns the file paths that live under `docs/releases/pending/` and end
 * in `.md`. Versioned files (`docs/releases/v1.2.3.md`) and any other
 * paths are ignored.
 *
 * Path-traversal rejection: any path containing a `..` segment, NUL byte,
 * or absolute marker (leading `/` or drive letter) is dropped. These
 * cannot occur from a well-formed `gh pr view --json files` response
 * against a real PR, but the listing is attacker-controllable (the PR
 * author controls their own file paths) and the script later does
 * `path.resolve(repoRoot, filePath)` to read the file, which would
 * happily escape the repo.
 */
export function filterPendingFragmentPaths(files) {
	if (!Array.isArray(files)) return [];
	const out = [];
	for (const f of files) {
		const p = typeof f === 'string' ? f : f?.path;
		if (typeof p !== 'string') continue;
		if (p.length === 0) continue;
		// Reject NUL or any control char that could confuse downstream
		// path/CLI handling.
		if (/[\x00-\x1f]/.test(p)) continue;
		// Reject absolute paths (POSIX `/x` or Windows `C:` / `\\share`).
		if (/^[\/\\]/.test(p) || /^[A-Za-z]:[\\/]/.test(p)) continue;
		// Normalize Windows separators for cross-platform comparison.
		const norm = p.replace(/\\/g, '/');
		// Reject any `..` segment — covers `a/../b`, `../foo`, `./../x`.
		// Done on the normalized form so a stray `\..\\` is caught too.
		if (norm.split('/').some((seg) => seg === '..')) continue;
		if (
			norm.startsWith(`${FRAGMENT_DIR}/`) &&
			norm.toLowerCase().endsWith('.md')
		) {
			out.push(norm);
		}
	}
	return out;
}

/**
 * Concatenate fragment contents in deterministic order:
 *   primary  → PR number ascending
 *   secondary→ file path ascending (case-sensitive)
 *
 * `entries` is `[{ prNumber, filePath, content }, ...]`.
 * De-duplication by filePath happens here too — the same fragment cannot
 * appear twice in the output even if multiple PRs touched it.
 */
export function combineFragments(entries) {
	if (!Array.isArray(entries) || entries.length === 0) return '';
	const dedup = new Map();
	for (const e of entries) {
		if (!e || typeof e.content !== 'string') continue;
		const fp = e.filePath;
		if (typeof fp !== 'string') continue;
		if (!dedup.has(fp)) dedup.set(fp, e);
	}
	const sorted = [...dedup.values()].sort((a, b) => {
		const pa = Number.isFinite(a.prNumber) ? a.prNumber : Number.MAX_SAFE_INTEGER;
		const pb = Number.isFinite(b.prNumber) ? b.prNumber : Number.MAX_SAFE_INTEGER;
		if (pa !== pb) return pa - pb;
		return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
	});
	const parts = sorted.map((e) => e.content.replace(/\s+$/, ''));
	return parts.join('\n\n---\n\n');
}

/**
 * Strip any literal marker strings out of fragment content before
 * insertion. A fragment that legitimately mentions the markers (e.g. the
 * release-notes design doc *describes* them) would otherwise nest the
 * markers inside the block, breaking the next idempotent run.
 *
 * We replace the literal strings with a visible marker-comment-escaped
 * form so the discussion remains legible in the rendered notes.
 */
function neutralizeMarkers(text) {
	return text
		.replace(/<!-- custom-release-notes:start -->/g, '<!-- custom-release-notes-start (literal) -->')
		.replace(/<!-- custom-release-notes:end -->/g, '<!-- custom-release-notes-end (literal) -->');
}

/**
 * Insert or replace the custom-release-notes marker block in a body.
 *
 * Behavior:
 *   - If both markers are present: replace from the FIRST `MARKER_START`
 *     through the LAST `MARKER_END`. Using `lastIndexOf` for the closer
 *     absorbs accidentally-nested markers that prior buggy runs may have
 *     left behind, and protects against fragment content that contains
 *     the literal marker strings (in addition to the `neutralizeMarkers`
 *     pass on `combined`).
 *   - If markers are absent: prepend a marker block above the existing
 *     body, separated by a blank line, preserving the original body
 *     (release-please content / markers) verbatim below.
 *   - If `combined` is empty: return the original body unchanged.
 *
 * Idempotent: running the function twice with the same `combined` yields
 * the same result as running it once, even if a fragment's content
 * contains the literal marker strings.
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
		// Replace from the first start marker through the LAST closing
		// marker (inclusive). This absorbs any nested markers a buggy
		// prior run might have introduced into the block content.
		const before = original.slice(0, startIdx);
		const after = original.slice(endIdx + MARKER_END.length);
		return `${before}${block}${after}`;
	}
	// No markers — prepend, separated by a blank line.
	if (original.length === 0) return block;
	return `${block}\n\n${original}`;
}

/**
 * Merge two arrays of PR candidate numbers into a single deduplicated array,
 * preserving first-seen order across both sources.
 *
 * `direct` entries come first (they are more reliable — explicit PR-number
 * references in the release body). Entries from `shaResolved` are appended
 * only if they haven't already appeared in `direct`.
 *
 * Exported for unit tests. Pure — no I/O, no side effects.
 */
export function mergeCandidateLists(direct, shaResolved) {
	if (!Array.isArray(direct) && !Array.isArray(shaResolved)) return [];
	// Seed `seen` and `out` both from the Set so intra-list duplicates in
	// `direct` are collapsed before any `shaResolved` entries are appended.
	const seen = new Set(Array.isArray(direct) ? direct : []);
	const out = Array.isArray(direct) ? [...seen] : [];
	for (const n of (Array.isArray(shaResolved) ? shaResolved : [])) {
		if (!seen.has(n)) {
			seen.add(n);
			out.push(n);
		}
	}
	return out;
}

// -----------------------------------------------------------------------------
// gh CLI shim — wrapped so update modes can be exercised at integration time
// while pure helpers stay testable without network access.
// -----------------------------------------------------------------------------

// Bounded subprocess invariant: every external-binary subprocess has an
// explicit timeout, bounded stdio, and an array-form argv. `gh` calls
// against the GitHub API resolve in low-single-digit seconds normally;
// the 30-second cap is generous but prevents an indefinite hang from
// stalling the workflow run.
const GH_TIMEOUT_MS = 30_000;

function ghJson(args) {
	const raw = execFileSync('gh', args, {
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
		timeout: GH_TIMEOUT_MS,
	});
	return JSON.parse(raw);
}

function ghText(args) {
	return execFileSync('gh', args, {
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
		timeout: GH_TIMEOUT_MS,
	});
}

function tryGhJson(args) {
	try {
		return { ok: true, value: ghJson(args) };
	} catch (err) {
		return { ok: false, err };
	}
}

/**
 * Verify a candidate number is a PR (not an issue). Returns the parsed
 * PR object or null if the candidate is not a PR or the lookup failed.
 */
function verifyPr(num) {
	const res = tryGhJson(['pr', 'view', String(num), '--json', 'number,files']);
	if (!res.ok) return null;
	return res.value;
}

/**
 * Resolve a list of commit SHAs to PR numbers via the GitHub REST API.
 *
 * release-please with `changelog-notes-type: "github"` often emits commit
 * SHA links rather than PR-number links. For each SHA we call
 * `GET /repos/{repo}/commits/{sha}/pulls` to discover which PR(s) introduced
 * that commit, then collect their numbers for fragment lookup.
 *
 * Edge cases handled:
 * - A commit that maps to multiple PRs (e.g. cherry-picks): all PR numbers
 *   are collected; each is logged. Fragment de-duplication in
 *   `collectFragmentsForPrs` ensures a file is never included twice.
 * - API failures for a given SHA are logged and skipped (non-fatal).
 * - The GITHUB_REPOSITORY env var provides the repo slug (owner/repo).
 *   Without it the lookup is skipped gracefully.
 * - `--paginate` is passed to `gh api` so that commits associated with more
 *   than 30 PRs (e.g. heavily cherry-picked base commits) are not silently
 *   truncated to the first page.
 *
 * Not exported: this function shells out to `gh` and therefore cannot be
 * exercised in the pure unit-test suite. The per-SHA guard logic
 * (`Number.isFinite`, digit-cap) mirrors `extractCandidatePrNumbers` and is
 * relied on to prevent garbage PR numbers from reaching `collectFragmentsForPrs`.
 *
 * Returns a deduplicated array of PR numbers in first-seen order.
 */
function resolveCommitShasToPrNumbers(shas, log) {
	if (!Array.isArray(shas) || shas.length === 0) return [];
	const repoSlug = process.env.GITHUB_REPOSITORY;
	if (!repoSlug) {
		log('GITHUB_REPOSITORY not set — cannot resolve commit SHAs to PR numbers');
		return [];
	}
	const seen = new Set();
	const out = [];
	for (const sha of shas) {
		const res = tryGhJson(['api', '--paginate', `repos/${repoSlug}/commits/${sha}/pulls`]);
		if (!res.ok || !Array.isArray(res.value)) {
			log(`skip SHA ${sha.slice(0, 7)} — API lookup failed`);
			continue;
		}
		const prs = res.value;
		if (prs.length === 0) {
			log(`SHA ${sha.slice(0, 7)} — no associated PRs found`);
			continue;
		}
		if (prs.length > 1) {
			log(`SHA ${sha.slice(0, 7)} — resolves to ${prs.length} PRs: ${prs.map((p) => `#${p.number}`).join(', ')}`);
		}
		for (const pr of prs) {
			if (
				Number.isFinite(pr.number) &&
				pr.number > 0 &&
				pr.number < 10 ** MAX_PR_DIGITS &&
				!seen.has(pr.number)
			) {
				seen.add(pr.number);
				out.push(pr.number);
			}
		}
	}
	return out;
}

/**
 * Read a fragment from the workspace if it exists, otherwise null.
 * Paths are normalized to forward-slash form. The script always runs from
 * the repo root in CI; we resolve relative to the repo root computed from
 * this script's own location for local invocations.
 */
function readFragmentFromWorkspace(repoRoot, filePath) {
	const abs = path.resolve(repoRoot, filePath);
	if (!existsSync(abs)) return null;
	return readFileSync(abs, 'utf8');
}

/**
 * Repo root resolution: this script lives at `<repoRoot>/scripts/`.
 */
function resolveRepoRoot() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, '..');
}

/**
 * Collect fragments for the given candidate PR numbers.
 * Each PR is verified (skips issues / 404s), its file list is fetched,
 * pending fragments are filtered, and contents are read from the
 * workspace. Returns the `entries` array shape expected by
 * `combineFragments`.
 */
function collectFragmentsForPrs(candidates, repoRoot, log) {
	const entries = [];
	const seenPaths = new Set();
	for (const num of candidates) {
		const pr = verifyPr(num);
		if (!pr || !Array.isArray(pr.files)) {
			log(`skip #${num} — not a PR or no files`);
			continue;
		}
		const fragPaths = filterPendingFragmentPaths(pr.files);
		if (fragPaths.length === 0) continue;
		for (const fp of fragPaths) {
			if (seenPaths.has(fp)) continue;
			seenPaths.add(fp);
			const content = readFragmentFromWorkspace(repoRoot, fp);
			if (content === null) {
				log(`fragment ${fp} referenced by #${num} not found in workspace`);
				continue;
			}
			entries.push({ prNumber: num, filePath: fp, content });
		}
	}
	return entries;
}

// -----------------------------------------------------------------------------
// Mode: update-pr — keep the open release-please PR body in sync.
// -----------------------------------------------------------------------------

async function modeUpdatePr(log) {
	const repoRoot = resolveRepoRoot();
	const prList = tryGhJson([
		'pr',
		'list',
		'--label',
		'autorelease: pending',
		'--json',
		'number,body',
		'--limit',
		'5',
	]);
	if (!prList.ok || !Array.isArray(prList.value) || prList.value.length === 0) {
		log('No autorelease PR found — exiting 0');
		return 0;
	}
	const releasePr = prList.value[0];
	// Strip any previously-injected block before scanning, so PR/commit
	// references inside the injected fragments are not re-treated as new
	// source PRs on the next run.
	const strippedBody = stripCustomReleaseNotesBlock(releasePr.body || '');

	// Primary path: extract explicit PR-number references (e.g. `(#1234)`).
	const directCandidates = extractCandidatePrNumbers(strippedBody);
	log(`release PR #${releasePr.number}: found ${directCandidates.length} direct PR ref(s) in body`);

	// Fallback path: release-please with changelog-notes-type "github" often
	// emits commit SHA links instead of PR-number links. Resolve each SHA to
	// its associated PR(s) via the GitHub API.
	const commitShas = extractCommitShasFromBody(strippedBody);
	log(`release PR #${releasePr.number}: found ${commitShas.length} commit SHA(s) in body`);
	const shaResolved = commitShas.length > 0
		? resolveCommitShasToPrNumbers(commitShas, log)
		: [];
	log(`resolved ${shaResolved.length} PR number(s) from commit SHAs`);

	// Merge both sets, preserving first-seen order and deduplicating.
	const allCandidates = mergeCandidateLists(directCandidates, shaResolved);

	if (allCandidates.length === 0) {
		log('Release PR body has no PR references (direct or via commit SHAs) — exiting 0');
		return 0;
	}
	log(`collecting fragments for ${allCandidates.length} candidate PR(s): ${allCandidates.map((n) => `#${n}`).join(', ')}`);
	const entries = collectFragmentsForPrs(allCandidates, repoRoot, log);
	if (entries.length === 0) {
		log('No pending fragments found across referenced PRs — exiting 0');
		return 0;
	}
	const combined = combineFragments(entries);
	const newBody = upsertReleaseNotesBlock(releasePr.body || '', combined);
	if (newBody === releasePr.body) {
		log('Release PR body already up to date — exiting 0');
		return 0;
	}
	execFileSync(
		'gh',
		['pr', 'edit', String(releasePr.number), '--body-file', '-'],
		{ input: newBody, encoding: 'utf8', timeout: GH_TIMEOUT_MS },
	);
	log(
		`Updated release PR #${releasePr.number} with ${entries.length} fragment(s)`,
	);
	return 0;
}

// -----------------------------------------------------------------------------
// Mode: update-release — keep the GitHub Release body in sync after a tag.
// -----------------------------------------------------------------------------

async function modeUpdateRelease(log) {
	const tagName = process.env.TAG_NAME;
	if (!tagName) {
		log('TAG_NAME env var not set — exiting 0');
		return 0;
	}
	const repoRoot = resolveRepoRoot();
	const rel = tryGhJson(['release', 'view', tagName, '--json', 'body,tagName']);
	if (!rel.ok) {
		log(`Release ${tagName} not found — exiting 0`);
		return 0;
	}
	const releaseBody = rel.value.body || '';
	// Strip any previously-injected block before scanning — same defense as
	// modeUpdatePr: prevents re-scanning our own injected content on re-runs.
	const strippedBody = stripCustomReleaseNotesBlock(releaseBody);

	// Primary path: explicit PR-number references.
	const directCandidates = extractCandidatePrNumbers(strippedBody);
	log(`release ${tagName}: found ${directCandidates.length} direct PR ref(s) in body`);

	// Fallback path: commit SHA links produced by release-please's github
	// changelog notes type.
	const commitShas = extractCommitShasFromBody(strippedBody);
	log(`release ${tagName}: found ${commitShas.length} commit SHA(s) in body`);
	const shaResolved = commitShas.length > 0
		? resolveCommitShasToPrNumbers(commitShas, log)
		: [];
	log(`resolved ${shaResolved.length} PR number(s) from commit SHAs`);

	// Merge both sets, preserving first-seen order and deduplicating.
	const allCandidates = mergeCandidateLists(directCandidates, shaResolved);

	if (allCandidates.length === 0) {
		log('Release body has no PR references (direct or via commit SHAs) — exiting 0');
		return 0;
	}
	log(`collecting fragments for ${allCandidates.length} candidate PR(s): ${allCandidates.map((n) => `#${n}`).join(', ')}`);
	const entries = collectFragmentsForPrs(allCandidates, repoRoot, log);
	if (entries.length === 0) {
		log('No pending fragments found across referenced PRs — exiting 0');
		return 0;
	}
	const combined = combineFragments(entries);
	const newBody = upsertReleaseNotesBlock(releaseBody, combined);
	if (newBody === releaseBody) {
		log(`Release ${tagName} body already up to date — exiting 0`);
		return 0;
	}
	execFileSync('gh', ['release', 'edit', tagName, '--notes-file', '-'], {
		input: newBody,
		encoding: 'utf8',
		timeout: GH_TIMEOUT_MS,
	});
	log(`Updated release ${tagName} with ${entries.length} fragment(s)`);
	return 0;
}

// -----------------------------------------------------------------------------
// CLI dispatch.
// -----------------------------------------------------------------------------

async function main() {
	const mode = process.argv[2];
	const log = (msg) => {
		process.stdout.write(`[release-notes-fragments] ${msg}\n`);
	};
	switch (mode) {
		case 'update-pr':
			return modeUpdatePr(log);
		case 'update-release':
			return modeUpdateRelease(log);
		default:
			process.stderr.write(
				'Usage: release-notes-fragments.mjs <update-pr|update-release>\n',
			);
			return 2;
	}
}

// Run when invoked directly (not when imported by tests).
const isDirectInvocation =
	import.meta.url === `file://${process.argv[1]}` ||
	process.argv[1]?.endsWith('release-notes-fragments.mjs');

if (isDirectInvocation) {
	main().then(
		(code) => process.exit(code ?? 0),
		(err) => {
			process.stderr.write(`[release-notes-fragments] ERROR: ${err?.stack ?? err}\n`);
			process.exit(1);
		},
	);
}
