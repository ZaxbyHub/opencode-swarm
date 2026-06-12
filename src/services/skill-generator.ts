/**
 * Knowledge-to-skill compiler.
 *
 * Selects mature, high-confidence knowledge entries (with optional actionable
 * directive metadata), clusters them, and emits SKILL.md files either as draft
 * proposals (.swarm/skills/proposals/<slug>.md) or active generated skills
 * (.opencode/skills/generated/<slug>/SKILL.md).
 *
 * Safety:
 *   - slug sanitizer rejects path traversal / control chars / absolute paths
 *   - active mode never overwrites a manually edited skill unless force=true
 *   - generated files always carry an explicit "<!-- generated -->" header
 *   - file writes are atomic (write to .tmp, rename)
 */

import { existsSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
} from '../hooks/knowledge-store.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeEntryBase,
	SwarmKnowledgeEntry,
} from '../hooks/knowledge-types.js';
import {
	ALLOWED_SKILL_PATH_PREFIXES,
	validateSkillPath,
} from '../hooks/knowledge-validator.js';
import { warn } from '../utils/logger.js';
import { appendSkillChangelog } from './skill-changelog.js';

// ============================================================================
// Slug & path helpers
// ============================================================================

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function sanitizeSlug(input: string): string {
	const lc = input.toLowerCase().trim();
	const mapped = lc.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-');
	const trimmed = mapped.replace(/^-+|-+$/g, '');
	return trimmed.slice(0, 64);
}

export function isValidSlug(slug: string): boolean {
	return SLUG_PATTERN.test(slug);
}

export function proposalPath(directory: string, slug: string): string {
	return path.join(directory, '.swarm', 'skills', 'proposals', `${slug}.md`);
}

export function activePath(directory: string, slug: string): string {
	return path.join(
		directory,
		'.opencode',
		'skills',
		'generated',
		slug,
		'SKILL.md',
	);
}

/** Repo-relative path used inside SKILLS: file: references and entry metadata. */
export function activeRepoRelativePath(slug: string): string {
	return `.opencode/skills/generated/${slug}/SKILL.md`;
}

// ============================================================================
// Candidate selection
// ============================================================================

export interface CandidateSelectionOptions {
	minConfidence: number;
	minConfirmations: number;
}

export interface KnowledgeCluster {
	slug: string;
	title: string;
	entries: KnowledgeEntryBase[];
	triggers: string[];
	required_actions: string[];
	forbidden_actions: string[];
	target_agents: string[];
	verification_checks: string[];
	avgConfidence: number;
}

export async function selectCandidateEntries(
	directory: string,
	opts: CandidateSelectionOptions,
): Promise<KnowledgeEntryBase[]> {
	const swarm = await readKnowledge<SwarmKnowledgeEntry>(
		resolveSwarmKnowledgePath(directory),
	);
	const hivePath = resolveHiveKnowledgePath();
	const hive = existsSync(hivePath)
		? await readKnowledge<HiveKnowledgeEntry>(hivePath)
		: [];
	const all: KnowledgeEntryBase[] = [...swarm, ...hive];
	return all.filter((e) => {
		if (e.status === 'archived') return false;
		if (e.confidence < opts.minConfidence) return false;
		const confirmations = (e.confirmed_by ?? []).length;
		if (confirmations < opts.minConfirmations) return false;
		// Already-compiled entries are not re-selected unless caller forces.
		if (e.generated_skill_slug) return false;
		return true;
	});
}

// ============================================================================
// Clustering — Jaccard-based fuzzy tag clustering
// ============================================================================

/** Minimum cluster size: single-entry clusters are dropped. */
const MIN_CLUSTER_SIZE = 2;

/** Jaccard similarity threshold for merging entries into an existing cluster. */
const JACCARD_THRESHOLD = 0.5;

/**
 * Compute Jaccard similarity between two tag sets.
 * Returns 0 when both sets are empty (avoids division by zero).
 */
