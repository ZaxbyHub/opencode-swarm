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
 *   node scripts/release-notes-fragments.mjs prepare-cleanup --tag <tag> --out .release-fragment-cleanup/plan.json --apply
 *   node scripts/release-notes-fragments.mjs prepare-historical-batch --tags-file .release-fragment-cleanup/tags.json [--cursor <cursor>] [--batch-size <count>]
 *   node scripts/release-notes-fragments.mjs apply-cleanup --plan .release-fragment-cleanup/plan.json [--apply]
 *   node scripts/release-notes-fragments.mjs verify-retention
 *
 * Dependencies: Node built-ins + the `gh` CLI already present on
 * GitHub-hosted runners. No npm dependencies.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Stable marker block — never change these strings without considering that
// older release PR bodies in the wild rely on them for idempotent replace.
// -----------------------------------------------------------------------------
export const MARKER_START = '<!-- custom-release-notes:start -->';
export const MARKER_END = '<!-- custom-release-notes:end -->';
export const FRAGMENT_DIR = 'docs/releases/pending';
export const HISTORICAL_REPLAY_STATE =
	'docs/releases/manifests/historical-replay-state.json';
export const HISTORICAL_REPLAY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

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

function hasNonEmptyCustomReleaseNotesBlock(body) {
	if (typeof body !== 'string' || body.length === 0) return false;
	const startIdx = body.indexOf(MARKER_START);
	const endIdx = body.lastIndexOf(MARKER_END);
	if (startIdx === -1 || endIdx <= startIdx) return false;
	return body
		.slice(startIdx + MARKER_START.length, endIdx)
		.trim().length > 0;
}

function customReleaseNotesPayload(body) {
	if (typeof body !== 'string') return null;
	const startIdx = body.indexOf(MARKER_START);
	const endIdx = body.lastIndexOf(MARKER_END);
	if (startIdx === -1 || endIdx <= startIdx) return null;
	return body.slice(startIdx + MARKER_START.length, endIdx).trim();
}

function normalizePublishedFragmentText(text) {
	return text.replace(/\x07/g, '^G');
}

function publishedBlockMatchesEntries(releaseBody, entries) {
	const combined = combineFragments(entries);
	return (
		upsertReleaseNotesBlock(releaseBody, combined) === releaseBody ||
		upsertReleaseNotesBlock(
			releaseBody,
			normalizePublishedFragmentText(combined),
		) === releaseBody
	);
}

export function selectEntriesForPublishedBlock(entries, releaseBody) {
	const payload = customReleaseNotesPayload(releaseBody);
	if (!payload) return [];
	const selected = [];
	const usedPaths = new Set();
	for (const part of payload.split('\n\n---\n\n')) {
		const matches = entries.filter(
			(entry) =>
				typeof entry?.filePath === 'string' &&
				typeof entry?.content === 'string' &&
				normalizePublishedFragmentText(entry.content.replace(/\s+$/, '')) ===
					part &&
				!usedPaths.has(entry.filePath),
		);
		if (matches.length !== 1) return null;
		selected.push(matches[0]);
		usedPaths.add(matches[0].filePath);
	}
	return publishedBlockMatchesEntries(releaseBody, selected) ? selected : null;
}

