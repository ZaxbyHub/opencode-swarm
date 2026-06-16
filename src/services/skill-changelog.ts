import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { warn } from '../utils/logger.js';

export const MAX_CHANGELOG_ENTRIES_PER_SKILL = 200;

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

export async function appendSkillChangelog(
	directory: string,
	slug: string,
	entry: SkillChangelogEntry,
): Promise<void> {
	const filePath = resolveSkillChangelogPath(directory, slug);
	const dirPath = path.dirname(filePath);
	await mkdir(dirPath, { recursive: true });
	await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');

	try {
		const content = await readFile(filePath, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim().length > 0);
		if (lines.length > MAX_CHANGELOG_ENTRIES_PER_SKILL) {
			const trimmed = lines.slice(
				lines.length - MAX_CHANGELOG_ENTRIES_PER_SKILL,
			);
			await writeFile(filePath, `${trimmed.join('\n')}\n`, 'utf-8');
		}
	} catch (err) {
		warn(
			`[skill-changelog] FIFO trim failed (non-fatal): ${
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
