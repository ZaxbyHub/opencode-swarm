#!/usr/bin/env bun
/**
 * Required-check and release-owner contract gate (issue #2677).
 *
 * This is deliberately a small, pure-first checker.  The checked-in contract
 * describes the names emitted by GitHub, while the checked-in evidence is a
 * bounded, operator-captured statement of the external ruleset and merge
 * queue state.  YAML is used only for top-level event/job discovery; matrix
 * names are never guessed from it.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);
export const CONTRACT_PATH = path.join(
	REPO_ROOT,
	'scripts',
	'required-check-contract.json',
);
export const EVIDENCE_PATH = path.join(
	REPO_ROOT,
	'docs',
	'ci',
	'required-check-evidence.json',
);
export const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_WORKFLOW_BYTES = 512 * 1024;
export const MAX_JSON_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export type ContractBucket = 'required' | 'intended-required';
export type ContractStatus = 'pass' | 'fail' | 'unknown';

export interface ContractContext {
	name: string;
	workflow: string;
	job: string;
	events?: string[];
	bucket?: ContractBucket;
}

export interface RequiredCheckContract {
	schemaVersion?: number;
	repository?: string;
	branch?: string;
	rulesetId?: string;
	requiredContexts?: string[];
	rulesetRequiredContexts?: string[];
	intendedRequiredContexts?: string[];
	previousRequiredContexts?: string[];
	contract?: {
		requiredContexts?: string[];
	intendedRequiredContexts?: string[];
	};
	requiredContextBuckets?: {
		required?: string[];
		intended?: string[];
		intendedRequired?: string[];
	};
	contexts?: {
		required?: ContractContext[];
		intendedRequired?: ContractContext[];
	};
	evidence?: RequiredCheckEvidence;
	workflows?: Array<{
		file: string;
		events?: string[];
		mergeGroupTypes?: string[];
		contexts?: string[];
		jobs?: string[];
	}>;
}

export interface RequiredCheckEvidence {
	schemaVersion?: number;
	capturedAt?: string;
	captureSha?: string;
	repository?: string;
	branch?: {
		name?: string;
		protected?: boolean | null;
		protection?: string;
		rulesetId?: string;
	};
	ruleset?: {
		id?: string;
		enforcement?: string;
		requiredContexts?: string[];
	};
	mergeGroup?: {
		known?: boolean;
		contexts?: string[];
		observedRuns?: unknown[];
		workflowRunsByWorkflow?: Record<string, unknown[]>;
	};
	workflowEvents?: Record<string, string[]> | null;
	/** SHA-256 hashes of the workflow files in the checked-in local tree. */
	localWorkflowHashes?: Record<string, string>;
	/** Backward-compatible alias for older captures; new captures use the explicit name. */
	workflowHashes?: Record<string, string>;
	capturedWorkflowFiles?: Record<string, {
		contentsEndpoint?: string;
		blobSha?: string;
	}>;
	sources?: Array<{ endpoint?: string; purpose?: string }>;
}

export interface ContractFinding {
	code: string;
	severity: 'error' | 'warning' | 'notice';
	message: string;
	context?: string;
	workflow?: string;
	job?: string;
	file?: string;
}

export interface ContractEvaluation {
	status: ContractStatus;
	ok: boolean;
	findings: ContractFinding[];
	unknown: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
		return null;
	}
	return [...new Set(value.map((v) => v.trim()).filter(Boolean))];
}

function hasDuplicateStrings(value: unknown): boolean {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string') && new Set(value).size !== value.length;
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}