export function reconstructPublishedBlockFromWorkspace(
	repoRoot,
	releaseBody,
	options = {},
) {
	const payload = customReleaseNotesPayload(releaseBody);
	if (!payload) return [];
	const {
		listFragments = listPendingFragmentState,
		readFragment = readFragmentFromWorkspace,
	} = options;
	const pending = listFragments(repoRoot).filter((item) => item.regular);
	if (pending.length > MAX_PENDING_FRAGMENT_SCAN) {
		throw new Error('pending fragment hard scan cap exceeded');
	}
	let totalBytes = 0;
	const available = pending.flatMap((item) => {
		const size = Number.isInteger(item.size)
			? item.size
			: lstatSync(item.absolute).size;
		totalBytes += size;
		if (totalBytes > MAX_FRAGMENT_SCAN_BYTES) {
			throw new Error('historical fragment scan byte cap exceeded');
		}
		try {
			const fragment = readFragment(repoRoot, item.relativePath);
			if (fragment === null) return [];
			return [{ filePath: item.relativePath, ...fragment }];
		} catch (error) {
			if (error instanceof Error && /not valid UTF-8/i.test(error.message)) {
				return [];
			}
			throw error;
		}
	});
	const selected = [];
	const usedPaths = new Set();
	const parts = payload.split('\n\n---\n\n');
	for (let order = 0; order < parts.length; order += 1) {
		const matches = available.filter(
			(entry) =>
				normalizePublishedFragmentText(entry.content.replace(/\s+$/, '')) ===
					parts[order] &&
				!usedPaths.has(entry.filePath),
		);
		if (matches.length !== 1) {
			throw new Error(
				'incomplete release provenance: published fragment has ' +
					matches.length +
					' exact workspace matches',
			);
		}
		selected.push({ ...matches[0], prNumber: null, order });
		usedPaths.add(matches[0].filePath);
	}
	if (!publishedBlockMatchesEntries(releaseBody, selected)) {
		throw new Error(
			'incomplete release provenance: workspace fragments do not reconstruct the published block',
		);
	}
	return selected;
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
		if (Number.isInteger(a.order) || Number.isInteger(b.order)) {
			const oa = Number.isInteger(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
			const ob = Number.isInteger(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
			if (oa !== ob) return oa - ob;
		}
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

const RELEASE_TAG_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
export const MAX_PENDING_FRAGMENT_SCAN = 5_000;
export const MAX_PENDING_FRAGMENT_RETENTION = 750;
export const MAX_RELEASE_MANIFEST_SCAN = 1_000;
const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;
export const MAX_RELEASE_CANDIDATES = 1_000;
export const MAX_FRAGMENT_ENTRIES = 5_000;
export const MAX_FRAGMENT_BYTES = 256 * 1024;
export const MAX_FRAGMENT_SCAN_BYTES = 64 * 1024 * 1024;

function sha256(value) {
	const hash = createHash('sha256');
	if (typeof value === 'string') hash.update(value, 'utf8');
	else hash.update(value);
	return hash.digest('hex');
}

export function decodeFragmentBytes(bytes, filePath = 'fragment') {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new Error('release fragment is not valid UTF-8: ' + filePath);
	}
}

function countLiteral(text, literal) {
	let count = 0;
	let offset = 0;
	while ((offset = text.indexOf(literal, offset)) !== -1) {
		count += 1;
		offset += literal.length;
	}
	return count;
}

function containedPendingPath(repoRoot, relativePath) {
	const normalized = relativePath.replace(/\\/g, '/');
	if (!filterPendingFragmentPaths([{ path: normalized }]).includes(normalized)) {
		throw new Error('unsafe pending fragment path: ' + relativePath);
	}
	const pendingRoot = path.resolve(repoRoot, FRAGMENT_DIR);
	const absolute = path.resolve(repoRoot, normalized);
	if (!absolute.startsWith(pendingRoot + path.sep)) {
		throw new Error('pending fragment escaped repository containment: ' + relativePath);
	}
	return { normalized, absolute };
}

function assertSafeDirectoryChain(repoRoot, relativeDirectory) {
	const normalized = relativeDirectory.replace(/\\/g, '/');
	if (
		path.isAbsolute(relativeDirectory) ||
		normalized.split('/').some((segment) => segment === '..')
	) {
		throw new Error('unsafe release directory: ' + relativeDirectory);
	}
	let current = path.resolve(repoRoot);
	for (const segment of normalized.split('/').filter(Boolean)) {
		current = path.join(current, segment);
		if (!existsSync(current)) break;
		const stat = lstatSync(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error('unsafe release directory: ' + relativeDirectory);
		}
	}
}

function safeRepositoryFilePath(repoRoot, relativePath) {
	const absolute = path.resolve(repoRoot, relativePath);
	const root = path.resolve(repoRoot);
	if (!absolute.startsWith(root + path.sep)) {
		throw new Error('release artifact escaped repository containment: ' + relativePath);
	}
	assertSafeDirectoryChain(repoRoot, path.dirname(relativePath));
	if (existsSync(absolute)) {
		const stat = lstatSync(absolute);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error('unsafe release artifact: ' + relativePath);
		}
	}
	return absolute;
}

function defaultReconciliationIo(repoRoot) {
	return {
		async readText(relativePath) {
			return readFileSync(safeRepositoryFilePath(repoRoot, relativePath), 'utf8');
		},
		async readBytes(relativePath) {
			return readBoundedFragmentBytes(repoRoot, relativePath);
		},
		async writeText(relativePath, content) {
			const absolute = safeRepositoryFilePath(repoRoot, relativePath);
			mkdirSync(path.dirname(absolute), { recursive: true });
			const temporary = absolute + '.tmp-' + process.pid;
			writeFileSync(temporary, content, 'utf8');
			renameSync(temporary, absolute);
		},
		async removePath(relativePath) {
			rmSync(safeRepositoryFilePath(repoRoot, relativePath), { force: true });
		},
	};
}

function readBoundedFragmentBytes(repoRoot, relativePath) {
	const absolute = safeRepositoryFilePath(repoRoot, relativePath);
	const stat = lstatSync(absolute);
	if (stat.size > MAX_FRAGMENT_BYTES) {
		throw new Error('release fragment size cap exceeded: ' + relativePath);
	}
	return readFileSync(absolute);
}

export function readDirectoryNamesBounded(directory, limit, label) {
	const names = [];
	const handle = opendirSync(directory);
	try {
		for (;;) {
			const entry = handle.readSync();
			if (entry === null) break;
			names.push(entry.name);
			if (names.length > limit) {
				throw new Error(
					label + ' hard scan cap exceeded: more than ' + limit,
				);
			}
		}
	} finally {
		handle.closeSync();
	}
	return names;
}

function listPendingFragmentState(repoRoot) {
	const pendingRoot = path.resolve(repoRoot, FRAGMENT_DIR);
	if (!existsSync(pendingRoot)) return [];
	assertSafeDirectoryChain(repoRoot, FRAGMENT_DIR);
	const names = readDirectoryNamesBounded(
		pendingRoot,
		MAX_PENDING_FRAGMENT_SCAN,
		'pending fragment',
	);
	return names
		.filter((name) => name.toLowerCase().endsWith('.md'))
		.sort()
		.map((name) => {
			const relativePath = FRAGMENT_DIR + '/' + name;
			const { absolute } = containedPendingPath(repoRoot, relativePath);
			const stat = lstatSync(absolute);
			if (stat.isFile() && !stat.isSymbolicLink() && stat.size > MAX_FRAGMENT_BYTES) {
				throw new Error('release fragment size cap exceeded: ' + relativePath);
			}
			return {
				relativePath,
				absolute,
				regular: stat.isFile() && !stat.isSymbolicLink(),
			};
		});
}

export function auditFragmentRetention(
	repoRoot,
	maxPendingFragments = MAX_PENDING_FRAGMENT_RETENTION,
	nowMs = Date.now(),
) {
	if (!Number.isFinite(nowMs)) throw new Error('retention audit time must be finite');
	const pending = listPendingFragmentState(repoRoot);
	const manifestsRoot = path.resolve(repoRoot, 'docs/releases/manifests');
	const consumedHashesByPath = new Map();
	if (existsSync(manifestsRoot)) {
		assertSafeDirectoryChain(repoRoot, 'docs/releases/manifests');
		const names = readDirectoryNamesBounded(
			manifestsRoot,
			MAX_RELEASE_MANIFEST_SCAN,
			'release manifest',
		)
			.filter(
				(name) =>
					name !== path.basename(HISTORICAL_REPLAY_STATE) &&
					name.toLowerCase().endsWith('.json'),
			)
			.sort();
		for (const name of names) {
			const absolute = path.resolve(manifestsRoot, name);
			const stat = lstatSync(absolute);
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.size > MAX_RELEASE_MANIFEST_BYTES
			) {
				throw new Error('unsafe or oversized release manifest: ' + name);
			}
			const manifest = JSON.parse(readFileSync(absolute, 'utf8'));
			if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.fragments)) {
				throw new Error('malformed release manifest: ' + name);
			}
			if (manifest.fragments.length > MAX_FRAGMENT_ENTRIES) {
				throw new Error('release manifest fragment entry cap exceeded: ' + name);
			}
			for (const fragment of manifest.fragments) {
				const { normalized } = containedPendingPath(repoRoot, fragment?.path ?? '');
				if (!/^[0-9a-f]{64}$/.test(fragment?.sha256 ?? '')) {
					throw new Error('malformed fragment hash in release manifest: ' + name);
				}
				const hashes = consumedHashesByPath.get(normalized) ?? new Set();
				hashes.add(fragment.sha256);
				consumedHashesByPath.set(normalized, hashes);
			}
		}
	}
	const consumedPending = [];
	for (const item of pending) {
		if (!item.regular) continue;
		const hashes = consumedHashesByPath.get(item.relativePath);
		if (hashes && hashes.has(sha256(readBoundedFragmentBytes(repoRoot, item.relativePath)))) {
			consumedPending.push(item.relativePath);
		}
	}
	let activeHistoricalReplay = false;
	let staleHistoricalReplay = false;
	const replayStatePath = safeRepositoryFilePath(repoRoot, HISTORICAL_REPLAY_STATE);
	if (existsSync(replayStatePath)) {
		const stateStat = lstatSync(replayStatePath);
		if (stateStat.size > MAX_CLEANUP_PLAN_BYTES) {
			throw new Error('historical replay state size cap exceeded');
		}
		const state = JSON.parse(readFileSync(replayStatePath, 'utf8'));
		if (
			state?.schemaVersion !== 1 ||
			typeof state.tagName !== 'string' ||
			typeof state.expiresAt !== 'string'
		) {
			throw new Error('historical replay state is malformed');
		}
		const authorization = validateHistoricalReplayProof(state.replay, state.tagName);
		if (!authorization?.hasMoreWork) {
			throw new Error('historical replay state does not authorize more work');
		}
		const expiresAt = Date.parse(state.expiresAt);
		if (!Number.isFinite(expiresAt)) {
			throw new Error('historical replay state expiry is malformed');
		}
		if (expiresAt <= nowMs) staleHistoricalReplay = true;
		else activeHistoricalReplay = true;
	}
	const countViolation =
		pending.length > maxPendingFragments && !activeHistoricalReplay;
	return {
		pending: pending.length,
		limit: maxPendingFragments,
		consumedPending,
		violation:
			countViolation || consumedPending.length > 0 || staleHistoricalReplay,
		diagnostics: [
			'retention: ' +
				pending.length +
				' pending fragment(s), limit ' +
				maxPendingFragments,
			...(consumedPending.length > 0
				? [
						'retention: ' +
							consumedPending.length +
							' byte-identical consumed fragment(s) remain pending',
					]
				: []),
			...(activeHistoricalReplay
				? ['retention: authorized historical replay remains in progress']
				: []),
			...(staleHistoricalReplay
				? ['retention: historical replay authorization expired before completion']
				: []),
		],
	};
}

