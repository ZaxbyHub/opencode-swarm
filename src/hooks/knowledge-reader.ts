/** Read path for the opencode-swarm v6.17 two-tier knowledge system.
 * Merges swarm + hive knowledge, deduplicates (hive wins), ranks by composite score,
 * and provides utility tracking.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { warn } from '../utils/logger.js';
import {
	jaccardBigram,
	normalize,
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
	wordBigrams,
} from './knowledge-store.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeCategory,
	KnowledgeConfig,
	KnowledgeEntryBase,
	KnowledgeRetrievalContext,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';

// ============================================================================
// Exported Types
// ============================================================================

export interface ProjectContext {
	projectName: string;
	currentPhase: string;
	techStack?: string[];
	recentErrors?: string[];
}

export interface RankedEntry extends KnowledgeEntryBase {
	tier: 'swarm' | 'hive';
	relevanceScore: {
		category: number;
		confidence: number;
		keywords: number;
	};
	finalScore: number;
}

// ============================================================================
// Scoring Constants
// ============================================================================

/** Jaccard bigram similarity threshold for near-duplicate detection. */
const JACCARD_THRESHOLD = 0.6;

/** Confidence boost for hive entries (cross-project validated). */
const HIVE_TIER_BOOST = 0.05;

/** Confidence penalty for same-project hive entries (architect likely knows these). */
const SAME_PROJECT_PENALTY = -0.05;

// ============================================================================
// Internal Helper: computeRelevance
// ============================================================================

function _computeRelevance(
	entry: KnowledgeEntryBase,
	context?: ProjectContext,
): number {
	let score = 0.5;

	// Global scope boost
	if (entry.scope === 'global') {
		score += 0.1;
	}

	// Stack-specific boost
	if (context?.techStack && entry.scope.startsWith('stack:')) {
		const stack = entry.scope.replace('stack:', '');
		if (context.techStack.includes(stack)) {
			score += 0.3;
		}
	}

	// Phase-based category boost
	if (context?.currentPhase) {
		const phaseCategories = inferCategoriesFromPhase(context.currentPhase);
		if (phaseCategories.includes(entry.category)) {
			score += 0.2;
		}
	}

	// Tag overlap boost
	if (context?.techStack && entry.tags.length > 0) {
		const tagOverlap = entry.tags.filter((t) =>
			context.techStack!.some((s) => t.toLowerCase().includes(s.toLowerCase())),
		).length;
		score += Math.min(tagOverlap * 0.1, 0.2);
	}

	return Math.min(score, 1.0);
}

// ============================================================================
// Internal Helper: inferCategoriesFromPhase
// ============================================================================

function inferCategoriesFromPhase(
	phaseDescription: string,
): KnowledgeCategory[] {
	const lower = phaseDescription.toLowerCase();

	// Pattern-to-category mappings (using bounded quantifiers — NO .*)
	const patterns: { pattern: RegExp; categories: KnowledgeCategory[] }[] = [
		{
			pattern: /\b(?:test|qa|quality|verification|validation)\b/,
			categories: ['testing', 'debugging'],
		},
		{
			pattern: /\b(?:implement|build|develop|coding|code)\b/,
			categories: ['tooling', 'architecture', 'debugging'],
		},
		{
			pattern: /\b(?:integrat|deploy|ci|cd|release|publish)\b/,
			categories: ['integration', 'tooling', 'performance'],
		},
		{
			pattern: /\b(?:plan|design|architect|spec|requirement)\b/,
			categories: ['architecture', 'process'],
		},
		{
			pattern: /\b(?:review|refactor|cleanup|polish|optimi)\b/,
			categories: ['performance', 'architecture', 'process'],
		},
		{
			pattern: /\b(?:secur|audit|harden|compliance)\b/,
			categories: ['security', 'testing'],
		},
		{
			pattern: /\b(?:setup|config|scaffold|init|bootstrap)\b/,
			categories: ['tooling', 'other'],
		},
		{
			pattern: /\b(?:doc|readme|changelog)\b/,
			categories: ['process', 'tooling'],
		},
	];

	// Return first matching pattern's categories
	for (const { pattern, categories } of patterns) {
		if (pattern.test(lower)) {
			return categories;
		}
	}

	// Default categories
	return ['process', 'tooling'];
}

