import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../config/plan-schema';
import { readEffectiveSpecSync } from '../sdd/effective-spec';

/**
 * Computes SHA-256 hex hash of `.swarm/spec.md` content in the given directory.
 * Returns null if the file does not exist (does NOT throw).
 */
export async function computeSpecHash(
	directory: string,
): Promise<string | null> {
	const spec = _internals.readEffectiveSpecSync(directory);
	if (!spec) return null;
	return createHash('sha256').update(spec.content, 'utf-8').digest('hex');
}

/**
 * Determines if the spec file has changed since the plan was saved.
 * Plans created before this feature (no specHash) are exempt from staleness checks.
 */
export async function isSpecStale(
	directory: string,
	plan: Plan,
): Promise<{ stale: boolean; reason?: string; currentHash?: string | null }> {
	const currentHash = await _internals.computeSpecHash(directory);

	// Pre-feature plan: no specHash means plan predates this feature
	if (!plan.specHash) {
		return { stale: false };
	}

	// Spec was deleted after plan was created
	if (currentHash === null) {
		return {
			stale: true,
			reason: 'effective spec has been deleted',
			currentHash: null,
		};
	}

	// Spec was modified since plan was saved
	if (currentHash !== plan.specHash) {
		return {
			stale: true,
			reason: 'effective spec has been modified since plan was saved',
			currentHash,
		};
	}

	return { stale: false };
}

/**
 * Returns true iff the recorded spec snapshot and the current effective spec
 * have IDENTICAL obligation-bearing PARAGRAPHS. A paragraph is a block of
 * text separated by blank lines. A paragraph is obligation-bearing if ANY
 * line in it matches /\bSC-\d+/, /\bFR-\d+/, or contains MUST or SHALL
 * (case-insensitive).
 *
 * This paragraph-level comparison detects changes on continuation lines within
 * an obligation paragraph (where the obligation marker is on one line but the
 * body text that changes meaning is on a subsequent line without a token).
 *
 * Conservative default: if the snapshot is missing, the current spec is missing,
 * or any error occurs during reading or comparison, returns false so the edit
 * falls back to the block-with-diff path.
 */
export function isObligationPreserving(directory: string): boolean {
	const snapshotPath = join(directory, '.swarm', 'spec-snapshot.md');

	try {
		let recordedContent: string;
		try {
			recordedContent = fsSync.readFileSync(snapshotPath, 'utf-8');
		} catch {
			return false;
		}

		const currentResult = _internals.readEffectiveSpecSync(directory);
		if (!currentResult || !currentResult.content) {
			return false;
		}
		const currentContent = currentResult.content;

		// Normalize line endings (CRLF → LF) before comparison
		const normalize = (text: string) => text.replace(/\r\n/g, '\n');
		const recordedNorm = normalize(recordedContent);
		const currentNorm = normalize(currentContent);

		// Split into paragraphs (blocks separated by one or more blank lines)
		const splitParagraphs = (text: string): string[] =>
			text
				.split(/\n\s*\n/)
				.map((p) => p.trim())
				.filter((p) => p.length > 0);

		const recordedParagraphs = splitParagraphs(recordedNorm);
		const currentParagraphs = splitParagraphs(currentNorm);

		const isObligationLine = (line: string): boolean =>
			/\bSC-\d+/.test(line) ||
			/\bFR-\d+/.test(line) ||
			/\bMUST\b/i.test(line) ||
			/\bSHALL\b/i.test(line);

		// A paragraph is obligation-bearing if any line inside it carries an obligation token
		const isObligationParagraph = (para: string): boolean =>
			para.split('\n').some(isObligationLine);

		const recordedObligationParas = recordedParagraphs
			.filter(isObligationParagraph)
			.sort();
		const currentObligationParas = currentParagraphs
			.filter(isObligationParagraph)
			.sort();

		if (recordedObligationParas.length !== currentObligationParas.length) {
			return false;
		}

		for (let i = 0; i < recordedObligationParas.length; i++) {
			if (recordedObligationParas[i] !== currentObligationParas[i]) {
				return false;
			}
		}

		return true;
	} catch {
		return false;
	}
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	computeSpecDiff: typeof computeSpecDiff;
	computeSpecHash: typeof computeSpecHash;
	isObligationPreserving: typeof isObligationPreserving;
	isSpecStale: typeof isSpecStale;
	readEffectiveSpecSync: typeof readEffectiveSpecSync;
} = {
	computeSpecDiff,
	computeSpecHash,
	isObligationPreserving,
	isSpecStale,
	readEffectiveSpecSync,
} as const;