async function readOptional(io, relativePath) {
	try {
		return await io.readText(relativePath);
	} catch (error) {
		if (error?.code === 'ENOENT') return null;
		throw error;
	}
}

/**
 * Reconcile exact tagged-release provenance with a current repository checkout.
 * The caller proves remote/local/HEAD tag equality and passes the canonical
 * commit value. This boundary is dry-run unless dryRun is explicitly false.
 */
export async function reconcileTaggedRelease(options) {
	const {
		repoRoot,
		tagName,
		release,
		tagCommit,
		entries = [],
		dryRun = true,
		historicalReplay = null,
		maxPendingFragments = MAX_PENDING_FRAGMENT_RETENTION,
		nowMs = Date.now(),
		log = () => {},
	} = options ?? {};
	if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
		throw new Error('repoRoot is required');
	}
	const match = RELEASE_TAG_RE.exec(tagName ?? '');
	if (!match) throw new Error('invalid release tag: ' + (tagName ?? ''));
	if (!release || release.tagName !== tagName) {
		throw new Error(
			'release tag mismatch: requested ' +
				tagName +
				', received ' +
				(release?.tagName ?? 'missing'),
		);
	}
	if (typeof tagCommit !== 'string' || tagCommit.length === 0) {
		throw new Error('canonical tag commit is required');
	}
	if (typeof release.body !== 'string') throw new Error('release body is required');
	if (!Array.isArray(entries)) throw new Error('entries must be an array');
	if (entries.length > MAX_FRAGMENT_ENTRIES) {
		throw new Error('consumed fragment entry cap exceeded');
	}
	if (!Number.isInteger(maxPendingFragments) || maxPendingFragments < 0) {
		throw new Error('maxPendingFragments must be a non-negative integer');
	}
	const replayAuthorization = validateHistoricalReplayProof(
		historicalReplay,
		tagName,
	);

	const io = { ...defaultReconciliationIo(repoRoot), ...(options.io ?? {}) };
	const pending = listPendingFragmentState(repoRoot);
	const entryByPath = new Map();
	for (const entry of entries) {
		if (
			!entry ||
			(!Number.isInteger(entry.prNumber) && !Number.isInteger(entry.order)) ||
			typeof entry.filePath !== 'string' ||
			typeof entry.content !== 'string'
		) {
			throw new Error('malformed consumed fragment entry');
		}
		if (Buffer.byteLength(entry.content, 'utf8') > MAX_FRAGMENT_BYTES) {
			throw new Error('consumed fragment content size cap exceeded: ' + entry.filePath);
		}
		const { normalized } = containedPendingPath(repoRoot, entry.filePath);
		const contentSha256 = entry.contentSha256 ?? sha256(entry.content);
		if (!/^[0-9a-f]{64}$/.test(contentSha256)) {
			throw new Error('malformed consumed fragment hash: ' + normalized);
		}
		if (contentSha256 !== sha256(entry.content)) {
			throw new Error(
				'consumed fragment hash does not match UTF-8 content: ' + normalized,
			);
		}
		const previous = entryByPath.get(normalized);
		if (
			previous &&
			(previous.content !== entry.content ||
				previous.contentSha256 !== contentSha256)
		) {
			throw new Error('ambiguous consumed fragment content: ' + normalized);
		}
		if (!previous) {
			entryByPath.set(normalized, {
				...entry,
				filePath: normalized,
				contentSha256,
			});
		}
	}

	const eligible = new Set();
	const retained = [];
	for (const item of pending) {
		const consumed = entryByPath.get(item.relativePath);
		if (!consumed || !item.regular) {
			retained.push(item.relativePath);
			continue;
		}
		const current = await io.readBytes(item.relativePath);
		if (sha256(current) === consumed.contentSha256) eligible.add(item.relativePath);
		else retained.push(item.relativePath);
	}
	const projectedPending = pending.length - eligible.size;
	const retention = {
		limit: maxPendingFragments,
		current: pending.length,
		projected: projectedPending,
		violation: projectedPending > maxPendingFragments,
		authorizedIntermediate:
			projectedPending > maxPendingFragments &&
			replayAuthorization?.hasMoreWork === true,
	};
	const diagnostics = [
		'retention: projected ' +
			projectedPending +
			' pending fragment(s), limit ' +
			maxPendingFragments,
	];
	if (retention.violation && !retention.authorizedIntermediate) {
		diagnostics.push(
			'retention policy violation: a non-final historical replay batch is required',
		);
		for (const message of diagnostics) log(message);
		return {
			tagName,
			version: match[1],
			consumedFragments: [...entryByPath.keys()],
			deleted: [],
			retained,
			diagnostics,
			retention,
		};
	}

	const markerStarts = countLiteral(release.body, MARKER_START);
	const markerEnds = countLiteral(release.body, MARKER_END);
	const markerShapeValid =
		entryByPath.size === 0
			? markerStarts === markerEnds && markerStarts <= 1
			: markerStarts === 1 && markerEnds === 1;
	if (!markerShapeValid) {
		throw new Error('release body has an invalid custom release-notes block');
	}
	if (entryByPath.size === 0 && hasNonEmptyCustomReleaseNotesBlock(release.body)) {
		throw new Error(
			'published custom release-notes block is non-empty but consumed-fragment provenance is empty',
		);
	}
	if (entryByPath.size > 0 && !publishedBlockMatchesEntries(release.body, entries)) {
		throw new Error('published custom release-notes block does not match consumed fragments');
	}

	const version = match[1];
	const historyPath = 'docs/releases/v' + version + '.md';
	const manifestPath = 'docs/releases/manifests/v' + version + '.json';
	const manifest = {
		schemaVersion: 1,
		tag: tagName,
		tagCommit,
		targetCommitish: release.targetCommitish ?? null,
		releaseBodySha256: sha256(release.body),
		fragments: [...entryByPath.values()]
			.sort((a, b) => a.filePath.localeCompare(b.filePath))
			.map((entry) => ({
				prNumber: Number.isInteger(entry.prNumber) ? entry.prNumber : null,
				...(Number.isInteger(entry.order) ? { order: entry.order } : {}),
				path: entry.filePath,
				sha256: entry.contentSha256,
			})),
	};
	const manifestText = JSON.stringify(manifest, null, 2) + '\n';
	for (const [relativePath, expected] of [
		[historyPath, release.body],
		[manifestPath, manifestText],
	]) {
		const current = await readOptional(io, relativePath);
		if (current !== null && current !== expected) {
			throw new Error('refusing to overwrite conflicting release history: ' + relativePath);
		}
	}

	const deleted = [];
	if (!dryRun) {
		if ((await readOptional(io, historyPath)) === null) {
			await io.writeText(historyPath, release.body);
		}
		if ((await readOptional(io, manifestPath)) === null) {
			await io.writeText(manifestPath, manifestText);
		}
		for (const relativePath of [...eligible].sort()) {
			const { absolute } = containedPendingPath(repoRoot, relativePath);
			let stat;
			try {
				stat = lstatSync(absolute);
			} catch (error) {
				if (error?.code === 'ENOENT') continue;
				throw error;
			}
			const consumed = entryByPath.get(relativePath);
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				sha256(await io.readBytes(relativePath)) !== consumed.contentSha256
			) {
				retained.push(relativePath);
				diagnostics.push(
					'retention: fragment changed during apply and was retained: ' +
						relativePath,
				);
				continue;
			}
			await io.removePath(relativePath);
			deleted.push(relativePath);
			log('deleted consumed fragment ' + relativePath);
		}
		if (replayAuthorization?.hasMoreWork) {
			const expiresAt = new Date(nowMs + HISTORICAL_REPLAY_TTL_MS).toISOString();
			await io.writeText(
				HISTORICAL_REPLAY_STATE,
				JSON.stringify(
					{
						schemaVersion: 1,
						tagName,
						expiresAt,
						replay: historicalReplay,
					},
					null,
					2,
				) + '\n',
			);
		} else if (historicalReplay !== null) {
			await io.removePath(HISTORICAL_REPLAY_STATE);
		}
	}
	for (const message of diagnostics) log(message);
	return {
		tagName,
		version,
		historyPath,
		manifestPath,
		consumedFragments: [...entryByPath.keys()],
		deleted,
		retained,
		diagnostics,
		retention,
	};
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
const GIT_TIMEOUT_MS = 15_000;
const SUBPROCESS_MAX_BUFFER = 16 * 1024 * 1024;

