import {
	closeSync,
	constants as FS_CONSTANTS,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type { AgentDefinition } from '../agents/index.js';
import {
	DEFAULT_HARNESS_EVOLUTION_CONFIG,
	type HarnessEvolutionConfig,
	type PluginConfig,
} from '../config/schema.js';
import {
	parseBlueprintPatch,
	parseHarnessBlueprint,
	parseHarnessCandidateManifest,
} from '../harness/contracts.js';
import {
	createAgentFactory,
	type RuntimeAgentDefinition,
} from '../harness/factory.js';
import { canonicalJson } from '../harness/hash.js';
import {
	auditHarnessLedger,
	HarnessStoreIntegrityError,
	listHarnessHistory,
	loadHarnessCandidate,
	loadHarnessCurrent,
	loadHarnessVersion,
} from '../harness/store.js';
import { validateTargetWithinRoot } from '../utils/path-security.js';

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

type HarnessCommandOptions = {
	config?: PluginConfig;
};

type HarnessCommandEnvelope =
	| {
			v: 1;
			ok: true;
			command: string;
			truncated: boolean;
			maxOutputBytes: number;
			result: Record<string, unknown>;
	  }
	| {
			v: 1;
			ok: false;
			command: string;
			truncated: false;
			maxOutputBytes: number;
			error: {
				code: string;
				message: string;
			};
	  };

function getHarnessConfig(config?: PluginConfig): HarnessEvolutionConfig {
	return config?.harness_evolution ?? DEFAULT_HARNESS_EVOLUTION_CONFIG;
}

function measureUtf8(text: string): number {
	return Buffer.byteLength(text, 'utf8');
}

function serializeEnvelope(
	envelope: HarnessCommandEnvelope,
	maxOutputBytes: number,
): string | null {
	const serialized = JSON.stringify(envelope);
	return measureUtf8(serialized) <= maxOutputBytes ? serialized : null;
}

function buildSuccessEnvelope(
	command: string,
	result: Record<string, unknown>,
	truncated: boolean,
	maxOutputBytes: number,
): HarnessCommandEnvelope {
	return {
		v: 1,
		ok: true,
		command,
		truncated,
		maxOutputBytes,
		result,
	};
}

function buildErrorEnvelope(
	command: string,
	code: string,
	message: string,
	maxOutputBytes: number,
): string {
	const serialized = serializeEnvelope(
		{
			v: 1,
			ok: false,
			command,
			truncated: false,
			maxOutputBytes,
			error: { code, message },
		},
		maxOutputBytes,
	);
	if (serialized) return serialized;
	return JSON.stringify({
		v: 1,
		ok: false,
		command,
		truncated: false,
		maxOutputBytes,
		error: {
			code: 'HARNESS_OUTPUT_TOO_LARGE',
			message:
				'harness command error envelope exceeded the configured output limit',
		},
	} satisfies HarnessCommandEnvelope);
}

function buildBoundedSuccess(
	command: string,
	maxOutputBytes: number,
	builders: Array<() => Record<string, unknown>>,
): string {
	for (let index = 0; index < builders.length; index++) {
		const serialized = serializeEnvelope(
			buildSuccessEnvelope(
				command,
				builders[index](),
				index > 0,
				maxOutputBytes,
			),
			maxOutputBytes,
		);
		if (serialized) return serialized;
	}
	return buildErrorEnvelope(
		command,
		'HARNESS_OUTPUT_TOO_LARGE',
		'harness command output exceeded the configured output limit',
		maxOutputBytes,
	);
}

function enforceArgCount(
	command: string,
	args: string[],
	expectedMin: number,
	expectedMax: number,
	usage: string,
	maxOutputBytes: number,
): string | null {
	if (args.length < expectedMin || args.length > expectedMax) {
		return buildErrorEnvelope(
			command,
			'HARNESS_COMMAND_USAGE',
			usage,
			maxOutputBytes,
		);
	}
	return null;
}

function parseBlueprintHistoryArgs(
	command: string,
	args: string[],
	maxOutputBytes: number,
): { limit: number } | { error: string } {
	const usage = 'usage: /swarm blueprint history [--limit <1..100>]';
	if (args.length === 0) {
		return { limit: 100 };
	}
	if (args.length !== 2 || args[0] !== '--limit') {
		return {
			error: buildErrorEnvelope(
				command,
				'HARNESS_COMMAND_USAGE',
				usage,
				maxOutputBytes,
			),
		};
	}
	const rawLimit = args[1];
	// Require a pure decimal integer so values like "1.5" or "+1" fail closed.
	if (!/^\d+$/.test(rawLimit)) {
		return {
			error: buildErrorEnvelope(
				command,
				'HARNESS_COMMAND_USAGE',
				usage,
				maxOutputBytes,
			),
		};
	}
	const limit = Number.parseInt(rawLimit, 10);
	if (limit < 1 || limit > 100) {
		return {
			error: buildErrorEnvelope(
				command,
				'HARNESS_COMMAND_USAGE',
				usage,
				maxOutputBytes,
			),
		};
	}
	return { limit };
}

function boundedJsonFile(
	directory: string,
	relativePath: string,
	config: HarnessEvolutionConfig,
): unknown {
	const rejection = validateTargetWithinRoot(relativePath, directory);
	if (rejection) throw new Error(`unsafe input path: ${rejection}`);
	const target = path.resolve(directory, relativePath);
	const stat = lstatSync(target);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error('input must be a regular non-symlink file');
	}
	if ((stat.nlink ?? 1) > 1) {
		throw new Error('input must not be a hardlinked file');
	}
	if (stat.size > config.max_output_bytes) {
		throw new Error('input exceeds the configured harness command size limit');
	}
	const fd = openSync(target, FS_CONSTANTS.O_RDONLY);
	try {
		const opened = fstatSync(fd);
		if (
			!opened.isFile() ||
			opened.isSymbolicLink() ||
			(opened.nlink ?? 1) > 1 ||
			opened.dev !== stat.dev ||
			opened.ino !== stat.ino
		) {
			throw new Error('input changed while being read');
		}
		if (opened.size > config.max_output_bytes) {
			throw new Error(
				'input exceeds the configured harness command size limit',
			);
		}
		const raw = readFileSync(fd, 'utf8');
		const after = fstatSync(fd);
		if (
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			after.size !== opened.size
		) {
			throw new Error('input changed while being read');
		}
		return JSON.parse(raw) as unknown;
	} finally {
		closeSync(fd);
	}
}

