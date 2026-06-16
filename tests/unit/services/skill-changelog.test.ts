import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	appendSkillChangelog,
	MAX_CHANGELOG_ENTRIES_PER_SKILL,
	readSkillChangelog,
	resolveSkillChangelogPath,
} from '../../../src/services/skill-changelog';

function makeEntry(
	overrides: Partial<{
		version: number;
		timestamp: string;
		action: 'generated' | 'regenerated' | 'revised' | 'promoted';
		reason: string;
	}> = {},
) {
	return {
		version: 1,
		timestamp: '2026-06-10T12:00:00.000Z',
		action: 'generated' as const,
		reason: 'Initial generation from 3 knowledge entries',
		...overrides,
	};
}

describe('skill-changelog', () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(path.join(os.tmpdir(), 'swarm-changelog-'));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// ── Path resolution ───────────────────────────────────────────────

	describe('resolveSkillChangelogPath', () => {
		it('returns correct path for a valid slug', () => {
			const result = resolveSkillChangelogPath(tmp, 'my-skill');
			expect(result).toBe(
				path.join(tmp, '.swarm', 'skill-changelogs', 'my-skill.jsonl'),
			);
		});

		it('throws on slug containing ".."', () => {
			expect(() => resolveSkillChangelogPath(tmp, 'foo..bar')).toThrow(
				/must not contain/,
			);
		});

		it('throws on slug containing "/"', () => {
			expect(() => resolveSkillChangelogPath(tmp, 'foo/bar')).toThrow(
				/must not contain/,
			);
		});

		it('throws on slug containing "\\"', () => {
			expect(() => resolveSkillChangelogPath(tmp, 'foo\\bar')).toThrow(
				/must not contain/,
			);
		});
	});

	// ── Append + Read roundtrip ───────────────────────────────────────

	describe('append and read roundtrip', () => {
		it('appends a single entry and reads it back', async () => {
			const entry = makeEntry();
			await appendSkillChangelog(tmp, 'roundtrip', entry);

			const result = await readSkillChangelog(tmp, 'roundtrip');
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual(entry);
		});

		it('appends multiple entries and returns them in order (oldest first)', async () => {
			const entries = [
				makeEntry({ reason: 'first', timestamp: '2026-06-10T01:00:00.000Z' }),
				makeEntry({
					reason: 'second',
					timestamp: '2026-06-10T02:00:00.000Z',
				}),
				makeEntry({ reason: 'third', timestamp: '2026-06-10T03:00:00.000Z' }),
			];

			for (const entry of entries) {
				await appendSkillChangelog(tmp, 'multi', entry);
			}

			const result = await readSkillChangelog(tmp, 'multi');
			expect(result).toHaveLength(3);
			expect(result[0]!.reason).toBe('first');
			expect(result[1]!.reason).toBe('second');
			expect(result[2]!.reason).toBe('third');
		});
	});

	// ── Empty / missing file ──────────────────────────────────────────

	describe('empty or missing file', () => {
		it('returns [] for a non-existent file', async () => {
			const result = await readSkillChangelog(tmp, 'does-not-exist');
			expect(result).toEqual([]);
		});

		it('returns [] when the directory does not exist', async () => {
			const missingDir = path.join(tmp, 'no-such-dir');
			const result = await readSkillChangelog(missingDir, 'anything');
			expect(result).toEqual([]);
		});
	});

	// ── Corrupt line tolerance ────────────────────────────────────────

	describe('corrupt line tolerance', () => {
		it('skips garbage lines and returns only valid entries', async () => {
			const validEntry = makeEntry({ reason: 'valid line' });
			const filePath = resolveSkillChangelogPath(tmp, 'corrupt');
			const dirPath = path.dirname(filePath);
			mkdirSync(dirPath, { recursive: true });

			const lines = [
				JSON.stringify(validEntry),
				'this is not json',
				'',
				'{bad json',
				JSON.stringify(makeEntry({ reason: 'also valid' })),
			].join('\n');
			writeFileSync(filePath, lines, 'utf-8');

			const result = await readSkillChangelog(tmp, 'corrupt');
			expect(result).toHaveLength(2);
			expect(result[0]!.reason).toBe('valid line');
			expect(result[1]!.reason).toBe('also valid');
		});
	});

	// ── FIFO trim ─────────────────────────────────────────────────────

	describe('FIFO trim', () => {
		it('trims old entries when exceeding MAX_CHANGELOG_ENTRIES_PER_SKILL', async () => {
			const totalEntries = MAX_CHANGELOG_ENTRIES_PER_SKILL + 10;

			for (let i = 0; i < totalEntries; i++) {
				await appendSkillChangelog(
					tmp,
					'fifo',
					makeEntry({ reason: `entry-${i}` }),
				);
			}

			const result = await readSkillChangelog(tmp, 'fifo');
			expect(result).toHaveLength(MAX_CHANGELOG_ENTRIES_PER_SKILL);

			// The oldest 10 entries (0..9) should have been trimmed.
			// The first surviving entry should be entry-10.
			expect(result[0]!.reason).toBe('entry-10');
			expect(result[result.length - 1]!.reason).toBe(
				`entry-${totalEntries - 1}`,
			);
		});
	});

	// ── Directory creation ────────────────────────────────────────────

	describe('directory creation', () => {
		it('creates .swarm/skill-changelogs/ when it does not exist', async () => {
			const nestedDir = path.join(tmp, 'nested', 'project');
			// Do not pre-create any directories — appendSkillChangelog should handle it.
			await appendSkillChangelog(
				nestedDir,
				'auto-dir',
				makeEntry({ reason: 'auto-created' }),
			);

			const filePath = resolveSkillChangelogPath(nestedDir, 'auto-dir');
			const content = readFileSync(filePath, 'utf-8');
			expect(content.trim()).toBe(
				JSON.stringify(makeEntry({ reason: 'auto-created' })),
			);
		});
	});
});