function jaccardSimilarity(setA: string[], setB: string[]): number {
	const normA = setA.map((s) => s.toLowerCase());
	const normB = setB.map((s) => s.toLowerCase());
	const setANorm = new Set(normA);
	const setBNorm = new Set(normB);
	if (setANorm.size === 0 && setBNorm.size === 0) return 0;
	let intersection = 0;
	for (const t of setANorm) {
		if (setBNorm.has(t)) intersection++;
	}
	const union = setANorm.size + setBNorm.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

export function clusterEntries(
	entries: KnowledgeEntryBase[],
): KnowledgeCluster[] {
	// Greedy Jaccard-based clustering: each cluster tracks the union of all
	// member tags as its representative tag set. Entries are assigned to the
	// best-matching cluster whose Jaccard similarity >= JACCARD_THRESHOLD.
	interface TagCluster {
		members: KnowledgeEntryBase[];
		repTags: Set<string>;
	}
	const clusters: TagCluster[] = [];

	for (const e of entries) {
		const eTags = (e.tags ?? []).map((t) => t.toLowerCase());
		let bestIdx = -1;
		let bestScore = 0;
		for (let i = 0; i < clusters.length; i++) {
			const score = jaccardSimilarity(eTags, [...clusters[i].repTags]);
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}
		if (bestIdx >= 0 && bestScore >= JACCARD_THRESHOLD) {
			clusters[bestIdx].members.push(e);
			for (const t of eTags) clusters[bestIdx].repTags.add(t);
		} else {
			clusters.push({ members: [e], repTags: new Set(eTags) });
		}
	}

	// Build KnowledgeCluster objects, filtering out small clusters
	const result: KnowledgeCluster[] = [];
	for (const c of clusters) {
		if (c.members.length < MIN_CLUSTER_SIZE) continue;
		const arr = c.members;
		const triggers = uniqueStrings(arr.flatMap((e) => e.triggers ?? []));
		const required = uniqueStrings(
			arr.flatMap((e) => e.required_actions ?? []),
		);
		const forbidden = uniqueStrings(
			arr.flatMap((e) => e.forbidden_actions ?? []),
		);
		const agents = uniqueStrings(arr.flatMap((e) => e.applies_to_agents ?? []));
		const checks = uniqueStrings(
			arr.flatMap((e) => e.verification_checks ?? []),
		);
		const avgConf =
			arr.reduce((s, e) => s + e.confidence, 0) / Math.max(1, arr.length);
		const slugSeed =
			triggers[0] ??
			required[0] ??
			arr[0]?.tags?.[0] ??
			arr[0]?.category ??
			'lesson';
		const slug = sanitizeSlug(slugSeed);
		const title =
			triggers[0] ??
			required[0] ??
			`Lessons: ${arr[0]?.category ?? 'general'} (${arr.length})`;
		result.push({
			slug: isValidSlug(slug)
				? slug
				: sanitizeSlug(`cluster-${slugSeed.slice(0, 12)}`),
			title,
			entries: arr,
			triggers,
			required_actions: required,
			forbidden_actions: forbidden,
			target_agents: agents,
			verification_checks: checks,
			avgConfidence: avgConf,
		});
	}

	// Stable order: largest, highest-confidence first
	result.sort(
		(a, b) =>
			b.entries.length - a.entries.length ||
			b.avgConfidence - a.avgConfidence ||
			a.slug.localeCompare(b.slug),
	);
	return result;
}

function uniqueStrings(arr: string[]): string[] {
	return [...new Set(arr.filter((s) => typeof s === 'string' && s.length > 0))];
}

// ============================================================================
// SKILL.md content emission
// ============================================================================

export interface SkillFrontmatterOverrides {
	version?: number;
	skillOrigin?: 'generated' | 'promoted_external';
}

export function renderSkillMarkdown(
	cluster: KnowledgeCluster,
	mode: GenerateMode = 'active',
	generatedAt = new Date().toISOString(),
	overrides?: SkillFrontmatterOverrides,
): string {
	const description =
		cluster.title.length > 200
			? `${cluster.title.slice(0, 197)}…`
			: cluster.title;
	const ids = cluster.entries.map((e) => `  - ${e.id}`).join('\n');
	const version = overrides?.version ?? 1;
	const skillOrigin = overrides?.skillOrigin ?? 'generated';
	const lines: string[] = [];
	lines.push('---');
	lines.push(`name: ${cluster.slug}`);
	lines.push(`description: ${escapeYaml(description)}`);
	lines.push('generated_from_knowledge:');
	lines.push(ids);
	lines.push('source_knowledge_ids:');
	lines.push(ids);
	lines.push(`generated_at: ${generatedAt}`);
	lines.push(`confidence: ${cluster.avgConfidence.toFixed(2)}`);
	lines.push(`status: ${mode === 'active' ? 'active' : 'draft'}`);
	lines.push(`version: ${version}`);
	lines.push(`skill_origin: ${skillOrigin}`);
	lines.push('---');
	lines.push('');
	lines.push(
		'<!-- generated by opencode-swarm skill-generator. Do not edit by hand; edits will be preserved on regeneration only with controlled update mode. -->',
	);
	lines.push('');
	lines.push(`# ${escapeMarkdown(cluster.title)}`);
	lines.push('');
	lines.push('## Trigger');
	lines.push('');
	for (const t of cluster.triggers.length > 0
		? cluster.triggers
		: ['(no explicit trigger metadata; cluster derived from category/tags)']) {
		lines.push(`- ${escapeMarkdown(t)}`);
	}
	lines.push('');
	lines.push('## Required Procedure');
	lines.push('');
	if (cluster.required_actions.length > 0) {
		for (const r of cluster.required_actions)
			lines.push(`- ${escapeMarkdown(r)}`);
	} else {
		lines.push('- Apply the lessons listed under Source Knowledge IDs.');
	}
	lines.push('');
	lines.push('## Forbidden Shortcuts');
	lines.push('');
	if (cluster.forbidden_actions.length > 0) {
		for (const f of cluster.forbidden_actions)
			lines.push(`- ${escapeMarkdown(f)}`);
	} else {
		lines.push('- (none recorded)');
	}
	lines.push('');
	lines.push('## Delegation Template');
	lines.push('');
	lines.push('When delegating a task affected by this skill, include:');
	lines.push('');
	lines.push('```');
	lines.push(
		`SKILLS: file:.opencode/skills/generated/${cluster.slug}/SKILL.md`,
	);
	lines.push('```');
	lines.push('');
	lines.push('## Reviewer Checks');
	lines.push('');
	if (cluster.verification_checks.length > 0) {
		for (const c of cluster.verification_checks)
			lines.push(`- ${escapeMarkdown(c)}`);
	} else {
		lines.push('- Verify each required action above appears in the diff.');
	}
	lines.push('');
	const needsTestEng = cluster.entries.some(
		(e) => e.category === 'testing' || (e.tags ?? []).includes('testing'),
	);
	if (needsTestEng) {
		lines.push('## Test Engineer Checks');
		lines.push('');
		lines.push(
			'- Add or update tests covering the trigger condition and the forbidden shortcut.',
		);
		lines.push('');
	}
	lines.push('## Source Knowledge IDs');
	lines.push('');
	for (const e of cluster.entries)
		lines.push(`- ${e.id} — ${escapeMarkdown(e.lesson)}`);
	lines.push('');
	return lines.join('\n');
}

function escapeYaml(s: string): string {
	if (/[:#\n\r"']/.test(s)) {
		return JSON.stringify(s);
	}
	return s;
}

function escapeMarkdown(s: string): string {
	return s.replace(/[\r\n]+/g, ' ').slice(0, 280);
}

// ============================================================================
// Atomic write
// ============================================================================

async function atomicWrite(p: string, content: string): Promise<void> {
	await mkdir(path.dirname(p), { recursive: true });
	const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, content, 'utf-8');
	await rename(tmp, p);
}

// ============================================================================
// Public API
// ============================================================================

export type GenerateMode = 'draft' | 'active';

export interface GenerateRequest {
	directory: string;
	mode: GenerateMode;
	slug?: string;
	sourceKnowledgeIds?: string[];
	force?: boolean;
	minConfidence?: number;
	minConfirmations?: number;
}

export interface GenerateResult {
	written: Array<{
		slug: string;
		path: string;
		mode: GenerateMode;
		sourceKnowledgeIds: string[];
		preserved: boolean;
	}>;
	skipped: Array<{ slug: string; reason: string }>;
}

export async function generateSkills(
	req: GenerateRequest,
): Promise<GenerateResult> {
	const minConfidence = req.minConfidence ?? 0.85;
	const minConfirmations = req.minConfirmations ?? 2;
	const candidates = await selectCandidateEntries(req.directory, {
		minConfidence,
		minConfirmations,
	});

	let pool: KnowledgeEntryBase[];
	if (req.sourceKnowledgeIds && req.sourceKnowledgeIds.length > 0) {
		const idSet = new Set(req.sourceKnowledgeIds);
		// In explicit-id mode we relax the maturity gates (caller has chosen)
		// but still skip archived entries.
		const swarm = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(req.directory),
		);
		const hivePath = resolveHiveKnowledgePath();
		const hive = existsSync(hivePath)
			? await readKnowledge<HiveKnowledgeEntry>(hivePath)
			: [];
		pool = [...swarm, ...hive].filter(
			(e) => idSet.has(e.id) && e.status !== 'archived',
		);
	} else {
		pool = candidates;
	}

	const clusters = clusterEntries(pool);
	const result: GenerateResult = { written: [], skipped: [] };

	for (let i = 0; i < clusters.length; i++) {
		const cluster = clusters[i];
		// Apply caller-provided slug only to the first cluster.
		if (req.slug && i === 0) {
			const overridden = sanitizeSlug(req.slug);
			if (!isValidSlug(overridden)) {
				result.skipped.push({
					slug: req.slug,
					reason:
						'slug rejected by sanitizer (path traversal or invalid chars)',
				});
				continue;
			}
			cluster.slug = overridden;
		}
		if (!isValidSlug(cluster.slug)) {
			result.skipped.push({
				slug: cluster.slug,
				reason: 'computed slug invalid',
			});
			continue;
		}
		const targetPath =
			req.mode === 'active'
				? activePath(req.directory, cluster.slug)
				: proposalPath(req.directory, cluster.slug);

		const repoRel = path
			.relative(req.directory, targetPath)
			.replace(/\\/g, '/');
		if (!validateSkillPath(repoRel)) {
			result.skipped.push({
				slug: cluster.slug,
				reason: `target path ${repoRel} not under allowed prefixes (${ALLOWED_SKILL_PATH_PREFIXES.join(', ')})`,
			});
			continue;
		}

		// Active mode: do not overwrite a non-generated SKILL.md
		let preserved = false;
		if (req.mode === 'active' && existsSync(targetPath) && !req.force) {
			const existing = await readFile(targetPath, 'utf-8');
			if (!existing.includes('generated by opencode-swarm skill-generator')) {
				preserved = true;
				result.skipped.push({
					slug: cluster.slug,
					reason:
						'manually edited skill exists at target path; rerun with force=true to overwrite',
				});
				continue;
			}
		}

		const content = renderSkillMarkdown(cluster, req.mode);
		await atomicWrite(targetPath, content);

		// In active mode, stamp source entries with the generated_skill metadata.
		if (req.mode === 'active') {
			await stampSourceEntries(
				req.directory,
				cluster.slug,
				cluster.entries.map((e) => e.id),
			);
		}

		result.written.push({
			slug: cluster.slug,
			path: targetPath,
			mode: req.mode,
			sourceKnowledgeIds: cluster.entries.map((e) => e.id),
			preserved,
		});
	}

	return result;
}

