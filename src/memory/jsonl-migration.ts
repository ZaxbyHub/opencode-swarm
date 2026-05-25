import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './config';
import { validateMemoryProposal, validateMemoryRecordRules } from './schema';
import type { MemoryProposal, MemoryRecord } from './types';

export const LEGACY_JSONL_MIGRATION_VERSION = 2;
export const LEGACY_JSONL_MIGRATION_NAME = 'legacy_jsonl_import_complete';

export interface JsonlInvalidRow {
	file: 'memories.jsonl' | 'proposals.jsonl';
	line: number;
	error: string;
}

export interface JsonlImportPayload {
	memories: MemoryRecord[];
	proposals: MemoryProposal[];
	invalidRows: JsonlInvalidRow[];
	totalRows: number;
}

export interface JsonlBackupResult {
	source: string;
	backup: string;
	created: boolean;
}

export interface JsonlMigrationReport {
	migration: typeof LEGACY_JSONL_MIGRATION_NAME;
	completedAt: string;
	skipped: boolean;
	reason?: string;
	importedMemories: number;
	importedProposals: number;
	invalidRows: JsonlInvalidRow[];
	backups: JsonlBackupResult[];
}

export function resolveMemoryStorageDir(
	rootDirectory: string,
	config: Partial<MemoryConfig> = {},
): string {
	const resolved = resolveConfig(config);
	const storageDir = resolved.storageDir.replace(/^\.swarm[/\\]?/, '');
	return validateSwarmPath(rootDirectory, storageDir);
}

export function resolveSqliteDatabasePath(
	rootDirectory: string,
	config: Partial<MemoryConfig> = {},
): string {
	const resolved = resolveConfig(config);
	const relativePath = resolved.sqlite.path.replace(/^\.swarm[/\\]?/, '');
	return validateSwarmPath(rootDirectory, relativePath);
}

export async function readLegacyJsonl(
	rootDirectory: string,
	config: Partial<MemoryConfig> = {},
): Promise<JsonlImportPayload> {
	const resolved = resolveConfig(config);
	const storageDir = resolveMemoryStorageDir(rootDirectory, resolved);
	const memoryLoad = await readMemoryJsonl(
		path.join(storageDir, 'memories.jsonl'),
		resolved,
	);
	const proposalLoad = await readProposalJsonl(
		path.join(storageDir, 'proposals.jsonl'),
		resolved,
	);
	return {
		memories: memoryLoad.records,
		proposals: proposalLoad.records,
		invalidRows: [...memoryLoad.invalidRows, ...proposalLoad.invalidRows],
		totalRows: memoryLoad.totalRows + proposalLoad.totalRows,
	};
}

export async function backupLegacyJsonl(
	rootDirectory: string,
	config: Partial<MemoryConfig> = {},
): Promise<JsonlBackupResult[]> {
	const storageDir = resolveMemoryStorageDir(rootDirectory, config);
	const backupDir = path.join(storageDir, 'backups');
	await mkdir(backupDir, { recursive: true });
	const results: JsonlBackupResult[] = [];
	for (const filename of ['memories.jsonl', 'proposals.jsonl'] as const) {
		const source = path.join(storageDir, filename);
		if (!existsSync(source)) continue;
		const backup = path.join(backupDir, `${filename}.pre-sqlite-migration`);
		if (existsSync(backup)) {
			results.push({ source, backup, created: false });
			continue;
		}
		await copyFile(source, backup);
		results.push({ source, backup, created: true });
	}
	return results;
}

export async function writeJsonlExport(
	rootDirectory: string,
	config: Partial<MemoryConfig>,
	memories: MemoryRecord[],
	proposals: MemoryProposal[],
): Promise<{ directory: string; memoriesPath: string; proposalsPath: string }> {
	const exportDir = path.join(
		resolveMemoryStorageDir(rootDirectory, config),
		'export',
	);
	await mkdir(exportDir, { recursive: true });
	const memoriesPath = path.join(exportDir, 'memories.jsonl');
	const proposalsPath = path.join(exportDir, 'proposals.jsonl');
	await writeFile(memoriesPath, toJsonl(memories), 'utf-8');
	await writeFile(proposalsPath, toJsonl(proposals), 'utf-8');
	return { directory: exportDir, memoriesPath, proposalsPath };
}

export async function writeMigrationReport(
	rootDirectory: string,
	report: JsonlMigrationReport,
	config: Partial<MemoryConfig> = {},
): Promise<string> {
	const reportPath = path.join(
		resolveMemoryStorageDir(rootDirectory, config),
		'migration-report.json',
	);
	await mkdir(path.dirname(reportPath), { recursive: true });
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
	return reportPath;
}

