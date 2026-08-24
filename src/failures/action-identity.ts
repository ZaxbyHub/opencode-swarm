import { createHash } from 'node:crypto';
import { stripKnownSwarmPrefix } from '../config/schema.js';

const MAX_STRING_INPUT = 512;
const MAX_PUBLIC_FIELD_LENGTH = 128;
const MAX_COLLECTION_ITEMS = 64;
const MAX_OBJECT_KEYS = 64;
const MAX_NORMALIZE_DEPTH = 6;
const DIGEST_PREFIX_LENGTH = 12;

const ROLE_KEYS = ['subagent_type', 'agent', 'role'] as const;
const TASK_KEYS = ['taskId', 'task_id', 'id'] as const;
const PHASE_KEYS = ['phase', 'phase_number'] as const;
const PARENT_SESSION_KEYS = [
	'parentSessionID',
	'parentSessionId',
	'parent_session_id',
	'parent_session',
] as const;
const PARENT_INVOCATION_KEYS = [
	'parentInvocationID',
	'parentInvocationId',
	'parent_invocation_id',
	'parent_invocation',
	'invocationID',
	'invocationId',
	'invocation_id',
] as const;
const DISPATCH_GENERATION_KEYS = [
	'dispatchGeneration',
	'dispatch_generation',
	'generationId',
	'generation_id',
	'generation',
] as const;
const MODE_KEYS = ['mode', 'execution_mode'] as const;
const BACKGROUND_KEYS = [
	'background',
	'run_in_background',
	'runInBackground',
] as const;
const SCOPE_KEYS = [
	'working_directory',
	'workingDirectory',
	'scope',
	'scope_id',
	'scopeId',
	'files',
	'file',
	'filePath',
	'path',
	'paths',
] as const;

type PresenceMarker = 'missing' | 'empty' | 'value';
type BackgroundMarker = PresenceMarker | 'invalid';

export interface ActionIdentityV1 {
	version: 1;
	tool: string;
	role: string;
	swarm: string | null;
	taskId: string | null;
	taskMarker: PresenceMarker;
	phase: string | null;
	phaseMarker: PresenceMarker;
	parentSessionDigest: string | null;
	parentSessionMarker: PresenceMarker;
	parentInvocation: string | null;
	parentInvocationMarker: PresenceMarker;
	dispatchGeneration: string | null;
	dispatchGenerationMarker: PresenceMarker;
	mode: string | null;
	modeMarker: PresenceMarker;
	background: boolean | null;
	backgroundMarker: BackgroundMarker;
	scopeDigest: string | null;
	scopeMarker: PresenceMarker;
	additionalDigest: string;
	digest: string;
	pattern: string;
}

export interface ActionIdentityInput {
	tool: string;
	args?: unknown;
}

type IdentityField = {
	marker: PresenceMarker;
	value: string | null;
};

type BackgroundField = {
	marker: BackgroundMarker;
	value: boolean | null;
};

function normalizeToolName(tool: string): string {
	return tool.trim().toLowerCase() || 'unknown-tool';
}