// ============================================================================
// Internal Helper: detectTechStack
// ============================================================================

async function _detectTechStack(directory: string): Promise<string[]> {
	const pkgPath = path.join(directory, 'package.json');
	const techStack = new Set<string>();

	try {
		const content = await readFile(pkgPath, 'utf-8');
		const pkg = JSON.parse(content);
		const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
		const depNames = Object.keys(allDeps || {});

		// Known direct matches
		const knownDeps = [
			'typescript',
			'vitest',
			'jest',
			'mocha',
			'react',
			'vue',
			'angular',
			'svelte',
			'express',
			'fastify',
			'next',
			'nuxt',
			'tailwindcss',
			'prisma',
			'drizzle-orm',
			'mongoose',
			'sequelize',
			'knex',
			'webpack',
			'vite',
			'esbuild',
			'rollup',
			'eslint',
			'prettier',
			'zod',
			'ajv',
			'joi',
		];

		for (const dep of depNames) {
			const lower = dep.toLowerCase();
			// Direct match
			if (knownDeps.includes(lower)) {
				techStack.add(lower);
			}
			// @types/ match
			if (lower.startsWith('@types/')) {
				const base = lower.replace('@types/', '');
				if (knownDeps.includes(base)) {
					techStack.add(base);
				}
			}
		}

		// Known scoped packages
		const knownScopes: Record<string, string> = {
			'@nestjs': 'nestjs',
			'@angular': 'angular',
			'@vue': 'vue',
			'@nuxt': 'nuxt',
			'@svelte': 'svelte',
			'@tanstack': 'tanstack',
		};

		for (const dep of depNames) {
			const lower = dep.toLowerCase();
			for (const [scope, name] of Object.entries(knownScopes)) {
				if (lower.startsWith(scope)) {
					techStack.add(name);
				}
			}
		}

		// ESM detection
		if (pkg.type === 'module') {
			techStack.add('esm');
		}

		// Explicit TypeScript detection
		if (allDeps.typescript || allDeps['ts-node'] || pkg.types) {
			techStack.add('typescript');
		}
	} catch {
		// Return empty array on any error
		return [];
	}

	return Array.from(techStack);
}

// ============================================================================
// Internal Helper: recordLessonsShown
// ============================================================================

async function recordLessonsShown(
	directory: string,
	lessonIds: string[],
	currentPhase: string,
): Promise<void> {
	const shownFile = path.join(directory, '.swarm', '.knowledge-shown.json');

	try {
		let shownData: Record<string, string[]> = {};

		if (existsSync(shownFile)) {
			const content = await readFile(shownFile, 'utf-8');
			shownData = JSON.parse(content);
		}

		// Normalize to canonical 'Phase N' key so updateRetrievalOutcome can
		// always find the record regardless of verbose phase description format.
		// e.g. 'Phase 1: Setup [IN PROGRESS]' → 'Phase 1'
		const phaseMatch = /^Phase\s+(\d+)/i.exec(currentPhase);
		const canonicalKey = phaseMatch ? `Phase ${phaseMatch[1]}` : currentPhase;

		shownData[canonicalKey] = lessonIds;

		await mkdir(path.dirname(shownFile), { recursive: true });
		await writeFile(shownFile, JSON.stringify(shownData, null, 2), 'utf-8');
	} catch {
		warn('[swarm] Knowledge: failed to record shown lessons');
	}
}

// ============================================================================
// Exported: readMergedKnowledge
// ============================================================================

