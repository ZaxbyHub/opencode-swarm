import {
	buildOpenSpecProjectionSync,
	detectSpeckit,
	loadSddStatusSync,
	resolveSpeckitProjection,
	validateSpeckit,
	writeProjectedSpecSync,
} from '../sdd/effective-spec';
import type { SpeckitResolution } from '../sdd/effective-spec';

const USAGE = `Usage:
  /swarm sdd status [--json] [--source <provider>]
  /swarm sdd validate [--json] [--change <id>] [--source <provider>] [--feature <id>]
  /swarm sdd project [--dry-run] [--json] [--change <id>] [--source <provider>] [--feature <id>]

Source options (required when both openspec and speckit are detected):
  --source <swarm|openspec|speckit>  select the SDD provider explicitly
  --feature <id>                     Spec-Kit feature directory name to project
                                     (required when multiple Spec-Kit features exist)

OpenSpec-compatible SDD support:
  - reads checked-in openspec/specs and openspec/changes artifacts
  - produces one effective Swarm spec for planning
  - keeps tasks.md as proposal input; .swarm/plan-ledger.jsonl remains execution state

Spec-Kit SDD support:
  - detects .specify/ marker + specs/NNN-feature-name/spec.md layout
  - projects a single Spec-Kit feature into .swarm/spec.md via /swarm sdd project
  - use --source speckit or --source openspec to disambiguate when both are present`;

interface ParsedSddArgs {
	json: boolean;
	dryRun: boolean;
	changeId?: string;
	source?: 'swarm' | 'openspec' | 'speckit';
	feature?: string;
	error?: string;
}

/**
 * Returns true when `value` contains characters that are unsafe in a directory
 * name id: path separators, traversal sequences, or bracket characters.
 *
 * Shared by both --change and --feature so the same rejection logic is reused
 * (task 2.2 explicit requirement; matches sdd.ts:36-49 pre-task baseline).
 */
function isUnsafeId(value: string): boolean {
	return (
		value.includes('/') ||
		value.includes('\\') ||
		value.includes('..') ||
		value.includes('[') ||
		value.includes(']')
	);
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
			if (isUnsafeId(value)) {
				return {
					...parsed,
					error: '--change must be a single OpenSpec change id with no path separators, traversal, or brackets',
				};
			}
			parsed.changeId = value;
		} else if (token === '--source') {
			if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
				return { ...parsed, error: '--source requires a value' };
			}
			const value = args[++i];
			if (value !== 'swarm' && value !== 'openspec' && value !== 'speckit') {
				return {
					...parsed,
					error: `--source must be one of: swarm | openspec | speckit; got "${value}"`,
				};
			}
			parsed.source = value as 'swarm' | 'openspec' | 'speckit';
		} else if (token === '--feature') {
			if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
				return { ...parsed, error: '--feature requires a value' };
			}
			const value = args[++i];
			if (isUnsafeId(value)) {
				return {
					...parsed,
					error: '--feature must be a single Spec-Kit feature directory name with no path separators, traversal, or brackets',
				};
			}
			parsed.feature = value;
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

/**
 * Map a non-ok SpeckitResolution to a user-facing error string (FR-008, FR-013).
 * Covers every non-ok kind so the command layer never re-detects ad hoc.
 */
function formatSpeckitError(resolution: SpeckitResolution): string {
	switch (resolution.kind) {
		case 'empty':
			return 'Spec-Kit layout detected (.specify/ marker present) but no feature directories found under specs/.';
		case 'ambiguous':
			return [
				`Multiple Spec-Kit features detected: ${resolution.features.join(', ')}.`,
				'Use --feature <id> to select one.',
			].join('\n');
		case 'unknown_feature':
			return [
				`Unknown Spec-Kit feature '${resolution.feature}'.`,
				`Available features: ${resolution.available.join(', ')}.`,
			].join('\n');
		case 'zero_requirements':
			return `Spec-Kit feature '${resolution.feature}' contains no parsable functional requirements.`;
		case 'too_large':
			return `Spec-Kit feature '${resolution.feature}' projected output exceeds the size limit (${resolution.bytes} bytes).`;
		case 'not_speckit':
			return 'No Spec-Kit layout detected (.specify/ marker not present).';
		case 'ok':
			// Should not be reached — callers guard on kind !== 'ok' before calling.
			return '';
	}
}