/**
 * Stamp source knowledge entries with `generated_skill_slug` and
 * `generated_skill_path` metadata. Refactored in Phase G′ to take
 * `(directory, slug, ids)` so it can be called both from direct active-mode
 * generation AND from `activateProposal` after parsing the draft frontmatter.
 */
async function stampSourceEntries(
	directory: string,
	slug: string,
	ids: string[],
): Promise<void> {
	if (!ids || ids.length === 0) return;
	const swarmPath = resolveSwarmKnowledgePath(directory);
	const swarm = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
	const idSet = new Set(ids);
	let touched = false;
	const repoRel = activeRepoRelativePath(slug);
	for (const e of swarm) {
		if (!idSet.has(e.id)) continue;
		(e as KnowledgeEntryBase).generated_skill_slug = slug;
		(e as KnowledgeEntryBase).generated_skill_path = repoRel;
		e.updated_at = new Date().toISOString();
		touched = true;
	}
	if (touched) await rewriteKnowledge(swarmPath, swarm);

	const hivePath = resolveHiveKnowledgePath();
	if (!existsSync(hivePath)) return;
	const hive = await readKnowledge<HiveKnowledgeEntry>(hivePath);
	let touchedHive = false;
	for (const e of hive) {
		if (!idSet.has(e.id)) continue;
		(e as KnowledgeEntryBase).generated_skill_slug = slug;
		(e as KnowledgeEntryBase).generated_skill_path = repoRel;
		e.updated_at = new Date().toISOString();
		touchedHive = true;
	}
	if (touchedHive) await rewriteKnowledge(hivePath, hive);
}