function inputPathExists(directory: string, relativePath: string): boolean {
	if (validateTargetWithinRoot(relativePath, directory)) return false;
	try {
		lstatSync(path.resolve(directory, relativePath));
		return true;
	} catch {
		return false;
	}
}

function requireArtifactId(
	command: string,
	value: string,
	kind: 'candidate' | 'version',
	maxOutputBytes: number,
): string | null {
	if (ARTIFACT_ID_RE.test(value)) return null;
	return buildErrorEnvelope(
		command,
		'HARNESS_INVALID_IDENTIFIER',
		`${kind} id must match ${ARTIFACT_ID_RE.source}`,
		maxOutputBytes,
	);
}

function safeCandidate(
	candidate: Awaited<ReturnType<typeof loadHarnessCandidate>>,
) {
	if (!candidate) return null;
	const { patch: _patch, ...manifest } = candidate.candidate;
	return {
		v: candidate.v,
		recordedAt: candidate.recordedAt,
		manifest,
		baseBlueprintHash: candidate.baseBlueprint?.contentHash ?? null,
		targetBlueprintHash: candidate.targetBlueprint?.contentHash ?? null,
		blueprintPatchId: candidate.blueprintPatch?.patchId ?? null,
	};
}

function summarizeBlueprint(
	blueprint: ReturnType<typeof parseHarnessBlueprint>,
) {
	return {
		blueprintId: blueprint.blueprintId,
		contentHash: blueprint.contentHash,
		definitionsHash: blueprint.definitionsHash,
		defaultAgent: blueprint.orchestration.defaultAgent,
		agentCount: blueprint.agents.length,
		toolCount: blueprint.tools.length,
		promptCount: blueprint.agents.length,
		constraints: {
			maxFiles: blueprint.constraints.maxFiles,
			maxVersions: blueprint.constraints.maxVersions,
			maxReplayRecords: blueprint.constraints.maxReplayRecords,
			maxOutputBytes: blueprint.constraints.maxOutputBytes,
		},
	};
}

