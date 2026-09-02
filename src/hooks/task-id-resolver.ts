/**
 * Pure, bounded task-identity resolution shared by delegation hooks.
 *
 * This leaf deliberately performs no I/O and imports no plan, hook, or tool
 * modules. Callers own plan loading and may supply only finite known IDs and an
 * optional fallback whose uniqueness they have already proved.
 */

export const TASK_ID_RESOLUTION_LIMITS = {
	maxFields: 4,
	maxFieldChars: 32 * 1024,
	maxTotalChars: 128 * 1024,
	maxKnownIds: 1024,
	maxCandidates: 32,
	maxTokenChars: 80,
} as const;

export type TaskIdPolicy = 'plan' | 'attribution';
export type TaskIdSource =
	| 'explicit'
	| 'task_line'
	| 'text'
	| 'marker'
	| 'fallback';

export type TaskIdResolution =
	| { status: 'resolved'; taskId: string; source: TaskIdSource }
	| { status: 'missing' }
	| { status: 'ambiguous'; candidates: string[] }
	| { status: 'over_limit'; input: string }
	| { status: 'invalid'; input: string };

export interface ResolveTaskIdOptions {
	policy: TaskIdPolicy;
	knownPlanTaskIds?: ReadonlySet<string>;
	/** The caller observed a valid plan whose task-ID cardinality exceeded the bound. */
	planContextOverLimit?: boolean;
	fallback?: string;
	fallbackProvenUnique?: boolean;
}

export type TaskIdPlanContextOptions = Pick<
	ResolveTaskIdOptions,
	'knownPlanTaskIds' | 'planContextOverLimit'
>;

const TEXT_FIELDS = ['prompt', 'description', 'task', 'input'] as const;
const EXPLICIT_FIELDS = [
	'plan_task_id',
	'planTaskId',
	'task_id',
	'taskId',
] as const;
const STRICT_PLAN_ID = /^\d+\.\d+(?:\.\d+)*$/;
const SAFE_ATTRIBUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAN_CANDIDATE = /\b(\d+\.\d+(?:\.\d+)*)\b/g;
const TASK_LINE = /^\s*TASK\s*[:=]\s*(.*)$/gim;
const ATTRIBUTION_ID_MARKER =
	/\b(?:task_id|task-id|taskId)\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._-]*)/gi;
// TASK: is also used as a natural-language heading (for example,
// "TASK: implement the hot loop"). Only treat it as an attribution marker
// when the value is the complete token on that line; plan-policy extraction
// separately handles numeric IDs embedded in prose.
const ATTRIBUTION_TASK_MARKER =
	/\bTASK\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*(?=\r?$)/gim;
const ATTRIBUTION_ID_MARKER_RAW =
	/\b(?:task_id|task-id|taskId)\s*[:=][ \t]*([^\s]*)/gi;
const ATTRIBUTION_TASK_MARKER_RAW =
	/\bTASK\s*[:=][ \t]*([^\s]+)[ \t]*(?=\r?$)/gim;

function isSafeAttributionId(value: string): boolean {
	return (
		value.length <= TASK_ID_RESOLUTION_LIMITS.maxTokenChars &&
		SAFE_ATTRIBUTION_ID.test(value) &&
		!/^ses_/i.test(value) &&
		!value.includes('..')
	);
}

function isAllowedAttributionId(
	value: string,
	knownPlanTaskIds: ReadonlySet<string> | undefined,
	planContextOverLimit = false,
): boolean {
	if (!isSafeAttributionId(value)) return false;
	return (
		!STRICT_PLAN_ID.test(value) ||
		(!planContextOverLimit && !knownPlanTaskIds) ||
		knownPlanTaskIds?.has(value) === true
	);
}

function sorted(values: ReadonlySet<string>): string[] {
	return [...values].sort();
}

function addCandidate(
	candidates: Set<string>,
	value: string,
): TaskIdResolution | null {
	candidates.add(value);
	if (candidates.size > TASK_ID_RESOLUTION_LIMITS.maxCandidates) {
		return { status: 'over_limit', input: 'candidates' };
	}
	return null;
}

