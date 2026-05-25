import { existsSync } from 'node:fs';
import { loadPluginConfig } from '../config/loader';
import {
	createConfiguredMemoryProvider,
	DEFAULT_MEMORY_CONFIG,
	getLegacyJsonlFileStatus,
	readMigrationReport,
	resolveMemoryConfig,
	resolveMemoryStorageDir,
	resolveSqliteDatabasePath,
	SQLiteMemoryProvider,
	writeJsonlExport,
} from '../memory';
import type { MemoryConfig } from '../memory/config';
import type { MemoryProposalStore, MemoryProvider } from '../memory/provider';

type ExportableProvider = MemoryProvider & Partial<MemoryProposalStore>;

export async function handleMemoryCommand(
	_directory: string,
	_args: string[],
): Promise<string> {
	return [
		'## Swarm Memory',
		'',
		'- `/swarm memory status` - show provider, SQLite path, JSONL files, and last migration report',
		'- `/swarm memory export` - export current memory and proposals to `.swarm/memory/export/*.jsonl`',
		'- `/swarm memory import` - import `.swarm/memory/{memories,proposals}.jsonl` into SQLite',
		'- `/swarm memory migrate` - run the one-time legacy JSONL to SQLite migration',
	].join('\n');
}

export async function handleMemoryStatusCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	const config = resolveCommandMemoryConfig(directory);
	const storageDir = resolveMemoryStorageDir(directory, config);
	const sqlitePath = resolveSqliteDatabasePath(directory, config);
	const jsonlFiles = await getLegacyJsonlFileStatus(directory, config);
	const report = await readMigrationReport(directory, config);

	const lines = [
		'## Swarm Memory Status',
		'',
		`- Enabled: \`${config.enabled}\``,
		`- Provider: \`${config.provider}\``,
		`- Storage: \`${storageDir}\``,
		`- SQLite path: \`${sqlitePath}\``,
		`- SQLite database exists: \`${existsSync(sqlitePath)}\``,
		'',
		'### Legacy JSONL',
	];
	for (const file of jsonlFiles) {
		lines.push(
			`- ${file.file}: \`${file.exists ? 'present' : 'missing'}\` (${file.sizeBytes} bytes)`,
		);
	}
	lines.push('', '### Migration');
	if (!report) {
		lines.push('- Last report: `none`');
	} else {
		lines.push(
			`- Completed at: \`${report.completedAt}\``,
			`- Imported memories: \`${report.importedMemories}\``,
			`- Imported proposals: \`${report.importedProposals}\``,
			`- Invalid rows: \`${report.invalidRows.length}\``,
			`- Backups: \`${report.backups.length}\``,
		);
		if (report.invalidRows.length > 0) {
			lines.push('', 'Invalid rows:');
			for (const row of report.invalidRows.slice(0, 20)) {
				lines.push(`- ${row.file}:${row.line} - ${row.error}`);
			}
			if (report.invalidRows.length > 20) {
				lines.push(`- ... ${report.invalidRows.length - 20} more`);
			}
		}
	}
	return lines.join('\n');
}

export async function handleMemoryMigrateCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	const config: MemoryConfig = {
		...resolveCommandMemoryConfig(directory),
		provider: 'sqlite',
	};
	const provider = new SQLiteMemoryProvider(directory, config);
	try {
		await provider.initialize();
		const report = await readMigrationReport(directory, config);
		return formatMigrationResult('migration', report);
	} finally {
		provider.close();
	}
}

export async function handleMemoryImportCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	const config: MemoryConfig = {
		...resolveCommandMemoryConfig(directory),
		provider: 'sqlite',
	};
	const provider = new SQLiteMemoryProvider(directory, config);
	try {
		const result = await provider.importJsonl();
		const lines = [
			'## Swarm Memory Import',
			'',
			`- Imported memories: \`${result.importedMemories}\``,
			`- Imported proposals: \`${result.importedProposals}\``,
			`- Total JSONL rows scanned: \`${result.totalRows}\``,
			`- Invalid rows: \`${result.invalidRows.length}\``,
		];
		appendInvalidRows(lines, result.invalidRows);
		return lines.join('\n');
	} finally {
		provider.close();
	}
}

export async function handleMemoryExportCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	const config = resolveCommandMemoryConfig(directory);
	const provider = createConfiguredMemoryProvider(
		directory,
		config,
	) as ExportableProvider;
	try {
		await provider.initialize?.();
		const memories = await provider.list({ includeExpired: true });
		const proposals = provider.listProposals
			? await provider.listProposals()
			: [];
		const output = await writeJsonlExport(
			directory,
			config,
			memories,
			proposals,
		);
		return [
			'## Swarm Memory Export',
			'',
			`- Memories: \`${memories.length}\` -> \`${output.memoriesPath}\``,
			`- Proposals: \`${proposals.length}\` -> \`${output.proposalsPath}\``,
		].join('\n');
	} finally {
		await provider.close?.();
	}
}

function resolveCommandMemoryConfig(directory: string): MemoryConfig {
	const loaded = loadPluginConfig(directory).memory;
	return resolveMemoryConfig(loaded ?? DEFAULT_MEMORY_CONFIG);
}

function formatMigrationResult(
	label: string,
	report: Awaited<ReturnType<typeof readMigrationReport>>,
): string {
	if (!report) {
		return [
			`## Swarm Memory ${label}`,
			'',
			'No migration report was written.',
		].join('\n');
	}
	const lines = [
		`## Swarm Memory ${label}`,
		'',
		`- Completed at: \`${report.completedAt}\``,
		`- Imported memories: \`${report.importedMemories}\``,
		`- Imported proposals: \`${report.importedProposals}\``,
		`- Invalid rows: \`${report.invalidRows.length}\``,
		`- Backups: \`${report.backups.length}\``,
	];
	if (report.backups.length > 0) {
		lines.push('', 'Backups:');
		for (const backup of report.backups) {
			lines.push(
				`- \`${backup.backup}\` (${backup.created ? 'created' : 'already existed'})`,
			);
		}
	}
	appendInvalidRows(lines, report.invalidRows);
	return lines.join('\n');
}

function appendInvalidRows(
	lines: string[],
	invalidRows: Array<{ file: string; line: number; error: string }>,
): void {
	if (invalidRows.length === 0) return;
	lines.push('', 'Invalid rows:');
	for (const row of invalidRows.slice(0, 20)) {
		lines.push(`- ${row.file}:${row.line} - ${row.error}`);
	}
	if (invalidRows.length > 20) {
		lines.push(`- ... ${invalidRows.length - 20} more`);
	}
}
