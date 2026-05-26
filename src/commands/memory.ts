import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginConfig } from '../config/loader';
import {
	createConfiguredMemoryProvider,
	DEFAULT_MEMORY_CONFIG,
	evaluateMemoryRecallFixtures,
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

const PACKAGE_ROOT = path.resolve(
	resolvePackageRootFromModule(fileURLToPath(import.meta.url)),
);

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
		'- `/swarm memory evaluate --json` - run the golden recall evaluation fixtures and emit a JSON report',
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

export async function handleMemoryEvaluateCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseEvaluateArgs(directory, args);
	if ('error' in parsed) return parsed.error;
	const report = await evaluateMemoryRecallFixtures({
		fixtureDirectory: parsed.fixtureDirectory,
	});
	if (parsed.json) return `${JSON.stringify(report, null, 2)}\n`;
	return [
		'## Swarm Memory Recall Evaluation',
		'',
		`- Fixtures: \`${report.summary.fixture_count}\``,
		`- Runs: \`${report.summary.run_count}\``,
		`- Passed runs: \`${report.summary.passed_run_count}\``,
		`- Precision@k: \`${report.summary['precision@k'].toFixed(3)}\``,
		`- Recall@k: \`${report.summary['recall@k'].toFixed(3)}\``,
		`- Injection count: \`${report.summary.injection_count}\``,
		`- Noisy injections: \`${report.summary.noisy_injection_count}\``,
		`- Same-scope noise: \`${report.summary.same_scope_noise_count}\``,
		`- Cross-scope leaks: \`${report.summary.cross_scope_leak_count}\``,
		`- Stale memories: \`${report.summary.stale_memory_count}\``,
		'',
		'Use `/swarm memory evaluate --json` for the full report.',
	].join('\n');
}

function resolveCommandMemoryConfig(directory: string): MemoryConfig {
	const loaded = loadPluginConfig(directory).memory;
	return resolveMemoryConfig(loaded ?? DEFAULT_MEMORY_CONFIG);
}

function parseEvaluateArgs(
	directory: string,
	args: string[],
): { json: boolean; fixtureDirectory: string } | { error: string } {
	let json = false;
	let fixtureDirectory = path.join(
		PACKAGE_ROOT,
		'tests',
		'fixtures',
		'memory-recall',
	);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--json') {
			json = true;
			continue;
		}
		if (arg === '--fixtures') {
			const next = args[i + 1];
			if (!next) {
				return {
					error:
						'Usage: /swarm memory evaluate [--json] [--fixtures <directory>]',
				};
			}
			fixtureDirectory = path.resolve(directory, next);
			i++;
			continue;
		}
		return {
			error: 'Usage: /swarm memory evaluate [--json] [--fixtures <directory>]',
		};
	}
	return { json, fixtureDirectory };
}

function resolvePackageRootFromModule(modulePath: string): string {
	const moduleDir = path.dirname(modulePath);
	const leaf = path.basename(moduleDir);
	if (leaf === 'commands' || leaf === 'cli') {
		return path.resolve(moduleDir, '..', '..');
	}
	if (leaf === 'dist') {
		return path.resolve(moduleDir, '..');
	}
	return path.resolve(moduleDir, '..');
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