export async function readMergedKnowledge(
	directory: string,
	config: KnowledgeConfig,
	context?: ProjectContext,
): Promise<RankedEntry[]> {
	// Step 1: Read swarm entries
	const swarmPath = resolveSwarmKnowledgePath(directory);
	const swarmEntries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);

	// Step 2: Read hive entries if enabled
	let hiveEntries: HiveKnowledgeEntry[] = [];
	if (config.hive_enabled !== false) {
		const hivePath = resolveHiveKnowledgePath();
		hiveEntries = await readKnowledge<HiveKnowledgeEntry>(hivePath);
	}

	// Step 3: Merge with deduplication — hive wins
	const seenLessons = new Set<string>();
	const merged: RankedEntry[] = [];

	// Add hive entries first (they win in deduplication)
	for (const entry of hiveEntries) {
		const normalized = normalize(entry.lesson);
		seenLessons.add(normalized);
		merged.push({
			...entry,
			relevanceScore: { category: 0, confidence: 0, keywords: 0 },
			finalScore: 0,
		});
	}

	// Add swarm entries only if not duplicate
	for (const entry of swarmEntries) {
		const normalized = normalize(entry.lesson);

		// Skip exact duplicates
		if (seenLessons.has(normalized)) {
			continue;
		}

		// Skip near-duplicates using Jaccard threshold
		const swarmBigrams = wordBigrams(normalized);

		// Check against hive entries (hive wins over swarm)
		const isHiveNearDup = hiveEntries.some(
			(hiveEntry) =>
				jaccardBigram(swarmBigrams, wordBigrams(normalize(hiveEntry.lesson))) >=
				JACCARD_THRESHOLD,
		);
		if (isHiveNearDup) continue;

		// Check against already-added swarm entries (intra-swarm dedup)
		const isSwarmNearDup = merged.some(
			(m) =>
				m.tier === 'swarm' &&
				jaccardBigram(swarmBigrams, wordBigrams(normalize(m.lesson))) >=
					JACCARD_THRESHOLD,
		);
		if (isSwarmNearDup) continue;

		seenLessons.add(normalized);
		merged.push({
			...entry,
			relevanceScore: { category: 0, confidence: 0, keywords: 0 },
			finalScore: 0,
		});
	}

	// Step 3.5: Apply scope_filter — exclude entries whose scope doesn't match
	const scopeFilter = config.scope_filter ?? ['global'];
	// Also filter out archived entries (stale by age/decay)
	const filtered = merged.filter(
		(entry) =>
			scopeFilter.some((pattern) => (entry.scope ?? 'global') === pattern) &&
			entry.status !== 'archived',
	);

	// Step 4: Compute finalScore using three-tier weighted scoring
	// Category: 40%, Confidence: 35%, Keywords: 25%
	const ranked: RankedEntry[] = filtered.map((entry) => {
		// Category match score (40% weight)
		let categoryScore = 0;
		if (context?.currentPhase) {
			const phaseCategories = inferCategoriesFromPhase(context.currentPhase);
			if (phaseCategories.includes(entry.category)) {
				categoryScore = 1.0; // Full match
			} else if (entry.category === 'process') {
				categoryScore = 0.5; // Process lessons are generally applicable
			}
		} else {
			categoryScore = 0.5; // Default if no phase context
		}

		// Confidence score (35% weight) - already 0.0-1.0
		const confidenceScore = entry.confidence;

		// Keywords match score (25% weight)
		let keywordsScore = 0;
		if (context?.techStack && entry.tags.length > 0) {
			const matchingTags = entry.tags.filter((t) =>
				context.techStack!.some(
					(s) =>
						t.toLowerCase().includes(s.toLowerCase()) ||
						s.toLowerCase().includes(t.toLowerCase()),
				),
			).length;
			keywordsScore = Math.min(
				matchingTags / Math.max(entry.tags.length, 1),
				1.0,
			);
		} else if (entry.tags.length === 0) {
			keywordsScore = 0.5; // Neutral if no tags
		}

		// Tier boost: hive entries get slight advantage
		const tierBoost = entry.tier === 'hive' ? HIVE_TIER_BOOST : 0;

		// Same project penalty: slightly reduce score for same-project hive entries
		const isSameProjectSource =
			context?.projectName &&
			entry.tier === 'hive' &&
			'source_project' in entry &&
			(entry as { source_project: string }).source_project ===
				context.projectName;
		const sameProjectPenalty = isSameProjectSource ? SAME_PROJECT_PENALTY : 0;

		// Weighted final score
		const finalScore =
			categoryScore * 0.4 +
			confidenceScore * 0.35 +
			keywordsScore * 0.25 +
			tierBoost +
			sameProjectPenalty;

		// Store component scores for debugging
		const relevanceScore = {
			category: categoryScore,
			confidence: confidenceScore,
			keywords: keywordsScore,
		};

		return {
			...entry,
			relevanceScore,
			finalScore: Math.min(Math.max(finalScore, 0), 1), // Clamp 0-1
		};
	});

	// Step 5: Sort by finalScore descending, with recency as tiebreaker
	ranked.sort((a, b) => {
		const scoreDiff = b.finalScore - a.finalScore;
		if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
		// Tiebreaker: prefer more recent entries (newer created_at)
		const dateA = new Date(a.created_at).getTime();
		const dateB = new Date(b.created_at).getTime();
		return dateB - dateA;
	});

	// Step 6: Apply maxInject limit
	const maxInject = config.max_inject_count ?? 5;
	const topN = ranked.slice(0, maxInject);

	// Step 7: Record lessons shown (fire-and-forget, non-critical)
	// Note: recordLessonsShown has its own internal catch that logs via warn(),
	// so this outer .catch() is defensive only (handles unexpected rejections).
	if (topN.length > 0 && context?.currentPhase) {
		recordLessonsShown(
			directory,
			topN.map((e) => e.id),
			context.currentPhase,
		).catch((err) => {
			warn('[knowledge-reader] recordLessonsShown unexpected rejection:', err);
		});
	}

	return topN;
}