/**
 * Bounded YAML frontmatter parser for generated drafts. Recognises the exact
 * shape we emit in renderSkillMarkdown — no full YAML lib required.
 *
 * Returns null when the document does not begin with a `---` frontmatter
 * fence or the closing fence is missing.
 */
export function parseDraftFrontmatter(content: string): {
	name?: string;
	status?: string;
	generatedAt?: string;
	sourceKnowledgeIds: string[];
	version?: number;
	skillOrigin?: string;
} | null {
	// Strip optional UTF-8 BOM that some editors prepend on Windows.
	const stripped =
		content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	// Match the opening fence with optional trailing whitespace before LF / CRLF
	// so hand-authored files with `--- \n` still parse instead of silently
	// returning null (PR #799 critic review).
	const openFence = stripped.match(/^---[ \t]*\r?\n/);
	if (!openFence) return null;
	const fenceLen = openFence[0].length;
	// Closing fence: `\n---` followed by optional trailing whitespace and a
	// line ending or end-of-file. Anchored search ensures the inner body
	// is bounded correctly even with CRLF line endings.
	const closeFence = stripped.slice(fenceLen).match(/\n---[ \t]*(\r?\n|$)/);
	if (!closeFence) return null;
	const closeStart = fenceLen + (closeFence.index ?? 0);
	const body = stripped.slice(fenceLen, closeStart).replace(/\r\n/g, '\n');
	const lines = body.split('\n');
	const out: {
		name?: string;
		status?: string;
		generatedAt?: string;
		sourceKnowledgeIds: string[];
		version?: number;
		skillOrigin?: string;
	} = {
		sourceKnowledgeIds: [],
	};
	let inLegacyIdsList = false;
	let inSourceIdsList = false;
	for (const raw of lines) {
		const line = raw;
		if (inLegacyIdsList || inSourceIdsList) {
			// Accept any non-empty, non-whitespace token bounded to 64 chars.
			// Generator emits UUID v4 ids; tests may use short synthetic ids.
			const m = line.match(/^\s+-\s+(\S{1,64})\s*$/);
			if (m) {
				out.sourceKnowledgeIds.push(m[1]);
				continue;
			}
			// any non-list line ends the list
			inLegacyIdsList = false;
			inSourceIdsList = false;
		}
		const nm = line.match(/^name:\s*(\S+)\s*$/);
		if (nm) {
			out.name = nm[1];
			continue;
		}
		const st = line.match(/^status:\s*(\S+)\s*$/);
		if (st) {
			out.status = st[1];
			continue;
		}
		const ga = line.match(/^generated_at:\s*(\S+)\s*$/);
		if (ga) {
			out.generatedAt = ga[1];
			continue;
		}
		const vm = line.match(/^version:\s*(\d+)\s*$/);
		if (vm) {
			out.version = parseInt(vm[1], 10);
			continue;
		}
		const so = line.match(/^skill_origin:\s*(\S+)\s*$/);
		if (so) {
			out.skillOrigin = so[1];
			continue;
		}
		if (/^generated_from_knowledge:\s*$/.test(line)) {
			inLegacyIdsList = true;
			continue;
		}
		if (/^source_knowledge_ids:\s*$/.test(line)) {
			out.sourceKnowledgeIds = [];
			inSourceIdsList = true;
		}
	}
	return out;
}