function summarizeCandidate(
	candidate: NonNullable<ReturnType<typeof safeCandidate>>,
) {
	return {
		candidateId: candidate.manifest.candidateId,
		manifestHash: candidate.manifest.manifestHash,
		riskTier: candidate.manifest.riskTier,
		fileCount: candidate.manifest.files.length,
		approvedPathCount: candidate.manifest.approvedPaths.length,
		baseBlueprintHash: candidate.baseBlueprintHash,
		targetBlueprintHash: candidate.targetBlueprintHash,
		blueprintPatchId: candidate.blueprintPatchId,
		recordedAt: candidate.recordedAt,
	};
}

function blueprintDiff(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
	const result: Record<string, { before: unknown; after: unknown }> = {};
	for (const key of [
		...new Set([...Object.keys(left), ...Object.keys(right)]),
	].sort()) {
		if (canonicalJson(left[key]) !== canonicalJson(right[key])) {
			result[key] = { before: left[key], after: right[key] };
		}
	}
	return result;
}

function summarizeBlueprintDiff(
	changes: Record<string, { before: unknown; after: unknown }>,
) {
	return {
		changeCount: Object.keys(changes).length,
		changedKeys: Object.keys(changes).sort(),
	};
}

function projectStaticBlueprint(agents: Record<string, AgentDefinition>) {
	const runtimeDefinitions: RuntimeAgentDefinition[] = Object.entries(agents)
		.sort(
			([leftKey, left], [rightKey, right]) =>
				left.name.localeCompare(right.name) || leftKey.localeCompare(rightKey),
		)
		.map(([, agent]) => {
			const config = agent.config as RuntimeAgentDefinition['config'];
			const tools = config.tools
				? Object.fromEntries(
						Object.entries(config.tools).sort(([a], [b]) => a.localeCompare(b)),
					)
				: config.tools;
			return {
				name: agent.name,
				description: agent.description,
				config: {
					...config,
					tools,
					mode: config.mode === 'primary' ? 'primary' : 'subagent',
					temperature: config.temperature ?? 0.1,
					prompt:
						config.prompt ?? `Static runtime definition for ${agent.name}`,
				},
			};
		});
	const registeredToolIds = [
		...new Set(
			runtimeDefinitions.flatMap((definition) =>
				Object.keys(definition.config.tools ?? {}),
			),
		),
	].sort();
	return createAgentFactory({
		runtimeDefinitions,
		registeredToolIds,
	}).projectBlueprint({
		blueprintId: 'static-runtime-shadow',
	});
}

