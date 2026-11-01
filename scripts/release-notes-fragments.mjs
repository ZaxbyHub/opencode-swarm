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
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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
		const filePath = typeof entry === 'string' ? entry : entry?.path;
		if (typeof filePath !== 'string' || filePath.length === 0) continue;
		const posix = filePath.replace(/\\/g, '/');
		if (!posix.startsWith(`${FRAGMENT_DIR}/`)) continue;
		if (!posix.endsWith('.md')) continue;
		// Path-traversal rejection: the listing is attacker-controllable
		// (PR authors control their file paths) and this path is later
		// resolved against the repo root for reading.
		if (posix.split('/').includes('..')) continue;
		if (posix.includes('\0')) continue;
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
			logFn(`skip SHA ${sha.slice(0, 7)} — API lookup failed`);
			continue;
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
function readFragmentFromWorkspace(repoRoot, relativePath) {
	const absolute = path.join(repoRoot, relativePath);
	if (!existsSync(absolute)) return null;
	const bytes = readFileSync(absolute);
	if (bytes.length > MAX_FRAGMENT_BYTES) {
		throw new Error(`fragment exceeds byte cap: ${relativePath}`);
	}
	const content = bytes.toString('utf8');
	return { content, sha256: sha256(content) };
}

function verifyPr(num) {
	const res = tryGhJson(['pr', 'view', String(num), '--json', 'number,files']);
	if (!res.ok) return null;
	return res.value;
}

export function collectFragmentsForPrs(candidates, repoRoot, logFn, options = {}) {
	if (!Array.isArray(candidates) || candidates.length > MAX_RELEASE_CANDIDATES) {
		throw new Error('release candidate PR cap exceeded');
	}
	const { verifyCandidate = verifyPr, readFragment = readFragmentFromWorkspace } = options;
	const entries = [];
	const seenPaths = new Set();
	for (const num of candidates) {
		const pr = verifyCandidate(num);
		if (!pr || !Array.isArray(pr.files)) {
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
	if (!prList.ok || !Array.isArray(prList.value) || prList.value.length === 0) {
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
		const body = bodyRes.ok ? (bodyRes.value?.body ?? '') : '';
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
		if (newBody !== body) {
			ghInput(['pr', 'edit', String(releasePr.number), '--body-file', '-'], newBody);
			logFn(`Updated release PR #${releasePr.number} with ${entries.length} fragment(s)`);
		} else {
			logFn('Release PR body already up to date');
		}
		// Verify the block survived a potential concurrent regeneration.
		await sleep(settleDelayMs);
		const afterRes = tryGhJson(['pr', 'view', String(releasePr.number), '--json', 'body']);
		const afterBody = afterRes.ok ? (afterRes.value?.body ?? '') : '';
		if (customReleaseNotesPayload(afterBody) !== null) return 0;
		logFn(`marker block missing after edit (attempt ${attempt}) — retrying`);
	}
	logFn('marker block did not survive after retries — giving up (non-fatal; next run retries)');
	return 0;
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
		logFn(`Release ${tagName} not found — exiting 0`);
		return 0;
	}
	const releaseBody = rel.value.body || '';
	const strippedBody = stripCustomReleaseNotesBlock(releaseBody);
	let allCandidates = resolveAllCandidates(strippedBody, logFn);

	// Fallback for an EMPTY release body (release-please has been observed
	// creating those): the component's own CHANGELOG.md carries the version
	// section with /commit/<40-hex> links.
	if (allCandidates.length === 0) {
		const changelogPath = path.join(
			repoRoot,
			COMPONENT_PATHS[parsedTag.component] ?? 'packages',
			'CHANGELOG.md',
		);
		if (existsSync(changelogPath)) {
			const section = readFileSync(changelogPath, 'utf8');
			allCandidates = resolveAllCandidates(section, logFn);
			if (allCandidates.length > 0) {
				logFn(`resolved ${allCandidates.length} candidate PR(s) from ${parsedTag.component} CHANGELOG fallback`);
			}
		}
	}
	logFn(`collecting fragments for ${allCandidates.length} candidate PR(s)`);
	const entries = collectFragmentsForPrs(allCandidates, repoRoot, logFn);
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
 *     is the operative oracle: a fragment edited in a later commit on next
 *     renders differently than the published body, so a retry/dispatch
 *     cleanup run RETAINS it (review F-5).
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
	const publishedParts = payload.split(FRAGMENT_SEPARATOR);
	const deletable = [];
	const retained = [];
	for (const entry of entries) {
		const rendered = renderFragmentBody(entry.content).replace(/\s+$/, '');
		if (rendered === '' || !publishedParts.includes(rendered)) {
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
		logFn(`Release ${tagName} not found — exiting 0`);
		return 0;
	}
	const strippedBody = stripCustomReleaseNotesBlock(rel.value.body || '');
	const allCandidates = resolveAllCandidates(strippedBody, logFn);
	if (allCandidates.length === 0) {
		logFn('No PR references in release body — nothing to clean up');
		return 0;
	}
	const entries = collectFragmentsForPrs(allCandidates, repoRoot, logFn);
	if (entries.length === 0) {
		logFn('No pending fragments referenced by this release — nothing to clean up');
		return 0;
	}
	const plan = planFragmentDeletions(rel.value.body || '', entries, (filePath) => {
		const absolute = path.join(repoRoot, filePath);
		if (!existsSync(absolute)) return null;
		return readFileSync(absolute, 'utf8');
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