function select(
	candidates: ReadonlySet<string>,
	source: TaskIdSource,
): TaskIdResolution | null {
	if (candidates.size === 1) {
		return { status: 'resolved', taskId: [...candidates][0], source };
	}
	if (candidates.size > 1) {
		return { status: 'ambiguous', candidates: sorted(candidates) };
	}
	return null;
}

function validateKnownIds(
	knownPlanTaskIds: ReadonlySet<string> | undefined,
): TaskIdResolution | null {
	if (!knownPlanTaskIds) return null;
	if (knownPlanTaskIds.size > TASK_ID_RESOLUTION_LIMITS.maxKnownIds) {
		return { status: 'over_limit', input: 'knownPlanTaskIds' };
	}
	for (const value of knownPlanTaskIds) {
		if (
			typeof value !== 'string' ||
			value.length > TASK_ID_RESOLUTION_LIMITS.maxTokenChars ||
			!STRICT_PLAN_ID.test(value)
		) {
			return { status: 'invalid', input: 'knownPlanTaskIds' };
		}
	}
	return null;
}

function isStrictExplicitPlanField(
	value: string,
	knownPlanTaskIds: ReadonlySet<string> | undefined,
	planContextOverLimit = false,
): boolean {
	return (
		STRICT_PLAN_ID.test(value) &&
		(planContextOverLimit || knownPlanTaskIds !== undefined)
	);
}

