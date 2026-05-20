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

import { existsSync } from 'node:fs';
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
// Clustering
// ============================================================================

function clusterKey(e: KnowledgeEntryBase): string {
	const t = (e.triggers ?? [])
		.map((s) => s.toLowerCase())
		.sort()
		.join('|');
	if (t) return `trigger:${t}`;
	const tools = (e.applies_to_tools ?? []).map((s) => s.toLowerCase()).sort();
	const agents = (e.applies_to_agents ?? []).map((s) => s.toLowerCase()).sort();
	if (tools.length > 0 || agents.length > 0) {
		return `tool-agent:${tools.join('+')}::${agents.join('+')}`;
	}
	const tagSig = e.tags
		.slice(0, 3)
		.map((s) => s.toLowerCase())
		.sort()
		.join(',');
	return `cat:${e.category}:${tagSig}`;
}

export function clusterEntries(
	entries: KnowledgeEntryBase[],
): KnowledgeCluster[] {
	const groups = new Map<string, KnowledgeEntryBase[]>();
	for (const e of entries) {
		const k = clusterKey(e);
		const arr = groups.get(k) ?? [];
		arr.push(e);
		groups.set(k, arr);
	}
	const clusters: KnowledgeCluster[] = [];
	for (const [key, arr] of groups) {
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
		clusters.push({
			slug: isValidSlug(slug)
				? slug
				: sanitizeSlug(`cluster-${key.slice(0, 12)}`),
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
	clusters.sort(
		(a, b) =>
			b.entries.length - a.entries.length ||
			b.avgConfidence - a.avgConfidence ||
			a.slug.localeCompare(b.slug),
	);
	return clusters;
}

function uniqueStrings(arr: string[]): string[] {
	return [...new Set(arr.filter((s) => typeof s === 'string' && s.length > 0))];
}

// ============================================================================
// SKILL.md content emission
// ============================================================================

export function renderSkillMarkdown(
	cluster: KnowledgeCluster,
	mode: GenerateMode = 'active',
): string {
	const description =
		cluster.title.length > 200
			? `${cluster.title.slice(0, 197)}…`
			: cluster.title;
	const ids = cluster.entries.map((e) => `  - ${e.id}`).join('\n');
	const lines: string[] = [];
	lines.push('---');
	lines.push(`name: ${cluster.slug}`);
	lines.push(`description: ${escapeYaml(description)}`);
	lines.push('generated_from_knowledge:');
	lines.push(ids);
	lines.push(`confidence: ${cluster.avgConfidence.toFixed(2)}`);
	lines.push(`status: ${mode === 'active' ? 'active' : 'draft'}`);
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
export function parseDraftFrontmatter(
	content: string,
): { name?: string; status?: string; sourceKnowledgeIds: string[] } | null {
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
	const out: { name?: string; status?: string; sourceKnowledgeIds: string[] } =
		{
			sourceKnowledgeIds: [],
		};
	let inIdsList = false;
	for (const raw of lines) {
		const line = raw;
		if (inIdsList) {
			// Accept any non-empty, non-whitespace token bounded to 64 chars.
			// Generator emits UUID v4 ids; tests may use short synthetic ids.
			const m = line.match(/^\s+-\s+(\S{1,64})\s*$/);
			if (m) {
				out.sourceKnowledgeIds.push(m[1]);
				continue;
			}
			// any non-list line ends the list
			inIdsList = false;
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
		if (/^generated_from_knowledge:\s*$/.test(line)) {
			inIdsList = true;
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
	const proposalContent = await readFile(from, 'utf-8');
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
// DI seam
// ============================================================================

export const _internals = {
	sanitizeSlug,
	isValidSlug,
	selectCandidateEntries,
	clusterEntries,
	renderSkillMarkdown,
	generateSkills,
	activateProposal,
	listSkills,
	inspectSkill,
	stampSourceEntries,
	parseDraftFrontmatter,
};

void warn; // reserved for future error reporting
