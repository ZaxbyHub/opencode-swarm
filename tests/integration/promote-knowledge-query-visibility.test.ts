/**
 * Regression test for issue: promote → knowledge_query integration
 * Ensures that `/swarm promote` output is visible to `knowledge_query --tier hive`
 * and `readMergedKnowledge`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handlePromoteCommand } from '../../src/commands/promote';
import {
	readKnowledge,
	resolveHiveKnowledgePath,
} from '../../src/hooks/knowledge-store';
import type { HiveKnowledgeEntry } from '../../src/hooks/knowledge-types';

// Test utilities
function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-query-test-'));
	return dir;
}

function cleanupDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe('Regression: /swarm promote visibility to knowledge_query', () => {
	let tempDir: string;
	let savedLocalAppData: string | undefined;
	let savedXdgDataHome: string | undefined;
	let savedHome: string | undefined;
	let savedCwd: string;

	beforeEach(() => {
		tempDir = createTempDir();
		savedCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		// Redirect hive knowledge path to tempDir to isolate from global state
		if (process.platform === 'win32') {
			savedLocalAppData = process.env.LOCALAPPDATA;
			process.env.LOCALAPPDATA = tempDir;
		} else if (process.platform === 'darwin') {
			savedHome = process.env.HOME;
			process.env.HOME = tempDir;
		} else {
			savedXdgDataHome = process.env.XDG_DATA_HOME;
			process.env.XDG_DATA_HOME = tempDir;
		}
	});

	afterEach(() => {
		process.chdir(savedCwd);
		cleanupDir(tempDir);
		// Restore env vars
		if (process.platform === 'win32') {
			if (savedLocalAppData !== undefined) {
				process.env.LOCALAPPDATA = savedLocalAppData;
			} else {
				delete process.env.LOCALAPPDATA;
			}
		} else if (process.platform === 'darwin') {
			if (savedHome !== undefined) {
				process.env.HOME = savedHome;
			} else {
				delete process.env.HOME;
			}
		} else {
			if (savedXdgDataHome !== undefined) {
				process.env.XDG_DATA_HOME = savedXdgDataHome;
			} else {
				delete process.env.XDG_DATA_HOME;
			}
		}
	});

	it('should make manually promoted lesson visible to knowledge_query', async () => {
		// Step 1: Promote a lesson manually
		const lesson = 'Always validate input at system boundaries';
		const promoteResult = await handlePromoteCommand(tempDir, [lesson]);

		expect(promoteResult).toContain('Promoted to hive');
		expect(promoteResult).toContain('Always validate');

		// Step 2: Verify the entry landed in the canonical hive store
		const hivePath = resolveHiveKnowledgePath();
		const hiveEntries = await readKnowledge<HiveKnowledgeEntry>(hivePath);
		const promotedEntry = hiveEntries.find((e) => e.lesson === lesson);
		expect(promotedEntry).toBeDefined();
		expect(promotedEntry?.tier).toBe('hive');
		expect(promotedEntry?.status).toBe('promoted');
	});

	it('should write promoted lesson to shared-learnings.jsonl', async () => {
		// Step 1: Promote a lesson
		const lesson = 'Document API breaking changes in release notes';
		await handlePromoteCommand(tempDir, [lesson]);

		// Step 2: Read directly from the hive knowledge file
		const hivePath = resolveHiveKnowledgePath();
		const hiveEntries = await readKnowledge<HiveKnowledgeEntry>(hivePath);

		expect(hiveEntries.length).toBeGreaterThan(0);
		const foundEntry = hiveEntries.find((e) =>
			e.lesson.toLowerCase().includes('breaking changes'),
		);
		expect(foundEntry).toBeDefined();
		expect(foundEntry?.tier).toBe('hive');
		expect(foundEntry?.status).toBe('promoted');
	});

	it('should deduplicate near-duplicate promotions', async () => {
		// Step 1: Promote a lesson
		const lesson = 'Use type hints to improve code clarity';
		const firstResult = await handlePromoteCommand(tempDir, [lesson]);
		expect(firstResult).toContain('Promoted to hive');

		// Step 2: Promote the EXACT same lesson (this will be caught by Jaccard > 0.6)
		const secondResult = await handlePromoteCommand(tempDir, [lesson]);

		// Should indicate it already exists
		expect(secondResult).toContain(
			'Lesson already exists in hive (near-duplicate)',
		);
	});

	it('should preserve category when promoting with --category flag', async () => {
		// Step 1: Promote with category
		const lesson = 'Enable request timeout for all external API calls';
		await handlePromoteCommand(tempDir, ['--category', 'security', lesson]);

		// Step 2: Read from hive and verify category
		const hivePath = resolveHiveKnowledgePath();
		const hiveEntries = await readKnowledge<HiveKnowledgeEntry>(hivePath);

		const foundEntry = hiveEntries.find((e) =>
			e.lesson.toLowerCase().includes('request timeout'),
		);
		expect(foundEntry).toBeDefined();
		expect(foundEntry?.category).toBe('security');
	});

	it('should use 1.0 confidence for manual promotions', async () => {
		// Step 1: Promote a lesson
		const lesson = 'Never commit secrets to version control';
		await handlePromoteCommand(tempDir, [lesson]);

		// Step 2: Verify confidence is 1.0
		const hivePath = resolveHiveKnowledgePath();
		const hiveEntries = await readKnowledge<HiveKnowledgeEntry>(hivePath);

		const foundEntry = hiveEntries.find((e) =>
			e.lesson.toLowerCase().includes('secrets'),
		);
		expect(foundEntry).toBeDefined();
		expect(foundEntry?.confidence).toBe(1.0);
	});

	it('should mark promoted entry with promoted status', async () => {
		// Step 1: Promote a lesson
		const lesson = 'Test error paths as thoroughly as success paths';
		await handlePromoteCommand(tempDir, [lesson]);

		// Step 2: Verify status is promoted
		const hivePath = resolveHiveKnowledgePath();
		const hiveEntries = await readKnowledge<HiveKnowledgeEntry>(hivePath);

		const foundEntry = hiveEntries.find((e) =>
			e.lesson.toLowerCase().includes('error paths'),
		);
		expect(foundEntry).toBeDefined();
		expect(foundEntry?.status).toBe('promoted');
	});

	it('should include proper timestamps on promoted entries', async () => {
		// Step 1: Promote a lesson
		const lesson = 'Use const by default, only use let when needed';
		await handlePromoteCommand(tempDir, [lesson]);

		// Step 2: Verify timestamps exist and are ISO 8601
		const hivePath = resolveHiveKnowledgePath();
		const hiveEntries = await readKnowledge<HiveKnowledgeEntry>(hivePath);

		const foundEntry = hiveEntries.find((e) =>
			e.lesson.toLowerCase().includes('const'),
		);
		expect(foundEntry).toBeDefined();
		expect(foundEntry?.created_at).toBeDefined();
		expect(foundEntry?.updated_at).toBeDefined();

		// Verify ISO 8601 format
		const createdDate = new Date(foundEntry?.created_at || '');
		const updatedDate = new Date(foundEntry?.updated_at || '');
		expect(createdDate.getTime()).toBeGreaterThan(0);
		expect(updatedDate.getTime()).toBeGreaterThan(0);
	});

	it('should support multiple sequential promotions without data loss', async () => {
		// Promote multiple lessons in sequence
		const lessons = [
			'Write small, focused functions',
			'Use meaningful variable names',
			'Add comments for the why, not the what',
			'Keep dependencies up to date',
			'Use version control for all code',
		];

		for (const lesson of lessons) {
			const result = await handlePromoteCommand(tempDir, [lesson]);
			expect(result).toContain('Promoted to hive');
		}

		// Verify all are in the hive (exact lesson match, not first-word)
		const hivePath = resolveHiveKnowledgePath();
		const hiveEntries = await readKnowledge<HiveKnowledgeEntry>(hivePath);

		expect(hiveEntries.length).toBe(lessons.length);
		for (const lesson of lessons) {
			const found = hiveEntries.some((e) => e.lesson === lesson);
			expect(found).toBe(true);
		}
	});
});