function hashString(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function fieldDigest(value: string | null): string | null {
	return value === null
		? null
		: hashString(value).slice(0, DIGEST_PREFIX_LENGTH);
}

function readIdentityField(
	record: Record<string, unknown> | undefined,
	keys: readonly string[],
): IdentityField {
	if (!record) return { marker: 'missing', value: null };
	for (const key of keys) {
		if (!Object.hasOwn(record, key)) continue;
		const value = record[key];
		if (value === undefined || value === null) {
			return { marker: 'empty', value: null };
		}
		if (typeof value === 'string') {
			const trimmed = value.trim();
			if (trimmed.length === 0) return { marker: 'empty', value: null };
			if (trimmed.length > MAX_PUBLIC_FIELD_LENGTH) {
				return {
					marker: 'value',
					value: `oversized:${hashString(trimmed.slice(0, MAX_STRING_INPUT))}`,
				};
			}
			return { marker: 'value', value: trimmed };
		}
		if (typeof value === 'number') {
			if (!Number.isFinite(value)) {
				return { marker: 'value', value: 'invalid:number' };
			}
			return { marker: 'value', value: String(value) };
		}
		if (typeof value === 'boolean') {
			return { marker: 'value', value: value ? 'true' : 'false' };
		}
		return {
			marker: 'value',
			value: `invalid:${Array.isArray(value) ? 'array' : typeof value}`,
		};
	}
	return { marker: 'missing', value: null };
}

function readBackgroundField(
	record: Record<string, unknown> | undefined,
): BackgroundField {
	if (!record) return { marker: 'missing', value: null };
	for (const key of BACKGROUND_KEYS) {
		if (!Object.hasOwn(record, key)) continue;
		const value = record[key];
		if (value === undefined || value === null) {
			return { marker: 'empty', value: null };
		}
		if (typeof value === 'boolean') {
			return { marker: 'value', value };
		}
		if (typeof value === 'string') {
			const normalized = value.trim().toLowerCase();
			if (normalized.length === 0) return { marker: 'empty', value: null };
			if (normalized === 'true') return { marker: 'value', value: true };
			if (normalized === 'false') return { marker: 'value', value: false };
		}
		return { marker: 'invalid', value: null };
	}
	return { marker: 'missing', value: null };
}

function canonicalRole(raw: unknown): { role: string; swarm: string | null } {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		return { role: 'unknown-role', swarm: null };
	}
	const trimmed = raw.trim();
	const role =
		stripKnownSwarmPrefix(trimmed).trim().toLowerCase() || 'unknown-role';
	if (role === trimmed.toLowerCase()) return { role, swarm: null };
	const suffix = `_${role}`;
	if (!trimmed.toLowerCase().endsWith(suffix)) return { role, swarm: null };
	const swarm = trimmed
		.slice(0, trimmed.length - suffix.length)
		.trim()
		.toLowerCase();
	return { role, swarm: swarm.length > 0 ? swarm : null };
}

function normalizeLeaf(value: unknown): unknown {
	if (value === undefined) return ['undefined'];
	if (value === null) return ['null'];
	if (typeof value === 'string') {
		return ['string', hashString(value.slice(0, MAX_STRING_INPUT))];
	}
	if (typeof value === 'number') {
		return Number.isFinite(value)
			? ['number', String(value)]
			: ['number', 'non-finite'];
	}
	if (typeof value === 'boolean') return ['boolean', value ? '1' : '0'];
	if (typeof value === 'bigint') {
		return ['bigint', hashString(String(value).slice(0, MAX_STRING_INPUT))];
	}
	return ['type', typeof value];
}

function canonicalizeAdditional(value: unknown, depth = 0): unknown {
	if (
		value === undefined ||
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		typeof value === 'bigint'
	) {
		return normalizeLeaf(value);
	}
	if (depth >= MAX_NORMALIZE_DEPTH) {
		return [
			'sentinel',
			'depth-capped',
			hashString(String(value).slice(0, MAX_STRING_INPUT)),
		];
	}
	if (Array.isArray(value)) {
		const entries = value
			.slice(0, MAX_COLLECTION_ITEMS)
			.map((entry) => canonicalizeAdditional(entry, depth + 1));
		if (value.length > MAX_COLLECTION_ITEMS) {
			entries.push(['sentinel', 'array-capped', String(value.length)]);
		}
		return ['array', ...entries];
	}
	const record = readRecord(value);
	if (!record) {
		return [
			'type',
			typeof value,
			hashString(String(value).slice(0, MAX_STRING_INPUT)),
		];
	}
	const keys = Object.keys(record).sort();
	const entries = keys
		.slice(0, MAX_OBJECT_KEYS)
		.map((key) => [key, canonicalizeAdditional(record[key], depth + 1)]);
	if (keys.length > MAX_OBJECT_KEYS) {
		entries.push([
			'__truncated_keys__',
			['sentinel', 'keys-capped', String(keys.length)],
		]);
	}
	return ['object', ...entries];
}

