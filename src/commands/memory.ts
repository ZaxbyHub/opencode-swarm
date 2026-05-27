import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginConfig } from '../config/loader';
import {
	buildMemoryMaintenanceReport,
	createConfiguredMemoryProvider,
	DEFAULT_MEMORY_CONFIG,
	evaluateMemoryRecallFixtures,
	getLegacyJsonlFileStatus,
	type MemoryMaintenanceReport,
	type MemoryRecallUsageByMemory,
	type MemoryRecallUsageByRole,
	type MemoryRecord,
	readMigrationReport,
	resolveMemoryConfig,
	resolveMemoryStorageDir,
	resolveSqliteDatabasePath,
	SQLiteMemoryProvider,
	writeJsonlExport,
} from '../memory';
import type { MemoryConfig } from '../memory/config';
import type {
	MemoryCompactResult,
	MemoryProposalStore,
	MemoryProvider,
} from '../memory/provider';

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
		'- `/swarm memory pending` - show pending proposals and recent rejection reasons',
		'- `/swarm memory recall-log` - summarize recall usage by agent role and memory ID',
		'- `/swarm memory stale` - list expired scratch, superseded, deleted, and low-utility memories',
		'- `/swarm memory compact` - dry-run compaction; pass `--confirm` to remove deleted, superseded, and expired scratch records',
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
		`- Automatic destructive cleanup: \`disabled\``,
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

export async function handleMemoryPendingCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseMaintenanceArgs(args, {
		usage: 'Usage: /swarm memory pending [--limit <n>]',
		allowConfirm: false,
	});
	if ('error' in parsed) return parsed.error;
	const config = resolveCommandMemoryConfig(directory);
	const provider = createMaintenanceProvider(directory, config);
	try {
		await provider.initialize?.();
		const report = await buildMemoryMaintenanceReport(provider, {
			...maintenanceReportOptions(config, parsed.limit),
		});
		const lines = [
			'## Swarm Memory Pending',
			'',
			`- Pending proposals shown: \`${report.pendingProposals.length}\``,
			`- Rejected proposal reasons shown: \`${report.rejectedProposalReasons.length}\``,
		];
		appendProposalLines(lines, 'Pending proposals', report.pendingProposals);
		appendProposalLines(
			lines,
			'Rejected proposal reasons',
			report.rejectedProposalReasons,
		);
		return lines.join('\n');
	} finally {
		await provider.close?.();
	}
}

export async function handleMemoryRecallLogCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseMaintenanceArgs(args, {
		usage: 'Usage: /swarm memory recall-log [--limit <n>]',
		allowConfirm: false,
	});
	if ('error' in parsed) return parsed.error;
	const config = resolveCommandMemoryConfig(directory);
	const provider = createMaintenanceProvider(directory, config);
	try {
		await provider.initialize?.();
		const report = await buildMemoryMaintenanceReport(provider, {
			...maintenanceReportOptions(config, parsed.limit),
		});
		const lines = [
			'## Swarm Memory Recall Log',
			'',
			`- Recall events scanned: \`${report.recallEventCount}\``,
			`- Most-recalled memories shown: \`${report.mostRecalledMemories.length}\``,
			`- Never-recalled memories shown: \`${report.neverRecalledMemories.length}\``,
		];
		appendRecallRoleLines(lines, report.recallByAgentRole);
		appendRecallMemoryLines(lines, report.mostRecalledMemories);
		appendMemoryLines(
			lines,
			'Never-recalled memories',
			report.neverRecalledMemories,
		);
		return lines.join('\n');
	} finally {
		await provider.close?.();
	}
}

export async function handleMemoryStaleCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseMaintenanceArgs(args, {
		usage: 'Usage: /swarm memory stale [--limit <n>]',
		allowConfirm: false,
	});
	if ('error' in parsed) return parsed.error;
	const config = resolveCommandMemoryConfig(directory);
	const provider = createMaintenanceProvider(directory, config);
	try {
		await provider.initialize?.();
		const report = await buildMemoryMaintenanceReport(provider, {
			...maintenanceReportOptions(config, parsed.limit),
		});
		const lines = [
			'## Swarm Memory Stale',
			'',
			`- Active memories: \`${report.activeMemories}\``,
			`- Expired scratch memories shown: \`${report.expiredScratchMemories.length}\``,
			`- Deleted tombstones shown: \`${report.deletedMemories.length}\``,
			`- Superseded memories shown: \`${report.supersededMemories.length}\``,
			`- Low-utility memories shown: \`${report.lowUtilityMemories.length}\``,
		];
		appendMemoryLines(
			lines,
			'Expired scratch memories',
			report.expiredScratchMemories,
		);
		appendMemoryLines(lines, 'Deleted tombstones', report.deletedMemories);
		appendSupersededChains(lines, report);
		appendMemoryLines(lines, 'Low-utility memories', report.lowUtilityMemories);
		return lines.join('\n');
	} finally {
		await provider.close?.();
	}
}