// ============================================================================
// Exported: updateRetrievalOutcome
// ============================================================================

export async function updateRetrievalOutcome(
	directory: string,
	phaseInfo: string,
	phaseSucceeded: boolean,
): Promise<void> {
	const shownFile = path.join(directory, '.swarm', '.knowledge-shown.json');

	try {
		// Exit early if file doesn't exist
		if (!existsSync(shownFile)) {
			return;
		}

		const content = await readFile(shownFile, 'utf-8');
		const shownData: Record<string, string[]> = JSON.parse(content);
		const shownIds = shownData[phaseInfo];

		// Exit if no shown IDs for this phase
		if (!shownIds || shownIds.length === 0) {
			return;
		}

		// Update swarm entries
		const swarmPath = resolveSwarmKnowledgePath(directory);
		const entries = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
		let updated = false;
		const foundInSwarm = new Set<string>();

		for (const entry of entries) {
			if (shownIds.includes(entry.id)) {
				// v2: applied_count is FROZEN — do NOT auto-increment from "shown".
				// Use shown_count (already bumped by recordKnowledgeShown) and the
				// new succeeded_after_shown_count / failed_after_shown_count for
				// post-phase outcome attribution.
				const ro = entry.retrieval_outcomes as unknown as Record<
					string,
					unknown
				>;
				if (phaseSucceeded) {
					ro.succeeded_after_shown_count =
						((ro.succeeded_after_shown_count as number) ?? 0) + 1;
				} else {
					ro.failed_after_shown_count =
						((ro.failed_after_shown_count as number) ?? 0) + 1;
				}
				updated = true;
				foundInSwarm.add(entry.id);
			}
		}

		if (updated) {
			await rewriteKnowledge(swarmPath, entries);
		}

		// Only update hive if there are IDs that weren't found in swarm
		const remainingIds = shownIds.filter((id) => !foundInSwarm.has(id));
		if (remainingIds.length === 0) {
			// All shown lessons were swarm-tier; skip hive read
			delete shownData[phaseInfo];
			await writeFile(shownFile, JSON.stringify(shownData, null, 2), 'utf-8');
			return;
		}

		// Update hive entries
		const hivePath = resolveHiveKnowledgePath();
		const hiveEntries = await readKnowledge<HiveKnowledgeEntry>(hivePath);
		let hiveUpdated = false;

		for (const entry of hiveEntries) {
			if (remainingIds.includes(entry.id)) {
				const ro = entry.retrieval_outcomes as unknown as Record<
					string,
					unknown
				>;
				if (phaseSucceeded) {
					ro.succeeded_after_shown_count =
						((ro.succeeded_after_shown_count as number) ?? 0) + 1;
				} else {
					ro.failed_after_shown_count =
						((ro.failed_after_shown_count as number) ?? 0) + 1;
				}
				hiveUpdated = true;
			}
		}

		if (hiveUpdated) {
			await rewriteKnowledge(hivePath, hiveEntries);
		}

		// Clean up shown record
		delete shownData[phaseInfo];
		await writeFile(shownFile, JSON.stringify(shownData, null, 2), 'utf-8');
	} catch {
		warn('[swarm] Knowledge: failed to update retrieval outcomes');
	}
}

