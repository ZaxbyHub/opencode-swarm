/**
 * Issue #2487 compatibility/reachability gate.
 *
 * The registry is a declaration. This checker independently reads the project
 * migration catalog and scans production source for the closed legacy-token
 * universe before comparing those facts with the declaration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	COMPATIBILITY_SCHEMA_VERSION,
	ISSUE_2487_COMPATIBILITY_ROWS,
	SQLITE_EQUIVALENCE_PARTITIONS,
	SUPPORTED_PROJECT_SCHEMA_VERSION,
	type CompatibilityRow,
} from './issue-2487-compatibility.data';
import {
	ISSUE_2487_LEGACY_SOURCE_CENSUS,
	type Issue2487LegacySourceDefinition,
} from './issue-2487-legacy-census.data';
import { RETENTION_REGISTRY } from './retention-registry.data';
import type { RetentionRow } from './retention-registry.data';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_DISPOSITIONS = new Set(['supported', 'retained-legacy', 'retired']);
const ALLOWED_SURFACES = new Set(['sqlite-table', 'legacy-stream']);
const ALLOWED_SCENARIOS = new Set([
	'cross-runtime',
	'recovery',
	'kill-switches',
	'archive-restore',
	'reachability',
	'field-scale',
]);
const ALLOWED_QUALIFICATION_GROUPS = new Set([
	'project-constraints-cross-runtime',
	'observability-production-retention',
	'schema-migration-open-recovery',
	'legacy-import-reachability',
]);

type LegacySourceDefinition = Issue2487LegacySourceDefinition;

interface MigrationFact {
	version: number;
	name: string;
	sql: string;
}

interface SourceFact {
	id: string;
	path: string;
	files: string[];
	tokens: string[];
}

function sourceFiles(root: string): string[] {
	const found: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(absolute);
				continue;
			}
			if (
				(entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.js')) &&
				!entry.name.includes('.test.') &&
				!absolute.includes(`${path.sep}__tests__${path.sep}`)
			) {
				found.push(absolute);
			}
		}
	};
	visit(path.join(root, 'src'));
	return found;
}

function parseMigrations(source: string): MigrationFact[] {
	const start = source.indexOf('const MIGRATIONS: Migration[] = [');
	const end = source.indexOf('\n];', start);
	if (start < 0 || end < 0) return [];
	const block = source.slice(start, end);
	const facts: MigrationFact[] = [];
	const pattern = /\n\t\{\s*version:\s*(\d+),\s*name:\s*'([^']+)',([\s\S]*?)\n\t\},/g;
	for (const match of block.matchAll(pattern)) {
		const sqlBody = match[3].trim().replace(/,$/, '').trim();
		const sqlMatch = sqlBody.match(/^sql:\s*`([\s\S]*)`$/) ?? sqlBody.match(/^sql:\s*'((?:\\.|[^'])*)'$/);
		if (sqlMatch === null) continue;
		facts.push({
			version: Number(match[1]),
			name: match[2],
			sql: sqlMatch[1],
		});
	}
	return facts;
}

function deriveTables(migrations: readonly MigrationFact[]): Map<string, number> {
	const tables = new Map<string, number>();
	for (const migration of migrations) {
		for (const match of migration.sql.matchAll(/\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
			tables.set(match[1], migration.version);
		}
	}
	return tables;
}

function deriveLegacyReachability(
	root: string,
	definitions: readonly LegacySourceDefinition[] = ISSUE_2487_LEGACY_SOURCE_CENSUS,
): SourceFact[] {
	const files = sourceFiles(root);
	const contents = files.map((file) => ({
		file,
		text: fs.readFileSync(file, 'utf8'),
	}));
	return definitions.map((candidate) => {
		const hits = contents.filter(({ text }) => candidate.tokens.some((token) => text.includes(token)));
		return {
			id: candidate.id,
			path: candidate.path,
			files: hits.map(({ file }) => path.relative(root, file)),
			tokens: candidate.tokens.filter((token) => contents.some(({ text }) => text.includes(token))),
		};
	});
}

function collectLegacyCensusErrors(
	root: string,
	definitions: readonly LegacySourceDefinition[],
	retentionRows: readonly RetentionRow[],
	rows: readonly CompatibilityRow[],
): string[] {
	const errors: string[] = [];
	const censusIds = new Set<string>();
	const retentionById = new Map(retentionRows.map((row) => [row.id, row]));
	const matrixById = new Map(rows.map((row) => [row.id, row]));
	const productionSources = sourceFiles(root).map((file) => ({
		file,
		text: fs.readFileSync(file, 'utf8'),
	}));
	for (const candidate of definitions) {
		if (censusIds.has(candidate.id)) {
			errors.push(`duplicate independent legacy census id: ${candidate.id}`);
		}
		censusIds.add(candidate.id);
		const sourcePath = path.join(root, candidate.sourceFile);
		if (!fs.existsSync(sourcePath)) {
			errors.push(`legacy census source file does not exist: ${candidate.sourceFile}`);
			continue;
		}
		const source = fs.readFileSync(sourcePath, 'utf8');
		for (const token of candidate.tokens) {
			if (!productionSources.some((item) => item.text.includes(token))) {
				errors.push(`legacy census token is absent: ${candidate.sourceFile}:${token}`);
			}
		}
		if (!candidate.tokens.some((token) => source.includes(token))) {
			errors.push(`legacy census source anchor is absent: ${candidate.sourceFile}:${candidate.id}`);
		}
		const retention = retentionById.get(candidate.retentionId);
		if (!retention) {
			errors.push(`legacy census retention row is missing: ${candidate.retentionId}`);
		} else if (!retention.issue2487Legacy) {
			errors.push(
				`retention legacy candidate is missing issue2487Legacy metadata: ${candidate.retentionId}`,
			);
		} else {
			const metadata = retention.issue2487Legacy;
			if (metadata.path !== candidate.path) {
				errors.push(`legacy census path mismatch: ${candidate.id}`);
			}
			if (metadata.sourceFile !== candidate.sourceFile) {
				errors.push(`legacy census source file mismatch: ${candidate.id}`);
			}
			for (const token of candidate.tokens) {
				if (!metadata.tokens.includes(token)) {
					errors.push(`legacy census token is not retained as metadata: ${candidate.id}:${token}`);
				}
			}
		}
		if (!matrixById.has(candidate.id)) {
			errors.push(`legacy source definition is unregistered: ${candidate.id}`);
		}
	}
	for (const row of retentionRows) {
		if (!row.issue2487Legacy) continue;
		if (!censusIds.has(row.id)) {
			errors.push(`retention legacy metadata has no independent census source: ${row.id}`);
		}
	}
	return errors;
}

function sourceReferenceErrors(root: string, rows: readonly CompatibilityRow[]): string[] {
	const errors: string[] = [];
	for (const row of rows.filter((candidate) => candidate.surface === 'legacy-stream')) {
		for (const reference of [...row.writers, ...row.readers]) {
			const match = reference.match(/^(.+):([A-Za-z_$][A-Za-z0-9_$]*)$/);
			if (match === null) {
				errors.push(`${row.id}: legacy source reference must be file:symbol: ${reference}`);
				continue;
			}
			const filePath = path.join(root, match[1]);
			if (!fs.existsSync(filePath)) {
				errors.push(`${row.id}: legacy source file does not exist: ${match[1]}`);
				continue;
			}
			if (!fs.readFileSync(filePath, 'utf8').includes(match[2])) {
				errors.push(`${row.id}: legacy source symbol is absent: ${reference}`);
			}
		}
	}
	return errors;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function collectRowShapeErrors(rows: readonly CompatibilityRow[]): string[] {
	const errors: string[] = [];
	const ids = new Set<string>();
	const tables = new Set<string>();
	for (const row of rows) {
		if (ids.has(row.id)) errors.push(`duplicate registry id: ${row.id}`);
		ids.add(row.id);
		if (!ALLOWED_SURFACES.has(row.surface)) errors.push(`${row.id}: unsupported surface ${row.surface}`);
		if (!ALLOWED_DISPOSITIONS.has(row.disposition)) errors.push(`${row.id}: unsupported disposition ${row.disposition}`);
		if (!ALLOWED_SCENARIOS.has(row.evidenceScenario)) errors.push(`${row.id}: unsupported evidence scenario`);
		if (!ALLOWED_QUALIFICATION_GROUPS.has(row.qualificationGroup)) errors.push(`${row.id}: unsupported qualification group`);
		if (!nonEmpty(row.qualificationRationale)) errors.push(`${row.id}: qualification rationale must be non-empty`);
		if (row.writers.length === 0 || row.readers.length === 0) errors.push(`${row.id}: writers/readers must not be empty`);
		for (const value of [row.rollout, row.rollback, row.fallback, row.archiveRestore]) {
			if (!nonEmpty(value)) errors.push(`${row.id}: rollout/rollback/fallback/archiveRestore must be non-empty`);
		}
		if (row.surface === 'sqlite-table') {
			if (!nonEmpty(row.table) || !Number.isInteger(row.migrationVersion)) {
				errors.push(`${row.id}: SQLite rows require table and integer migrationVersion`);
			} else if (tables.has(row.table)) {
				errors.push(`duplicate SQLite table row: ${row.table}`);
			} else {
				tables.add(row.table);
			}
		} else if (!nonEmpty(row.legacyPath)) {
			errors.push(`${row.id}: legacy rows require legacyPath`);
		}
		const control = row.control;
		if (control.kind === 'always-on-authority') {
			for (const value of [control.justification, control.recoveryOperation, control.rollbackOperation]) {
				if (!nonEmpty(value)) errors.push(`${row.id}: always-on authority policy is incomplete`);
			}
			if (!control.justification.toLowerCase().includes('always-on')) {
				errors.push(`${row.id}: always-on policy must state its justification`);
			}
			if (!control.recoveryOperation.includes('getProjectDb') || !control.recoveryOperation.includes('closeProjectDb')) {
				errors.push(`${row.id}: always-on recovery must name getProjectDb and closeProjectDb`);
			}
			if (!control.rollbackOperation.includes('archiveSqliteSnapshot') || !control.rollbackOperation.includes('getProjectDb')) {
				errors.push(`${row.id}: always-on rollback must name archiveSqliteSnapshot and getProjectDb`);
			}
		} else if (control.kind === 'production-read-switch') {
			for (const value of [control.name, control.enabledEvidence, control.disabledEvidence]) {
				if (!nonEmpty(value)) errors.push(`${row.id}: production-read switch policy is incomplete`);
			}
		} else {
			errors.push(`${row.id}: unsupported authority control`);
		}
	}
	return errors;
}

function collectEquivalencePartitionErrors(
	root: string,
	actualTables: ReadonlyMap<string, number>,
): string[] {
	const errors: string[] = [];
	const claimed = new Map<string, string>();
	const source = sourceFiles(root).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
	for (const partition of SQLITE_EQUIVALENCE_PARTITIONS) {
		if (partition.tables.length === 0) errors.push(`${partition.id}: empty equivalence partition`);
		if (partition.productionApis.length === 0 || partition.semanticTests.length === 0) {
			errors.push(`${partition.id}: representative APIs and semantic tests are required`);
		}
		for (const table of partition.tables) {
			if (claimed.has(table)) errors.push(`SQLite table appears in two equivalence partitions: ${table} (${claimed.get(table)}, ${partition.id})`);
			claimed.set(table, partition.id);
		}
		for (const api of partition.productionApis) {
			if (!source.includes(api)) errors.push(`${partition.id}: production API is absent from source: ${api}`);
		}
		for (const testPath of partition.semanticTests) {
			if (!fs.existsSync(path.join(root, testPath))) errors.push(`${partition.id}: semantic test is absent: ${testPath}`);
		}
	}
	for (const table of actualTables.keys()) {
		if (!claimed.has(table)) errors.push(`SQLite table lacks an equivalence partition: ${table}`);
	}
	for (const table of claimed.keys()) {
		if (!actualTables.has(table)) errors.push(`equivalence partition names non-existent SQLite table: ${table}`);
	}
	return errors;
}

export interface CompatibilityCheckOptions {
	rows?: readonly CompatibilityRow[];
	supportedProjectSchemaVersion?: number;
	legacySourceDefinitions?: readonly LegacySourceDefinition[];
	retentionRows?: readonly RetentionRow[];
}

export function collectIssue2487CompatibilityErrors(
	root = REPO_ROOT,
	options: CompatibilityCheckOptions = {},
): string[] {
	const rows = options.rows ?? ISSUE_2487_COMPATIBILITY_ROWS;
	const retentionRows = options.retentionRows ?? RETENTION_REGISTRY;
	const legacyDefinitions = options.legacySourceDefinitions ?? ISSUE_2487_LEGACY_SOURCE_CENSUS;
	const errors = collectRowShapeErrors(rows);
	errors.push(...sourceReferenceErrors(root, rows));
	errors.push(
		...collectLegacyCensusErrors(
			root,
			legacyDefinitions,
			retentionRows,
			rows,
		),
	);
	const productionSource = fs.existsSync(path.join(root, 'src'))
		? sourceFiles(root).map((file) => fs.readFileSync(file, 'utf8')).join('\n')
		: '';
	for (const row of rows) {
		if (row.control.kind !== 'production-read-switch') continue;
		if (!productionSource.includes(row.control.name)) {
			errors.push(`${row.id}: production-read switch is not a real source control: ${row.control.name}`);
		}
		if (!row.control.enabledEvidence.toLowerCase().includes('enabled') || !row.control.disabledEvidence.toLowerCase().includes('disabled')) {
			errors.push(`${row.id}: production-read switch requires enabled and disabled evidence`);
		}
	}
	const projectDbPath = path.join(root, 'src', 'db', 'project-db.ts');
	if (!fs.existsSync(projectDbPath)) return [...errors, 'missing src/db/project-db.ts'];

	const migrations = parseMigrations(fs.readFileSync(projectDbPath, 'utf8'));
	if (migrations.length === 0) errors.push('could not independently parse MIGRATIONS from src/db/project-db.ts');
	const versions = migrations.map((migration) => migration.version).sort((a, b) => a - b);
	const supportedVersion = versions.at(-1);
	if (supportedVersion === undefined) return errors;
	if (versions.some((version, index) => version !== index + 1)) {
		errors.push(`migration catalog is not contiguous from v1 through v${supportedVersion}`);
	}
	const declaredSchemaVersion = options.supportedProjectSchemaVersion ?? SUPPORTED_PROJECT_SCHEMA_VERSION;
	if (declaredSchemaVersion !== supportedVersion) {
		errors.push(`stale schema claim: registry max=${declaredSchemaVersion} source max=${supportedVersion}`);
	}
	if (COMPATIBILITY_SCHEMA_VERSION !== 1) errors.push('unsupported compatibility registry schema version');

	const actualTables = deriveTables(migrations);
	const declaredTables = new Map(
		rows.filter((row) => row.surface === 'sqlite-table').map((row) => [row.table!, row.migrationVersion!]),
	);
	for (const [table, version] of actualTables) {
		if (!declaredTables.has(table)) errors.push(`unregistered SQLite table: ${table}`);
		else if (declaredTables.get(table) !== version) errors.push(`stale table migration: ${table} registry=${declaredTables.get(table)} source=${version}`);
	}
	for (const table of declaredTables.keys()) {
		if (!actualTables.has(table)) errors.push(`registry names non-existent SQLite table: ${table}`);
	}
	errors.push(...collectEquivalencePartitionErrors(root, actualTables));

	const reachability = deriveLegacyReachability(root, legacyDefinitions);
	const rowsById = new Map(rows.map((row) => [row.id, row]));
	for (const fact of reachability) {
		const row = rowsById.get(fact.id);
		if (fact.files.length > 0 && row === undefined) errors.push(`reachable legacy surface is unregistered: ${fact.id}`);
		if (fact.files.length > 0 && row?.disposition === 'retired') errors.push(`retired legacy surface remains reachable: ${fact.id}`);
		if (row?.surface !== 'legacy-stream') errors.push(`legacy reachability row has wrong surface: ${fact.id}`);
		if (fact.files.length > 0 && fact.tokens.length === 0) errors.push(`legacy surface matched without a recorded token: ${fact.id}`);
	}
	for (const row of rows.filter((candidate) => candidate.surface === 'legacy-stream')) {
		const candidate = legacyDefinitions.find((item) => item.id === row.id);
		if (candidate === undefined) errors.push(`legacy row has no independent reachability candidate: ${row.id}`);
		else if (candidate.path !== row.legacyPath) errors.push(`legacy path mismatch: ${row.id}`);
	}

	return errors;
}

function main(): void {
	if (process.argv.includes('--semantic-tests')) {
		for (const testPath of [
			...new Set(SQLITE_EQUIVALENCE_PARTITIONS.flatMap((partition) => partition.semanticTests)),
		]) console.log(testPath);
		return;
	}
	if (process.argv.includes('--partition-contract')) {
		console.log(JSON.stringify(SQLITE_EQUIVALENCE_PARTITIONS));
		return;
	}
	const root = process.argv[2] ? path.resolve(process.argv[2]) : REPO_ROOT;
	const errors = collectIssue2487CompatibilityErrors(root);
	if (errors.length > 0) {
		console.error('Issue #2487 compatibility check failed:');
		for (const error of errors) console.error(`- ${error}`);
		process.exit(1);
	}
	const migrations = parseMigrations(fs.readFileSync(path.join(root, 'src', 'db', 'project-db.ts'), 'utf8'));
	const actualTables = deriveTables(migrations);
	const reachable = deriveLegacyReachability(root).filter((fact) => fact.files.length > 0).length;
	const sqliteRows = ISSUE_2487_COMPATIBILITY_ROWS.filter((row) => row.surface === 'sqlite-table').length;
	console.log(`Issue #2487 compatibility check passed: schema v${migrations.at(-1)?.version}; ${actualTables.size} SQLite tables; ${reachable} reachable legacy surfaces; ${ISSUE_2487_COMPATIBILITY_ROWS.length} registry rows (${sqliteRows} SQLite).`);
}

if (import.meta.main) main();
