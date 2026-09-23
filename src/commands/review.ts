import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type AutoReviewConfig,
	resolveAutoReviewConfig,
} from '../config/schema.js';
import {
	parseReviewDiffSelector,
	type ReviewDiffSelector,
} from '../review/diff-source.js';
import {
	type ReviewEngineResult,
	type RunReviewEngineInput,
	runReviewEngine,
} from '../review/engine.js';
import type { AutoReviewEvidence } from '../review/evidence.js';
import { isAutoReviewEvidence } from '../review/evidence.js';
import {
	resolveReviewAgentNames,
	resolveReviewFallbackModels,
} from '../review/runtime.js';
import {
	type ModelOverride,
	parseModelString,
} from '../utils/model-dispatch-fallback.js';
import type { CommandContext } from './registry.js';

const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_JSON_WRAPPER_BYTES = 64 * 1024;
const MAX_DISPLAY_TEXT = 500;
const MAX_SCOPE_WARNINGS = 20;
const MAX_SCOPE_FILES = 25;
const JSON_OPEN_TAG = '[SWARM_REVIEW_JSON]';
const JSON_CLOSE_TAG = '[/SWARM_REVIEW_JSON]';
const SEVERITY_RANK: Record<string, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
	info: 4,
};

function truncateText(
	value: string | undefined,
	maximum = MAX_DISPLAY_TEXT,
): string {
	if (!value) return '';
	if (value.length <= maximum) return value;
	return `${value.slice(0, Math.max(0, maximum - 16))}... [truncated]`;
}

function hasRoleSuffix(name: string, role: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower === role || lower.endsWith(`_${role}`) || lower.endsWith(`-${role}`)
	);
}

function findAgentName(
	agents: CommandContext['agents'],
	role: string,
	preferredPrefix?: string,
): string | undefined {
	if (Object.hasOwn(agents, role)) return role;
	if (preferredPrefix) {
		const preferred = `${preferredPrefix}${role}`;
		if (Object.hasOwn(agents, preferred)) return preferred;
	}
	return Object.keys(agents)
		.filter((name) => hasRoleSuffix(name, role))
		.sort((left, right) => left.localeCompare(right))[0];
}

function formatSelector(selector: ReviewDiffSelector): string {
	switch (selector.kind) {
		case 'default':
			return 'default (merge-base plus working tree)';
		case 'base':
			return `base ${selector.ref}`;
		case 'range':
			return `range ${selector.from}${selector.operator}${selector.to}`;
		case 'working-tree':
			return 'working tree';
	}
}