// ============================================================================
// v2: Action-aware retrieval
// ============================================================================

/** Default min confidence for trigger/action match boost. */
const DIRECTIVE_BOOST_MIN_CONFIDENCE = 0.75;

function lc(s: string | undefined): string {
	return (s ?? '').toLowerCase();
}

function anyMatch(haystack: string[], needles: string[]): boolean {
	if (needles.length === 0) return false;
	const hay = haystack.map(lc);
	return needles.some((n) => hay.some((h) => h.includes(lc(n))));
}

function tokenizeContext(ctx: KnowledgeRetrievalContext): string[] {
	const parts: string[] = [];
	if (ctx.taskTitle) parts.push(ctx.taskTitle);
	if (ctx.taskDescription) parts.push(ctx.taskDescription);
	if (ctx.lastUserMessage) parts.push(ctx.lastUserMessage);
	if (ctx.currentAction) parts.push(ctx.currentAction);
	if (ctx.currentTool) parts.push(ctx.currentTool);
	if (ctx.targetAgent) parts.push(ctx.targetAgent);
	if (ctx.declaredScope) parts.push(ctx.declaredScope);
	if (ctx.recentReviewerFailures) parts.push(...ctx.recentReviewerFailures);
	if (ctx.recentTestFailures) parts.push(...ctx.recentTestFailures);
	if (ctx.recentToolErrors) parts.push(...ctx.recentToolErrors);
	if (ctx.planConstraints) parts.push(...ctx.planConstraints);
	if (ctx.filePaths) parts.push(...ctx.filePaths);
	return parts.map(lc);
}

/** Returns 0..1 score representing trigger/action match strength against the context. */
export function scoreDirectiveAgainstContext(
	entry: KnowledgeEntryBase,
	ctx: KnowledgeRetrievalContext,
): {
	triggerHit: boolean;
	actionHit: boolean;
	agentHit: boolean;
	score: number;
} {
	const haystack = tokenizeContext(ctx);
	const triggerHit =
		entry.triggers && entry.triggers.length > 0
			? anyMatch(haystack, entry.triggers)
			: false;
	const actionHit =
		entry.applies_to_tools && entry.applies_to_tools.length > 0
			? entry.applies_to_tools
					.map(lc)
					.some((t) => t === lc(ctx.currentTool) || t === lc(ctx.currentAction))
			: false;
	const agentHit =
		entry.applies_to_agents && entry.applies_to_agents.length > 0
			? entry.applies_to_agents.map(lc).some((a) => a === lc(ctx.targetAgent))
			: false;
	let score = 0;
	if (triggerHit) score += 0.5;
	if (actionHit) score += 0.35;
	if (agentHit) score += 0.25;
	if (entry.directive_priority === 'critical') score += 0.4;
	else if (entry.directive_priority === 'high') score += 0.2;
	else if (entry.directive_priority === 'medium') score += 0.1;
	return { triggerHit, actionHit, agentHit, score: Math.min(1, score) };
}

