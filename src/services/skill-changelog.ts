import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveRetentionCap } from '../retention/caps.js';
import { appendCappedJsonl } from '../retention/jsonl-cap.js';
import { warn } from '../utils/logger.js';

/**
 * Per-skill FIFO cap (issue #2483 §2). Enforcement routes the append through
 * `appendCappedJsonl`, so the trim is crash-atomic (temp + rename), and
 * resolves the effective value through `resolveRetentionCap` so the #2483
 * acceptance checks can shrink the cap below this default and prove the
 * writer clamps.
 */
export const MAX_SKILL_CHANGELOG_ENTRIES_PER_SKILL = 200;

/**
 * Legacy alias for {@link MAX_SKILL_CHANGELOG_ENTRIES_PER_SKILL} — retained
 * for existing citations (`scripts/retention-registry.data.ts`) and tests.
 */
export const MAX_CHANGELOG_ENTRIES_PER_SKILL =
	MAX_SKILL_CHANGELOG_ENTRIES_PER_SKILL;

/**
 * Global ceiling on TOTAL changelog entries across every per-skill file
 * (issue #2483 §2). Enforced on EVERY append (critic N3 — deliberately no
 * cadence) by scanning the changelog directory; the scan is bounded by the
 * ceiling itself (one entry per slug ⇒ at most `cap` files / `cap` entries
 * to enumerate). Appends are rare, so the per-append scan cost is accepted.
 */
export const MAX_SKILL_CHANGELOG_GLOBAL_ENTRIES = 10000;

export interface SkillChangelogEntry {
	version: number;
	timestamp: string;
	action: 'generated' | 'regenerated' | 'revised' | 'promoted';
	reason: string;
	triggeringVerdicts?: { taskId: string; verdict: string; agent: string }[];
	sectionsChanged?: string[];
}

export function resolveSkillChangelogPath(
	directory: string,
	slug: string,
): string {
	if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
		throw new Error(
			`Invalid skill slug: ${slug} — must not contain "..", "/" or "\\"`,
		);
	}
	return path.join(directory, '.swarm', 'skill-changelogs', `${slug}.jsonl`);
}

/** Crash-atomic whole-file rewrite (temp + rename), mirroring jsonl-cap. */
async function rewriteLinesAtomically(
	filePath: string,
	lines: string[],
): Promise<void> {
	const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	await writeFile(tmpPath, `${lines.join('\n')}\n`, 'utf-8');
	try {
		await rename(tmpPath, filePath);
	} catch (err) {
		await unlink(tmpPath).catch(() => {});
		throw err;
	}
}

/**
 * Enforce {@link MAX_SKILL_CHANGELOG_GLOBAL_ENTRIES} across every per-skill
 * changelog file: when the TOTAL entry count exceeds the cap, drop the oldest
 * entries globally (timestamp ascending, then file name and line order as
 * deterministic tie-breaks), rewriting each affected file crash-atomically
 * and unlinking files left with zero entries. Per-file fail-open.
 */
async function enforceGlobalEntryCap(dirPath: string): Promise<void> {
	const cap = resolveRetentionCap(
		'MAX_SKILL_CHANGELOG_GLOBAL_ENTRIES',
		MAX_SKILL_CHANGELOG_GLOBAL_ENTRIES,
	);
	let files: string[];
	try {
		files = (await readdir(dirPath)).filter((name) => name.endsWith('.jsonl'));
	} catch {
		return; // missing/unreadable directory — nothing to enforce against
	}
	const linesByFile = new Map<string, string[]>();
	const stamped: Array<{ file: string; index: number; timestamp: string }> = [];
	for (const file of files) {
		let content: string;
		try {
			content = await readFile(path.join(dirPath, file), 'utf-8');
		} catch {
			continue; // per-file fail-open
		}
		const lines = content.split('\n').filter((line) => line.trim().length > 0);
		linesByFile.set(file, lines);
		for (let i = 0; i < lines.length; i++) {
			let timestamp = '';
			try {
				const parsed = JSON.parse(lines[i] as string) as {
					timestamp?: unknown;
				};
				if (typeof parsed.timestamp === 'string') timestamp = parsed.timestamp;
			} catch {
				/* malformed line sorts oldest (empty timestamp key) */
			}
			stamped.push({ file, index: i, timestamp });
		}
	}
	if (stamped.length <= cap) return;
	stamped.sort((a, b) => {
		if (a.timestamp !== b.timestamp) {
			return a.timestamp < b.timestamp ? -1 : 1;
		}
		if (a.file !== b.file) return a.file < b.file ? -1 : 1;
		return a.index - b.index;
	});
	const drop = new Set<string>();
	for (let i = 0; i < stamped.length - cap; i++) {
		const item = stamped[i]!;
		drop.add(`${item.file}\u0000${item.index}`);
	}
	for (const [file, lines] of linesByFile) {
		const kept = lines.filter((_, index) => !drop.has(`${file}\u0000${index}`));
		if (kept.length === lines.length) continue;
		const filePath = path.join(dirPath, file);
		if (kept.length === 0) {
			await unlink(filePath).catch(() => {});
			continue;
		}
		await rewriteLinesAtomically(filePath, kept);
	}
}

export async function appendSkillChangelog(
	directory: string,
	slug: string,
	entry: SkillChangelogEntry,
): Promise<void> {
	const filePath = resolveSkillChangelogPath(directory, slug);
	// Append + per-skill FIFO cap in one crash-atomic step (issue #2483).
	await appendCappedJsonl(filePath, JSON.stringify(entry), {
		maxEntries: resolveRetentionCap(
			'MAX_SKILL_CHANGELOG_ENTRIES_PER_SKILL',
			MAX_SKILL_CHANGELOG_ENTRIES_PER_SKILL,
		),
	});

	try {
		await enforceGlobalEntryCap(path.dirname(filePath));
	} catch (err) {
		warn(
			`[skill-changelog] global ceiling enforcement failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

export async function readSkillChangelog(
	directory: string,
	slug: string,
): Promise<SkillChangelogEntry[]> {
	const filePath = resolveSkillChangelogPath(directory, slug);
	let content: string;
	try {
		content = await readFile(filePath, 'utf-8');
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw err;
	}
	const out: SkillChangelogEntry[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as SkillChangelogEntry);
		} catch {
			warn(
				`[skill-changelog] Skipping corrupted JSONL line in ${filePath}: ${trimmed.slice(
					0,
					80,
				)}`,
			);
		}
	}
	return out;
}

export const _internals: {
	resolveSkillChangelogPath: typeof resolveSkillChangelogPath;
	appendSkillChangelog: typeof appendSkillChangelog;
	readSkillChangelog: typeof readSkillChangelog;
} = {
	resolveSkillChangelogPath,
	appendSkillChangelog,
	readSkillChangelog,
};