export async function readMigrationReport(
	rootDirectory: string,
	config: Partial<MemoryConfig> = {},
): Promise<JsonlMigrationReport | null> {
	const reportPath = path.join(
		resolveMemoryStorageDir(rootDirectory, config),
		'migration-report.json',
	);
	if (!existsSync(reportPath)) return null;
	try {
		return JSON.parse(await readFile(reportPath, 'utf-8'));
	} catch {
		return null;
	}
}

export async function getLegacyJsonlFileStatus(
	rootDirectory: string,
	config: Partial<MemoryConfig> = {},
): Promise<
	Array<{
		file: 'memories.jsonl' | 'proposals.jsonl';
		path: string;
		exists: boolean;
		sizeBytes: number;
	}>
> {
	const storageDir = resolveMemoryStorageDir(rootDirectory, config);
	const statuses = [];
	for (const file of ['memories.jsonl', 'proposals.jsonl'] as const) {
		const filePath = path.join(storageDir, file);
		let sizeBytes = 0;
		if (existsSync(filePath)) {
			sizeBytes = (await stat(filePath)).size;
		}
		statuses.push({
			file,
			path: filePath,
			exists: existsSync(filePath),
			sizeBytes,
		});
	}
	return statuses;
}

function resolveConfig(config: Partial<MemoryConfig>): MemoryConfig {
	return {
		...DEFAULT_MEMORY_CONFIG,
		...config,
		sqlite: {
			...DEFAULT_MEMORY_CONFIG.sqlite,
			...(config.sqlite ?? {}),
		},
		recall: {
			...DEFAULT_MEMORY_CONFIG.recall,
			...(config.recall ?? {}),
			injection: {
				...DEFAULT_MEMORY_CONFIG.recall.injection,
				...(config.recall?.injection ?? {}),
			},
		},
		writes: {
			...DEFAULT_MEMORY_CONFIG.writes,
			...(config.writes ?? {}),
		},
		redaction: {
			...DEFAULT_MEMORY_CONFIG.redaction,
			...(config.redaction ?? {}),
		},
	};
}

async function readMemoryJsonl(
	filePath: string,
	config: MemoryConfig,
): Promise<{
	records: MemoryRecord[];
	invalidRows: JsonlInvalidRow[];
	totalRows: number;
}> {
	const rows = await readJsonlRows(filePath);
	const records: MemoryRecord[] = [];
	const invalidRows: JsonlInvalidRow[] = [];
	for (const row of rows.rows) {
		try {
			records.push(
				validateMemoryRecordRules(row.value as MemoryRecord, {
					rejectDurableSecrets: config.redaction.rejectDurableSecrets,
				}),
			);
		} catch (err) {
			invalidRows.push({
				file: 'memories.jsonl',
				line: row.line,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	for (const row of rows.invalidRows) {
		invalidRows.push({ file: 'memories.jsonl', ...row });
	}
	return { records, invalidRows, totalRows: rows.totalRows };
}

async function readProposalJsonl(
	filePath: string,
	config: MemoryConfig,
): Promise<{
	records: MemoryProposal[];
	invalidRows: JsonlInvalidRow[];
	totalRows: number;
}> {
	const rows = await readJsonlRows(filePath);
	const records: MemoryProposal[] = [];
	const invalidRows: JsonlInvalidRow[] = [];
	for (const row of rows.rows) {
		try {
			const proposal = validateMemoryProposal(row.value as MemoryProposal);
			if (proposal.proposedRecord) {
				validateMemoryRecordRules(proposal.proposedRecord, {
					rejectDurableSecrets: config.redaction.rejectDurableSecrets,
				});
			}
			records.push(proposal);
		} catch (err) {
			invalidRows.push({
				file: 'proposals.jsonl',
				line: row.line,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	for (const row of rows.invalidRows) {
		invalidRows.push({ file: 'proposals.jsonl', ...row });
	}
	return { records, invalidRows, totalRows: rows.totalRows };
}

async function readJsonlRows(filePath: string): Promise<{
	rows: Array<{ line: number; value: unknown }>;
	invalidRows: Array<{ line: number; error: string }>;
	totalRows: number;
}> {
	if (!existsSync(filePath)) {
		return { rows: [], invalidRows: [], totalRows: 0 };
	}
	const content = await readFile(filePath, 'utf-8');
	const rows: Array<{ line: number; value: unknown }> = [];
	const invalidRows: Array<{ line: number; error: string }> = [];
	let totalRows = 0;
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const trimmed = lines[index].trim();
		if (!trimmed) continue;
		totalRows++;
		try {
			rows.push({ line: index + 1, value: JSON.parse(trimmed) });
		} catch (err) {
			invalidRows.push({
				line: index + 1,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return { rows, invalidRows, totalRows };
}

function toJsonl(values: unknown[]): string {
	return (
		values.map((value) => JSON.stringify(value)).join('\n') +
		(values.length > 0 ? '\n' : '')
	);
}