function isPathInside(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return (
		relative.length > 0 &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function sameFileSnapshot(
	left: fs.BigIntStats,
	right: fs.BigIntStats,
): boolean {
	return (
		(left.dev !== 0n || left.ino !== 0n) &&
		(right.dev !== 0n || right.ino !== 0n) &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function readEvidence(
	evidencePath: string | undefined,
	directory: string,
): AutoReviewEvidence | null {
	if (!evidencePath) return null;
	const swarmRoot = path.resolve(directory, '.swarm');
	const candidate = path.resolve(evidencePath);
	if (!isPathInside(swarmRoot, candidate)) return null;

	let descriptor: number | undefined;
	try {
		// Capture the path identity before opening, then revalidate against the
		// opened descriptor. A non-symlink reparse point (Windows junction) or
		// an ancestor swap between lstat and open would otherwise redirect the
		// read outside `.swarm/`. Mirrors the readSafeUntracked /
		// readReviewReceiptText containment pattern in the review subsystem,
		// including exact BigInt filesystem identities so Windows inode values
		// above Number.MAX_SAFE_INTEGER cannot alias unrelated paths.
		const statBeforeOpen = fs.lstatSync(candidate, { bigint: true });
		if (
			!statBeforeOpen.isFile() ||
			statBeforeOpen.isSymbolicLink() ||
			statBeforeOpen.size > BigInt(MAX_EVIDENCE_BYTES)
		) {
			return null;
		}
		const canonicalBeforeOpen = fs.realpathSync(candidate);
		if (!isPathInside(swarmRoot, canonicalBeforeOpen)) return null;

		descriptor = fs.openSync(canonicalBeforeOpen, 'r');
		const openedBeforeRead = fs.fstatSync(descriptor, { bigint: true });
		const canonicalAfterOpen = fs.realpathSync(candidate);
		if (
			!openedBeforeRead.isFile() ||
			!sameFileSnapshot(statBeforeOpen, openedBeforeRead) ||
			!sameFileSnapshot(
				openedBeforeRead,
				fs.lstatSync(candidate, { bigint: true }),
			) ||
			canonicalBeforeOpen !== canonicalAfterOpen ||
			!isPathInside(swarmRoot, canonicalAfterOpen)
		) {
			return null;
		}

		// openedBeforeRead.size is bounded by the safe-integer MAX_EVIDENCE_BYTES
		// immediately above, so this conversion cannot lose precision.
		const buffer = Buffer.alloc(Number(openedBeforeRead.size));
		const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
		const openedAfterRead = fs.fstatSync(descriptor, { bigint: true });
		if (
			bytesRead !== buffer.length ||
			!sameFileSnapshot(openedBeforeRead, openedAfterRead)
		) {
			return null;
		}
		const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
		return isAutoReviewEvidence(parsed) ? parsed : null;
	} catch {
		return null;
	} finally {
		if (descriptor !== undefined) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// Best-effort cleanup.
			}
		}
	}
}

function sortedFindings(result: ReviewEngineResult) {
	return [...result.findings].sort((left, right) => {
		const severity =
			(SEVERITY_RANK[left.effective_severity] ?? 99) -
			(SEVERITY_RANK[right.effective_severity] ?? 99);
		if (severity !== 0) return severity;
		const validationRank = (
			finding: (typeof result.findings)[number],
		): number =>
			finding.validation?.disposition === 'CONFIRMED'
				? 0
				: finding.validation?.disposition === 'UNVERIFIED'
					? 1
					: finding.validation?.disposition === 'DISPROVED'
						? 2
						: 3;
		const validation = validationRank(left) - validationRank(right);
		if (validation !== 0) return validation;
		return left.finding_id.localeCompare(right.finding_id);
	});
}

function costLine(evidence: AutoReviewEvidence | null): string {
	if (!evidence) return 'Cost: unavailable (durable evidence was not readable)';
	const cost = evidence.cost;
	const dollars =
		cost.cost_usd === null
			? `unavailable (${cost.cost_source})`
			: `$${cost.cost_usd.toFixed(6)} (${cost.cost_source})`;
	return `Cost: ${dollars}; tokens ${cost.tokens_input} input / ${cost.tokens_output} output / ${cost.tokens_reasoning} reasoning / ${cost.tokens_cache} cache; prompt ${cost.prompt_bytes} bytes`;
}

function renderHuman(
	result: ReviewEngineResult,
	evidence: AutoReviewEvidence | null,
	requestedSelector: ReviewDiffSelector,
): string {
	const selector = evidence?.scope.selector ?? requestedSelector;
	const completeness = evidence?.scope.completeness;
	const scopeWarnings = (result.scopeWarnings ?? []).slice(
		0,
		MAX_SCOPE_WARNINGS,
	);
	const scopeFiles = (result.scopeFileList ?? []).slice(0, MAX_SCOPE_FILES);
	const lines = [
		'## Swarm Review',
		'',
		`Status: ${result.status}${result.blocked ? ` — BLOCKED (${result.blockReason ?? 'unspecified'})` : ' — advisory'}`,
		`Scope: ${formatSelector(selector)}; ${
			completeness
				? `${completeness.complete ? 'complete' : 'incomplete'}${completeness.truncated ? ', truncated' : ''}; ${evidence?.scope.review_text_bytes ?? 0} bytes`
				: 'scope metadata unavailable'
		}`,
		`Scope hash: ${result.scopeHash ?? evidence?.scope.hash ?? 'unavailable'}`,
		`Validation: ${result.validationComplete ? 'complete' : 'incomplete'}`,
		`Reviewer model: ${result.reviewModel ?? evidence?.review.model ?? 'registered agent default / unavailable'}`,
		`Model calls: ${result.modelCalls}`,
		costLine(evidence),
		`Receipt: ${result.receiptPath ?? evidence?.receipt_path ?? 'unavailable'}`,
		`Evidence: ${result.evidencePath ?? 'unavailable'}`,
	];
	if (scopeWarnings.length > 0) {
		lines.push(
			'',
			`### Scope warnings (${result.scopeWarnings?.length ?? scopeWarnings.length})`,
			...scopeWarnings.map((warning) => `- ${truncateText(warning)}`),
		);
	}
	if (result.scopeFileList !== undefined) {
		const omitted = Math.max(
			0,
			result.scopeFileList.length - scopeFiles.length,
		);
		lines.push(
			'',
			`### Scope files (${result.scopeFileList.length}${result.scopeFileListComplete === false ? ', fallback list may be incomplete' : ''})`,
			...scopeFiles.map((file) => `- ${truncateText(file, 300)}`),
		);
		if (omitted > 0) lines.push(`- ... ${omitted} additional file(s) omitted`);
	}
	lines.push('', `### Findings (${result.findings.length})`);

	const findings = sortedFindings(result);
	if (findings.length === 0) {
		lines.push('No findings reported.');
	} else {
		for (let index = 0; index < findings.length; index++) {
			const finding = findings[index];
			const validation = finding.validation?.disposition ?? 'NOT_VALIDATED';
			const anchor = finding.anchored
				? 'anchored'
				: `unanchored — ${truncateText(finding.anchor_rejection, 240) || 'reason unavailable'}`;
			lines.push(
				'',
				`${index + 1}. [${finding.effective_severity.toUpperCase()} / ${validation}] ${truncateText(finding.title, 300)}`,
				`   Location: ${truncateText(finding.file, 300)}:${finding.line_start}${finding.line_end !== finding.line_start ? `-${finding.line_end}` : ''}`,
				`   Anchor: ${anchor}; confidence ${finding.confidence.toFixed(2)}; duplicates ${finding.duplicate_count}`,
				`   ${truncateText(finding.body)}`,
			);
			if (finding.validation?.evidence) {
				lines.push(
					`   Validator evidence: ${truncateText(finding.validation.evidence)}`,
				);
			}
		}
	}
	return lines.join('\n');
}

function findingForJson(
	finding: ReviewEngineResult['findings'][number],
): Record<string, unknown> {
	return {
		finding_id: truncateText(finding.finding_id, 128),
		title: truncateText(finding.title),
		body: truncateText(finding.body),
		severity: finding.severity,
		effective_severity: finding.effective_severity,
		confidence: finding.confidence,
		file: truncateText(finding.file),
		line_start: finding.line_start,
		line_end: finding.line_end,
		duplicate_count: finding.duplicate_count,
		anchor: {
			anchored: finding.anchored,
			rejection: truncateText(finding.anchor_rejection),
		},
		validation: finding.validation
			? {
					disposition: finding.validation.disposition,
					confidence: finding.validation.confidence,
					evidence: truncateText(finding.validation.evidence),
				}
			: null,
	};
}

function renderJson(
	result: ReviewEngineResult,
	evidence: AutoReviewEvidence | null,
	requestedSelector: ReviewDiffSelector,
): string {
	const ranked = sortedFindings(result).map(findingForJson);
	const scopeWarnings = (result.scopeWarnings ?? [])
		.slice(0, MAX_SCOPE_WARNINGS)
		.map((warning) => truncateText(warning));
	const scopeFiles = (result.scopeFileList ?? [])
		.slice(0, MAX_SCOPE_FILES)
		.map((file) => truncateText(file, 300));
	const payload: Record<string, unknown> = {
		schema_version: 1,
		command: 'review',
		status: result.status,
		blocked: result.blocked,
		block_reason: result.blockReason ?? null,
		message: truncateText(result.message, 1000),
		scope: {
			selector: evidence?.scope.selector ?? requestedSelector,
			hash: result.scopeHash ?? evidence?.scope.hash ?? null,
			complete: evidence?.scope.completeness.complete ?? null,
			truncated: evidence?.scope.completeness.truncated ?? null,
			skip_reasons: (evidence?.scope.completeness.skipReasons ?? [])
				.slice(0, 50)
				.map((reason) => ({
					code: reason.code,
					path: truncateText(reason.path),
					detail: truncateText(reason.detail),
				})),
			review_text_bytes: evidence?.scope.review_text_bytes ?? null,
			warnings: scopeWarnings,
			warnings_omitted: Math.max(
				0,
				(result.scopeWarnings?.length ?? 0) - scopeWarnings.length,
			),
			file_list: scopeFiles,
			file_list_complete: result.scopeFileListComplete ?? null,
			files_omitted: Math.max(
				0,
				(result.scopeFileList?.length ?? 0) - scopeFiles.length,
			),
		},
		validation_complete: result.validationComplete,
		model: result.reviewModel ?? evidence?.review.model ?? null,
		model_calls: result.modelCalls,
		cost: evidence?.cost ?? null,
		receipt_path: result.receiptPath ?? evidence?.receipt_path ?? null,
		evidence_path: result.evidencePath ?? null,
		findings: ranked,
		findings_omitted: 0,
	};

	const wrapper = (body: string): string =>
		`${JSON_OPEN_TAG}\n${body}\n${JSON_CLOSE_TAG}`;
	let body = JSON.stringify(payload, null, 2);
	while (
		Buffer.byteLength(wrapper(body), 'utf8') > MAX_JSON_WRAPPER_BYTES &&
		ranked.length > 0
	) {
		ranked.pop();
		payload.findings_omitted = result.findings.length - ranked.length;
		body = JSON.stringify(payload, null, 2);
	}
	if (Buffer.byteLength(wrapper(body), 'utf8') > MAX_JSON_WRAPPER_BYTES) {
		body = JSON.stringify({
			schema_version: 1,
			command: 'review',
			status: 'error',
			message: 'bounded review JSON payload could not include result details',
		});
	}
	return wrapper(body);
}

export async function handleReviewCommand(
	ctx: CommandContext,
): Promise<string> {
	const parsed = parseReviewDiffSelector(ctx.args);
	if (!parsed.ok) {
		return [
			`Review argument error [${parsed.code}]: ${parsed.reason}`,
			'Usage: /swarm review [--base <ref> | --range <from..to|from...to> | --working-tree] [--json]',
		].join('\n');
	}
	if (!ctx.reviewModelDispatcher) {
		return (
			'Review runtime unavailable: no ReviewModelDispatcher is bound. ' +
			'Run `/swarm review` from an active plugin session; the standalone CLI cannot dispatch isolated review-model sessions.'
		);
	}

	let reviewerAgent: string;
	let validatorAgent: string;
	try {
		const names = resolveReviewAgentNames(
			Object.keys(ctx.agents),
			ctx.activeAgentName,
		);
		reviewerAgent = names.reviewer;
		validatorAgent = names.validator;
	} catch (error) {
		return `Review runtime unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (!Object.hasOwn(ctx.agents, reviewerAgent)) {
		return 'Review runtime unavailable: no generated reviewer agent is registered for this plugin session.';
	}
	const config: AutoReviewConfig =
		ctx.autoReviewConfig ?? resolveAutoReviewConfig({});
	if (
		(config.validate_findings || config.final_review.mode === 'gate') &&
		!Object.hasOwn(ctx.agents, validatorAgent)
	) {
		return 'Review runtime unavailable: finding validation is enabled but no generated critic_finding_validator agent is registered.';
	}

	let reviewerModel: ModelOverride | undefined;
	let reviewerFallbackModels: ModelOverride[] = [];
	let validatorModel: ModelOverride | undefined;
	let validatorFallbackModels: ModelOverride[] = [];
	try {
		reviewerModel = config.final_review.model
			? parseModelString(config.final_review.model)
			: undefined;
		reviewerFallbackModels = resolveReviewFallbackModels(
			reviewerAgent,
			ctx.reviewAgentModelRegistry,
		);
		validatorModel = config.validation_model
			? parseModelString(config.validation_model)
			: undefined;
		validatorFallbackModels = resolveReviewFallbackModels(
			validatorAgent,
			ctx.reviewAgentModelRegistry,
		);
	} catch (error) {
		return `Review configuration error: ${error instanceof Error ? error.message : String(error)}`;
	}

	const result = await _internals.runReviewEngine({
		directory: ctx.directory,
		sessionID: ctx.sessionID,
		trigger: 'manual',
		selector: parsed.selector,
		config,
		dispatcher: ctx.reviewModelDispatcher,
		reviewerAgent,
		validatorAgent,
		reviewerModel,
		reviewerFallbackModels,
		validatorModel,
		validatorFallbackModels,
	});
	const evidence = _internals.readEvidence(result.evidencePath, ctx.directory);
	return parsed.json
		? renderJson(result, evidence, parsed.selector)
		: renderHuman(result, evidence, parsed.selector);
}

export const _internals: {
	runReviewEngine: (input: RunReviewEngineInput) => Promise<ReviewEngineResult>;
	readEvidence: (
		evidencePath: string | undefined,
		directory: string,
	) => AutoReviewEvidence | null;
} = {
	runReviewEngine,
	readEvidence,
};

export const _test_exports = {
	MAX_JSON_WRAPPER_BYTES,
	findAgentName,
	formatSelector,
	renderHuman,
	renderJson,
};