export async function handleSddStatusCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseArgs(args);
	if (parsed.error) return `Error: ${parsed.error}\n\n${USAGE}`;

	// --feature is only meaningful with Spec-Kit.
	if (parsed.feature && parsed.source && parsed.source !== 'speckit') {
		return `Error: --feature is only valid with --source speckit\n\n${USAGE}`;
	}

	// Call detectSpeckit directly — SddStatus/loadSddStatusSync are OpenSpec-only
	// and carry no Spec-Kit fields (task 2.2; plan.md critic Finding 3).
	// Do this BEFORE loadSddStatusSync so we can short-circuit on ambiguity without
	// triggering the resolver's console.warn (which fires inside readEffectiveSpecSync).
	const speckitDetection = detectSpeckit(directory);
	const speckitPresent = speckitDetection.features.length > 0;

	// FR-009/010: both sources present and no --source → hard error naming both.
	// Discriminator mirrors readEffectiveSpecSync: speckitPresent = features.length > 0,
	// openspecPresent = buildOpenSpecProjectionSync !== null.
	if (speckitPresent && !parsed.source) {
		const openspecProjection = buildOpenSpecProjectionSync(directory);
		if (openspecProjection !== null) {
			const errLines = [
				'Error: Multiple SDD sources detected (openspec, speckit).',
				'Pass --source openspec or --source speckit to select a provider.',
			];
			return parsed.json
				? JSON.stringify(
						{ error: errLines.join(' '), sources: ['openspec', 'speckit'] },
						null,
						2,
					)
				: errLines.join('\n');
		}
	}

	// Thread --source/--feature so an explicit selection wins (FR-009). The no-source
	// both-present case is already short-circuited above, so this only affects the
	// explicit-selection path and never triggers the resolver's ambiguity console.warn.
	const status = loadSddStatusSync(directory, {
		source: parsed.source,
		feature: parsed.feature,
	});

	if (parsed.json) {
		return JSON.stringify({ ...status, speckit: speckitDetection }, null, 2);
	}

	const changes = status.changes.map(
		(change) =>
			`${change.id} (${change.specs.length} spec file${change.specs.length === 1 ? '' : 's'}, proposal=${change.proposal}, design=${change.design}, tasks=${change.tasks})`,
	);

	const speckitLines = [
		'### Spec-Kit',
		`Spec-Kit provider: ${speckitDetection.markerPresent ? 'detected' : 'not present'}`,
		speckitDetection.features.length > 0
			? `Features:\n${speckitDetection.features.map((f) => `- ${f.featureId}`).join('\n')}`
			: 'Features: none',
	].join('\n');

	return [
		'## SDD Status',
		'',
		`Provider: ${status.provider}`,
		`Swarm spec: ${status.swSpecExists ? 'present' : 'missing'}`,
		`OpenSpec root: ${status.openSpecExists ? 'present' : 'missing'}`,
		`Current OpenSpec specs: ${status.currentSpecs.length}`,
		`Active OpenSpec changes: ${status.changes.length}`,
		'',
		speckitLines,
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

	// --feature is only meaningful with Spec-Kit (same guard as status/project).
	if (parsed.feature && parsed.source && parsed.source !== 'speckit') {
		return `Error: --feature is only valid with --source speckit\n\n${USAGE}`;
	}

	// Determine whether to use the Spec-Kit validation path.
	// Mirrors the detection logic from handleSddProjectCommand (task 2.2).
	let useSpeckit = false;

	if (parsed.source === 'speckit') {
		useSpeckit = true;
	} else if (!parsed.source) {
		// Auto-detect: check for Spec-Kit marker and feature dirs.
		const speckitDetection = detectSpeckit(directory);

		if (speckitDetection.features.length > 0) {
			// Spec-Kit features present — check for OpenSpec ambiguity.
			const openspecProjection = buildOpenSpecProjectionSync(directory);
			if (openspecProjection !== null) {
				// FR-009/010: both sources present, no --source → hard error naming both.
				// Reuses the same messaging path task 2.2 added (no second messaging scheme).
				const errLines = [
					'Error: Multiple SDD sources detected (openspec, speckit).',
					'Pass --source openspec or --source speckit to select a provider.',
				];
				// valid:false keeps validate's --json error shape uniform across all
				// three Spec-Kit error paths (multi-source, FR-012 empty, resolution-level).
				return parsed.json
					? JSON.stringify(
							{
								valid: false,
								error: errLines.join(' '),
								sources: ['openspec', 'speckit'],
							},
							null,
							2,
						)
					: errLines.join('\n');
			}
			useSpeckit = true;
		} else if (speckitDetection.markerPresent) {
			// FR-012: .specify/ marker present but no feature dirs (detected-but-empty).
			const openspecProjection = buildOpenSpecProjectionSync(directory);
			if (openspecProjection === null) {
				const resolution = resolveSpeckitProjection(directory);
				return parsed.json
					? JSON.stringify(
							{ valid: false, error: formatSpeckitError(resolution) },
							null,
							2,
						)
					: `Error: ${formatSpeckitError(resolution)}\n\n${USAGE}`;
			}
			// OpenSpec compensates — fall through to the OpenSpec path.
		}
		// else: no .specify/ marker → fall through to OpenSpec path.
	}
	// parsed.source === 'openspec' → useSpeckit = false (OpenSpec path, byte-identical regression guard).

	if (useSpeckit) {
		// Spec-Kit validation path (FR-007, FR-013).
		const { resolution, problems } = validateSpeckit(directory, {
			feature: parsed.feature,
		});

		if (resolution.kind !== 'ok' && resolution.kind !== 'zero_requirements') {
			// Resolution-level error — reuse the task 2.2 messaging path (FR-008/012).
			return parsed.json
				? JSON.stringify(
						{ valid: false, error: formatSpeckitError(resolution) },
						null,
						2,
					)
				: `Error: ${formatSpeckitError(resolution)}\n\n${USAGE}`;
		}

		// Projection metadata comes from the ok-resolution spec (or nulls for zero_requirements).
		const spec = resolution.kind === 'ok' ? resolution.spec : null;
		const result = {
			valid: problems.length === 0 && resolution.kind === 'ok',
			provider: 'speckit_projection' as const,
			changeId: null as string | null,
			sourcePaths: spec?.sourcePaths ?? [],
			hash: spec?.hash ?? null,
			errors: problems,
			warnings: spec?.warnings ?? [],
		};

		if (parsed.json) return JSON.stringify(result, null, 2);
		return [
			`SDD validation: ${result.valid ? 'valid' : 'invalid'}`,
			`Provider: ${result.provider}`,
			`Projected sources: ${result.sourcePaths.length}`,
			result.errors.length > 0
				? `\nErrors:\n${formatList(result.errors)}`
				: '',
			result.warnings.length > 0
				? `\nWarnings:\n${formatList(result.warnings)}`
				: '',
		].join('\n');
	}

	// OpenSpec path — byte-identical to pre-task behavior (regression-guard, FR-011).
	// Thread parsed.source/feature so --source openspec on a both-present repo does not
	// trigger the resolver's console.warn inside loadSddStatusSync (advisor item 1).
	const status = loadSddStatusSync(directory, {
		source: parsed.source,
		feature: parsed.feature,
	});
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

	// --feature is only meaningful with Spec-Kit.
	if (parsed.feature && parsed.source && parsed.source !== 'speckit') {
		return `Error: --feature is only valid with --source speckit\n\n${USAGE}`;
	}

	// --source swarm selects the native .swarm/spec.md and cannot generate a projection.
	if (parsed.source === 'swarm') {
		return `Error: --source swarm selects the native .swarm/spec.md and does not generate a projection. Use --source openspec or --source speckit.\n\n${USAGE}`;
	}

	// Determine whether to use the Spec-Kit projection path.
	let useSpeckit = false;

	if (parsed.source === 'speckit') {
		useSpeckit = true;
	} else if (!parsed.source) {
		// Auto-detect: check for Spec-Kit marker and feature dirs.
		const speckitDetection = detectSpeckit(directory);

		if (speckitDetection.features.length > 0) {
			// Spec-Kit present (features.length > 0 mirrors readEffectiveSpecSync discriminator).
			// Check for openspec using the same predicate as the resolver.
			const openspecProjection = buildOpenSpecProjectionSync(directory);
			if (openspecProjection !== null) {
				// FR-009/010: both sources present, no --source → hard error naming both.
				return [
					'Error: Multiple SDD sources detected (openspec, speckit).',
					'Pass --source openspec or --source speckit to select a provider.',
				].join('\n');
			}
			useSpeckit = true;
		} else if (speckitDetection.markerPresent) {
			// FR-012: .specify/ marker present but no feature dirs (detected-but-empty).
			// Only error when OpenSpec is also absent — with OpenSpec present, empty .specify/
			// is a non-competing source and the OpenSpec path is correct (mirrors 2.1 resolver).
			const openspecProjection = buildOpenSpecProjectionSync(directory);
			if (openspecProjection === null) {
				const resolution = resolveSpeckitProjection(directory);
				return `Error: ${formatSpeckitError(resolution)}\n\n${USAGE}`;
			}
			// OpenSpec compensates — fall through to the OpenSpec projection path.
		}
		// else: no .specify/ marker → fall through to OpenSpec path.
	}
	// parsed.source === 'openspec' → useSpeckit = false (OpenSpec path, default behavior).

	if (useSpeckit) {
		// Spec-Kit projection path (FR-002, FR-008, FR-013).
		const resolution = resolveSpeckitProjection(directory, {
			feature: parsed.feature,
		});
		if (resolution.kind !== 'ok') {
			return `Error: ${formatSpeckitError(resolution)}\n\n${USAGE}`;
		}

		// Reuse the atomic-write + archive logic in writeProjectedSpecSync (task 2.2).
		// Pass resolution.feature so the auto-selected feature id is always explicit.
		const result = writeProjectedSpecSync(directory, {
			source: 'speckit',
			feature: resolution.feature,
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
				'SDD projection failed: no valid Spec-Kit projection could be built.',
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

	// OpenSpec projection path — byte-identical to pre-task behavior (FR-011).
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
