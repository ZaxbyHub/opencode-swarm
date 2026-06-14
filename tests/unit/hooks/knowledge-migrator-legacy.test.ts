import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import {
	migrateHiveKnowledgeLegacy,
	_internals as migratorInternals,
} from '../../../src/hooks/knowledge-migrator.js';
import {
	readKnowledge,
	resolveHiveKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import type { HiveKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';

function createTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mig-test-'));
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function computeLegacyHivePath(home: string): string {
	const platform = process.platform;
	if (platform === 'win32') {
		return path.join(
			process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
			'opencode-swarm',
			'Data',
			'hive-knowledge.jsonl',
		);
	} else if (platform === 'darwin') {
		return path.join(
			home,
			'Library',
			'Application Support',
			'opencode-swarm',
			'hive-knowledge.jsonl',
		);
	}
	return path.join(
		process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
		'opencode-swarm',
		'hive-knowledge.jsonl',
	);
}

describe('migrateHiveKnowledgeLegacy', () => {
	let tempDir: string;
	let originalHome: string | undefined;
	let originalLocalAppData: string | undefined;
	let originalXdgDataHome: string | undefined;
	let legacyHivePath: string;
	let canonicalHivePath: string;

	beforeEach(() => {
		tempDir = createTempProject();

		// Redirect HOME so resolveHiveKnowledgePath lands inside tempDir
		originalHome = process.env.HOME;
		originalLocalAppData = process.env.LOCALAPPDATA;
		originalXdgDataHome = process.env.XDG_DATA_HOME;

		process.env.HOME = tempDir;
		if (process.platform === 'win32') {
			process.env.LOCALAPPDATA = path.join(tempDir, 'AppData', 'Local');
		} else {
			process.env.XDG_DATA_HOME = path.join(tempDir, '.local', 'share');
		}

		canonicalHivePath = resolveHiveKnowledgePath();
		legacyHivePath = computeLegacyHivePath(tempDir);

		// Create directory structure for legacy file
		fs.mkdirSync(path.dirname(legacyHivePath), { recursive: true });
		// Pre-create empty legacy file (mimics the real env-redirected path)
		fs.writeFileSync(legacyHivePath, '', 'utf-8');
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (process.platform === 'win32') {
			if (originalLocalAppData === undefined) {
				delete process.env.LOCALAPPDATA;
			} else {
				process.env.LOCALAPPDATA = originalLocalAppData;
			}
		} else {
			if (originalXdgDataHome === undefined) {
				delete process.env.XDG_DATA_HOME;
			} else {
				process.env.XDG_DATA_HOME = originalXdgDataHome;
			}
		}
		cleanupDir(tempDir);
	});

	const config = KnowledgeConfigSchema.parse({});

	it('returns sentinel-exists when sentinel already exists', async () => {
		const sentinelPath = path.join(
			path.dirname(canonicalHivePath),
			'.hive-knowledge-migrated',
		);
		fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
		fs.writeFileSync(
			sentinelPath,
			JSON.stringify({ migrated_at: new Date().toISOString() }),
			'utf-8',
		);

		const result = await migrateHiveKnowledgeLegacy(config);

		expect(result).toEqual({
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'sentinel-exists',
		});
		expect(fs.existsSync(canonicalHivePath)).toBe(false);
	});

	it('returns no-context-file when legacy file missing', async () => {
		fs.rmSync(legacyHivePath, { force: true });

		const result = await migrateHiveKnowledgeLegacy(config);

		expect(result).toEqual({
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'no-context-file',
		});
	});

	it('writes sentinel and returns zero counts for empty legacy file', async () => {
		const result = await migrateHiveKnowledgeLegacy(config);

		expect(result.migrated).toBe(true);
		expect(result.entriesMigrated).toBe(0);
		expect(result.entriesDropped).toBe(0);
		expect(result.entriesTotal).toBe(0);

		const sentinelPath = path.join(
			path.dirname(canonicalHivePath),
			'.hive-knowledge-migrated',
		);
		expect(fs.existsSync(sentinelPath)).toBe(true);
	});

	it('migrates one valid entry with all schema fields set', async () => {
		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({
				lesson: 'Always validate user input at boundaries',
				category: 'security',
			}) + '\n',
			'utf-8',
		);

		const result = await migrateHiveKnowledgeLegacy(config);

		expect(result).toEqual({
			migrated: true,
			entriesMigrated: 1,
			entriesDropped: 0,
			entriesTotal: 1,
		});

		const entries = await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(entries).toHaveLength(1);
		const entry = entries[0]!;
		expect(entry.tier).toBe('hive');
		expect(entry.status).toBe('established');
		expect(entry.category).toBe('security');
		expect(entry.source_project).toBe('legacy-promotion');
		expect(entry.encounter_score).toBe(1.0);
		expect(entry.tags).toContain('migration:legacy-hive');
	});

	it('migrates all valid entries from legacy file', async () => {
		const entries = [
			{
				lesson: 'Always validate user input at boundaries',
				category: 'security',
			},
			{
				lesson: 'Use dependency injection to decouple modules',
				category: 'architecture',
			},
			{
				lesson: 'Write tests before implementing features',
				category: 'testing',
			},
		];
		fs.writeFileSync(
			legacyHivePath,
			entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
			'utf-8',
		);

		const result = await migrateHiveKnowledgeLegacy(config);

		expect(result.entriesMigrated).toBe(3);
		expect(result.entriesDropped).toBe(0);
		expect(result.entriesTotal).toBe(3);

		const canonical =
			await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(canonical).toHaveLength(3);
	});

	it('drops entries with lesson shorter than 15 chars', async () => {
		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({ lesson: 'short' }) + '\n',
			'utf-8',
		);

		const result = await migrateHiveKnowledgeLegacy(config);

		expect(result.entriesMigrated).toBe(0);
		expect(result.entriesDropped).toBe(1);
		expect(result.entriesTotal).toBe(1);

		const canonical =
			await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(canonical).toHaveLength(0);
	});

	it('drops entries without lesson field', async () => {
		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({ category: 'testing' }) + '\n',
			'utf-8',
		);

		const result = await migrateHiveKnowledgeLegacy(config);

		expect(result.entriesDropped).toBe(1);
		expect(result.entriesMigrated).toBe(0);

		const canonical =
			await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(canonical).toHaveLength(0);
	});

	it('defaults missing confidence to 0.8', async () => {
		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({ lesson: 'Always validate user input at boundaries' }) +
				'\n',
			'utf-8',
		);

		await migrateHiveKnowledgeLegacy(config);

		const entries = await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(entries[0]!.confidence).toBe(0.8);
	});

	it('preserves explicit confidence value', async () => {
		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({
				lesson: 'Always validate user input at boundaries',
				confidence: 0.65,
			}) + '\n',
			'utf-8',
		);

		await migrateHiveKnowledgeLegacy(config);

		const entries = await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(entries[0]!.confidence).toBe(0.65);
	});

	it('defaults missing category to process', async () => {
		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({ lesson: 'Always validate user input at boundaries' }) +
				'\n',
			'utf-8',
		);

		await migrateHiveKnowledgeLegacy(config);

		const entries = await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(entries[0]!.category).toBe('process');
	});

	it('maps legacy scope_tag to scope field', async () => {
		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({
				lesson: 'Always validate user input at boundaries',
				scope_tag: 'stack:python',
			}) + '\n',
			'utf-8',
		);

		await migrateHiveKnowledgeLegacy(config);

		const entries = await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(entries[0]!.scope).toBe('stack:python');
	});

	it('preserves legacy entry id when present', async () => {
		const legacyId = 'legacy-abc-123';
		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({
				id: legacyId,
				lesson: 'Always validate user input at boundaries',
			}) + '\n',
			'utf-8',
		);

		await migrateHiveKnowledgeLegacy(config);

		const entries = await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(entries[0]!.id).toBe(legacyId);
	});

	it('generates new UUID for entries without id', async () => {
		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({ lesson: 'Always validate user input at boundaries' }) +
				'\n',
			'utf-8',
		);

		await migrateHiveKnowledgeLegacy(config);

		const entries = await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(entries[0]!.id).toBeTruthy();
		expect(entries[0]!.id.length).toBeGreaterThan(0);
		expect(entries[0]!.id).toContain('-');
	});

	it('deduplicates against existing canonical entry', async () => {
		const existingEntry: HiveKnowledgeEntry = {
			id: 'existing-id',
			tier: 'hive',
			lesson: 'Always validate user input at boundaries',
			category: 'security',
			tags: [],
			scope: 'global',
			confidence: 0.8,
			status: 'established',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 2,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			source_project: 'other-project',
			encounter_score: 1.0,
		};

		fs.mkdirSync(path.dirname(canonicalHivePath), { recursive: true });
		fs.writeFileSync(
			canonicalHivePath,
			JSON.stringify(existingEntry) + '\n',
			'utf-8',
		);

		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({ lesson: 'Always validate user input at boundaries' }) +
				'\n',
			'utf-8',
		);

		const result = await migrateHiveKnowledgeLegacy(config);

		expect(result.entriesMigrated).toBe(0);
		expect(result.entriesDropped).toBe(1);
		expect(result.entriesTotal).toBe(1);

		const canonical =
			await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(canonical).toHaveLength(1);
		expect(canonical[0]!.id).toBe('existing-id');
	});

	it('logs per-entry error and continues on appendKnowledge failure', async () => {
		const originalAppendKnowledge = migratorInternals.appendKnowledge;
		let callCount = 0;

		migratorInternals.appendKnowledge = async (...args: unknown[]) => {
			callCount++;
			if (callCount === 1) {
				throw new Error('simulated write failure');
			}
			return originalAppendKnowledge(...args);
		};

		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({ lesson: 'Always validate user input at boundaries' }) +
				'\n',
			'utf-8',
		);

		try {
			const result = await migrateHiveKnowledgeLegacy(config);

			expect(result.entriesMigrated).toBe(0);
			expect(result.entriesDropped).toBe(1);
			expect(result.entriesTotal).toBe(1);
			expect(result.entryErrors).toBeDefined();
			expect(result.entryErrors!.length).toBe(1);
			expect(result.entryErrors![0]).toContain('simulated write failure');

			const canonical =
				await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
			expect(canonical).toHaveLength(0);
		} finally {
			migratorInternals.appendKnowledge = originalAppendKnowledge;
		}
	});

	it('preserves confidence: 0 as zero, not inflated to 0.8', async () => {
		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({
				lesson: 'Always validate user input at boundaries',
				confidence: 0,
			}) + '\n',
			'utf-8',
		);

		await migrateHiveKnowledgeLegacy(config);

		const entries = await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(entries[0]!.confidence).toBe(0);
	});

	it('generates new UUID when legacy ID collides with existing canonical entry', async () => {
		const legacyId = 'legacy-collision-id';
		const existingEntry: HiveKnowledgeEntry = {
			id: legacyId,
			tier: 'hive',
			lesson: 'A different lesson to avoid near-dedup',
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.8,
			status: 'established',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 2,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			source_project: 'other-project',
			encounter_score: 1.0,
		};

		fs.mkdirSync(path.dirname(canonicalHivePath), { recursive: true });
		fs.writeFileSync(
			canonicalHivePath,
			JSON.stringify(existingEntry) + '\n',
			'utf-8',
		);

		fs.writeFileSync(
			legacyHivePath,
			JSON.stringify({
				id: legacyId,
				lesson: 'Always validate user input at boundaries',
			}) + '\n',
			'utf-8',
		);

		await migrateHiveKnowledgeLegacy(config);

		const canonical =
			await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);
		expect(canonical).toHaveLength(2);
		const newEntry = canonical.find(
			(e) => e.lesson === 'Always validate user input at boundaries',
		);
		expect(newEntry).toBeDefined();
		expect(newEntry!.id).not.toBe(legacyId);
	});
});