// ============================================================================
// Activate / list / inspect
// ============================================================================

export async function activateProposal(
	directory: string,
	slug: string,
	force = false,
): Promise<{
	activated: boolean;
	from: string;
	to: string;
	reason?: string;
	stamped?: boolean;
	stampedIds?: string[];
}> {
	const cleanSlug = sanitizeSlug(slug);
	if (!isValidSlug(cleanSlug)) {
		return {
			activated: false,
			from: '',
			to: '',
			reason: 'invalid slug',
		};
	}
	const from = proposalPath(directory, cleanSlug);
	const to = activePath(directory, cleanSlug);
	if (!existsSync(from)) {
		return {
			activated: false,
			from,
			to,
			reason: `proposal not found: ${from}`,
		};
	}
	if (existsSync(to) && !force) {
		const existing = await readFile(to, 'utf-8');
		if (!existing.includes('generated by opencode-swarm skill-generator')) {
			return {
				activated: false,
				from,
				to,
				reason:
					'active SKILL.md is not generator-stamped (manual edit suspected)',
			};
		}
	}
	let proposalContent: string;
	try {
		proposalContent = await readFile(from, 'utf-8');
	} catch (readErr) {
		return {
			activated: false,
			from,
			to,
			reason: `proposal not found or already activated: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
		};
	}
	// Re-stamp status: active in frontmatter (proposals carry status: draft).
	const flipped = proposalContent.replace(
		/^status:\s*draft\s*$/m,
		'status: active',
	);
	await atomicWrite(to, flipped);

	// Phase G′: parse the draft frontmatter and stamp the source knowledge
	// entries with generated_skill_slug / generated_skill_path. Malformed
	// frontmatter MUST NOT mutate knowledge — we leave activated=true but
	// stamped=false so callers can surface the issue.
	const fm = parseDraftFrontmatter(proposalContent);
	if (!fm || fm.sourceKnowledgeIds.length === 0) {
		return {
			activated: true,
			from,
			to,
			stamped: false,
			reason: 'malformed_frontmatter: no source knowledge ids found',
		};
	}
	try {
		await stampSourceEntries(directory, cleanSlug, fm.sourceKnowledgeIds);
		try {
			_internals.unlinkSync(from);
		} catch {
			/* best-effort: proposal already gone or permissions */
		}
		return {
			activated: true,
			from,
			to,
			stamped: true,
			stampedIds: fm.sourceKnowledgeIds,
		};
	} catch (err) {
		return {
			activated: true,
			from,
			to,
			stamped: false,
			reason: `stamp_failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

export async function listSkills(directory: string): Promise<{
	proposals: Array<{ slug: string; path: string }>;
	active: Array<{ slug: string; path: string }>;
}> {
	const result = {
		proposals: [] as Array<{ slug: string; path: string }>,
		active: [] as Array<{ slug: string; path: string }>,
	};
	const proposalsDir = path.join(directory, '.swarm', 'skills', 'proposals');
	const activeDir = path.join(directory, '.opencode', 'skills', 'generated');
	const fs = await import('node:fs/promises');
	if (existsSync(proposalsDir)) {
		const entries = await fs.readdir(proposalsDir);
		for (const f of entries) {
			if (!f.endsWith('.md')) continue;
			const slug = f.replace(/\.md$/, '');
			result.proposals.push({
				slug,
				path: path.join(proposalsDir, f),
			});
		}
	}
	if (existsSync(activeDir)) {
		const entries = await fs.readdir(activeDir, { withFileTypes: true });
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const retiredMarker = path.join(activeDir, e.name, 'retired.marker');
			if (existsSync(retiredMarker)) continue;
			const skillPath = path.join(activeDir, e.name, 'SKILL.md');
			if (existsSync(skillPath)) {
				result.active.push({
					slug: e.name,
					path: skillPath,
				});
			}
		}
	}
	return result;
}

export async function inspectSkill(
	directory: string,
	slug: string,
	prefer: 'auto' | 'proposal' | 'active' = 'auto',
): Promise<{
	found: boolean;
	path?: string;
	content?: string;
	mode?: GenerateMode;
}> {
	const cleanSlug = sanitizeSlug(slug);
	if (!isValidSlug(cleanSlug)) return { found: false };
	const candidates: Array<{ p: string; m: GenerateMode }> = [];
	if (prefer === 'active' || prefer === 'auto')
		candidates.push({ p: activePath(directory, cleanSlug), m: 'active' });
	if (prefer === 'proposal' || prefer === 'auto')
		candidates.push({ p: proposalPath(directory, cleanSlug), m: 'draft' });
	for (const c of candidates) {
		if (existsSync(c.p)) {
			const content = await readFile(c.p, 'utf-8');
			return { found: true, path: c.p, content, mode: c.m };
		}
	}
	return { found: false };
}

// ============================================================================
// Retire
// ============================================================================

export async function retireSkill(
	directory: string,
	slug: string,
	reason?: string,
): Promise<{
	retired: boolean;
	path: string;
	markerPath: string;
	reason?: string;
}> {
	const cleanSlug = sanitizeSlug(slug);
	if (!isValidSlug(cleanSlug)) {
		return {
			retired: false,
			path: activePath(directory, cleanSlug),
			markerPath: path.join(
				directory,
				'.opencode',
				'skills',
				'generated',
				cleanSlug,
				'retired.marker',
			),
			reason: 'invalid slug',
		};
	}
	const skillPath = activePath(directory, cleanSlug);
	if (!existsSync(skillPath)) {
		return {
			retired: false,
			path: skillPath,
			markerPath: path.join(
				directory,
				'.opencode',
				'skills',
				'generated',
				cleanSlug,
				'retired.marker',
			),
			reason: 'active skill not found',
		};
	}
	const markerDir = path.join(
		directory,
		'.opencode',
		'skills',
		'generated',
		cleanSlug,
	);
	const markerPath = path.join(markerDir, 'retired.marker');
	const markerContent = JSON.stringify({
		retiredAt: new Date().toISOString(),
		reason: reason ?? 'manual_retire',
	});
	await mkdir(markerDir, { recursive: true });
	await writeFile(markerPath, markerContent, 'utf-8');
	return {
		retired: true,
		path: skillPath,
		markerPath,
		reason,
	};
}

// ============================================================================
// Regenerate
// ============================================================================

export async function regenerateSkill(
	directory: string,
	slug: string,
): Promise<{
	regenerated: boolean;
	path: string;
	entryCount: number;
	reason?: string;
	retired?: boolean;
}> {
	const cleanSlug = sanitizeSlug(slug);
	if (!isValidSlug(cleanSlug)) {
		return {
			regenerated: false,
			path: activePath(directory, cleanSlug),
			entryCount: 0,
			reason: 'invalid slug',
		};
	}

	const skillPath = activePath(directory, cleanSlug);
	if (!existsSync(skillPath)) {
		return {
			regenerated: false,
			path: skillPath,
			entryCount: 0,
			reason: 'active skill not found',
		};
	}

	let existingContent: string;
	try {
		existingContent = await readFile(skillPath, 'utf-8');
	} catch (err) {
		return {
			regenerated: false,
			path: skillPath,
			entryCount: 0,
			reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const fm = parseDraftFrontmatter(existingContent);
	let matchedEntries: KnowledgeEntryBase[] = [];

	if (fm && fm.sourceKnowledgeIds.length > 0) {
		// Resolve source entries from frontmatter IDs
		try {
			const swarm = await readKnowledge<SwarmKnowledgeEntry>(
				resolveSwarmKnowledgePath(directory),
			);
			const hivePath = resolveHiveKnowledgePath();
			const hive = existsSync(hivePath)
				? await readKnowledge<HiveKnowledgeEntry>(hivePath)
				: [];
			const all: KnowledgeEntryBase[] = [...swarm, ...hive];
			const idSet = new Set(fm.sourceKnowledgeIds);
			matchedEntries = all.filter((e) => idSet.has(e.id));

			// Early retirement: if ALL source entries are archived, retire
			// immediately — BEFORE any re-clustering fallback. Archived
			// entries ARE matched entries, so we must check here.
			if (
				matchedEntries.length === idSet.size &&
				idSet.size > 0 &&
				matchedEntries.every((e) => e.status === 'archived')
			) {
				try {
					await _internals.retireSkill(
						directory,
						cleanSlug,
						'auto-retire: all source knowledge entries archived at regeneration time',
					);
				} catch {
					/* best effort */
				}
				return {
					regenerated: false,
					path: skillPath,
					entryCount: 0,
					reason: 'all source knowledge archived — skill retired',
					retired: true,
				};
			}
		} catch (err) {
			return {
				regenerated: false,
				path: skillPath,
				entryCount: 0,
				reason: `knowledge read failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	// Filter out archived entries — only regenerate from active knowledge.
	// The early-retirement check above handles the exact case where every
	// source ID matched and all were archived.  This filter handles the
	// partial case: some source IDs missing from the store, or a mix of
	// archived and active entries.
	if (matchedEntries.length > 0) {
		const activeEntries = matchedEntries.filter((e) => e.status !== 'archived');
		if (activeEntries.length === 0) {
			// All matched entries were archived — retire the skill.
			// (Reached when some source IDs had no matching entry, so the
			// early-retirement check above did not fire.)
			try {
				await _internals.retireSkill(
					directory,
					cleanSlug,
					'auto-retire: all matched source knowledge entries archived at regeneration time',
				);
			} catch {
				/* best effort */
			}
			return {
				regenerated: false,
				path: skillPath,
				entryCount: 0,
				reason: 'all matched source knowledge archived — skill retired',
				retired: true,
			};
		}
		matchedEntries = activeEntries;
	}

	if (!matchedEntries || matchedEntries.length === 0) {
		// Re-cluster from scratch using candidate selection with slug as keyword hint
		try {
			const candidates = await selectCandidateEntries(directory, {
				minConfidence: 0.7,
				minConfirmations: 1,
			});
			// Use the slug as a fuzzy tag match — filter entries whose tags or lesson
			// contain slug-derived tokens as a best-effort re-cluster hint.
			const slugTokens = cleanSlug.split('-').filter((t) => t.length > 1);
			matchedEntries = candidates.filter((e) => {
				const text =
					`${e.lesson} ${(e.tags ?? []).join(' ')} ${e.category}`.toLowerCase();
				return slugTokens.some((tok) => text.includes(tok));
			});
		} catch (err) {
			return {
				regenerated: false,
				path: skillPath,
				entryCount: 0,
				reason: `candidate selection failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	if (matchedEntries.length === 0) {
		return {
			regenerated: false,
			path: skillPath,
			entryCount: 0,
			reason: 'no matching knowledge entries found for re-clustering',
		};
	}

	// Build a single cluster from the matched entries
	const triggers = uniqueStrings(
		matchedEntries.flatMap((e) => e.triggers ?? []),
	);
	const required = uniqueStrings(
		matchedEntries.flatMap((e) => e.required_actions ?? []),
	);
	const forbidden = uniqueStrings(
		matchedEntries.flatMap((e) => e.forbidden_actions ?? []),
	);
	const agents = uniqueStrings(
		matchedEntries.flatMap((e) => e.applies_to_agents ?? []),
	);
	const checks = uniqueStrings(
		matchedEntries.flatMap((e) => e.verification_checks ?? []),
	);
	const avgConf =
		matchedEntries.reduce((s, e) => s + e.confidence, 0) /
		Math.max(1, matchedEntries.length);
	const title =
		fm?.name ??
		triggers[0] ??
		required[0] ??
		`Lessons: ${matchedEntries[0]?.category ?? 'general'} (${matchedEntries.length})`;

	const cluster: KnowledgeCluster = {
		slug: cleanSlug,
		title,
		entries: matchedEntries,
		triggers,
		required_actions: required,
		forbidden_actions: forbidden,
		target_agents: agents,
		verification_checks: checks,
		avgConfidence: avgConf,
	};

	const priorVersion = fm?.version ?? 1;
	const newVersion = priorVersion + 1;
	const origin = fm?.skillOrigin;
	const content = renderSkillMarkdown(cluster, 'active', undefined, {
		version: newVersion,
		skillOrigin:
			origin === 'generated' || origin === 'promoted_external'
				? origin
				: 'generated',
	});
	try {
		await atomicWrite(skillPath, content);
		// Re-stamp source entries
		await stampSourceEntries(
			directory,
			cleanSlug,
			matchedEntries.map((e) => e.id),
		);
	} catch (writeErr) {
		return {
			regenerated: false,
			path: skillPath,
			entryCount: 0,
			reason: `write failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
		};
	}

	try {
		await appendSkillChangelog(directory, cleanSlug, {
			version: newVersion,
			timestamp: new Date().toISOString(),
			action: 'regenerated',
			reason: `Regenerated from ${matchedEntries.length} source entries`,
		});
	} catch {
		/* changelog is best-effort */
	}

	return {
		regenerated: true,
		path: skillPath,
		entryCount: matchedEntries.length,
	};
}

// ============================================================================
// DI seam
// ============================================================================

export const _internals = {
	sanitizeSlug,
	isValidSlug,
	selectCandidateEntries,
	clusterEntries,
	jaccardSimilarity,
	renderSkillMarkdown,
	generateSkills,
	activateProposal,
	listSkills,
	inspectSkill,
	stampSourceEntries,
	parseDraftFrontmatter,
	retireSkill,
	regenerateSkill,
	unlinkSync,
};

void warn; // reserved for future error reporting