/**
 * v2: Action-aware retrieval. Returns RankedEntry[] but uses the richer
 * KnowledgeRetrievalContext to bias ranking toward entries whose triggers,
 * applies_to_tools, applies_to_agents, or directive_priority match the
 * current decision point. Falls back to readMergedKnowledge ordering for
 * non-matching entries.
 */
export async function readContextualKnowledge(
	directory: string,
	config: KnowledgeConfig,
	ctx: KnowledgeRetrievalContext,
): Promise<RankedEntry[]> {
	// Step 1: get the legacy ranked merge using the projected ProjectContext shape.
	const projected: ProjectContext = {
		projectName: ctx.projectName ?? 'unknown',
		currentPhase: ctx.currentPhase ?? 'Phase 0',
		techStack: ctx.techStack,
		recentErrors: [
			...(ctx.recentReviewerFailures ?? []),
			...(ctx.recentTestFailures ?? []),
			...(ctx.recentToolErrors ?? []),
		],
	};
	// Pull a wider window than max_inject so we have headroom to re-rank.
	const wideCfg: KnowledgeConfig = {
		...config,
		max_inject_count: Math.max(20, config.max_inject_count ?? 5),
	};
	const candidates =
		(await readMergedKnowledge(directory, wideCfg, projected)) ?? [];

	// Step 2: re-rank using directive metadata.
	const minConf =
		typeof (config as { directive_min_confidence?: number })
			.directive_min_confidence === 'number'
			? (config as { directive_min_confidence?: number })
					.directive_min_confidence!
			: DIRECTIVE_BOOST_MIN_CONFIDENCE;

	const rescored = candidates.map((entry) => {
		const ds = scoreDirectiveAgainstContext(entry, ctx);
		// High-confidence + action match → strong boost
		const confBoost =
			entry.confidence >= minConf && (ds.actionHit || ds.agentHit) ? 0.25 : 0;
		const generatedSkillBoost =
			entry.generated_skill_path && entry.status !== 'archived' ? 0.05 : 0;
		const finalScore = Math.min(
			1,
			entry.finalScore + ds.score + confBoost + generatedSkillBoost,
		);
		return {
			...entry,
			finalScore,
			__directive: ds,
		} as RankedEntry & {
			__directive: ReturnType<typeof scoreDirectiveAgainstContext>;
		};
	});

	// Step 3: force-include critical+matching entries even if they would otherwise drop off.
	rescored.sort((a, b) => b.finalScore - a.finalScore);
	const max = config.max_inject_count ?? 5;
	const top: typeof rescored = [];
	const seen = new Set<string>();

	// Pass A: critical + trigger/action matches first
	for (const e of rescored) {
		if (top.length >= max) break;
		const ds = e.__directive;
		const isCritical =
			e.directive_priority === 'critical' &&
			(ds.triggerHit || ds.actionHit || ds.agentHit);
		if (isCritical && !seen.has(e.id)) {
			top.push(e);
			seen.add(e.id);
		}
	}
	// Pass B: remaining by score
	for (const e of rescored) {
		if (top.length >= max) break;
		if (!seen.has(e.id)) {
			top.push(e);
			seen.add(e.id);
		}
	}

	// Strip private fields before returning
	return top.map(({ __directive: _d, ...rest }) => rest as RankedEntry);
}

// ============================================================================
// DI Seam — _internals
// ============================================================================

export const _internals: {
	readMergedKnowledge: typeof readMergedKnowledge;
	readContextualKnowledge: typeof readContextualKnowledge;
	updateRetrievalOutcome: typeof updateRetrievalOutcome;
	scoreDirectiveAgainstContext: typeof scoreDirectiveAgainstContext;
} = {
	readMergedKnowledge,
	readContextualKnowledge,
	updateRetrievalOutcome,
	scoreDirectiveAgainstContext,
};