/** Resolve a task identity without I/O or mutable session state. */
export function resolveTaskId(
	input: Record<string, unknown>,
	options: ResolveTaskIdOptions,
): TaskIdResolution {
	try {
		if (options.planContextOverLimit && options.knownPlanTaskIds) {
			return { status: 'invalid', input: 'planContext' };
		}
		if (options.planContextOverLimit && options.policy === 'plan') {
			return { status: 'over_limit', input: 'knownPlanTaskIds' };
		}
		const knownValidation = validateKnownIds(options.knownPlanTaskIds);
		if (knownValidation) return knownValidation;

		let totalChars = 0;
		const textFields: string[] = [];
		for (const field of TEXT_FIELDS) {
			const raw = input[field];
			if (raw === undefined || raw === null) continue;
			if (typeof raw !== 'string') return { status: 'invalid', input: field };
			if (raw.length > TASK_ID_RESOLUTION_LIMITS.maxFieldChars) {
				return { status: 'over_limit', input: field };
			}
			totalChars += raw.length;
			if (totalChars > TASK_ID_RESOLUTION_LIMITS.maxTotalChars) {
				return { status: 'over_limit', input: 'totalText' };
			}
			textFields.push(raw);
		}

		const explicit = new Set<string>();
		for (const field of EXPLICIT_FIELDS) {
			const raw = input[field];
			if (raw === undefined || raw === null) continue;
			if (typeof raw !== 'string') return { status: 'invalid', input: field };
			const value = raw.trim();
			if (value.length > TASK_ID_RESOLUTION_LIMITS.maxTokenChars) {
				return { status: 'over_limit', input: field };
			}
			const valid =
				options.policy === 'plan'
					? value.length <= 20 &&
						STRICT_PLAN_ID.test(value) &&
						(!options.knownPlanTaskIds || options.knownPlanTaskIds.has(value))
					: isAllowedAttributionId(
							value,
							options.knownPlanTaskIds,
							options.planContextOverLimit,
						);
			if (!valid) {
				if (
					options.policy === 'plan' &&
					value.length <= 20 &&
					STRICT_PLAN_ID.test(value) &&
					options.knownPlanTaskIds
				) {
					return { status: 'invalid', input: field };
				}
				if (
					options.policy === 'attribution' &&
					isStrictExplicitPlanField(
						value,
						options.knownPlanTaskIds,
						options.planContextOverLimit,
					)
				) {
					return { status: 'invalid', input: field };
				}
				continue;
			}
			const overflow = addCandidate(explicit, value);
			if (overflow) return overflow;
		}

		if (options.policy === 'plan') {
			const taskLineCandidates = new Set<string>();
			for (const text of textFields) {
				TASK_LINE.lastIndex = 0;
				for (const lineMatch of text.matchAll(TASK_LINE)) {
					PLAN_CANDIDATE.lastIndex = 0;
					for (const match of lineMatch[1].matchAll(PLAN_CANDIDATE)) {
						const value = match[1];
						if (
							options.knownPlanTaskIds &&
							!options.knownPlanTaskIds.has(value)
						) {
							continue;
						}
						const overflow = addCandidate(taskLineCandidates, value);
						if (overflow) return overflow;
					}
				}
			}
			const explicitSelection = select(explicit, 'explicit');
			if (explicitSelection) return explicitSelection;
			const taskLineSelection = select(taskLineCandidates, 'task_line');
			if (taskLineSelection) return taskLineSelection;

			const textCandidates = new Set<string>();
			for (const text of textFields) {
				PLAN_CANDIDATE.lastIndex = 0;
				for (const match of text.matchAll(PLAN_CANDIDATE)) {
					const value = match[1];
					if (
						options.knownPlanTaskIds &&
						!options.knownPlanTaskIds.has(value)
					) {
						continue;
					}
					const overflow = addCandidate(textCandidates, value);
					if (overflow) return overflow;
				}
			}
			const textSelection = select(textCandidates, 'text');
			if (textSelection) return textSelection;
		} else {
			for (const rawMarker of [
				ATTRIBUTION_ID_MARKER_RAW,
				ATTRIBUTION_TASK_MARKER_RAW,
			]) {
				for (const text of textFields) {
					rawMarker.lastIndex = 0;
					for (const match of text.matchAll(rawMarker)) {
						const value = match[1];
						if (value.length > TASK_ID_RESOLUTION_LIMITS.maxTokenChars) {
							return { status: 'over_limit', input: 'markerToken' };
						}
						if (
							!isAllowedAttributionId(
								value,
								options.knownPlanTaskIds,
								options.planContextOverLimit,
							)
						) {
							return { status: 'invalid', input: 'marker' };
						}
					}
				}
			}
			const marked = new Set<string>();
			for (const marker of [ATTRIBUTION_ID_MARKER, ATTRIBUTION_TASK_MARKER]) {
				for (const text of textFields) {
					marker.lastIndex = 0;
					for (const match of text.matchAll(marker)) {
						const value = match[1];
						if (value.length > TASK_ID_RESOLUTION_LIMITS.maxTokenChars) {
							return { status: 'over_limit', input: 'markerToken' };
						}
						if (
							!isAllowedAttributionId(
								value,
								options.knownPlanTaskIds,
								options.planContextOverLimit,
							)
						) {
							continue;
						}
						const overflow = addCandidate(marked, value);
						if (overflow) return overflow;
					}
				}
			}
			const explicitSelection = select(explicit, 'explicit');
			if (explicitSelection) return explicitSelection;
			const markerSelection = select(marked, 'marker');
			if (markerSelection) return markerSelection;
		}

		if (options.fallback !== undefined) {
			if (!options.fallbackProvenUnique) {
				return { status: 'invalid', input: 'fallback' };
			}
			const fallback = options.fallback.trim();
			const validFallback =
				options.policy === 'plan'
					? STRICT_PLAN_ID.test(fallback) &&
						options.knownPlanTaskIds?.has(fallback) === true
					: isAllowedAttributionId(
							fallback,
							options.knownPlanTaskIds,
							options.planContextOverLimit,
						);
			if (
				fallback.length > TASK_ID_RESOLUTION_LIMITS.maxTokenChars ||
				!validFallback
			) {
				return { status: 'invalid', input: 'fallback' };
			}
			return { status: 'resolved', taskId: fallback, source: 'fallback' };
		}

		return { status: 'missing' };
	} catch {
		return { status: 'invalid', input: 'resolver' };
	}
}

/** Backward-compatible delegation API backed by the bounded plan policy. */
export function resolveDelegatedPlanTaskId(
	args: Record<string, unknown>,
	planContext?: ReadonlySet<string> | TaskIdPlanContextOptions,
): string | null {
	const options =
		planContext instanceof Set
			? { knownPlanTaskIds: planContext }
			: planContext;
	const result = resolveTaskId(args, {
		policy: 'plan',
		...options,
	});
	return result.status === 'resolved' ? result.taskId : null;
}
