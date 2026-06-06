/**
 * Context Capsule Builder
 *
 * Constructs role-specific Context Capsules that are injected into delegated
 * agent system messages. Uses the Context Map to populate file summaries,
 * builds a per-file read policy based on staleness, and formats the capsule
 * as a structured markdown document.
 *
 * Each agent role (coder, reviewer, critic, test_engineer, sme) has a
 * dedicated profile that controls which sections are included and how many
 * files appear in the capsule.
 *
 * Uses the `_internals` DI seam pattern so tests can override filesystem
 * and analysis dependencies without `mock.module` (which leaks across
 * files in Bun's shared test-runner process).
 *
 * All functions accept an explicit `directory` parameter (Invariant 4).
 * No `process.cwd()` usage. Never throws — returns best-effort capsules.
 * No `bun:` imports — Node-ESM-loadable (Invariant 2).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { estimateTokens as estimateTokensBase } from '../services/context-budget-service.js';
import type {
	AgentRole,
	CapsuleDelegationReason,
	CapsuleMetadata,
	ContextCapsule,
	ReadPolicyEntry,
	RoleProfile,
} from '../types/context-capsule';
import type { ContextMap, FileContextEntry } from '../types/context-map';
import { extractFileSummary, isFileStale } from './file-summary';
import {
	computeContentHash,
	createEmptyContextMap,
	loadContextMap,
} from './persistence';

// ---------------------------------------------------------------------------
// Token estimation — reuses shared estimator from context-budget-service
// ---------------------------------------------------------------------------

/**
 * Reuse shared token estimator with capsule-specific floor of 1.
 * The base estimator returns 0 for empty strings; capsules need at least 1
 * token to avoid degenerate budget calculations.
 */
export function estimateTokens(content: string): number {
	return Math.max(1, estimateTokensBase(content));
}

// ---------------------------------------------------------------------------
// DI seam — tests override these functions without touching real modules
// ---------------------------------------------------------------------------

/**
 * Test-only dependency-injection seam. Production code calls through this
 * object so tests can replace the underlying implementations without
 * `mock.module` (which leaks across files in Bun's shared test-runner process).
 * Mutating this local object is file-scoped and trivially restorable
 * via `afterEach`.
 */
export const _internals = {
	loadContextMap,
	createEmptyContextMap,
	computeContentHash,
	isFileStale,
	extractFileSummary,
	estimateTokens,
	readFileSync: fs.readFileSync,
	existsSync: fs.existsSync,
} as const;

// ---------------------------------------------------------------------------
// BuildCapsuleParams — inline interface, not exported
// ---------------------------------------------------------------------------

/**
 * Parameters for building a context capsule.
 * Defined inline — not part of the public API surface.
 */
