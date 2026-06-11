import {
	buildOpenSpecProjectionSync,
	loadSddStatusSync,
	writeProjectedSpecSync,
} from '../sdd/effective-spec';

const USAGE = `Usage:
  /swarm sdd status [--json]
  /swarm sdd validate [--json] [--change <id>]
  /swarm sdd project [--dry-run] [--json] [--change <id>]

OpenSpec-compatible SDD support:
  - reads checked-in openspec/specs and openspec/changes artifacts
  - produces one effective Swarm spec for planning
  - keeps tasks.md as proposal input; .swarm/plan-ledger.jsonl remains execution state`;

interface ParsedSddArgs {
	json: boolean;
	dryRun: boolean;
	changeId?: string;
	error?: string;
}

function parseArgs(args: string[]): ParsedSddArgs {
	const parsed: ParsedSddArgs = { json: false, dryRun: false };
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === '--json') {
			parsed.json = true;
		} else if (token === '--dry-run') {
			parsed.dryRun = true;
		} else if (token === '--change') {
			if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
				return { ...parsed, error: '--change requires a value' };
			}
			const value = args[++i];
			if (
				value.includes('/') ||
				value.includes('\\') ||
				value.includes('..') ||
				value.includes('[') ||
				value.includes(']')
			) {
				return {
					...parsed,
					error:
						'--change must be a single OpenSpec change id with no path separators, traversal, or brackets',
				};
			}
			parsed.changeId = value;
		} else {
			return { ...parsed, error: `Unknown flag "${token}"` };
		}
	}
	return parsed;
}

function formatList(items: string[]): string {
	return items.length > 0
		? items.map((item) => `- ${item}`).join('\n')
		: '- none';
}

export async function handleSddStatusCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseArgs(args);
	if (parsed.error) return `Error: ${parsed.error}\n\n${USAGE}`;
	const status = loadSddStatusSync(directory);
	if (parsed.json) return JSON.stringify(status, null, 2);

	const changes = status.changes.map(
		(change) =>
			`${change.id} (${change.specs.length} spec file${change.specs.length === 1 ? '' : 's'}, proposal=${change.proposal}, design=${change.design}, tasks=${change.tasks})`,
	);

	return [
		'## SDD Status',
		'',
		`Provider: ${status.provider}`,
		`Swarm spec: ${status.swSpecExists ? 'present' : 'missing'}`,
		`OpenSpec root: ${status.openSpecExists ? 'present' : 'missing'}`,
		`Current OpenSpec specs: ${status.currentSpecs.length}`,
		`Active OpenSpec changes: ${status.changes.length}`,
		'',
		'### Changes',
		formatList(changes),
		'',
		'### Effective Spec',
		status.effectiveSpec
			? `- source: ${status.effectiveSpec.source}\n- hash: ${status.effectiveSpec.hash}\n- sources: ${status.effectiveSpec.sourcePaths.length}`
			: '- none',
		status.errors.length > 0
			? `\n### Errors\n${formatList(status.errors)}`
			: '',
		status.warnings.length > 0
			? `\n### Warnings\n${formatList([
					...status.warnings,
					...(status.effectiveSpec?.warnings ?? []),
				])}`
			: '',
	].join('\n');
}

export async function handleSddValidateCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseArgs(args);
	if (parsed.error) return `Error: ${parsed.error}\n\n${USAGE}`;
	const status = loadSddStatusSync(directory);
	const projection = buildOpenSpecProjectionSync(directory, {
		changeId: parsed.changeId,
	});
	const errors = [...status.errors];
	const warnings = [...status.warnings, ...(projection?.warnings ?? [])];
	if (status.openSpecExists && projection === null) {
		errors.push(
			parsed.changeId
				? `No valid projection could be built for change ${parsed.changeId}.`
				: 'No valid OpenSpec projection could be built.',
		);
		if (
			status.currentSpecs.length > 0 ||
			status.changes.some((c) => c.specs.length > 0)
		) {
			errors.push(
				'No parsable OpenSpec requirements found in source artifacts.',
			);
		}
	}
	const result = {
		valid: errors.length === 0 && projection !== null,
		provider: projection ? 'openspec_projection' : status.provider,
		changeId: parsed.changeId ?? null,
		sourcePaths: projection?.sourcePaths ?? [],
		hash: projection?.hash ?? null,
		errors,
		warnings,
	};
	if (parsed.json) return JSON.stringify(result, null, 2);
	return [
		`SDD validation: ${result.valid ? 'valid' : 'invalid'}`,
		`Provider: ${result.provider}`,
		`Projected sources: ${result.sourcePaths.length}`,
		result.errors.length > 0 ? `\nErrors:\n${formatList(result.errors)}` : '',
		result.warnings.length > 0
			? `\nWarnings:\n${formatList(result.warnings)}`
			: '',
	].join('\n');
}

export async function handleSddProjectCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseArgs(args);
	if (parsed.error) return `Error: ${parsed.error}\n\n${USAGE}`;
	const result = writeProjectedSpecSync(directory, {
		changeId: parsed.changeId,
		dryRun: parsed.dryRun,
	});
	const response = {
		written: result.written,
		dryRun: parsed.dryRun,
		path: result.path,
		archivePath: result.archivePath ?? null,
		hash: result.projection?.hash ?? null,
		sourcePaths: result.projection?.sourcePaths ?? [],
		warnings: result.projection?.warnings ?? [],
	};
	if (parsed.json) return JSON.stringify(response, null, 2);
	if (!result.projection) {
		return [
			'SDD projection failed: no valid OpenSpec-compatible projection could be built.',
			'',
			USAGE,
		].join('\n');
	}
	return [
		parsed.dryRun ? 'SDD projection preview' : 'SDD projection written',
		`Path: ${result.path}`,
		`Hash: ${result.projection.hash}`,
		`Sources: ${result.projection.sourcePaths.length}`,
		result.archivePath ? `Archived previous spec: ${result.archivePath}` : '',
		result.projection.warnings.length > 0
			? `\nWarnings:\n${formatList(result.projection.warnings)}`
			: '',
	].join('\n');
}

export async function handleSddCommand(
	_directory: string,
	_args: string[],
): Promise<string> {
	return USAGE;
}

export const _test_exports = { parseArgs };