function posix(value: string): string {
	return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function namesFromContract(contract: RequiredCheckContract): {
	required: string[];
	intended: string[];
	previous: string[];
} {
	const required =
		stringArray(contract.requiredContexts) ??
		stringArray(contract.rulesetRequiredContexts) ??
		stringArray(contract.contract?.requiredContexts) ??
		stringArray(contract.requiredContextBuckets?.required) ??
		stringArray(contract.contexts?.required?.map((context) => context.name)) ??
		[];
	const intended =
		stringArray(contract.intendedRequiredContexts) ??
		stringArray(contract.contract?.intendedRequiredContexts) ??
		stringArray(contract.requiredContextBuckets?.intendedRequired) ??
		stringArray(contract.requiredContextBuckets?.intended) ??
		stringArray(
			Array.isArray(contract.contexts?.intendedRequired)
				? contract.contexts.intendedRequired.map((context) => context.name)
				: null,
		) ??
		[];
	return {
		required: unique(required),
		intended: unique(intended),
		previous: stringArray(contract.previousRequiredContexts) ?? [],
	};
}

function contextRecords(contract: RequiredCheckContract): ContractContext[] {
	const records = [
		...(Array.isArray(contract.contexts?.required) ? contract.contexts.required : []),
		...(Array.isArray(contract.contexts?.intendedRequired) ? contract.contexts.intendedRequired : []),
	].filter((record): record is ContractContext => isRecord(record) && typeof record.name === 'string' && typeof record.workflow === 'string' && typeof record.job === 'string');
	const required = namesFromContract(contract);
	const workflows = (Array.isArray(contract.workflows) ? contract.workflows : []).filter((workflow): workflow is { file: string; contexts?: string[] } => isRecord(workflow) && typeof workflow.file === 'string');
	const fallbackWorkflow = typeof workflows[0]?.file === 'string' ? workflows[0].file : '';
	return [...required.required, ...required.intended].map((name) => {
		const record = records.find((candidate) => candidate.name === name);
		if (record) return { ...record, name };
		const workflow =
			workflows.find((candidate) =>
				isRecord(candidate) && Array.isArray(candidate.contexts) && candidate.contexts.includes(name),
			)?.file ?? fallbackWorkflow;
		return { name, workflow, job: '' };
	});
}

function workflowKey(file: string): string {
	const normalized = posix(file);
	const base = normalized.slice(normalized.lastIndexOf('/') + 1);
	return base.replace(/\.(?:ya?ml)$/i, '').toLowerCase();
}

function workflowEvidenceKeys(file: string): string[] {
	const key = workflowKey(file);
	return unique([posix(file), key, key.replace(/-check$/i, '')]);
}

function evidenceContexts(evidence: RequiredCheckEvidence): {
	ruleset: string[] | null;
	mergeGroup: string[] | null;
} {
	return {
		ruleset: stringArray(evidence.ruleset?.requiredContexts),
		mergeGroup: stringArray(evidence.mergeGroup?.contexts),
	};
}

function addFinding(
	findings: ContractFinding[],
	code: string,
	severity: ContractFinding['severity'],
	message: string,
	fields: Partial<ContractFinding> = {},
): void {
	findings.push({ code, severity, message, ...fields });
}

function strictEvidence(evidence: RequiredCheckEvidence): boolean {
	return Boolean(
		evidence.schemaVersion ||
		evidence.capturedAt ||
		evidence.repository ||
		evidence.sources ||
		evidence.localWorkflowHashes ||
		evidence.workflowHashes ||
		evidence.capturedWorkflowFiles,
	);
}

function finishEvaluation(
	findings: ContractFinding[],
	unknown: string[],
): ContractEvaluation {
	const normalizedUnknown = unique(unknown);
	const hasErrors = findings.some((finding) => finding.severity === 'error');
	return {
		status: normalizedUnknown.length > 0 ? 'unknown' : hasErrors ? 'fail' : 'pass',
		ok: normalizedUnknown.length === 0 && !hasErrors,
		findings,
		unknown: normalizedUnknown,
	};
}

/**
 * Compare a contract with captured ruleset and workflow evidence.
 *
 * The small fixture form used by the acceptance tests intentionally omits
 * capture metadata; it remains valid for pure evaluator tests.  Repository
 * collection always supplies the strict, freshness-bound form below.
 */
export function evaluateRequiredCheckContract(
	input: unknown,
	options: { now?: Date; strict?: boolean } = {},
): ContractEvaluation {
	const findings: ContractFinding[] = [];
	const unknown: string[] = [];
	if (!isRecord(input)) {
		addFinding(findings, 'CONTRACT_MALFORMED', 'error', 'required-check contract is not an object');
		return finishEvaluation(findings, ['contract']);
	}
	const contract = input as RequiredCheckContract;
	const evidence = (isRecord(contract.evidence) ? contract.evidence : null) as
		| RequiredCheckEvidence
		| null;
	const names = namesFromContract(contract);
	const declaredArrays: Array<[string, unknown]> = [
		['requiredContexts', contract.requiredContexts],
		['rulesetRequiredContexts', contract.rulesetRequiredContexts],
		['intendedRequiredContexts', contract.intendedRequiredContexts],
		['previousRequiredContexts', contract.previousRequiredContexts],
		['contract.requiredContexts', contract.contract?.requiredContexts],
		['contract.intendedRequiredContexts', contract.contract?.intendedRequiredContexts],
		['requiredContextBuckets.required', contract.requiredContextBuckets?.required],
		['requiredContextBuckets.intended', contract.requiredContextBuckets?.intended],
		['requiredContextBuckets.intendedRequired', contract.requiredContextBuckets?.intendedRequired],
	];
	for (const [label, value] of declaredArrays) {
		if (value !== undefined && stringArray(value) === null) {
			unknown.push('contract');
			addFinding(findings, 'CONTRACT_MALFORMED', 'error', `${label} must be an array of non-empty strings`);
		} else if (hasDuplicateStrings(value)) {
			unknown.push('contract');
			addFinding(findings, 'CONTRACT_MALFORMED', 'error', `${label} must not contain duplicate contexts`);
		}
	}
	for (const [label, value] of [
		['contexts.required', contract.contexts?.required],
		['contexts.intendedRequired', contract.contexts?.intendedRequired],
	] as const) {
		if (value !== undefined && (!Array.isArray(value) || value.some((record) =>
			!isRecord(record) || typeof record.name !== 'string' || typeof record.workflow !== 'string' || typeof record.job !== 'string' || (record.events !== undefined && stringArray(record.events) === null))))
		{
			unknown.push('contract');
			addFinding(findings, 'CONTRACT_MALFORMED', 'error', `${label} must contain name, workflow, and job records`);
		}
	}
	if (contract.workflows !== undefined && (!Array.isArray(contract.workflows) || contract.workflows.some((workflow) =>
		!isRecord(workflow) || typeof workflow.file !== 'string' || (workflow.events !== undefined && stringArray(workflow.events) === null) ||
		(workflow.mergeGroupTypes !== undefined && stringArray(workflow.mergeGroupTypes) === null) ||
		(workflow.contexts !== undefined && stringArray(workflow.contexts) === null) ||
		(workflow.jobs !== undefined && stringArray(workflow.jobs) === null)))) {
		unknown.push('contract');
		addFinding(findings, 'CONTRACT_MALFORMED', 'error', 'workflows must contain valid file and string-array fields');
	}
	if (names.required.length === 0 && names.intended.length === 0) {
		addFinding(findings, 'CONTRACT_MALFORMED', 'error', 'contract declares no required-context bucket');
		return finishEvaluation(findings, ['contract']);
	}
	const allContractNames = new Set([...names.required, ...names.intended]);
	if (new Set([...names.required, ...names.intended]).size !== names.required.length + names.intended.length) {
		addFinding(findings, 'CONTRACT_BUCKET_DEMOTION', 'error', 'a context appears in both required buckets');
	}
	for (const previous of names.previous) {
		if (!names.required.includes(previous)) {
			addFinding(
				findings,
				'CONTRACT_BUCKET_DEMOTION',
				'error',
				`previously required context "${previous}" was demoted out of the required bucket`,
				{ context: previous },
			);
		}
	}
	if (!evidence) {
		for (const section of ['ruleset', 'branch', 'merge_group', 'workflow_events']) unknown.push(section);
		addFinding(findings, 'EXTERNAL_EVIDENCE_UNKNOWN', 'error', 'required-check evidence is missing');
		return finishEvaluation(findings, unknown);
	}

	const strict = options.strict ?? strictEvidence(evidence);
	if (strict) {
		const now = options.now ?? new Date();
		if (!contract.repository || !contract.branch || !contract.rulesetId) {
			unknown.push('contract');
			addFinding(findings, 'CONTRACT_MALFORMED', 'error', 'strict contract evidence requires repository, branch, and rulesetId identity');
		}
		if (!evidence.capturedAt) {
			unknown.push('evidence');
			addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'evidence is missing capturedAt');
		} else {
			const captured = Date.parse(evidence.capturedAt);
			if (!Number.isFinite(captured)) {
				unknown.push('evidence');
				addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'evidence capturedAt is not an ISO timestamp');
			} else if (captured > now.getTime() + 5 * 60 * 1000 || now.getTime() - captured > MAX_EVIDENCE_AGE_MS) {
				unknown.push('evidence');
				addFinding(findings, 'EVIDENCE_STALE', 'error', `evidence is older than ${MAX_EVIDENCE_AGE_MS / 86_400_000} days or from the future`);
			}
		}
		if (!evidence.captureSha || !/^[0-9a-f]{40}$/i.test(evidence.captureSha)) {
			unknown.push('evidence');
			addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'evidence captureSha must be an exact 40-character commit SHA');
		}
		if (!evidence.repository) {
			unknown.push('repository');
			addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'evidence repository is missing');
		} else if (contract.repository && evidence.repository !== contract.repository) {
			addFinding(findings, 'EVIDENCE_REPOSITORY_MISMATCH', 'error', `evidence repository ${evidence.repository} does not match ${contract.repository}`);
		}
		if (!evidence.branch || !evidence.branch.name) {
			unknown.push('branch');
			addFinding(findings, 'EVIDENCE_PROTECTION_UNKNOWN', 'error', 'evidence does not establish the protected branch');
		} else {
			if (contract.branch && evidence.branch.name !== contract.branch) {
				addFinding(findings, 'EVIDENCE_BRANCH_MISMATCH', 'error', `evidence branch ${evidence.branch.name} does not match ${contract.branch}`);
			}
			if (evidence.branch.protected !== true) {
				unknown.push('branch');
				addFinding(findings, 'EVIDENCE_PROTECTION_UNKNOWN', 'error', 'evidence does not confirm branch protection is active');
			}
			if (contract.rulesetId && evidence.branch.rulesetId !== contract.rulesetId) {
				addFinding(findings, 'EVIDENCE_RULESET_MISMATCH', 'error', `branch evidence ruleset ${evidence.branch.rulesetId ?? '<missing>'} does not match ${contract.rulesetId}`);
			}
		}
		const strictRulesetContexts = stringArray(evidence.ruleset?.requiredContexts);
		if (!evidence.ruleset?.id || !strictRulesetContexts?.length || evidence.ruleset.enforcement !== 'active') {
			unknown.push('ruleset');
			addFinding(findings, 'EVIDENCE_PROTECTION_UNKNOWN', 'error', 'evidence does not establish an active ruleset with required contexts');
		} else if (contract.rulesetId && evidence.ruleset.id !== contract.rulesetId) {
			addFinding(findings, 'EVIDENCE_RULESET_MISMATCH', 'error', `captured ruleset ${evidence.ruleset.id} does not match ${contract.rulesetId}`);
		}
		if (hasDuplicateStrings(evidence.ruleset?.requiredContexts) || hasDuplicateStrings(evidence.mergeGroup?.contexts)) {
			unknown.push('evidence');
			addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'captured context lists must not contain duplicates');
		}
		if (!evidence.mergeGroup || evidence.mergeGroup.known !== true) {
			unknown.push('merge_group');
			addFinding(findings, 'EVIDENCE_MERGE_GROUP_UNKNOWN', 'error', 'evidence does not establish merge-group behavior');
		}
		if (!evidence.workflowEvents || Object.values(evidence.workflowEvents).some((events) => !Array.isArray(events) || events.some((event) => typeof event !== 'string'))) {
			unknown.push('workflow_events');
			addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'workflow-event evidence is missing or malformed');
		}
		if (!Array.isArray(evidence.sources) || evidence.sources.length === 0 || evidence.sources.some((source) => !isRecord(source) || typeof source.endpoint !== 'string' || !/^https:\/\//.test(source.endpoint))) {
			unknown.push('sources');
			addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'evidence must include HTTPS source endpoints');
		} else if (contract.repository && contract.branch && contract.rulesetId) {
			const sourceEndpoints = evidence.sources
				.filter((source): source is { endpoint: string } => isRecord(source) && typeof source.endpoint === 'string')
				.map((source) => source.endpoint);
			const requiredSourceEndpoints = [
				`https://api.github.com/repos/${contract.repository}/rulesets/${contract.rulesetId}`,
				`https://api.github.com/repos/${contract.repository}/branches/${contract.branch}`,
				`https://api.github.com/repos/${contract.repository}/actions/runs?event=merge_group`,
			];
			for (const endpoint of requiredSourceEndpoints) {
				if (!sourceEndpoints.includes(endpoint)) {
					unknown.push('sources');
					addFinding(findings, 'EVIDENCE_MALFORMED', 'error', `evidence sources must include the repository-bound endpoint ${endpoint}`);
				}
			}
		}
		const localWorkflowHashes = evidence.localWorkflowHashes ?? evidence.workflowHashes;
		const contractWorkflowFiles = Array.isArray(contract.workflows)
			? contract.workflows.filter((workflow): workflow is { file: string } => isRecord(workflow) && typeof workflow.file === 'string').map((workflow) => posix(workflow.file))
			: [];
		if (!isRecord(localWorkflowHashes) || Object.values(localWorkflowHashes).some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash))) {
			unknown.push('workflow_hashes');
			addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'evidence must include SHA-256 hashes for every contract-owned local workflow');
		} else if (Object.keys(localWorkflowHashes).length !== contractWorkflowFiles.length || contractWorkflowFiles.some((file) => typeof localWorkflowHashes[file] !== 'string')) {
			unknown.push('workflow_hashes');
			addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'local workflow hash map must exactly cover contract-owned workflows');
		}
		if (!isRecord(evidence.capturedWorkflowFiles) || Object.values(evidence.capturedWorkflowFiles).some((capture) =>
			!isRecord(capture) || typeof capture.contentsEndpoint !== 'string' || !/^https:\/\//.test(capture.contentsEndpoint) ||
			typeof capture.blobSha !== 'string' || !/^[0-9a-f]{40}$/i.test(capture.blobSha))) {
			unknown.push('workflow_capture');
			addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'evidence must include pinned HTTPS Contents endpoints and Git blob SHAs for each captured workflow');
		} else {
			for (const workflow of Array.isArray(contract.workflows) ? contract.workflows : []) {
				if (!isRecord(workflow) || typeof workflow.file !== 'string') continue;
				const capture = evidence.capturedWorkflowFiles[posix(workflow.file)];
				if (!isRecord(capture) || typeof capture.contentsEndpoint !== 'string' || typeof capture.blobSha !== 'string') {
					unknown.push('workflow_capture');
					addFinding(findings, 'EVIDENCE_MALFORMED', 'error', `evidence has no pinned external capture for ${workflow.file}`, { workflow: workflow.file });
				}
			}
			if (Object.keys(evidence.capturedWorkflowFiles).length !== contractWorkflowFiles.length) {
				unknown.push('workflow_capture');
				addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'external workflow capture map must exactly cover contract-owned workflows');
			}
		}
		const observedRuns = evidence.mergeGroup?.observedRuns;
		const sourceEndpoints = Array.isArray(evidence.sources)
			? evidence.sources
				.filter((source): source is { endpoint: string } => isRecord(source) && typeof source.endpoint === 'string')
				.map((source) => source.endpoint)
			: [];
		if (!Array.isArray(observedRuns) || observedRuns.length === 0 || observedRuns.some((run) =>
			!isRecord(run) || !Number.isInteger(run.id) || run.id <= 0 || typeof run.workflow !== 'string' || run.event !== 'merge_group' || typeof run.workflowPath !== 'string' || run.workflowPath.trim().length === 0 || !contractWorkflowFiles.includes(run.workflowPath) || typeof run.endpoint !== 'string' || !/^https:\/\//.test(run.endpoint) || run.endpoint !== `https://api.github.com/repos/${evidence.repository}/actions/runs/${run.id}` || !sourceEndpoints.includes(run.endpoint) || typeof run.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(run.headSha) || run.headSha !== evidence.captureSha || run.conclusion !== 'success')) {
			unknown.push('merge_group_runs');
			addFinding(findings, 'EVIDENCE_MERGE_GROUP_UNKNOWN', 'error', 'evidence must include concrete successful merge-group run receipts pinned to captureSha and an exact contract workflow path');
		}
		const runMap = evidence.mergeGroup?.workflowRunsByWorkflow;
		const validObservedRuns = Array.isArray(observedRuns)
			? observedRuns.filter((run): run is Record<string, unknown> => isRecord(run) && Number.isInteger(run.id) && run.id > 0)
			: [];
		const observedRunIds = new Set(validObservedRuns.map((run) => run.id as number));
		if (observedRunIds.size !== validObservedRuns.length) {
			unknown.push('merge_group_runs');
			addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'observed merge-group run receipts must not reuse a run ID');
		}
		const observedRunById = new Map<number, Record<string, unknown>>();
		for (const run of validObservedRuns) {
			const id = run.id as number;
			if (!observedRunById.has(id)) observedRunById.set(id, run);
		}
		const requiredMergeGroupWorkflows = new Set(
			(Array.isArray(contract.workflows) ? contract.workflows : [])
				.filter((workflow): workflow is { file: string; events?: string[] } =>
					isRecord(workflow) && typeof workflow.file === 'string' && stringArray(workflow.events)?.includes('merge_group') === true)
				.filter((workflow) =>
					(Array.isArray(contract.contexts?.required) ? contract.contexts.required : []).some((context) =>
						isRecord(context) && typeof context.workflow === 'string' && posix(context.workflow) === posix(workflow.file)),
				)
				.map((workflow) => posix(workflow.file)),
		);
		if (
			!isRecord(runMap) ||
			Object.keys(runMap).length !== contractWorkflowFiles.length ||
			contractWorkflowFiles.some((file) => !Array.isArray(runMap[file])) ||
			Object.values(runMap).some((ids) => !Array.isArray(ids))
		) {
			unknown.push('merge_group_runs');
			addFinding(findings, 'EVIDENCE_MALFORMED', 'error', 'merge-group run map must include an array for every contract-owned workflow');
		} else {
			const mappedRunIds = new Map<number, string>();
			for (const file of contractWorkflowFiles) {
				const ids = runMap[file];
				if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
					unknown.push('merge_group_runs');
					addFinding(findings, 'EVIDENCE_MALFORMED', 'error', `merge-group run map for ${file} must contain positive integer run IDs`, { workflow: file });
					continue;
				}
				for (const id of ids) {
					const previousWorkflow = mappedRunIds.get(id);
					if (previousWorkflow !== undefined) {
						unknown.push('merge_group_runs');
						addFinding(findings, 'EVIDENCE_MALFORMED', 'error', `merge-group run ${id} is mapped more than once (${previousWorkflow} and ${file})`, { workflow: file });
					} else {
						mappedRunIds.set(id, file);
					}
					if (!observedRunIds.has(id)) {
						unknown.push('merge_group_runs');
						addFinding(findings, 'EVIDENCE_MALFORMED', 'error', `merge-group run ${id} for ${file} has no observed run receipt`, { workflow: file });
					} else if (observedRunById.get(id)?.workflowPath !== file) {
						unknown.push('merge_group_runs');
						addFinding(findings, 'EVIDENCE_MALFORMED', 'error', `merge-group run ${id} receipt workflowPath does not match mapped workflow ${file}`, { workflow: file });
					}
				}
				if (requiredMergeGroupWorkflows.has(file) && ids.length === 0) {
					unknown.push('merge_group_runs');
					addFinding(findings, 'EVIDENCE_MERGE_GROUP_UNKNOWN', 'error', `required workflow ${file} has no observed merge-group run receipt`, { workflow: file });
				}
			}
		}
		if (/^[0-9a-f]{40}$/i.test(evidence.captureSha ?? '') && contract.repository && Array.isArray(contract.workflows)) {
			const sourceEndpoints = Array.isArray(evidence.sources)
				? evidence.sources.filter((source): source is { endpoint: string } => isRecord(source) && typeof source.endpoint === 'string').map((source) => source.endpoint)
				: [];
			for (const workflow of contract.workflows) {
				if (!isRecord(workflow) || typeof workflow.file !== 'string') continue;
				const workflowPath = posix(workflow.file);
				const expectedEndpoint = `https://api.github.com/repos/${contract.repository}/contents/${workflowPath}?ref=${evidence.captureSha}`;
				const capture = evidence.capturedWorkflowFiles?.[workflowPath];
				if (!isRecord(capture) || capture.contentsEndpoint !== expectedEndpoint || !sourceEndpoints.includes(expectedEndpoint)) {
					unknown.push('workflow_capture');
					addFinding(findings, 'EVIDENCE_MALFORMED', 'error', `workflow capture endpoint for ${workflowPath} is not pinned to repository, path, and captureSha`, { workflow: workflowPath });
				}
			}
		}
		const declaredContextRecords = [
			...(Array.isArray(contract.contexts?.required) ? contract.contexts.required : []),
			...(Array.isArray(contract.contexts?.intendedRequired) ? contract.contexts.intendedRequired : []),
		];
		if (!Array.isArray(contract.contexts?.required) || !Array.isArray(contract.contexts?.intendedRequired)) {
			unknown.push('contract');
			addFinding(findings, 'CONTRACT_MALFORMED', 'error', 'strict contract requires explicit required and intended context owner records');
		} else {
			for (const name of allContractNames) {
				if (!declaredContextRecords.some((record) => isRecord(record) && record.name === name)) {
					unknown.push('contract');
					addFinding(findings, 'CONTRACT_MALFORMED', 'error', `strict contract has no explicit owner record for context "${name}"`, { context: name });
				}
			}
		}
	}

	const evidenceParts = evidenceContexts(evidence);
	if (!evidence.ruleset) {
		unknown.push('ruleset');
		addFinding(findings, 'EXTERNAL_EVIDENCE_UNKNOWN', 'error', 'ruleset evidence is unavailable');
	}
	if (!evidence.branch) {
		unknown.push('branch');
		addFinding(findings, 'EXTERNAL_EVIDENCE_UNKNOWN', 'error', 'branch evidence is unavailable');
	}
	if (!evidence.mergeGroup) {
		unknown.push('merge_group');
		addFinding(findings, 'EXTERNAL_EVIDENCE_UNKNOWN', 'error', 'merge-group evidence is unavailable');
	}
	if (!evidence.workflowEvents) {
		unknown.push('workflow_events');
		addFinding(findings, 'EXTERNAL_EVIDENCE_UNKNOWN', 'error', 'workflow-event evidence is unavailable');
	}
	for (const [label, contexts] of Object.entries(evidenceParts)) {
		if (contexts === null) {
			unknown.push(label === 'mergeGroup' ? 'merge_group' : 'ruleset');
			addFinding(findings, 'EXTERNAL_EVIDENCE_UNKNOWN', 'error', `${label} evidence is missing or malformed`);
		}
	}
	const requiredSet = new Set(names.required);
	const intendedSet = new Set(names.intended);
	for (const required of names.required) {
		if (evidenceParts.ruleset && !evidenceParts.ruleset.includes(required)) {
			addFinding(findings, 'PROMISED_CONTEXT_MISSING', 'error', `required context "${required}" is absent from captured ruleset`, { context: required });
		}
		if (evidenceParts.mergeGroup && !evidenceParts.mergeGroup.includes(required)) {
			addFinding(findings, 'PROMISED_CONTEXT_EVENT_SKIPPED', 'error', `required context "${required}" is absent from captured merge-group checks`, { context: required });
		}
	}
	for (const intended of names.intended) {
		if (evidenceParts.ruleset && !evidenceParts.ruleset.includes(intended)) {
			addFinding(findings, 'RULESET_DIVERGENCE', 'notice', `intended-required context "${intended}" is not yet required by the captured ruleset`, { context: intended });
		} else if (evidenceParts.ruleset?.includes(intended) && !requiredSet.has(intended)) {
			addFinding(findings, 'CONTRACT_BUCKET_DEMOTION', 'error', `context "${intended}" is required by the captured ruleset but remains only in the intended-required bucket`, { context: intended });
		}
	}
	for (const observed of [...(evidenceParts.ruleset ?? []), ...(evidenceParts.mergeGroup ?? [])]) {
		if (!allContractNames.has(observed)) {
			addFinding(findings, 'CONTRACT_CONTEXT_UNDECLARED', 'error', `captured context "${observed}" is not declared by the contract`, { context: observed });
		}
	}

	const workflows = (Array.isArray(contract.workflows) ? contract.workflows : []).filter((workflow): workflow is { file: string; events?: string[]; contexts?: string[]; jobs?: string[]; mergeGroupTypes?: string[] } => isRecord(workflow) && typeof workflow.file === 'string');
	const workflowContextNames = new Map<string, string[]>();
	for (const workflow of workflows) {
		if (!isRecord(workflow) || typeof workflow.file !== 'string' || workflow.file.trim().length === 0) {
			addFinding(findings, 'CONTRACT_MALFORMED', 'error', 'contract workflow entry is missing a file path');
			continue;
		}
		if (workflow.events !== undefined && stringArray(workflow.events) === null) {
			addFinding(findings, 'CONTRACT_MALFORMED', 'error', `workflow ${workflow.file} has a malformed event list`, { file: workflow.file });
		}
		if (workflow.mergeGroupTypes !== undefined && stringArray(workflow.mergeGroupTypes) === null) {
			addFinding(findings, 'CONTRACT_MALFORMED', 'error', `workflow ${workflow.file} has a malformed merge-group type list`, { file: workflow.file });
		}
		if (workflow.contexts !== undefined && stringArray(workflow.contexts) === null) {
			addFinding(findings, 'CONTRACT_MALFORMED', 'error', `workflow ${workflow.file} has a malformed context list`, { file: workflow.file });
		}
		const namesForWorkflow = stringArray(workflow.contexts) ?? [];
		workflowContextNames.set(workflowKey(workflow.file), namesForWorkflow);
	}
	const records = contextRecords(contract);
	// The production contract keeps the exact emitted names on each context
	// record, while the small acceptance fixture keeps them on `workflows`.
	// Join both representations before checking ownership.
	for (const record of records) {
		const key = workflowKey(record.workflow);
		const namesForWorkflow = workflowContextNames.get(key) ?? [];
		const explicitNames = workflows.find((workflow) => workflowKey(workflow.file) === key)?.contexts;
		if (!explicitNames && !namesForWorkflow.includes(record.name)) namesForWorkflow.push(record.name);
		workflowContextNames.set(key, namesForWorkflow);
	}
	for (const record of records) {
		const workflow = workflows.find((candidate) => candidate.file === record.workflow || workflowKey(candidate.file) === workflowKey(record.workflow));
		if (!workflow) {
			addFinding(findings, 'PROMISED_CONTEXT_MISSING', 'error', `context "${record.name}" has no contract-owned workflow`, { context: record.name, workflow: record.workflow, job: record.job });
			continue;
		}
		if (strict && (!Array.isArray(workflow.jobs) || !workflow.jobs.includes(record.job))) {
			addFinding(findings, 'CONTRACT_MALFORMED', 'error', `context "${record.name}" is not anchored to a declared job owner in ${workflow.file}`, { context: record.name, workflow: workflow.file, job: record.job });
		}
		const workflowNames = workflowContextNames.get(workflowKey(workflow.file)) ?? [];
		if (!workflowNames.includes(record.name)) {
			const observedReplacement = (evidenceParts.ruleset ?? []).find((candidate) => !allContractNames.has(candidate) && workflowNames.includes(candidate));
			if (observedReplacement) {
				addFinding(findings, 'PROMISED_CONTEXT_RENAMED', 'error', `context "${record.name}" was renamed to "${observedReplacement}" under workflow ${workflow.file}; preserve the recorded job owner`, { context: record.name, workflow: workflow.file, job: record.job });
			} else if (requiredSet.has(record.name) || intendedSet.has(record.name)) {
				addFinding(findings, 'PROMISED_CONTEXT_MISSING', 'error', `context "${record.name}" is absent from workflow ${workflow.file}`, { context: record.name, workflow: workflow.file, job: record.job });
			}
		}
		const expectedEvents = Array.isArray(record.events) ? record.events : ['pull_request', 'merge_group'];
		for (const event of expectedEvents) {
			if (!(stringArray(workflow.events) ?? []).includes(event)) {
				addFinding(findings, 'PROMISED_CONTEXT_EVENT_SKIPPED', 'error', `context "${record.name}" is not covered by ${event} in ${workflow.file}`, { context: record.name, workflow: workflow.file, job: record.job });
			}
		}
		if (evidence.workflowEvents) {
			const observedEvents = workflowEvidenceKeys(workflow.file)
				.map((key) => evidence.workflowEvents?.[key])
				.find((events): events is string[] => Array.isArray(events));
			if (!observedEvents) {
				if (intendedSet.has(record.name)) {
					addFinding(findings, 'RULESET_DIVERGENCE', 'notice', `intended-required context "${record.name}" has no captured external workflow-event entry for ${workflow.file}`, { context: record.name, workflow: workflow.file, job: record.job });
				} else {
					unknown.push('workflow_events');
					addFinding(findings, 'EXTERNAL_EVIDENCE_UNKNOWN', 'error', `captured workflow-event evidence has no entry for ${workflow.file}`, { workflow: workflow.file });
				}
			} else if (expectedEvents.some((event) => !observedEvents.includes(event))) {
				if (intendedSet.has(record.name)) {
					addFinding(findings, 'RULESET_DIVERGENCE', 'notice', `intended-required context "${record.name}" is not present for every expected event in captured external workflow evidence`, { context: record.name, workflow: workflow.file, job: record.job });
				} else {
					addFinding(findings, 'PROMISED_CONTEXT_EVENT_SKIPPED', 'error', `captured workflow-event evidence skips an event for context "${record.name}"`, { context: record.name, workflow: workflow.file, job: record.job });
				}
			}
		}
	}
	return finishEvaluation(findings, unknown);
}