interface BuildCapsuleParams {
	/** Task ID this capsule is for (e.g. "1.1", "2.3") */
	task_id: string;
	/** Which agent role receives this capsule */
	agent_role: AgentRole;
	/** Why this capsule was generated */
	delegation_reason: CapsuleDelegationReason;
	/** Files relevant to this task */
	files_in_scope: string[];
	/** What the task aims to accomplish */
	task_goal: string;
	/** Prior rejection reason, if this capsule is for a fix iteration */
	prior_rejection?: string;
	/** What needs to be fixed, if applicable */
	required_fix?: string;
	/** Repository facts relevant to this task */
	relevant_facts?: string[];
	/** Review checklist items, included for reviewer capsules */
	review_checklist?: string[];
	/** Coverage targets, included for test_engineer capsules */
	coverage_targets?: string[];
	/** Project root directory */
	directory: string;
	/** Maximum token budget for the capsule content (default 2000) */
	max_capsule_tokens?: number;
	/** Capsule mode: conservative (more files, less pruning), balanced (default), aggressive (fewer files, more pruning) */
	mode?: 'conservative' | 'balanced' | 'aggressive';
	/** Whether content hash changes invalidate cached file summaries. Default: true. */
	invalidate_on_hash_change?: boolean;
	/** Custom agent profile overrides — maps role names to strategy names */
	agent_profiles?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Default role profiles
// ---------------------------------------------------------------------------

/**
 * Default capsule construction profiles for each agent role.
 * Controls strategy, max file count, and which optional sections are included.
 */
export const DEFAULT_ROLE_PROFILES: Record<AgentRole, RoleProfile> = {
	coder: {
		role: 'coder',
		strategy: 'scoped_files_plus_rejection',
		max_files: 15,
		include_rejection: true,
		include_coverage: false,
		include_claims: false,
	},
	reviewer: {
		role: 'reviewer',
		strategy: 'full_scope_plus_checklist',
		max_files: 20,
		include_rejection: true,
		include_coverage: false,
		include_claims: true,
	},
	critic: {
		role: 'critic',
		strategy: 'plan_context_only',
		max_files: 5,
		include_rejection: false,
		include_coverage: false,
		include_claims: false,
	},
	test_engineer: {
		role: 'test_engineer',
		strategy: 'code_plus_coverage_targets',
		max_files: 15,
		include_rejection: true,
		include_coverage: true,
		include_claims: false,
	},
	sme: {
		role: 'sme',
		strategy: 'domain_facts_only',
		max_files: 3,
		include_rejection: false,
		include_coverage: false,
		include_claims: false,
	},
};

// ---------------------------------------------------------------------------
// Read policy construction
// ---------------------------------------------------------------------------

/**
 * Build a per-file read policy that tells the consuming agent whether to
 * trust cached summaries or read the original source.
 *
 * For each file:
 * - Not in map → read original (no cached data exists)
 * - In map but stale (content hash changed) → read original
 * - In map and fresh → trust summary
 *
 * @param files - Relative file paths to build policy for
 * @param map - The loaded Context Map
 * @param directory - Project root directory for file resolution
 * @returns Array of read policy entries, one per file
 */
export function buildReadPolicy(
	files: string[],
	map: ContextMap,
	directory: string,
	invalidateOnHashChange = true,
): ReadPolicyEntry[] {
	const policy: ReadPolicyEntry[] = [];

	for (const filePath of files) {
		const entry = map.files[filePath];

		if (!entry) {
			// File is not in the context map
			policy.push({
				file_path: filePath,
				trust_summary: false,
				read_original: true,
				reason: 'file not in context map',
			});
			continue;
		}

		// File exists in map — check staleness
		const absolutePath = path.join(directory, filePath);
		let currentContent: string | undefined;
		try {
			if (_internals.existsSync(absolutePath)) {
				currentContent = _internals.readFileSync(absolutePath, 'utf-8');
			}
		} catch {
			// File unreadable — treat as stale
		}

		if (
			currentContent === undefined ||
			(invalidateOnHashChange && _internals.isFileStale(entry, currentContent))
		) {
			policy.push({
				file_path: filePath,
				trust_summary: false,
				read_original: true,
				reason: 'summary is stale (content changed)',
			});
		} else {
			policy.push({
				file_path: filePath,
				trust_summary: true,
				read_original: false,
				reason: 'summary is current',
			});
		}
	}

	return policy;
}

// ---------------------------------------------------------------------------
// Markdown formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format the read policy section as a single bulleted line.
 */
function formatReadPolicyLine(entry: ReadPolicyEntry): string {
	const action = entry.read_original ? 'READ original' : 'TRUST summary';
	return `- ${entry.file_path}: ${action} (${entry.reason})`;
}

/**
 * Format a file details subsection for a single context map entry.
 */
function formatFileDetails(filePath: string, entry: FileContextEntry): string {
	const language = entry.language ?? 'unknown';
	const exports = entry.exports?.join(', ') ?? 'none';
	const keySymbols = entry.key_symbols?.join(', ') ?? 'none';
	const summary = entry.summary || entry.purpose || 'No summary available';

	return [
		`### ${filePath}`,
		`Language: ${language}`,
		`Exports: ${exports}`,
		`Key Symbols: ${keySymbols}`,
		`Summary: ${summary}`,
	].join('\n');
}

// ---------------------------------------------------------------------------
// Token budget enforcement — pruning
// ---------------------------------------------------------------------------

/**
 * Section headings used to identify removable parts of the capsule.
 * Ordered from least important (removed first) to most important (removed last).
 * The header, Task Goal, Files in Scope, and Read Policy are never in this list
 * because they are mandatory and must never be pruned.
 */
const PRUNE_ORDER: string[] = [
	'## File Details',
	'## Coverage Targets',
	'## Review Checklist',
	'## Required Fix',
	'## Prior Rejection',
	'## Relevant Facts',
];

/**
 * Remove optional sections from capsule content to fit within a token budget.
 *
 * Pruning follows the priority order in PRUNE_ORDER (least important first).
 * After removing each section, tokens are re-estimated. Stops as soon as the
 * budget is satisfied or only mandatory sections remain.
 *
 * @param sections - All capsule content sections (including mandatory + optional)
 * @param tokenEstimate - Current token count of the joined sections
 * @param maxTokens - Token budget to fit within
 * @param estimateFn - Token estimation function
 * @returns Pruned sections and their token count
 */
function pruneCapsuleContent(
	sections: string[],
	tokenEstimate: number,
	maxTokens: number,
	estimateFn: (content: string) => number,
): { prunedSections: string[]; prunedTokenEstimate: number } {
	if (tokenEstimate <= maxTokens) {
		return { prunedSections: sections, prunedTokenEstimate: tokenEstimate };
	}

	let remaining = [...sections];
	let currentEstimate = tokenEstimate;

	for (const heading of PRUNE_ORDER) {
		if (currentEstimate <= maxTokens) break;

		const headingIndex = remaining.indexOf(heading);
		if (headingIndex === -1) continue;

		// Find the end of this section: the next "## " heading or end of array
		let endIndex = remaining.length;
		for (let i = headingIndex + 1; i < remaining.length; i++) {
			if (remaining[i].startsWith('## ')) {
				endIndex = i;
				break;
			}
		}

		// Remove the section heading and all its content lines
		remaining = [
			...remaining.slice(0, headingIndex),
			...remaining.slice(endIndex),
		];

		currentEstimate = estimateFn(remaining.join('\n'));
	}

	return { prunedSections: remaining, prunedTokenEstimate: currentEstimate };
}

// ---------------------------------------------------------------------------
// Capsule builder
// ---------------------------------------------------------------------------

/**
 * Build a role-specific Context Capsule for a delegated agent.
 *
 * Loads the context map, applies the role profile to determine which
 * sections to include, builds a per-file read policy, and formats
 * everything as a structured markdown document.
 *
 * Never throws — returns a best-effort capsule even if the context map
 * is missing or corrupt.
 *
 * @param params - Build parameters including task ID, role, files, and directory
 * @returns The constructed capsule and diagnostic metadata
 */
export function buildCapsule(params: BuildCapsuleParams): {
	capsule: ContextCapsule;
	metadata: CapsuleMetadata;
} {
	const { task_id, agent_role, delegation_reason, directory } = params;
	const generatedAt = new Date().toISOString();

	// (a) Load context map — fall back to empty if missing or corrupt
	const map: ContextMap =
		_internals.loadContextMap(directory) ?? _internals.createEmptyContextMap();

	// (b) Get role profile
	let profile = DEFAULT_ROLE_PROFILES[agent_role];

	// Apply mode adjustments
	if (params.mode === 'conservative') {
		profile = { ...profile, max_files: Math.ceil(profile.max_files * 1.5) };
	} else if (params.mode === 'aggressive') {
		profile = {
			...profile,
			max_files: Math.max(3, Math.floor(profile.max_files * 0.6)),
		};
	}

	// Apply custom agent profile overrides
	if (params.agent_profiles?.[agent_role]) {
		const customStrategy = params.agent_profiles[agent_role];
		profile = { ...profile, strategy: customStrategy };
	}

	// (c) Truncate files to max_files from profile
	const filesInScope = params.files_in_scope.slice(0, profile.max_files);

	// (d) Build read policy
	const readPolicy = buildReadPolicy(
		filesInScope,
		map,
		directory,
		params.invalidate_on_hash_change ?? true,
	);

	// (e) Populate file summaries and track cache diagnostics
	let cacheHits = 0;
	let cacheMisses = 0;
	let staleEntries = 0;

	const fileSummaries: string[] = [];
	const fileDetailsSections: string[] = [];

	for (const filePath of filesInScope) {
		const entry = map.files[filePath];

		if (entry) {
			cacheHits++;

			// Check staleness for tracking purposes (only when hash invalidation is enabled)
			const shouldCheckStaleness = params.invalidate_on_hash_change !== false;
			if (shouldCheckStaleness) {
				const absolutePath = path.join(directory, filePath);
				let currentContent: string | undefined;
				try {
					if (_internals.existsSync(absolutePath)) {
						currentContent = _internals.readFileSync(absolutePath, 'utf-8');
					}
				} catch {
					// File unreadable
				}

				if (
					currentContent === undefined ||
					_internals.isFileStale(entry, currentContent)
				) {
					staleEntries++;
					fileSummaries.push(
						`- ${filePath} — ${entry.purpose || 'No summary available'} (stale)`,
					);
				} else {
					fileSummaries.push(
						`- ${filePath} — ${entry.purpose || 'No summary available'}`,
					);
				}
			} else {
				fileSummaries.push(
					`- ${filePath} — ${entry.purpose || 'No summary available'}`,
				);
			}

			fileDetailsSections.push(formatFileDetails(filePath, entry));
		} else {
			cacheMisses++;
			fileSummaries.push(`- ${filePath} — No summary available`);
		}
	}

	// Compute recommended/skipped reads from the read policy
	const recommendedReads = readPolicy
		.filter((p) => p.read_original)
		.map((p) => p.file_path);
	const skippedReads = readPolicy
		.filter((p) => p.trust_summary)
		.map((p) => p.file_path);

	// (f) Build markdown content
	const sections: string[] = [];

	// Header
	sections.push(
		`# Context Capsule: Task ${task_id}`,
		`Role: ${agent_role} | Reason: ${delegation_reason} | Generated: ${generatedAt}`,
		'',
	);

	// Task Goal
	sections.push('## Task Goal', params.task_goal, '');

	// Files in Scope
	sections.push(
		`## Files in Scope (${filesInScope.length} file${filesInScope.length === 1 ? '' : 's'})`,
		...fileSummaries,
		'',
	);

	// Read Policy
	sections.push('## Read Policy', ...readPolicy.map(formatReadPolicyLine), '');

	// Relevant Facts
	if (params.relevant_facts && params.relevant_facts.length > 0) {
		sections.push(
			'## Relevant Facts',
			...params.relevant_facts.map((f) => `- ${f}`),
			'',
		);
	}

	// Prior Rejection
	if (profile.include_rejection && params.prior_rejection) {
		sections.push('## Prior Rejection', params.prior_rejection, '');
	}

	// Required Fix
	if (profile.include_rejection && params.required_fix) {
		sections.push('## Required Fix', params.required_fix, '');
	}

	// Review Checklist (reviewer role, when include_claims is true)
	if (
		profile.include_claims &&
		params.review_checklist &&
		params.review_checklist.length > 0
	) {
		sections.push(
			'## Review Checklist',
			...params.review_checklist.map((item) => `- ${item}`),
			'',
		);
	}

	// Coverage Targets (test_engineer role, when include_coverage is true)
	if (
		profile.include_coverage &&
		params.coverage_targets &&
		params.coverage_targets.length > 0
	) {
		sections.push(
			'## Coverage Targets',
			...params.coverage_targets.map((t) => `- ${t}`),
			'',
		);
	}

	// File Details
	if (fileDetailsSections.length > 0) {
		sections.push('## File Details', ...fileDetailsSections, '');
	}

	const content = sections.join('\n');

	// (g) Estimate tokens
	let tokenEstimate = _internals.estimateTokens(content);

	// (g2) Enforce token budget with relevance-based pruning
	const maxCapsuleTokens = params.max_capsule_tokens ?? 2000;
	let prunedContent = content;

	if (tokenEstimate > maxCapsuleTokens) {
		const { prunedSections, prunedTokenEstimate } = pruneCapsuleContent(
			sections,
			tokenEstimate,
			maxCapsuleTokens,
			_internals.estimateTokens,
		);
		prunedContent = prunedSections.join('\n');
		tokenEstimate = prunedTokenEstimate;
	}

	// (h) Build the capsule object
	const capsule: ContextCapsule = {
		task_id,
		agent_role,
		delegation_reason,
		generated_at: generatedAt,
		files_in_scope: filesInScope,
		task_goal: params.task_goal,
		prior_rejection: params.prior_rejection,
		required_fix: params.required_fix,
		relevant_facts: params.relevant_facts ?? [],
		review_checklist: params.review_checklist,
		coverage_targets: params.coverage_targets,
		read_policy: readPolicy,
		content: prunedContent,
	};

	// (i) Build metadata
	const metadata: CapsuleMetadata = {
		success: true,
		capsule_path: '',
		token_estimate: tokenEstimate,
		cache_hits: cacheHits,
		cache_misses: cacheMisses,
		stale_entries: staleEntries,
		recommended_reads: recommendedReads,
		skipped_reads: skippedReads,
	};

	return { capsule, metadata };
}