function omitKnownKeys(
	record: Record<string, unknown> | undefined,
	knownKeys: Set<string>,
): Record<string, unknown> | null {
	if (!record) return null;
	const entries = Object.entries(record).filter(([key]) => !knownKeys.has(key));
	return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function extractScopeIdentity(record: Record<string, unknown> | undefined): {
	marker: PresenceMarker;
	digest: string | null;
} {
	if (!record) return { marker: 'missing', digest: null };
	const present = SCOPE_KEYS.filter((key) => Object.hasOwn(record, key));
	if (present.length === 0) return { marker: 'missing', digest: null };
	const subset = Object.fromEntries(present.map((key) => [key, record[key]]));
	const allEmpty = present.every((key) => {
		const value = record[key];
		return (
			value === undefined ||
			value === null ||
			(typeof value === 'string' && value.trim().length === 0)
		);
	});
	if (allEmpty) return { marker: 'empty', digest: null };
	return {
		marker: 'value',
		digest: hashString(JSON.stringify(canonicalizeAdditional(subset))),
	};
}

function buildPatternSegment(
	label: string,
	marker: PresenceMarker | BackgroundMarker,
	digest: string | null,
): string {
	return digest ? `${label}-${marker}-${digest}` : `${label}-${marker}`;
}

export function createActionIdentity(
	input: ActionIdentityInput,
): ActionIdentityV1 {
	const args = readRecord(input.args);
	const { role, swarm } = canonicalRole(
		readIdentityField(args, ROLE_KEYS).value ??
			args?.subagent_type ??
			args?.agent ??
			args?.role,
	);
	const task = readIdentityField(args, TASK_KEYS);
	const phase = readIdentityField(args, PHASE_KEYS);
	const parentSession = readIdentityField(args, PARENT_SESSION_KEYS);
	const parentInvocation = readIdentityField(args, PARENT_INVOCATION_KEYS);
	const dispatchGeneration = readIdentityField(args, DISPATCH_GENERATION_KEYS);
	const mode = readIdentityField(args, MODE_KEYS);
	const background = readBackgroundField(args);
	const scope = extractScopeIdentity(args);
	const knownKeys = new Set<string>([
		...ROLE_KEYS,
		...TASK_KEYS,
		...PHASE_KEYS,
		...PARENT_SESSION_KEYS,
		...PARENT_INVOCATION_KEYS,
		...DISPATCH_GENERATION_KEYS,
		...MODE_KEYS,
		...BACKGROUND_KEYS,
		...SCOPE_KEYS,
	]);
	const additionalDigest = hashString(
		JSON.stringify(canonicalizeAdditional(omitKnownKeys(args, knownKeys))),
	);
	const normalized = {
		tool: normalizeToolName(input.tool),
		role,
		swarm,
		task,
		phase,
		parentSession: {
			marker: parentSession.marker,
			digest:
				parentSession.value === null ? null : hashString(parentSession.value),
		},
		parentInvocation,
		dispatchGeneration,
		mode,
		background,
		scope,
		additionalDigest,
	};
	const digest = hashString(JSON.stringify(normalized));
	const pattern = [
		normalized.tool,
		role,
		buildPatternSegment('task', task.marker, fieldDigest(task.value)),
		buildPatternSegment('phase', phase.marker, fieldDigest(phase.value)),
		buildPatternSegment(
			'gen',
			dispatchGeneration.marker,
			fieldDigest(dispatchGeneration.value),
		),
		buildPatternSegment(
			'bg',
			background.marker,
			background.value === null
				? null
				: hashString(background.value ? 'true' : 'false').slice(
						0,
						DIGEST_PREFIX_LENGTH,
					),
		),
		digest.slice(0, DIGEST_PREFIX_LENGTH),
	].join(':');
	return {
		version: 1,
		tool: normalized.tool,
		role,
		swarm,
		taskId: task.value,
		taskMarker: task.marker,
		phase: phase.value,
		phaseMarker: phase.marker,
		parentSessionDigest:
			parentSession.value === null ? null : hashString(parentSession.value),
		parentSessionMarker: parentSession.marker,
		parentInvocation: parentInvocation.value,
		parentInvocationMarker: parentInvocation.marker,
		dispatchGeneration: dispatchGeneration.value,
		dispatchGenerationMarker: dispatchGeneration.marker,
		mode: mode.value,
		modeMarker: mode.marker,
		background: background.value,
		backgroundMarker: background.marker,
		scopeDigest: scope.digest,
		scopeMarker: scope.marker,
		additionalDigest,
		digest,
		pattern,
	};
}