export interface ReleaseOwnershipInput {
	changedFiles: string[];
	addedFiles?: string[];
	actor?: string;
	event?: string;
	tagName?: string;
	releaseAutomation?: boolean;
}

export interface ReleaseOwnershipResult {
	ok: boolean;
	code: 'NO_RELEASE_OWNER_EDIT' | 'UNAUTHORIZED_RELEASE_OWNER_EDIT' | 'RELEASE_AUTOMATION_EXCEPTION';
	message: string;
	requiredNotes: string[];
}

export const RELEASE_OWNER_FILES = [
	'package.json',
	'CHANGELOG.md',
	'.release-please-manifest.json',
] as const;

/** Keep the release-owner subprocess bounded to the exact root-owned paths. */
export function releaseOwnerDiffArgs(base: string, head: string): string[] {
	return [
		'diff',
		'--name-only',
		'--no-renames',
		base,
		head,
		'--',
		...RELEASE_OWNER_FILES,
	];
}

/**
 * Compose the trusted actor and release predicate at the CI boundary.  The
 * merge-group predicate intentionally ignores actor: GitHub reports the user
 * who queued the group, not the automation identity that produced a release
 * commit.
 */
export function deriveReleaseAutomation(input: {
	event: string;
	actor?: string;
	releaseBranch?: string;
	headCommitSubject?: string;
	releasePredicate?: boolean;
}): boolean {
	if (input.event === 'pull_request') {
		const predicate = input.releasePredicate ?? (input.releaseBranch ?? '').startsWith('release-please--');
		return input.actor === 'github-actions[bot]' && predicate;
	}
	if (input.event === 'merge_group') {
		if (input.releasePredicate !== undefined) return input.releasePredicate;
		const subject = input.headCommitSubject ?? '';
		return /^(?:Merge pull request #[0-9]+ from ZaxbyHub\/release-please--|chore\(main\): release )/.test(subject);
	}
	return false;
}

/** Evaluate only exact root-level release-owned paths. */
export function evaluateReleaseOwnership(input: ReleaseOwnershipInput): ReleaseOwnershipResult {
	const changedOwnerFiles = unique(input.changedFiles.map(posix)).filter((file) =>
		(RELEASE_OWNER_FILES as readonly string[]).includes(file),
	);
	if (changedOwnerFiles.length === 0) {
		return {
			ok: true,
			code: 'NO_RELEASE_OWNER_EDIT',
			message: 'no release-please-owned files changed',
			requiredNotes: [],
		};
	}
	if (input.releaseAutomation === true) {
		return {
			ok: true,
			code: 'RELEASE_AUTOMATION_EXCEPTION',
			message: `release automation authorized exact owner files: ${changedOwnerFiles.join(', ')}`,
			requiredNotes: [],
		};
	}
	return {
		ok: false,
		code: 'UNAUTHORIZED_RELEASE_OWNER_EDIT',
		message: `unauthorized edit to release-please-owned file(s): ${changedOwnerFiles.join(', ')}`,
		requiredNotes: [],
	};
}

export interface WorkflowSurface {
	file: string;
	events: string[];
	mergeGroupTypes: string[];
	jobs: string[];
}

/** Parse only bounded top-level `on` events and `jobs` IDs from a workflow. */
export function parseWorkflowSurface(source: string, file = 'workflow.yml'): WorkflowSurface {
	if (Buffer.byteLength(source, 'utf8') > MAX_WORKFLOW_BYTES) {
		throw new Error(`${file} exceeds the ${MAX_WORKFLOW_BYTES}-byte parser bound`);
	}
	const lines = source.split(/\r?\n/);
	const events: string[] = [];
	const mergeGroupTypes: string[] = [];
	const jobs: string[] = [];
	let section: 'on' | 'jobs' | null = null;
	let onIndent = -1;
	let jobsIndent = -1;
	let mergeGroupIndent = -1;
	for (const line of lines) {
		if (/^\s*#/.test(line) || line.trim() === '') continue;
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		const trimmed = line.trim();
		if (indent === 0) {
			section = null;
			if (/^(?:on|"on"|'on')\s*:/.test(trimmed)) {
				section = 'on';
				onIndent = 0;
				const inline = trimmed.slice(trimmed.indexOf(':') + 1).trim();
				const match = inline.match(/^\[([^\]]*)\]$/);
				if (match) events.push(...match[1].split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
			} else if (/^jobs\s*:/.test(trimmed)) {
				section = 'jobs';
				jobsIndent = 0;
			}
			continue;
		}
		// Workflow event keys are direct children of `on:` (exactly two
		// spaces). Nested `branches`, `types`, and `inputs` are configuration,
		// not additional event names.
		if (section === 'on' && indent === onIndent + 2) {
			const event = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:/)?.[1];
			if (event) {
				events.push(event);
				mergeGroupIndent = event === 'merge_group' ? indent : -1;
			}
			continue;
		}
		if (section === 'on' && mergeGroupIndent >= 0 && indent === mergeGroupIndent + 2) {
			const inlineTypes = trimmed.match(/^types\s*:\s*\[([^\]]*)\]\s*$/)?.[1];
			if (inlineTypes !== undefined) {
				mergeGroupTypes.push(...inlineTypes.split(',').map((value) => value.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
			}
			continue;
		}
		if (section === 'on' && mergeGroupIndent >= 0 && indent === mergeGroupIndent + 4) {
			const blockType = trimmed.match(/^-\s*([^#]+?)(?:\s+#.*)?$/)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
			if (blockType) mergeGroupTypes.push(blockType);
			continue;
		}
		if (section === 'jobs' && indent > jobsIndent) {
			const job = line.match(/^\s{2}([^\s:#][^:#]*):\s*(?:#.*)?$/)?.[1]?.trim();
			if (job) jobs.push(job);
		}
	}
	return { file, events: unique(events), mergeGroupTypes: unique(mergeGroupTypes), jobs: unique(jobs) };
}

function readBoundedJson(file: string): unknown {
	const stat = fs.statSync(file);
	if (stat.size > MAX_JSON_BYTES) throw new Error(`${file} exceeds the ${MAX_JSON_BYTES}-byte JSON bound`);
	return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function sha256(file: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runGit(args: string[], cwd: string): { exitCode: number; stdout: string } {
	try {
		const proc = Bun.spawnSync({
			cmd: ['git', ...args],
			cwd,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		});
		return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
	} catch {
		return { exitCode: 1, stdout: '' };
	}
}

/**
 * Resolve a Git diff into changed paths without treating an unavailable diff
 * as an empty change set. An empty set is a valid result only after Git has
 * positively confirmed the range, otherwise a release-owner edit could pass
 * simply because the guard could not inspect it.
 */
export function changedFilesFromGitResult(result: { exitCode: number; stdout: string }): string[] {
	if (result.exitCode !== 0) {
		throw new Error(`git diff failed with exit code ${result.exitCode}; cannot determine changed files`);
	}
	return result.stdout.split(/\r?\n/).map(posix).filter(Boolean);
}

/** Collect and evaluate the real checked-in contract without network access. */
export function collectRequiredCheckContract(
	root: string = REPO_ROOT,
	options: { now?: Date; contractPath?: string; evidencePath?: string; currentSha?: string } = {},
): ContractEvaluation {
	const findings: ContractFinding[] = [];
	const contractFile = options.contractPath ?? path.join(root, 'scripts', 'required-check-contract.json');
	const evidenceFile = options.evidencePath ?? path.join(root, 'docs', 'ci', 'required-check-evidence.json');
	let contractValue: unknown;
	let evidenceValue: unknown;
	try {
		contractValue = readBoundedJson(contractFile);
		evidenceValue = readBoundedJson(evidenceFile);
	} catch (error) {
		return {
			status: 'unknown',
			ok: false,
			findings: [{ code: 'EXTERNAL_EVIDENCE_UNKNOWN', severity: 'error', message: `could not read required-check contract/evidence: ${error instanceof Error ? error.message : String(error)}` }],
			unknown: ['contract', 'evidence'],
		};
	}
	if (!isRecord(contractValue)) {
		return {
			status: 'unknown',
			ok: false,
			findings: [{ code: 'CONTRACT_MALFORMED', severity: 'error', message: 'required-check contract JSON must be an object' }],
			unknown: ['contract'],
		};
	}
	if (!isRecord(evidenceValue)) {
		return {
			status: 'unknown',
			ok: false,
			findings: [{ code: 'EXTERNAL_EVIDENCE_UNKNOWN', severity: 'error', message: 'required-check evidence JSON must be an object' }],
			unknown: ['evidence'],
		};
	}
	const contract = contractValue as RequiredCheckContract;
	const evidence = evidenceValue as RequiredCheckEvidence;
	const input = { ...contract, evidence };
	const result = evaluateRequiredCheckContract(input, { now: options.now, strict: true });
	findings.push(...result.findings);
	const collectorUnknown = [...result.unknown];
	if (options.currentSha && evidence.captureSha && options.currentSha !== evidence.captureSha) {
		addFinding(findings, 'CAPTURE_SHA_MISMATCH', 'error', `evidence capture SHA ${evidence.captureSha} does not match requested current SHA ${options.currentSha}`);
	}
	if (!Array.isArray(contract.workflows)) {
		addFinding(findings, 'CONTRACT_MALFORMED', 'error', 'contract workflows must be an array');
	}
	const contractWorkflows = Array.isArray(contract.workflows) ? contract.workflows : [];
	for (const workflow of contractWorkflows) {
		if (!isRecord(workflow) || typeof workflow.file !== 'string') {
			addFinding(findings, 'CONTRACT_MALFORMED', 'error', 'contract workflow entry must be an object');
			continue;
		}
		const workflowPath = posix(workflow.file);
		if (!workflowPath.startsWith('.github/workflows/') || workflowPath.includes('/../') || workflowPath.includes('\0')) {
			addFinding(findings, 'CONTRACT_MALFORMED', 'error', `contract workflow path is outside .github/workflows: ${workflowPath}`, { file: workflowPath });
			continue;
		}
		const absolute = path.join(root, workflowPath);
		try {
			const capture = evidence.capturedWorkflowFiles?.[workflowPath];
			if (
				/^[0-9a-f]{40}$/i.test(evidence.captureSha ?? '') &&
				isRecord(capture) &&
				typeof capture.blobSha === 'string' &&
				/^[0-9a-f]{40}$/i.test(capture.blobSha)
			) {
				const capturedBlob = runGit(
					['rev-parse', `${evidence.captureSha}:${workflowPath}`],
					root,
				);
				if (
					capturedBlob.exitCode !== 0 ||
					capturedBlob.stdout.trim() !== capture.blobSha
				) {
					collectorUnknown.push('workflow_capture');
					addFinding(
						findings,
						'CAPTURE_BLOB_MISMATCH',
						'error',
						`captured workflow blob for ${workflowPath} is unavailable or does not match its pinned blobSha`,
						{ file: workflowPath },
					);
				}
			}
			const surface = parseWorkflowSurface(fs.readFileSync(absolute, 'utf8'), workflowPath);
			const expectedEvents = new Set(stringArray(workflow.events) ?? []);
			for (const expected of expectedEvents) {
				if (!surface.events.includes(expected)) {
					addFinding(findings, 'PROMISED_CONTEXT_EVENT_SKIPPED', 'error', `contract workflow ${workflowPath} no longer declares ${expected}`, { file: workflowPath });
				}
			}
			const expectedMergeGroupTypes = stringArray(workflow.mergeGroupTypes) ?? (expectedEvents.has('merge_group') ? ['checks_requested'] : []);
			for (const expectedType of expectedMergeGroupTypes) {
				if (!surface.mergeGroupTypes.includes(expectedType)) {
					addFinding(findings, 'PROMISED_CONTEXT_EVENT_SKIPPED', 'error', `contract workflow ${workflowPath} does not declare merge_group type ${expectedType}`, { file: workflowPath });
				}
			}
			const localWorkflowHashes = evidence.localWorkflowHashes ?? evidence.workflowHashes;
			if (localWorkflowHashes?.[workflowPath] && localWorkflowHashes[workflowPath] !== sha256(absolute)) {
				addFinding(findings, 'WORKFLOW_CHANGED_AFTER_CAPTURE', 'error', `contract-owned workflow ${workflowPath} differs from its recorded local validation hash`, { file: workflowPath });
			}
			const expectedJobs = stringArray(workflow.jobs) ?? [];
			for (const job of expectedJobs) {
				if (!surface.jobs.includes(job)) {
					addFinding(findings, 'PROMISED_CONTEXT_MISSING', 'error', `contract workflow ${workflowPath} no longer declares job ${job}`, { file: workflowPath, job });
				}
			}
		} catch (error) {
			addFinding(findings, 'EVIDENCE_MALFORMED', 'error', `cannot parse contract workflow ${workflowPath}: ${error instanceof Error ? error.message : String(error)}`, { file: workflowPath });
		}
	}
	const final = finishEvaluation(findings, collectorUnknown);
	return final;
}

function changedFilesForGuard(root: string): string[] {
	const explicit = process.env.RELEASE_GUARD_CHANGED_FILES;
	if (explicit !== undefined) return explicit.split(/\r?\n/).map(posix).filter(Boolean);
	const head = process.env.RELEASE_GUARD_HEAD_SHA || process.env.GITHUB_SHA || 'HEAD';
	const base = process.env.RELEASE_GUARD_BASE_SHA || (process.env.GITHUB_EVENT_NAME === 'merge_group' ? `${head}^` : 'origin/main');
	return changedFilesFromGitResult(runGit(releaseOwnerDiffArgs(base, head), root));
}

function headSubject(root: string): string {
	const head = process.env.RELEASE_GUARD_HEAD_SHA || process.env.GITHUB_SHA || 'HEAD';
	const result = runGit(['log', '-1', '--format=%s', head], root);
	return result.exitCode === 0 ? result.stdout.trim() : '';
}

function printFindings(findings: ContractFinding[]): void {
	for (const finding of findings) {
		const level = finding.severity === 'notice' ? 'notice' : finding.severity;
		const file = finding.file ? ` file=${finding.file}` : '';
		console.log(`::${level}${file}::[required-check-contract:${finding.code}] ${finding.message}`);
	}
}

export function main(argv: string[] = process.argv.slice(2), root = REPO_ROOT): number {
	if (argv.includes('--release-owner')) {
		const event = process.env.RELEASE_GUARD_EVENT || process.env.GITHUB_EVENT_NAME || '';
		const suppliedAutomation = process.env.RELEASE_GUARD_AUTOMATION;
		const automation = suppliedAutomation === undefined
			? deriveReleaseAutomation({
				event,
				actor: process.env.RELEASE_GUARD_ACTOR || process.env.GITHUB_ACTOR,
				releaseBranch: process.env.RELEASE_GUARD_BRANCH || process.env.GITHUB_HEAD_REF,
				headCommitSubject: process.env.RELEASE_GUARD_HEAD_SUBJECT || headSubject(root),
			})
			: ['1', 'true', 'yes', 'on'].includes(suppliedAutomation.trim().toLowerCase());
		try {
			const result = evaluateReleaseOwnership({
				changedFiles: changedFilesForGuard(root),
				event,
				actor: process.env.RELEASE_GUARD_ACTOR || process.env.GITHUB_ACTOR,
				releaseAutomation: automation,
			});
			console.log(`[required-check-contract] ${result.message}`);
			return result.ok ? 0 : 1;
		} catch (error) {
			console.error(`[required-check-contract] release-owner guard unavailable: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
	}
	const result = collectRequiredCheckContract(root);
	printFindings(result.findings);
	console.log(`[required-check-contract] ${result.status} (${result.findings.length} finding(s))`);
	return result.status === 'fail' || result.status === 'unknown' ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