function boundedHistoryRecords(
	command: string,
	history: Awaited<ReturnType<typeof listHarnessHistory>>,
	quarantinePath: string | null,
	maxOutputBytes: number,
): string {
	const records = history.records;
	let low = 0;
	let high = records.length;
	let bestCount = 0;

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const serialized = serializeEnvelope(
			buildSuccessEnvelope(
				command,
				{
					recordCount: mid,
					totalRecordCount: history.totalRecordCount,
					totalSegments: history.totalSegments,
					records: records.slice(0, mid),
					quarantinePath,
				},
				history.truncated || mid < history.totalRecordCount,
				maxOutputBytes,
			),
			maxOutputBytes,
		);
		if (serialized) {
			bestCount = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	const best = serializeEnvelope(
		buildSuccessEnvelope(
			command,
			{
				recordCount: bestCount,
				totalRecordCount: history.totalRecordCount,
				totalSegments: history.totalSegments,
				records: records.slice(0, bestCount),
				quarantinePath,
			},
			history.truncated || bestCount < history.totalRecordCount,
			maxOutputBytes,
		),
		maxOutputBytes,
	);
	if (best) return best;

	return buildErrorEnvelope(
		command,
		'HARNESS_OUTPUT_TOO_LARGE',
		'harness history output exceeded the configured output limit',
		maxOutputBytes,
	);
}

function asErrorMessage(error: unknown): string {
	if (error instanceof HarnessStoreIntegrityError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

async function readCommittedVersionIds(
	directory: string,
	maxReplayRecords: number,
): Promise<Set<string>> {
	const history = await auditHarnessLedger(directory, {
		maxReplayRecords,
		maxSegments: maxReplayRecords,
	});
	if (history.outcome !== 'ok') {
		throw new Error(
			`harness ledger audit exceeded segment scope ${history.maxSegments}`,
		);
	}
	return new Set(
		history.records.flatMap((record) =>
			record.versionId ? [record.versionId] : [],
		),
	);
}

async function loadCommittedHarnessVersion(
	directory: string,
	versionId: string,
	maxReplayRecords: number,
) {
	const committedVersionIds = await readCommittedVersionIds(
		directory,
		maxReplayRecords,
	);
	if (!committedVersionIds.has(versionId)) return null;
	return loadHarnessVersion(directory, versionId);
}

export async function handleBlueprintValidateCommand(
	directory: string,
	args: string[],
	options: HarnessCommandOptions = {},
): Promise<string> {
	const command = 'blueprint.validate';
	const config = getHarnessConfig(options.config);
	const usage = enforceArgCount(
		command,
		args,
		1,
		1,
		'usage: /swarm blueprint validate <project-relative-json|version-id>',
		config.max_output_bytes,
	);
	if (usage) return usage;

	try {
		let value: unknown;
		try {
			value = boundedJsonFile(directory, args[0], config);
		} catch (fileError) {
			if (inputPathExists(directory, args[0])) throw fileError;
			const artifactIdError = requireArtifactId(
				command,
				args[0],
				'version',
				config.max_output_bytes,
			);
			if (artifactIdError) throw fileError;
			const stored = await loadCommittedHarnessVersion(
				directory,
				args[0],
				config.max_replay_records,
			);
			if (!stored?.blueprint) {
				throw new Error(
					`blueprint version ${args[0]} is not committed in harness ledger`,
				);
			}
			value = stored.blueprint;
		}
		try {
			const blueprint = parseHarnessBlueprint(value);
			return buildBoundedSuccess(command, config.max_output_bytes, [
				() => ({
					kind: 'blueprint',
					contentHash: blueprint.contentHash,
					blueprintId: blueprint.blueprintId,
					constraints: blueprint.constraints,
				}),
			]);
		} catch {
			const blueprintPatch = parseBlueprintPatch(value);
			return buildBoundedSuccess(command, config.max_output_bytes, [
				() => ({
					kind: 'blueprint_patch',
					patchId: blueprintPatch.patchId,
					expectedBaseHash: blueprintPatch.expectedBaseHash,
					expectedResultHash: blueprintPatch.expectedResultHash,
				}),
			]);
		}
	} catch (error) {
		return buildErrorEnvelope(
			command,
			'HARNESS_VALIDATION_FAILED',
			asErrorMessage(error),
			config.max_output_bytes,
		);
	}
}

export async function handleBlueprintCurrentCommand(
	directory: string,
	agents: Record<string, AgentDefinition>,
	options: HarnessCommandOptions = {},
): Promise<string> {
	const command = 'blueprint.current';
	const config = getHarnessConfig(options.config);

	try {
		const current = await loadHarnessCurrent(
			directory,
			config.max_replay_records,
		);
		const version = current.currentVersionId
			? await loadHarnessVersion(directory, current.currentVersionId)
			: null;
		if (current.currentVersionId && (!version || !version.blueprint)) {
			throw new HarnessStoreIntegrityError(
				current.currentVersionId,
				'active harness version is missing',
			);
		}
		const blueprint = version?.blueprint ?? projectStaticBlueprint(agents);
		return buildBoundedSuccess(command, config.max_output_bytes, [
			() => ({
				source: version?.blueprint ? 'activated' : 'static-shadow',
				current,
				blueprint,
			}),
			() => ({
				source: version?.blueprint ? 'activated' : 'static-shadow',
				current,
				blueprintSummary: summarizeBlueprint(blueprint),
			}),
		]);
	} catch (error) {
		return buildErrorEnvelope(
			command,
			'HARNESS_CURRENT_FAILED',
			asErrorMessage(error),
			config.max_output_bytes,
		);
	}
}

export async function handleBlueprintHistoryCommand(
	directory: string,
	args: string[] = [],
	options: HarnessCommandOptions = {},
): Promise<string> {
	const command = 'blueprint.history';
	const config = getHarnessConfig(options.config);
	const parsed = parseBlueprintHistoryArgs(
		command,
		args,
		config.max_output_bytes,
	);
	if ('error' in parsed) return parsed.error;

	try {
		const history = await listHarnessHistory(directory, {
			maxReplayRecords: config.max_replay_records,
			limit: parsed.limit,
		});
		return boundedHistoryRecords(
			command,
			history,
			history.quarantinePath,
			config.max_output_bytes,
		);
	} catch (error) {
		return buildErrorEnvelope(
			command,
			'HARNESS_HISTORY_FAILED',
			asErrorMessage(error),
			config.max_output_bytes,
		);
	}
}

export async function handleBlueprintDiffCommand(
	directory: string,
	args: string[],
	options: HarnessCommandOptions = {},
): Promise<string> {
	const command = 'blueprint.diff';
	const config = getHarnessConfig(options.config);
	const usage = enforceArgCount(
		command,
		args,
		2,
		2,
		'usage: /swarm blueprint diff <from-version> <to-version>',
		config.max_output_bytes,
	);
	if (usage) return usage;

	const fromIdError = requireArtifactId(
		command,
		args[0],
		'version',
		config.max_output_bytes,
	);
	if (fromIdError) return fromIdError;
	const toIdError = requireArtifactId(
		command,
		args[1],
		'version',
		config.max_output_bytes,
	);
	if (toIdError) return toIdError;

	try {
		const committedVersionIds = await readCommittedVersionIds(
			directory,
			config.max_replay_records,
		);
		const missing = [args[0], args[1]].filter(
			(versionId) => !committedVersionIds.has(versionId),
		);
		if (missing.length > 0) {
			return buildErrorEnvelope(
				command,
				'HARNESS_NOT_FOUND',
				`blueprint version ${missing[0]} is not committed in harness ledger`,
				config.max_output_bytes,
			);
		}
		const [from, to] = await Promise.all([
			loadHarnessVersion(directory, args[0]),
			loadHarnessVersion(directory, args[1]),
		]);
		if (!from?.blueprint || !to?.blueprint) {
			return buildErrorEnvelope(
				command,
				'HARNESS_NOT_FOUND',
				'both versions must contain a stored blueprint',
				config.max_output_bytes,
			);
		}
		const changes = blueprintDiff(
			from.blueprint as unknown as Record<string, unknown>,
			to.blueprint as unknown as Record<string, unknown>,
		);
		return buildBoundedSuccess(command, config.max_output_bytes, [
			() => ({
				from: from.versionId,
				to: to.versionId,
				changes,
			}),
			() => ({
				from: from.versionId,
				to: to.versionId,
				summary: summarizeBlueprintDiff(changes),
			}),
		]);
	} catch (error) {
		return buildErrorEnvelope(
			command,
			'HARNESS_DIFF_FAILED',
			asErrorMessage(error),
			config.max_output_bytes,
		);
	}
}

export async function handleBlueprintExportCommand(
	directory: string,
	args: string[],
	options: HarnessCommandOptions = {},
): Promise<string> {
	const command = 'blueprint.export';
	const config = getHarnessConfig(options.config);
	const usage = enforceArgCount(
		command,
		args,
		0,
		1,
		'usage: /swarm blueprint export [version-id]',
		config.max_output_bytes,
	);
	if (usage) return usage;
	if (args[0]) {
		const artifactIdError = requireArtifactId(
			command,
			args[0],
			'version',
			config.max_output_bytes,
		);
		if (artifactIdError) return artifactIdError;
	}

	try {
		const current = await loadHarnessCurrent(
			directory,
			config.max_replay_records,
		);
		const versionId = args[0] ?? current.currentVersionId;
		if (!versionId) {
			return buildErrorEnvelope(
				command,
				'HARNESS_NOT_FOUND',
				'no harness blueprint version is active',
				config.max_output_bytes,
			);
		}
		const version = await loadCommittedHarnessVersion(
			directory,
			versionId,
			config.max_replay_records,
		);
		if (!version?.blueprint) {
			return buildErrorEnvelope(
				command,
				'HARNESS_NOT_FOUND',
				`blueprint version ${versionId} is not committed in harness ledger`,
				config.max_output_bytes,
			);
		}
		const blueprint = version.blueprint;
		return buildBoundedSuccess(command, config.max_output_bytes, [
			() => ({
				versionId,
				blueprint,
			}),
			() => ({
				versionId,
				blueprintSummary: summarizeBlueprint(blueprint),
			}),
		]);
	} catch (error) {
		return buildErrorEnvelope(
			command,
			'HARNESS_EXPORT_FAILED',
			asErrorMessage(error),
			config.max_output_bytes,
		);
	}
}

export async function handleHarnessCandidateValidateCommand(
	directory: string,
	args: string[],
	options: HarnessCommandOptions = {},
): Promise<string> {
	const command = 'harness.candidate.validate';
	const config = getHarnessConfig(options.config);
	const usage = enforceArgCount(
		command,
		args,
		1,
		1,
		'usage: /swarm harness candidate validate <project-relative-json|candidate-id>',
		config.max_output_bytes,
	);
	if (usage) return usage;

	try {
		let value: unknown;
		try {
			value = boundedJsonFile(directory, args[0], config);
		} catch (fileError) {
			const artifactIdError = requireArtifactId(
				command,
				args[0],
				'candidate',
				config.max_output_bytes,
			);
			if (artifactIdError) throw fileError;
			const stored = await loadHarnessCandidate(
				directory,
				args[0],
				config.max_replay_records,
			);
			if (!stored) throw fileError;
			value = stored;
		}
		const record = value as { candidate?: unknown };
		const manifest = parseHarnessCandidateManifest(record.candidate ?? value);
		return buildBoundedSuccess(command, config.max_output_bytes, [
			() => ({
				candidateId: manifest.candidateId,
				manifestHash: manifest.manifestHash,
				riskTier: manifest.riskTier,
				fileCount: manifest.files.length,
			}),
		]);
	} catch (error) {
		return buildErrorEnvelope(
			command,
			'HARNESS_CANDIDATE_INVALID',
			asErrorMessage(error),
			config.max_output_bytes,
		);
	}
}

export async function handleHarnessCandidateShowCommand(
	directory: string,
	args: string[],
	options: HarnessCommandOptions = {},
): Promise<string> {
	const command = 'harness.candidate.show';
	const config = getHarnessConfig(options.config);
	const usage = enforceArgCount(
		command,
		args,
		1,
		1,
		'usage: /swarm harness candidate show <candidate-id>',
		config.max_output_bytes,
	);
	if (usage) return usage;

	const artifactIdError = requireArtifactId(
		command,
		args[0],
		'candidate',
		config.max_output_bytes,
	);
	if (artifactIdError) return artifactIdError;

	try {
		const candidate = safeCandidate(
			await loadHarnessCandidate(directory, args[0], config.max_replay_records),
		);
		if (!candidate) {
			return buildErrorEnvelope(
				command,
				'HARNESS_NOT_FOUND',
				`harness candidate ${args[0]} was not found`,
				config.max_output_bytes,
			);
		}
		return buildBoundedSuccess(command, config.max_output_bytes, [
			() => candidate,
			() => summarizeCandidate(candidate),
		]);
	} catch (error) {
		return buildErrorEnvelope(
			command,
			'HARNESS_CANDIDATE_SHOW_FAILED',
			asErrorMessage(error),
			config.max_output_bytes,
		);
	}
}

export async function handleHarnessCandidateDiffCommand(
	directory: string,
	args: string[],
	options: HarnessCommandOptions = {},
): Promise<string> {
	const command = 'harness.candidate.diff';
	const config = getHarnessConfig(options.config);
	const usage = enforceArgCount(
		command,
		args,
		1,
		1,
		'usage: /swarm harness candidate diff <candidate-id>',
		config.max_output_bytes,
	);
	if (usage) return usage;

	const artifactIdError = requireArtifactId(
		command,
		args[0],
		'candidate',
		config.max_output_bytes,
	);
	if (artifactIdError) return artifactIdError;

	try {
		const candidate = await loadHarnessCandidate(
			directory,
			args[0],
			config.max_replay_records,
		);
		if (!candidate) {
			return buildErrorEnvelope(
				command,
				'HARNESS_NOT_FOUND',
				`harness candidate ${args[0]} was not found`,
				config.max_output_bytes,
			);
		}
		const blueprintChanges =
			candidate.baseBlueprint && candidate.targetBlueprint
				? blueprintDiff(
						candidate.baseBlueprint as unknown as Record<string, unknown>,
						candidate.targetBlueprint as unknown as Record<string, unknown>,
					)
				: null;
		return buildBoundedSuccess(command, config.max_output_bytes, [
			() => ({
				candidateId: candidate.candidate.candidateId,
				manifestHash: candidate.candidate.manifestHash,
				files: candidate.candidate.files,
				blueprintChanges,
			}),
			() => ({
				candidateId: candidate.candidate.candidateId,
				manifestHash: candidate.candidate.manifestHash,
				fileCount: candidate.candidate.files.length,
				filePaths: candidate.candidate.files.map((file) => file.relativePath),
				blueprintSummary: blueprintChanges
					? summarizeBlueprintDiff(blueprintChanges)
					: null,
			}),
		]);
	} catch (error) {
		return buildErrorEnvelope(
			command,
			'HARNESS_CANDIDATE_DIFF_FAILED',
			asErrorMessage(error),
			config.max_output_bytes,
		);
	}
}