/**
 * Computes a unified line diff between the recorded spec snapshot and the
 * current effective spec. Returns null if no snapshot exists (cannot diff).
 *
 * Diff format: lines prefixed with ' ' (unchanged), '+' (added), '-' (removed).
 * Changed sections are markdown headings (lines starting with '## ') that
 * appear in added or removed lines.
 *
 * The diff is capped at 300 lines; when exceeded, only the changed-sections
 * summary is returned alongside a truncated diff.
 *
 * Uses synchronous reads internally so it can be called from sync contexts
 * (e.g. the spec-drift guardrail block path).
 */
export function computeSpecDiff(
	directory: string,
): { diff: string; changedSections: string[] } | null {
	const snapshotPath = join(directory, '.swarm', 'spec-snapshot.md');

	let recordedContent: string;
	try {
		const snapshotSize = fsSync.statSync(snapshotPath).size;
		const MAX_SNAPSHOT_BYTES = 512 * 1024; // 512 KB — conservative cap
		if (snapshotSize > MAX_SNAPSHOT_BYTES) {
			return null;
		}
		recordedContent = fsSync.readFileSync(snapshotPath, 'utf-8');
	} catch {
		return null;
	}

	const spec = _internals.readEffectiveSpecSync(directory);
	if (!spec) {
		return null;
	}

	const currentContent = spec.content;

	// Normalize line endings (CRLF → LF) before diffing
	const normalize = (text: string) => text.replace(/\r\n/g, '\n');
	const recordedLines = normalize(recordedContent).split('\n');
	const currentLines = normalize(currentContent).split('\n');

	const diffLines = computeLcsDiff(recordedLines, currentLines);

	// Cap diff output at 300 lines to avoid flooding the error/advisory message
	const MAX_DIFF_LINES = 300;
	const diffText =
		diffLines.length <= MAX_DIFF_LINES
			? diffLines.join('\n')
			: diffLines.slice(0, MAX_DIFF_LINES).join('\n') +
				'\n... (diff truncated — ' +
				String(diffLines.length - MAX_DIFF_LINES) +
				' more lines)';

	// Identify changed sections: track the nearest preceding ## heading
	// (updated by unchanged, added, or removed heading lines) and record it
	// for every added/removed line so in-section body changes are attributed.
	const changedSectionsSet = new Set<string>();
	let currentSection = '';
	for (const line of diffLines) {
		const headingMatch = line.slice(1).match(/^##\s+(.+)$/);
		if (headingMatch) {
			currentSection = headingMatch[1].trim();
		}
		if (line.length > 0 && (line[0] === '+' || line[0] === '-')) {
			if (currentSection) {
				changedSectionsSet.add(currentSection);
			}
		}
	}

	return {
		diff: diffText,
		changedSections: Array.from(changedSectionsSet),
	};
}

/**
 * Minimal LCS-based line diff.
 * Returns diff lines with prefixes: ' ' (unchanged), '+' (added), '-' (removed).
 */
function computeLcsDiff(oldLines: string[], newLines: string[]): string[] {
	const m = oldLines.length;
	const n = newLines.length;

	// Build LCS DP table
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		Array(n + 1).fill(0),
	);

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	// Backtrack to produce diff
	const entries: { type: 'add' | 'remove' | 'unchanged'; line: string }[] = [];
	let i = m;
	let j = n;

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			entries.unshift({ type: 'unchanged', line: oldLines[i - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			entries.unshift({ type: 'add', line: newLines[j - 1] });
			j--;
		} else {
			entries.unshift({ type: 'remove', line: oldLines[i - 1] });
			i--;
		}
	}

	return entries.map((entry) => {
		if (entry.type === 'unchanged') return ` ${entry.line}`;
		if (entry.type === 'add') return `+${entry.line}`;
		return `-${entry.line}`;
	});
}