function ghJson(args, cwd = resolveRepoRoot()) {
	const raw = execFileSync('gh', args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: SUBPROCESS_MAX_BUFFER,
		timeout: GH_TIMEOUT_MS,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return JSON.parse(raw);
}

function ghText(args, cwd = resolveRepoRoot()) {
	return execFileSync('gh', args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: SUBPROCESS_MAX_BUFFER,
		timeout: GH_TIMEOUT_MS,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

function ghInput(args, input, cwd = resolveRepoRoot()) {
	return execFileSync('gh', args, {
		cwd,
		input,
		encoding: 'utf8',
		maxBuffer: SUBPROCESS_MAX_BUFFER,
		timeout: GH_TIMEOUT_MS,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
}

function gitText(args, cwd = resolveRepoRoot()) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: SUBPROCESS_MAX_BUFFER,
		timeout: GIT_TIMEOUT_MS,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
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
 * Validate a candidate PR number from an API response.
 *
 * Guards against garbage values (NaN, zero, negative, excessively large)
 * that could slip through from malformed API responses.
 *
 * Exported for unit tests. Pure — no I/O, no side effects.
 *
 * @param {*} n — candidate number (may be any type from JSON)
 * @returns {boolean} — true if n is a valid PR number
 */
export function isValidPrNumber(n) {
	return (
		Number.isInteger(n) &&
		n > 0 &&
		n < 10 ** MAX_PR_DIGITS
	);
}

/**
 * From a flat array of candidate PR objects (e.g. the .flat()-ed result of a
 * `gh api --slurp` response), return the valid PR numbers in first-seen order,
 * skipping null/non-object/invalid entries. Pure — no I/O. Exported for tests.
 *
 * Defense-in-depth: a malformed API response containing null or non-object
 * slots must never throw here (which would crash the release-notes job and
 * discard already-extracted direct candidates — see resolveAllCandidates).
 * @param {unknown[]} prs
 * @returns {number[]}
 */
export function selectValidPrNumbers(prs) {
	if (!Array.isArray(prs)) return [];
	const seen = new Set();
	const out = [];
	for (const pr of prs) {
		if (pr && typeof pr === 'object' && isValidPrNumber(pr.number) && !seen.has(pr.number)) {
			seen.add(pr.number);
			out.push(pr.number);
		}
	}
	return out;
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
 * - `--paginate --slurp` is passed to `gh api` so that commits associated
 *   with more than 30 PRs (e.g. heavily cherry-picked base commits) are not
 *   silently truncated to the first page. `--slurp` wraps each page into an
 *   outer JSON array (`[[...page1],[...page2]]`), which `.flat()` unwraps into
 *   a single PR-object array; without `--slurp`, `JSON.parse()` would fail
 *   on the multiple-array output from `--paginate`.
 *
 * Returns a deduplicated array of PR numbers in first-seen order.
 */
function resolveCommitShasToPrNumbers(shas, log, requireComplete = false) {
	if (!Array.isArray(shas) || shas.length === 0) return [];
	const repoSlug = process.env.GITHUB_REPOSITORY;
	if (!repoSlug) {
		if (requireComplete) {
			throw new Error(
				'incomplete release provenance: GITHUB_REPOSITORY is required for commit SHA resolution',
			);
		}
		log('GITHUB_REPOSITORY not set — cannot resolve commit SHAs to PR numbers');
		return [];
	}
	const seen = new Set();
	const out = [];
	for (const sha of shas) {
		const res = tryGhJson(['api', '--paginate', '--slurp', `repos/${repoSlug}/commits/${sha}/pulls`]);
		if (!res.ok || !Array.isArray(res.value)) {
			if (requireComplete) {
				throw new Error(
					'incomplete release provenance: failed to resolve commit SHA ' + sha,
				);
			}
			log(`skip SHA ${sha.slice(0, 7)} — API lookup failed`);
			continue;
		}
		// With --slurp, gh api returns an array of pages: [[...page1], [...page2]].
		// Flatten into a single array of PR objects.
		const prs = res.value.flat();
		if (prs.length === 0) {
			log(`SHA ${sha.slice(0, 7)} — no associated PRs found`);
			continue;
		}
		const validNums = selectValidPrNumbers(prs);
		if (validNums.length > 1) {
			log(`SHA ${sha.slice(0, 7)} — resolves to ${validNums.length} PRs: ${validNums.map((n) => `#${n}`).join(', ')}`);
		}
		for (const n of validNums) {
			if (!seen.has(n)) {
				seen.add(n);
				out.push(n);
			}
		}
	}
	return out;
}

/**
 * Extract and resolve all PR candidates from a release body.
 *
 * Shared by modeUpdatePr and modeUpdateRelease. Runs the direct
 * PR-number extractor first, then falls back to commit-SHA resolution,
 * and merges both result sets (deduped, first-seen order).
 *
 * Exported for unit tests. The only I/O is in `resolveCommitShasToPrNumbers`
 * (when commit SHAs are present); the rest is pure.
 *
 * @param {string} strippedBody — body with custom-release-notes block stripped
 * @param {(msg: string) => void} log — logger function
 * @returns {number[]} — merged array of PR numbers
 */
const MAX_CHANGELOG_FALLBACK_BYTES = 2 * 1024 * 1024;
const MAX_FALLBACK_CANDIDATES = 50;

export function resolveAllCandidates(strippedBody, log, options = {}) {
	const { requireComplete = false } = options;
	const directCandidates = extractCandidatePrNumbers(strippedBody);
	if (directCandidates.length > MAX_RELEASE_CANDIDATES) {
		throw new Error('release candidate PR cap exceeded');
	}
	log(`found ${directCandidates.length} direct PR ref(s) in body`);

	const commitShas = extractCommitShasFromBody(strippedBody);
	if (commitShas.length > MAX_RELEASE_CANDIDATES) {
		throw new Error('release commit SHA candidate cap exceeded');
	}
	log(`found ${commitShas.length} commit SHA(s) in body`);
	let shaResolved = [];
	if (commitShas.length > 0) {
		try {
			shaResolved = resolveCommitShasToPrNumbers(
				commitShas,
				log,
				requireComplete,
			);
		} catch (err) {
			if (requireComplete) throw err;
			log(`commit-SHA resolution failed unexpectedly — continuing with direct candidates only: ${err instanceof Error ? err.message : String(err)}`);
			shaResolved = [];
		}
	}
	log(`resolved ${shaResolved.length} PR number(s) from commit SHAs`);

	return mergeCandidateLists(directCandidates, shaResolved);
}

/**
 * Read a fragment from the workspace if it exists, otherwise null.
 * Paths are normalized to forward-slash form. The script always runs from
 * the repo root in CI; we resolve relative to the repo root computed from
 * this script's own location for local invocations.
 */
export function readFragmentFromWorkspace(repoRoot, filePath) {
	assertSafeDirectoryChain(repoRoot, FRAGMENT_DIR);
	const { absolute: abs } = containedPendingPath(repoRoot, filePath);
	if (!existsSync(abs)) return null;
	const stat = lstatSync(abs);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error('unsafe release fragment: ' + filePath);
	}
	if (stat.size > MAX_FRAGMENT_BYTES) {
		throw new Error('release fragment size cap exceeded: ' + filePath);
	}
	const bytes = readBoundedFragmentBytes(repoRoot, filePath);
	return {
		content: decodeFragmentBytes(bytes, filePath),
		contentSha256: sha256(bytes),
	};
}

/**
 * Repo root resolution: this script lives at `<repoRoot>/scripts/`.
 */
function resolveRepoRoot() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, '..');
}

/**
 * Extract the CHANGELOG.md section for a specific version.
 *
 * Section headings look like:
 *   ## [7.146.1](https://github.com/owner/repo/compare/v7.146.0...v7.146.1) (2026-08-24)
 *
 * The match is a prefix scan for `## [<version>]` with the closing bracket
 * immediately after the version, so 7.146.1 never matches a 7.146.10 heading.
 * Returns the heading line plus every line up to (excluding) the next
 * `## [` heading, or null when the version has no section (e.g. a degenerate
 * meta-only release that never added a changelog entry).
 *
 * Pure — no I/O. Exported for unit tests. Used by modeUpdateRelease as the
 * fallback candidate source when the release body itself has no PR/commit
 * references (observed on releases cut with an empty body, e.g. v7.146.1).
 */
export function extractChangelogSection(changelog, version) {
	if (typeof changelog !== 'string' || typeof version !== 'string' || version.length === 0) {
		return null;
	}
	const prefix = `## [${version}]`;
	const lines = changelog.split('\n');
	const startIdx = lines.findIndex((line) => line.startsWith(prefix));
	if (startIdx === -1) return null;
	const out = [lines[startIdx]];
	for (let i = startIdx + 1; i < lines.length; i++) {
		if (lines[i].startsWith('## [')) break;
		out.push(lines[i]);
	}
	return out.join('\n');
}

/**
 * Edit a PR body, then settle-verify that the custom-release-notes block
 * survived an external rewrite race.
 *
 * Third-party bots (observed: the cubic PR-description bot on release PR
 * #2331 — injected body wiped 7s after our edit) can rewrite the PR body
 * right after this script edits it. After EVERY attempt — including a
 * no-op attempt where the body already carried the block — we wait
 * `delayMs`, re-fetch the body, and if the marker block is gone, run a
 * FULL fresh attempt (re-reading the body and re-extracting candidates
 * from it, never reusing the prior attempt's stale combined notes).
 *
 * All I/O is injected (`fetchBody`, `applyEdit`, `sleep`) so unit tests
 * exercise the race without mocking the `gh` subprocess. `runAttempt`
 * performs one read-extract-upsert-edit pass and returns
 * `{ body, blockExpected }`. When an attempt legitimately produces no
 * block (zero candidates or zero pending fragments — nothing to inject),
 * `blockExpected` is false and the loop exits immediately without
 * settle-verifying: an absent block is the intended outcome, not an
 * external rewrite, so no false warning is emitted and no settle delay
 * is paid.
 *
 * Returns true when the final observed body contains the marker block (or
 * no block was expected).
 */
export async function verifyBlockSurvived(opts) {
	const {
		runAttempt,
		fetchBody,
		applyEdit,
		sleep,
		delayMs,
		maxAttempts = 2,
		log = () => {},
	} = opts;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const result = await runAttempt({ attempt, fetchBody, applyEdit, log });
		const blockExpected =
			typeof result === 'string' ? true : result?.blockExpected !== false;
		if (!blockExpected) {
			log('no fragments to inject — skipping settle-verify (absent block is expected)');
			return true;
		}
		if (delayMs > 0) await sleep(delayMs);
		const settled = await fetchBody();
		if (settled.includes(MARKER_START) && settled.includes(MARKER_END)) {
			if (attempt > 1) log(`marker block survived after attempt ${attempt}`);
			return true;
		}
		log(`marker block vanished after attempt ${attempt} (external rewrite suspected)`);
		if (attempt < maxAttempts) {
			log('re-running a full attempt against the freshly-fetched body');
		}
	}
	log(
		`::warning::custom-release-notes block did not survive ${maxAttempts} attempt(s) — external body rewriter may have clobbered it`,
	);
	return false;
}

/**
 * Collect fragments for the given candidate PR numbers.
 * Each PR is verified (skips issues / 404s), its file list is fetched,
 * pending fragments are filtered, and contents are read from the
 * workspace. Returns the `entries` array shape expected by
 * `combineFragments`.
 */
export function collectFragmentsForPrs(
	candidates,
	repoRoot,
	log,
	options = {},
) {
	if (!Array.isArray(candidates) || candidates.length > MAX_RELEASE_CANDIDATES) {
		throw new Error('release candidate PR cap exceeded');
	}
	const {
		requireComplete = false,
		verifyCandidate = verifyPr,
		readFragment = readFragmentFromWorkspace,
	} = options;
	const entries = [];
	const seenPaths = new Set();
	for (const num of candidates) {
		const pr = verifyCandidate(num);
		if (pr?.kind === 'non-pr') {
			log(`skip #${num} — reference is an issue, not a PR`);
			continue;
		}
		if (!pr || !Array.isArray(pr.files)) {
			if (requireComplete) {
				throw new Error(
					'incomplete release provenance: failed to resolve candidate PR #' + num,
				);
			}
			log(`skip #${num} — not a PR or no files`);
			continue;
		}
		const fragPaths = filterPendingFragmentPaths(pr.files);
		if (fragPaths.length > MAX_FRAGMENT_ENTRIES) {
			throw new Error('release fragment entry cap exceeded for #' + num);
		}
		if (fragPaths.length === 0) continue;
		for (const fp of fragPaths) {
			if (seenPaths.has(fp)) continue;
			seenPaths.add(fp);
			const fragment = readFragment(repoRoot, fp);
			if (fragment === null) {
				if (requireComplete) {
					throw new Error(
						'incomplete release provenance: fragment referenced by #' +
							num +
							' is unavailable: ' +
							fp,
					);
				}
				log(`fragment ${fp} referenced by #${num} not found in workspace`);
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

export function verifyProvenanceCandidate(num) {
	const pr = tryGhJson(['pr', 'view', String(num), '--json', 'number,files']);
	if (pr.ok) return pr.value;
	const repoSlug = requireRepoSlug();
	const issue = tryGhJson(['api', `repos/${repoSlug}/issues/${num}`]);
	if (issue.ok && !issue.value?.pull_request) return { kind: 'non-pr' };
	throw new Error(
		'incomplete release provenance: failed to classify candidate #' + num,
	);
}

/**
 * Decide the CHANGELOG-fallback outcome for a release whose body yielded no
 * PR candidates. I/O is injected (readChangelog / statChangelog /
 * resolveCandidates) so unit tests cover every exit branch:
 *   - section missing or CHANGELOG unreadable/oversized -> exit 0 (degenerate
 *     release; warn), candidates []
 *   - section present but zero candidates               -> exit 1 (advisory
 *     loud failure; warn), candidates []
 *   - candidates found                                   -> exit 0, candidates
 *     clamped to MAX_FALLBACK_CANDIDATES
 */
export async function decideChangelogFallback(opts) {
	const {
		tagName,
		repoRoot,
		readChangelog,
		statChangelog,
		resolveCandidates,
		log,
	} = opts;
	log('Release body has no PR references — falling back to the CHANGELOG section for this version');
	const version = tagName.startsWith('v') ? tagName.slice(1) : tagName;
	const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
	let section = null;
	try {
		const stat = statChangelog(changelogPath);
		if (stat.size > MAX_CHANGELOG_FALLBACK_BYTES) {
			log(`CHANGELOG.md exceeds the ${MAX_CHANGELOG_FALLBACK_BYTES}-byte fallback cap (${stat.size} bytes) — refusing the unbounded read`);
		} else {
			section = extractChangelogSection(readChangelog(changelogPath), version);
		}
	} catch {
		log(`CHANGELOG.md not found in workspace (${changelogPath}) — no fallback available`);
	}
	if (section === null) {
		log(`::warning::no PR refs in release body and no CHANGELOG section for ${version} — release stays bare`);
		// Degenerate release (no changelog entry at all): legitimate.
		return { exitCode: 0, candidates: [] };
	}
	const resolved = resolveCandidates(section, log);
	if (resolved.length > MAX_FALLBACK_CANDIDATES) {
		log(`clamping CHANGELOG-fallback candidates from ${resolved.length} to ${MAX_FALLBACK_CANDIDATES}`);
	}
	const candidates = resolved.slice(0, MAX_FALLBACK_CANDIDATES);
	if (candidates.length === 0) {
		log(`::warning::CHANGELOG section for ${version} exists but yielded no PR candidates — refusing to fail silently`);
		// Advisory loud failure. Deliberately does NOT gate publish-npm
		// (that job needs only release-please); this reddens the workflow
		// run so a bare release is visible instead of silently green.
		return { exitCode: 1, candidates: [] };
	}
	return { exitCode: 0, candidates };
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
		'number',
		'--limit',
		'5',
	]);
	if (!prList.ok || !Array.isArray(prList.value) || prList.value.length === 0) {
		log('No autorelease PR found — exiting 0');
		return 0;
	}
	const releasePr = prList.value[0];
	const settleDelayMs = Number.parseInt(
		process.env.FRAGMENT_SETTLE_DELAY_MS ?? '45000',
		10,
	);

	// One read-extract-upsert-edit pass over the CURRENT body. Always
	// re-fetches so a retry after an external rewrite re-extracts candidates
	// from the fresh body instead of reusing stale combined notes.
	const runAttempt = async ({ fetchBody, applyEdit, log: attemptLog }) => {
		const body = (await fetchBody()) ?? '';
		const strippedBody = stripCustomReleaseNotesBlock(body);
		const allCandidates = resolveAllCandidates(strippedBody, attemptLog);
		if (allCandidates.length === 0) {
			attemptLog('Release PR body has no PR references (direct or via commit SHAs) — nothing to inject');
			return { body, blockExpected: false };
		}
		attemptLog(`collecting fragments for ${allCandidates.length} candidate PR(s): ${allCandidates.map((n) => `#${n}`).join(', ')}`);
		const entries = collectFragmentsForPrs(allCandidates, repoRoot, attemptLog);
		if (entries.length === 0) {
			attemptLog('No pending fragments found across referenced PRs');
			return { body, blockExpected: false };
		}
		const combined = combineFragments(entries);
		const newBody = upsertReleaseNotesBlock(body, combined);
		if (newBody !== body) {
			await applyEdit(newBody);
			attemptLog(`Updated release PR #${releasePr.number} with ${entries.length} fragment(s)`);
			return { body: newBody, blockExpected: true };
		}
		attemptLog('Release PR body already up to date');
		return { body, blockExpected: true };
	};

	const fetchBody = async () => {
		const res = tryGhJson([
			'pr',
			'view',
			String(releasePr.number),
			'--json',
			'body',
		]);
		return res.ok ? (res.value?.body ?? '') : '';
	};
	const applyEdit = async (newBody) => {
		ghInput(['pr', 'edit', String(releasePr.number), '--body-file', '-'], newBody);
	};

	await verifyBlockSurvived({
		runAttempt,
		fetchBody,
		applyEdit,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		delayMs: Number.isFinite(settleDelayMs) && settleDelayMs >= 0 ? settleDelayMs : 45_000,
		log,
	});
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

	// Extract direct PR refs and resolve commit-SHA links, then merge.
	let allCandidates = resolveAllCandidates(strippedBody, log);

	// Fallback: release-please has been observed to create releases with an
	// EMPTY body (e.g. v7.146.1, v7.145.1). The tag workspace's CHANGELOG.md
	// always carries the version section with /commit/<40-hex> links, so it
	// is a reliable secondary candidate source. Unlike the release PR body,
	// the GitHub Release body has no regenerator — without this fallback the
	// release would stay bare forever.
	if (allCandidates.length === 0) {
		const decision = await decideChangelogFallback({
			tagName,
			repoRoot,
			readChangelog: (p) => readFileSync(p, 'utf8'),
			statChangelog: (p) => statSync(p),
			resolveCandidates: (section, log2) => resolveAllCandidates(section, log2),
			log,
		});
		if (decision.exitCode !== 0) {
			return decision.exitCode;
		}
		allCandidates = decision.candidates;
		if (allCandidates.length > 0) {
			log(`resolved ${allCandidates.length} candidate PR(s) from the CHANGELOG fallback`);
		}
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
	ghInput(['release', 'edit', tagName, '--notes-file', '-'], newBody);
	log(`Updated release ${tagName} with ${entries.length} fragment(s)`);
	return 0;
}

const MAX_TAG_PEEL_DEPTH = 5;
const MAX_CLEANUP_PLAN_BYTES = 16 * 1024 * 1024;
export const MAX_HISTORICAL_TAGS = 1_000;
export const MAX_HISTORICAL_BATCH_SIZE = 25;

function parseModeFlags(args) {
	const flags = {
		apply: false,
		tag: null,
		out: null,
		plan: null,
		tagsFile: null,
		cursor: null,
		batchSize: null,
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--apply') {
			flags.apply = true;
			continue;
		}
		if (
			arg === '--tag' ||
			arg === '--out' ||
			arg === '--plan' ||
			arg === '--tags-file' ||
			arg === '--cursor' ||
			arg === '--historical-batch' ||
			arg === '--batch-size'
		) {
			const value = args[index + 1];
			if (!value || value.startsWith('--')) {
				throw new Error(arg + ' requires a value');
			}
			const key = arg
				.slice(2)
				.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
			flags[key] = value;
			index += 1;
			continue;
		}
		throw new Error('unknown option: ' + arg);
	}
	return flags;
}

/**
 * Select one bounded, resumable historical replay batch. The caller owns the
 * oldest-to-newest tag ordering; cursors bind an offset to that list's digest.
 * A non-null nextCursor is the explicit signal that retention may remain above
 * policy until another batch is processed.
 */
export function createHistoricalReplayBatch(
	tags,
	cursor = '0',
	batchSize = MAX_HISTORICAL_BATCH_SIZE,
) {
	if (!Array.isArray(tags) || tags.length === 0) {
		throw new Error('historical tags must be a non-empty array');
	}
	if (tags.length > MAX_HISTORICAL_TAGS) {
		throw new Error(
			'historical tag hard cap exceeded: ' +
				tags.length +
				' > ' +
				MAX_HISTORICAL_TAGS,
		);
	}
	if (
		!Number.isInteger(batchSize) ||
		batchSize < 1 ||
		batchSize > MAX_HISTORICAL_BATCH_SIZE
	) {
		throw new Error(
			'historical batch size must be between 1 and ' +
				MAX_HISTORICAL_BATCH_SIZE,
		);
	}
	const seen = new Set();
	for (const tag of tags) {
		if (typeof tag !== 'string' || !RELEASE_TAG_RE.test(tag)) {
			throw new Error('invalid historical release tag: ' + String(tag));
		}
		if (seen.has(tag)) throw new Error('duplicate historical release tag: ' + tag);
		seen.add(tag);
	}
	const tagListDigest = sha256(JSON.stringify(tags));
	let start = 0;
	if (cursor !== '0') {
		const match = /^([0-9a-f]{64}):(0|[1-9]\d*)$/.exec(cursor ?? '');
		if (!match) {
			throw new Error('historical cursor is malformed');
		}
		if (match[1] !== tagListDigest) {
			throw new Error('historical cursor does not match the ordered tag list');
		}
		start = Number(match[2]);
	}
	if (!Number.isSafeInteger(start) || start > tags.length) {
		throw new Error('historical cursor is outside the tag list');
	}
	const end = Math.min(start + batchSize, tags.length);
	const boundCursor = tagListDigest + ':' + start;
	return {
		schemaVersion: 1,
		cursor: boundCursor,
		tagListDigest,
		orderedTags: [...tags],
		tags: tags.slice(start, end),
		nextCursor: end < tags.length ? tagListDigest + ':' + end : null,
		complete: end === tags.length,
	};
}

/**
 * Validate that retention authorization is a coherent batch emitted by
 * createHistoricalReplayBatch, not a standalone cursor-shaped string.
 */
export function validateHistoricalReplayProof(replay, tagName) {
	if (replay === null || replay === undefined) return null;
	if (
		replay.schemaVersion !== 1 ||
		!Array.isArray(replay.tags) ||
		replay.tags.length === 0 ||
		replay.tags.length > MAX_HISTORICAL_BATCH_SIZE ||
		!replay.tags.includes(tagName) ||
		!Array.isArray(replay.orderedTags) ||
		replay.orderedTags.length === 0 ||
		replay.orderedTags.length > MAX_HISTORICAL_TAGS ||
		new Set(replay.orderedTags).size !== replay.orderedTags.length ||
		replay.orderedTags.some(
			(tag) => typeof tag !== 'string' || !RELEASE_TAG_RE.test(tag),
		) ||
		typeof replay.complete !== 'boolean' ||
		!/^[0-9a-f]{64}$/.test(replay.tagListDigest ?? '')
	) {
		throw new Error('historical replay proof is malformed');
	}
	const cursorMatch = /^([0-9a-f]{64}):(0|[1-9]\d*)$/.exec(
		replay.cursor ?? '',
	);
	const nextMatch =
		replay.nextCursor === null
			? null
			: /^([0-9a-f]{64}):(0|[1-9]\d*)$/.exec(replay.nextCursor ?? '');
	const start = Number(cursorMatch?.[2]);
	const end = start + replay.tags.length;
	if (
		!cursorMatch ||
		cursorMatch[1] !== replay.tagListDigest ||
		sha256(JSON.stringify(replay.orderedTags)) !== replay.tagListDigest ||
		(replay.complete
			? replay.nextCursor !== null || end !== replay.orderedTags.length
			: !nextMatch ||
				nextMatch[1] !== replay.tagListDigest ||
				Number(nextMatch[2]) !== end ||
				end >= replay.orderedTags.length) ||
		JSON.stringify(replay.tags) !==
			JSON.stringify(replay.orderedTags.slice(start, end))
	) {
		throw new Error('historical replay proof is not a contiguous batch');
	}
	const tagIndex = replay.tags.indexOf(tagName);
	return {
		nextCursor: replay.nextCursor,
		hasMoreWork: tagIndex < replay.tags.length - 1 || replay.nextCursor !== null,
	};
}

function requireRepoSlug() {
	const repoSlug = process.env.GITHUB_REPOSITORY;
	if (!repoSlug || !/^[^/\s]+\/[^/\s]+$/.test(repoSlug)) {
		throw new Error('GITHUB_REPOSITORY must be set to owner/repository');
	}
	return repoSlug;
}

export function peelRemoteTagObject(repoSlug, tagName, getJson = ghJson) {
	let object = getJson([
		'api',
		'repos/' + repoSlug + '/git/ref/tags/' + encodeURIComponent(tagName),
	]).object;
	for (let depth = 0; depth <= MAX_TAG_PEEL_DEPTH; depth += 1) {
		if (!object || typeof object.sha !== 'string') {
			throw new Error('remote tag object is malformed');
		}
		if (object.type === 'commit') return object.sha;
		if (object.type !== 'tag' || depth === MAX_TAG_PEEL_DEPTH) {
			throw new Error('remote tag did not peel to a commit within the depth cap');
		}
		object = getJson(['api', 'repos/' + repoSlug + '/git/tags/' + object.sha]).object;
	}
	throw new Error('remote tag peel failed');
}

export function validateExactTagProof(remoteCommit, localCommit, headCommit) {
	if (
		typeof remoteCommit !== 'string' ||
		remoteCommit.length === 0 ||
		remoteCommit !== localCommit ||
		localCommit !== headCommit
	) {
		throw new Error(
			'exact tag proof failed: remote=' +
				(remoteCommit ?? 'missing') +
				' local=' +
				(localCommit ?? 'missing') +
				' HEAD=' +
				(headCommit ?? 'missing'),
		);
	}
	return remoteCommit;
}

export async function resolveReleaseEntries(
	tagName,
	releaseBody,
	repoRoot,
	log,
	options = {},
) {
	const {
		readChangelog = (filePath) => readFileSync(filePath, 'utf8'),
		statChangelog = (filePath) => statSync(filePath),
		readFragment = readFragmentFromWorkspace,
		listFragments = listPendingFragmentState,
		verifyCandidate = verifyProvenanceCandidate,
	} = options;
	const payload = customReleaseNotesPayload(releaseBody);
	if (payload) {
		try {
			const markerCandidates = resolveAllCandidates(payload, log);
			const markerEntries = collectFragmentsForPrs(
				markerCandidates,
				repoRoot,
				log,
				{ readFragment, verifyCandidate },
			);
			const exactMarkerEntries = selectEntriesForPublishedBlock(
				markerEntries,
				releaseBody,
			);
			if (exactMarkerEntries?.length > 0) return exactMarkerEntries;
		} catch (error) {
			log(
				'marker-derived provenance did not resolve exactly: ' +
					(error instanceof Error ? error.message : String(error)),
			);
		}
		try {
			return reconstructPublishedBlockFromWorkspace(repoRoot, releaseBody, {
				listFragments,
				readFragment,
			});
		} catch (error) {
			log(
				'bounded workspace provenance scan did not resolve exactly: ' +
					(error instanceof Error ? error.message : String(error)),
			);
		}
	}
	const strippedBody = stripCustomReleaseNotesBlock(releaseBody);
	let candidates = resolveAllCandidates(strippedBody, log, {
		requireComplete: true,
	});
	if (candidates.length === 0) {
		const decision = await decideChangelogFallback({
			tagName,
			repoRoot,
			readChangelog,
			statChangelog,
			resolveCandidates: (section, nestedLog) =>
				resolveAllCandidates(section, nestedLog, { requireComplete: true }),
			log,
		});
		if (decision.exitCode !== 0) {
			throw new Error('release candidate fallback failed for ' + tagName);
		}
		candidates = decision.candidates;
	}
	const entries = collectFragmentsForPrs(candidates, repoRoot, log, {
		requireComplete: true,
		verifyCandidate,
		readFragment,
	});
	if (payload && !selectEntriesForPublishedBlock(entries, releaseBody)) {
		throw new Error(
			'incomplete release provenance: published block could not be reconstructed exactly',
		);
	}
	return entries;
}

function writeAtomicJson(filePath, value) {
	const absolute = path.resolve(filePath);
	mkdirSync(path.dirname(absolute), { recursive: true });
	const temporary = absolute + '.tmp-' + process.pid;
	const content = JSON.stringify(value, null, 2) + '\n';
	if (Buffer.byteLength(content, 'utf8') > MAX_CLEANUP_PLAN_BYTES) {
		throw new Error('cleanup plan exceeds byte cap');
	}
	writeFileSync(temporary, content, 'utf8');
	renameSync(temporary, absolute);
}

export function resolveCleanupPlanPath(repoRoot, candidate) {
	if (typeof candidate !== 'string' || candidate.length === 0) {
		throw new Error('cleanup plan path is required');
	}
	const normalized = candidate.replace(/\\/g, '/');
	if (
		path.isAbsolute(candidate) ||
		normalized.split('/').some((segment) => segment === '..') ||
		!normalized.startsWith('.release-fragment-cleanup/') ||
		normalized.slice('.release-fragment-cleanup/'.length).includes('/') ||
		!normalized.toLowerCase().endsWith('.json')
	) {
		throw new Error(
			'cleanup plan path must be a JSON file under .release-fragment-cleanup/',
		);
	}
	const plansRoot = path.resolve(repoRoot, '.release-fragment-cleanup');
	if (existsSync(plansRoot) && lstatSync(plansRoot).isSymbolicLink()) {
		throw new Error('cleanup plan directory must not be a symlink');
	}
	const absolute = path.resolve(repoRoot, normalized);
	if (!absolute.startsWith(plansRoot + path.sep)) {
		throw new Error('cleanup plan path escaped repository containment');
	}
	if (existsSync(absolute)) {
		const stat = lstatSync(absolute);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error('cleanup plan path must be a regular non-symlink file');
		}
	}
	return absolute;
}

async function modePrepareCleanup(log, args) {
	const flags = parseModeFlags(args);
	const tagName = flags.tag ?? process.env.TAG_NAME;
	if (!tagName) throw new Error('prepare-cleanup requires --tag or TAG_NAME');
	const repoRoot = resolveRepoRoot();
	const repoSlug = requireRepoSlug();
	const release = ghJson([
		'release',
		'view',
		tagName,
		'--json',
		'body,tagName,targetCommitish',
	]);
	if (release.tagName !== tagName) {
		throw new Error('release tag mismatch for ' + tagName);
	}
	const remoteCommit = peelRemoteTagObject(repoSlug, tagName);
	const localCommit = gitText(['rev-parse', tagName + '^{commit}'], repoRoot);
	const headCommit = gitText(['rev-parse', 'HEAD'], repoRoot);
	validateExactTagProof(remoteCommit, localCommit, headCommit);
	const entries = await resolveReleaseEntries(
		tagName,
		release.body ?? '',
		repoRoot,
		log,
	);
	let historicalReplay = null;
	if (flags.historicalBatch) {
		const batchPath = resolveCleanupPlanPath(repoRoot, flags.historicalBatch);
		const stat = statSync(batchPath);
		if (!stat.isFile() || stat.size > MAX_CLEANUP_PLAN_BYTES) {
			throw new Error('historical batch proof is not a bounded regular file');
		}
		historicalReplay = JSON.parse(readFileSync(batchPath, 'utf8'));
		validateHistoricalReplayProof(historicalReplay, tagName);
	}
	const plan = {
		schemaVersion: 1,
		tagName,
		tagCommit: remoteCommit,
		release: {
			tagName: release.tagName,
			targetCommitish: release.targetCommitish ?? null,
			body: release.body ?? '',
		},
		entries,
		historicalReplay,
	};
	log(
		'prepared cleanup plan for ' +
			tagName +
			' with ' +
			entries.length +
			' fragment(s)' +
			(flags.apply ? '' : ' (dry run)'),
	);
	if (flags.apply) {
		if (!flags.out) throw new Error('--apply requires --out for prepare-cleanup');
		writeAtomicJson(resolveCleanupPlanPath(repoRoot, flags.out), plan);
		log('wrote cleanup plan to ' + flags.out);
	}
	return 0;
}

function modePrepareHistoricalBatch(log, args) {
	const flags = parseModeFlags(args);
	if (!flags.tagsFile) {
		throw new Error('prepare-historical-batch requires --tags-file');
	}
	const repoRoot = resolveRepoRoot();
	const tagsPath = resolveCleanupPlanPath(repoRoot, flags.tagsFile);
	const stat = statSync(tagsPath);
	if (!stat.isFile() || stat.size > MAX_CLEANUP_PLAN_BYTES) {
		throw new Error('historical tags file is not a bounded regular file');
	}
	const input = JSON.parse(readFileSync(tagsPath, 'utf8'));
	if (input?.schemaVersion !== 1 || !Array.isArray(input.tags)) {
		throw new Error('historical tags file must use schemaVersion 1 with tags');
	}
	const rawBatchSize = flags.batchSize ?? String(MAX_HISTORICAL_BATCH_SIZE);
	if (!/^[1-9]\d*$/.test(rawBatchSize)) {
		throw new Error('historical batch size must be a positive integer');
	}
	const result = createHistoricalReplayBatch(
		input.tags,
		flags.cursor ?? '0',
		Number(rawBatchSize),
	);
	process.stderr.write(
		'prepared historical batch at cursor ' +
			result.cursor +
			(result.nextCursor === null
				? ' (final batch)'
				: '; resume with --cursor ' + result.nextCursor) +
			'\n',
	);
	process.stdout.write(JSON.stringify(result, null, 2) + '\n');
	return 0;
}

function readCleanupPlan(repoRoot, planPath) {
	const absolute = resolveCleanupPlanPath(repoRoot, planPath);
	const stat = statSync(absolute);
	if (!stat.isFile() || stat.size > MAX_CLEANUP_PLAN_BYTES) {
		throw new Error('cleanup plan is not a bounded regular file');
	}
	const plan = JSON.parse(readFileSync(absolute, 'utf8'));
	if (plan?.schemaVersion !== 1) throw new Error('unsupported cleanup plan schema');
	return plan;
}

async function modeApplyCleanup(log, args) {
	const flags = parseModeFlags(args);
	if (!flags.plan) throw new Error('apply-cleanup requires --plan');
	const repoRoot = resolveRepoRoot();
	const plan = readCleanupPlan(repoRoot, flags.plan);
	const result = await reconcileTaggedRelease({
		repoRoot,
		tagName: plan.tagName,
		release: plan.release,
		tagCommit: plan.tagCommit,
		entries: plan.entries,
		historicalReplay: plan.historicalReplay ?? null,
		dryRun: !flags.apply,
		log,
	});
	process.stdout.write(JSON.stringify(result, null, 2) + '\n');
	return result.retention.violation && !result.retention.authorizedIntermediate
		? 1
		: 0;
}

function modeVerifyRetention(log, args) {
	if (args.length > 0) throw new Error('verify-retention does not accept options');
	const result = auditFragmentRetention(resolveRepoRoot());
	for (const message of result.diagnostics) log(message);
	process.stdout.write(JSON.stringify(result, null, 2) + '\n');
	return result.violation ? 1 : 0;
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
		case 'prepare-cleanup':
			return modePrepareCleanup(log, process.argv.slice(3));
		case 'prepare-historical-batch':
			return modePrepareHistoricalBatch(log, process.argv.slice(3));
		case 'apply-cleanup':
			return modeApplyCleanup(log, process.argv.slice(3));
		case 'verify-retention':
			return modeVerifyRetention(log, process.argv.slice(3));
		default:
			process.stderr.write(
				'Usage: release-notes-fragments.mjs <update-pr|update-release|prepare-cleanup|prepare-historical-batch|apply-cleanup|verify-retention>\n',
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