export async function handleMemoryCompactCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseMaintenanceArgs(args, {
		usage: 'Usage: /swarm memory compact [--confirm]',
		allowConfirm: true,
		allowLimit: false,
	});
	if ('error' in parsed) return parsed.error;
	const provider = createMaintenanceProvider(
		directory,
		resolveCommandMemoryConfig(directory),
	);
	try {
		await provider.initialize?.();
		if (!provider.compactMaintenance) {
			return 'Memory provider does not support compaction.';
		}
		const result = await provider.compactMaintenance({
			dryRun: !parsed.confirm,
		});
		return formatCompactResult(result, parsed.confirm);
	} finally {
		await provider.close?.();
	}
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

function createMaintenanceProvider(
	directory: string,
	config: MemoryConfig,
): ExportableProvider {
	return createConfiguredMemoryProvider(
		directory,
		config,
	) as ExportableProvider;
}

function maintenanceReportOptions(
	config: MemoryConfig,
	limit: number,
): {
	limit: number;
	lowUtilityMaxConfidence: number;
	lowUtilityMinAgeDays: number;
} {
	return {
		limit,
		lowUtilityMaxConfidence: config.maintenance.lowUtilityMaxConfidence,
		lowUtilityMinAgeDays: config.maintenance.lowUtilityMinAgeDays,
	};
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

function parseMaintenanceArgs(
	args: string[],
	options: { usage: string; allowConfirm: boolean; allowLimit?: boolean },
): { limit: number; confirm: boolean } | { error: string } {
	let limit = 20;
	let confirm = false;
	const allowLimit = options.allowLimit ?? true;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--confirm' && options.allowConfirm) {
			confirm = true;
			continue;
		}
		if (arg === '--limit' && allowLimit) {
			const next = args[i + 1];
			if (!next || !/^\d+$/.test(next)) return { error: options.usage };
			limit = Math.min(100, Math.max(1, Number(next)));
			i++;
			continue;
		}
		return { error: options.usage };
	}
	return { limit, confirm };
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

function appendProposalLines(
	lines: string[],
	title: string,
	proposals: MemoryMaintenanceReport['pendingProposals'],
): void {
	lines.push('', `### ${title}`);
	if (proposals.length === 0) {
		lines.push('- none');
		return;
	}
	for (const proposal of proposals) {
		const reason =
			proposal.status === 'rejected'
				? ` - ${proposal.rejectionReason ?? 'no reason recorded'}`
				: '';
		lines.push(
			`- \`${proposal.id}\` ${proposal.operation} ${proposal.targetMemoryId ?? proposal.proposedRecord?.id ?? 'new'} (${proposal.status})${reason}`,
		);
	}
}

function appendMemoryLines(
	lines: string[],
	title: string,
	memories: MemoryRecord[],
): void {
	lines.push('', `### ${title}`);
	if (memories.length === 0) {
		lines.push('- none');
		return;
	}
	for (const memory of memories) {
		lines.push(
			`- \`${memory.id}\` ${memory.kind} confidence=${memory.confidence.toFixed(2)} updated=${memory.updatedAt} - ${truncate(memory.text, 100)}`,
		);
	}
}

function appendRecallRoleLines(
	lines: string[],
	roles: MemoryRecallUsageByRole[],
): void {
	lines.push('', '### Recall by agent role');
	if (roles.length === 0) {
		lines.push('- none');
		return;
	}
	for (const role of roles) {
		const memoryCount = Object.keys(role.memoryIds).length;
		lines.push(
			`- \`${role.agentRole}\`: ${role.count} recall event(s), ${memoryCount} memory ID(s)`,
		);
	}
}

function appendRecallMemoryLines(
	lines: string[],
	memories: MemoryRecallUsageByMemory[],
): void {
	lines.push('', '### Most-recalled memories');
	if (memories.length === 0) {
		lines.push('- none');
		return;
	}
	for (const memory of memories) {
		lines.push(
			`- \`${memory.memoryId}\`: ${memory.count} hit(s), last=${memory.lastRecalledAt}, avgScore=${memory.averageScore.toFixed(3)}`,
		);
	}
}

function appendSupersededChains(
	lines: string[],
	report: MemoryMaintenanceReport,
): void {
	lines.push('', '### Superseded chains');
	if (report.supersededChains.length === 0) {
		lines.push('- none');
		return;
	}
	for (const chain of report.supersededChains) {
		const reason = chain.reason ? ` - ${chain.reason}` : '';
		lines.push(
			`- ${chain.chain.map((id) => `\`${id}\``).join(' -> ')}${reason}`,
		);
	}
}

function formatCompactResult(
	result: MemoryCompactResult,
	confirmed: boolean,
): string {
	const lines = [
		'## Swarm Memory Compact',
		'',
		`- Mode: \`${confirmed ? 'confirmed' : 'dry-run'}\``,
		`- Deleted tombstones: \`${result.removedDeleted}\``,
		`- Superseded records: \`${result.removedSuperseded}\``,
		`- Expired scratch records: \`${result.removedExpiredScratch}\``,
		`- Remaining memories: \`${result.remaining}\``,
	];
	if (!confirmed) {
		lines.push(
			'',
			'No records were removed. Re-run `/swarm memory compact --confirm` to apply this compaction.',
		);
	}
	return lines.join('\n');
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 3)}...`;
}
