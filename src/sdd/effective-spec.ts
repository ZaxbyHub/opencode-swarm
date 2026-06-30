import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSpecContent } from '../config/spec-schema';

const SWARM_SPEC_REL = path.join('.swarm', 'spec.md');
const OPENSPEC_ROOT = 'openspec';
const SPECKIT_MARKER = '.specify';
const SPECKIT_SPECS_DIR = 'specs';
const MAX_SPEC_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_SPEC_FILES = 100;
const MAX_WALK_DEPTH = 10;

/**
 * Required top-level section headers for a Spec-Kit feature spec.md (FR-007).
 *
 * Justification for the minimal list:
 * - `## Functional Requirements` — the content basis for all drift / coverage / projection
 *   work; absent means nothing can be enforced (FR-007, FR-013).
 * - `## Success Criteria` — the only Spec-Kit-required acceptance gate; the malformed
 *   fixture deliberately drops it to exercise the validator.
 * Keeping the list small and justified avoids over-specifying the Spec-Kit template.
 */
const SPECKIT_REQUIRED_SECTIONS = [
	'## Functional Requirements',
	'## Success Criteria',
] as const;

export type EffectiveSpecSource = 'swarm' | 'openspec_projection' | 'speckit_projection';

export interface OpenSpecArtifact {
	relPath: string;
	bytes: number;
	mtimeMs: number;
}

export interface OpenSpecChange {
	id: string;
	proposal: boolean;
	design: boolean;
	tasks: boolean;
	specs: OpenSpecArtifact[];
}

export interface EffectiveSpec {
	source: EffectiveSpecSource;
	content: string;
	hash: string;
	mtime: string | null;
	sourcePaths: string[];
	warnings: string[];
}

export interface SddStatus {
	provider: EffectiveSpecSource | 'none';
	swSpecExists: boolean;
	openSpecExists: boolean;
	currentSpecs: OpenSpecArtifact[];
	changes: OpenSpecChange[];
	effectiveSpec: EffectiveSpec | null;
	errors: string[];
	warnings: string[];
}

/** A single Spec-Kit feature directory containing a spec.md. */
export interface SpeckitFeatureEntry {
	/** Full directory name, e.g. `001-feature-name`. */
	featureId: string;
	/** Posix-normalized path relative to the repo root, e.g. `specs/001-feature-name/spec.md`. */
	specRelPath: string;
}

/** Result returned by {@link detectSpeckit}. */
export interface SpeckitDetection {
	/** Whether the `.specify/` marker directory is present at the repo root (A-001). */
	markerPresent: boolean;
	/**
	 * Detected feature directories, sorted lexicographically by {@link SpeckitFeatureEntry.featureId}.
	 * Empty when no `specs/<feature>/spec.md` files are found (or when markerPresent is false).
	 */
	features: SpeckitFeatureEntry[];
}

/**
 * Discriminated union returned by {@link resolveSpeckitProjection} (task 1.4).
 *
 * Each kind carries exactly the information the command layer (task 2.2) needs to
 * produce the correct error message per FR-008, FR-012, FR-013 without re-detecting.
 *
 * - `not_speckit`      — no `.specify/` marker at the repo root (A-001).
 * - `empty`            — marker present but no `specs/NNN/spec.md` feature dirs (FR-012).
 * - `ambiguous`        — more than one feature and no `options.feature` given (FR-008);
 *                        `features` = sorted feature ids for naming in the error message.
 * - `unknown_feature`  — `options.feature` was given but matches no detected feature.
 * - `zero_requirements`— the selected feature's spec.md yielded zero parsable functional
 *                        requirements (covers unreadable/oversized *input* files too) (FR-013).
 * - `too_large`        — requirements parsed, but the projected *output* exceeds the byte
 *                        cap and is refused; `bytes` is the projected size. Distinct from
 *                        zero_requirements so the command layer reports the real reason.
 * - `ok`               — a valid projection was built; `spec` is ready for use, `feature`
 *                        identifies the projected feature dir name.
 */
export type SpeckitResolution =
	| { kind: 'not_speckit' }
	| { kind: 'empty' }
	| { kind: 'ambiguous'; features: string[] }
	| { kind: 'unknown_feature'; feature: string; available: string[] }
	| { kind: 'zero_requirements'; feature: string }
	| { kind: 'too_large'; feature: string; bytes: number }
	| { kind: 'ok'; spec: EffectiveSpec; feature: string };

type DeltaKind = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'CURRENT';

interface ParsedRequirement {
	id: string | null;
	kind: DeltaKind;
	title: string;
	text: string;
	sourceRel: string;
}

function toPosix(relPath: string): string {
	return relPath.split(path.sep).join('/');
}

function hash(content: string): string {
	return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function readTextBounded(absPath: string): string | null {
	const stat = fs.lstatSync(absPath);
	if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
		return null;
	}
	return fs.readFileSync(absPath, 'utf-8');
}

function fileArtifact(root: string, absPath: string): OpenSpecArtifact | null {
	try {
		const stat = fs.lstatSync(absPath);
		if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null;
		return {
			relPath: toPosix(path.relative(root, absPath)),
			bytes: stat.size,
			mtimeMs: stat.mtimeMs,
		};
	} catch {
		return null;
	}
}

function walkSpecFiles(root: string, startRel: string): OpenSpecArtifact[] {
	const start = path.join(root, startRel);
	if (!fs.existsSync(start)) return [];
	const artifacts: OpenSpecArtifact[] = [];
	const stack: Array<{ abs: string; depth: number }> = [
		{ abs: start, depth: 0 },
	];

	while (stack.length > 0 && artifacts.length < MAX_SPEC_FILES) {
		const item = stack.pop();
		if (!item || item.depth > MAX_WALK_DEPTH) continue;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(item.abs, { withFileTypes: true });
		} catch {
			continue;
		}

		const dirents = entries.filter(
			(entry): entry is fs.Dirent => typeof entry?.name === 'string',
		);
		for (const entry of dirents.sort((a, b) => b.name.localeCompare(a.name))) {
			const abs = path.join(item.abs, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				stack.push({ abs, depth: item.depth + 1 });
			} else if (entry.isFile() && entry.name === 'spec.md') {
				const artifact = fileArtifact(root, abs);
				if (artifact) artifacts.push(artifact);
				if (artifacts.length >= MAX_SPEC_FILES) break;
			}
		}
	}

	return artifacts.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function listOpenSpecChanges(root: string): OpenSpecChange[] {
	const changesDir = path.join(root, OPENSPEC_ROOT, 'changes');
	if (!fs.existsSync(changesDir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(changesDir, { withFileTypes: true });
	} catch {
		return [];
	}

	return entries
		.filter((entry) => entry.isDirectory() && entry.name !== 'archive')
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((entry): OpenSpecChange => {
			const rel = path.join(OPENSPEC_ROOT, 'changes', entry.name);
			return {
				id: entry.name,
				proposal: fs.existsSync(path.join(root, rel, 'proposal.md')),
				design: fs.existsSync(path.join(root, rel, 'design.md')),
				tasks: fs.existsSync(path.join(root, rel, 'tasks.md')),
				specs: walkSpecFiles(root, path.join(rel, 'specs')),
			};
		});
}

function detectKind(line: string, current: DeltaKind): DeltaKind {
	const upper = line.toUpperCase();
	if (/^#{2,6}\s+ADDED\b/.test(upper)) return 'ADDED';
	if (/^#{2,6}\s+MODIFIED\b/.test(upper)) return 'MODIFIED';
	if (/^#{2,6}\s+REMOVED\b/.test(upper)) return 'REMOVED';
	return current;
}

function requirementTextFromBlock(
	title: string,
	block: string[],
	kind: DeltaKind,
): string {
	const joined = block.join(' ').replace(/\s+/g, ' ').trim();
	const obligation = joined.match(/\b(MUST|SHALL|SHOULD|MAY)\b/i)?.[1];
	if (obligation) return joined;
	if (kind === 'REMOVED') {
		return `MAY remove or retire behavior for ${title}.`;
	}
	return `MUST satisfy OpenSpec requirement ${title}.`;
}

function parseRequirements(
	content: string,
	sourceRel: string,
	defaultKind: DeltaKind,
): ParsedRequirement[] {
	const requirements: ParsedRequirement[] = [];
	const lines = content.replace(/\r\n/g, '\n').split('\n');
	let kind = defaultKind;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		kind = detectKind(line, kind);

		const explicit = line.match(/\b(FR-(?!000)\d{3})\b/);
		if (explicit && /\b(MUST|SHALL|SHOULD|MAY)\b/i.test(line)) {
			requirements.push({
				id: explicit[1].toUpperCase(),
				kind,
				title: explicit[1].toUpperCase(),
				text: line.trim().replace(/^\s*[-*]\s*/, ''),
				sourceRel,
			});
			continue;
		}

		const openSpecReq = line.match(/^#{3,4}\s+Requirement:\s*(.+)$/i);
		if (!openSpecReq) continue;

		const title = openSpecReq[1].trim();
		const block: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (/^##\s+/.test(lines[j])) break;
			if (/^#{3,4}\s+Requirement:/i.test(lines[j])) break;
			const trimmed = lines[j].trim();
			if (trimmed) block.push(trimmed);
		}
		const id = block.join('\n').match(/\b(FR-(?!000)\d{3})\b/)?.[1] ?? null;
		requirements.push({
			id: id?.toUpperCase() ?? null,
			kind,
			title,
			text: requirementTextFromBlock(title, block, kind),
			sourceRel,
		});
	}

	return requirements;
}

function nextFrId(used: Set<string>, warnings: string[]): string {
	for (let n = 1; n <= 999; n++) {
		const id = `FR-${String(n).padStart(3, '0')}`;
		if (!used.has(id)) {
			used.add(id);
			return id;
		}
	}
	warnings.push('More than 999 FR identifiers are required; reusing FR-999.');
	return 'FR-999';
}

function renderRequirement(
	req: ParsedRequirement,
	used: Set<string>,
	warnings: string[],
): string {
	const id = req.id && !used.has(req.id) ? req.id : nextFrId(used, warnings);
	if (req.id && req.id !== id) {
		warnings.push(
			`Duplicate requirement id ${req.id} in ${req.sourceRel}; generated ${id}.`,
		);
	}
	if (req.id === id) used.add(id);

	let text = req.text;
	if (!text.includes(id)) {
		text = `${id}: ${text}`;
	}
	return `- ${text} _(source: ${req.sourceRel})_`;
}

/**
 * Detect whether `directory` is a GitHub Spec-Kit project (FR-001, A-001).
 *
 * Detection key: the `.specify/` marker directory at the repo root.
 * A repo with `specs/` but no `.specify/` is NOT a Spec-Kit repo (A-001).
 *
 * When the marker is present, enumerates all direct children of `specs/` that
 * contain a `spec.md` file.  The enumeration is:
 * - One level deep (depth is bounded by construction — stronger than MAX_WALK_DEPTH).
 * - Bounded by MAX_SPEC_FILES.
 * - Symlink-safe: directories and spec.md files that are symlinks are skipped.
 * - Size-bounded: spec.md files exceeding MAX_SOURCE_BYTES are skipped.
 * - Error-swallowing: unreadable directories are skipped silently.
 * - Deterministic: feature entries are sorted lexicographically by featureId.
 *
 * Does NOT read or parse spec.md content — detection only (FR-001).
 */
export function detectSpeckit(directory: string): SpeckitDetection {
	const root = path.resolve(directory);

	// A-001: detection is keyed on the .specify/ marker directory.
	const markerPath = path.join(root, SPECKIT_MARKER);
	const markerPresent = fs.existsSync(markerPath);

	if (!markerPresent) {
		return { markerPresent: false, features: [] };
	}

	const specsRoot = path.join(root, SPECKIT_SPECS_DIR);
	if (!fs.existsSync(specsRoot)) {
		return { markerPresent: true, features: [] };
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(specsRoot, { withFileTypes: true });
	} catch {
		return { markerPresent: true, features: [] };
	}

	// Feature dirs are direct children of specs/ that are not symlinks.
	const featureDirs = entries
		.filter(
			(entry): entry is fs.Dirent =>
				typeof entry?.name === 'string' &&
				!entry.isSymbolicLink() &&
				entry.isDirectory(),
		)
		.sort((a, b) => a.name.localeCompare(b.name));

	const features: SpeckitFeatureEntry[] = [];
	for (const entry of featureDirs) {
		if (features.length >= MAX_SPEC_FILES) break;

		const specAbs = path.join(specsRoot, entry.name, 'spec.md');
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(specAbs);
		} catch {
			// spec.md missing or unreadable — not a feature dir
			continue;
		}
		// isFile() returns false for symlinks under lstatSync, so no separate
		// isSymbolicLink() check is needed here.
		if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) continue;

		features.push({
			featureId: entry.name,
			specRelPath: toPosix(path.relative(root, specAbs)),
		});
	}

	return { markerPresent: true, features };
}

/**
 * Parse Spec-Kit functional requirements from a feature's spec.md content.
 *
 * Separate from the shared parseRequirements (:196) which MUST remain
 * byte-untouched for OpenSpec compatibility (FR-011, critic Finding 1).
 *
 * Handles two cases within the `## Functional Requirements` section:
 * (a) Explicit FR-### id (e.g. `- **FR-001**: System MUST …`) — preserve id unchanged (FR-003).
 * (b) Id-less obligation bullet (e.g. `- System MUST …`) — id: null so nextFrId synthesises
 *     a stable id at render time (FR-004).  This is the primary synthesis path: the shared
 *     parseRequirements drops these lines silently because they match neither the explicit-FR
 *     branch nor the `### Requirement:` header branch.
 *
 * Traversal is deterministic (top-to-bottom within the section) so synthesised ids are
 * stable across repeated calls on the same content (FR-004, SC-003).
 */
function parseSpeckitRequirements(
	content: string,
	sourceRel: string,
): ParsedRequirement[] {
	const requirements: ParsedRequirement[] = [];
	const lines = content.replace(/\r\n/g, '\n').split('\n');
	let inFrSection = false;

	for (const line of lines) {
		// Track ## section boundaries (## only — ### or #### do not reset inFrSection).
		if (/^##\s+/.test(line)) {
			inFrSection = /^##\s+Functional Requirements\s*$/i.test(line);
			continue;
		}

		if (!inFrSection) continue;

		// Only process list bullets (- or *).
		if (!/^\s*[-*]\s+/.test(line)) continue;

		// Must carry an obligation keyword.
		if (!/\b(MUST|SHALL|SHOULD|MAY)\b/i.test(line)) continue;

		const text = line.trim().replace(/^\s*[-*]\s+/, '');

		// Case (a): explicit FR-### id — preserve it unchanged (FR-003).
		const explicit = line.match(/\b(FR-(?!000)\d{3})\b/);
		if (explicit) {
			requirements.push({
				id: explicit[1].toUpperCase(),
				kind: 'CURRENT',
				title: explicit[1].toUpperCase(),
				text,
				sourceRel,
			});
			continue;
		}

		// Case (b): id-less obligation bullet — id: null for nextFrId synthesis (FR-004).
		requirements.push({
			id: null,
			kind: 'CURRENT',
			title: text,
			text,
			sourceRel,
		});
	}

	return requirements;
}

/**
 * Resolve a Spec-Kit feature projection with a discriminated result (FR-008, FR-012, FR-013).
 *
 * Returns one of six kinds so the command layer can produce the right error message without
 * re-running detection:
 * - `not_speckit`       — no `.specify/` marker (A-001).
 * - `empty`             — marker present but no feature dirs (FR-012).
 * - `ambiguous`         — multiple features, no `options.feature` (FR-008).
 * - `unknown_feature`   — `options.feature` not among detected features.
 * - `zero_requirements` — feature found but yields zero parsable FRs, or spec.md unreadable
 *                         (FR-013; covers oversized files too).
 * - `ok`                — valid EffectiveSpec built (FR-002, FR-003, FR-004, FR-005).
 *
 * This function is the single source of truth for feature selection logic.
 * {@link buildSpeckitProjectionSync} delegates here and maps `ok → spec | null`.
 */
export function resolveSpeckitProjection(
	directory: string,
	options: { feature?: string } = {},
): SpeckitResolution {
	const root = path.resolve(directory);
	const detection = detectSpeckit(root);

	if (!detection.markerPresent) {
		return { kind: 'not_speckit' };
	}

	if (detection.features.length === 0) {
		return { kind: 'empty' };
	}

	// Feature selection.
	let selectedFeature: SpeckitFeatureEntry;
	if (options.feature) {
		const found = detection.features.find((f) => f.featureId === options.feature);
		if (!found) {
			return {
				kind: 'unknown_feature',
				feature: options.feature,
				// detectSpeckit already sorts features lexicographically.
				available: detection.features.map((f) => f.featureId),
			};
		}
		selectedFeature = found;
	} else if (detection.features.length === 1) {
		// Single-feature auto-select (FR-008).
		selectedFeature = detection.features[0]!;
	} else {
		// Multiple features, no explicit selection — caller must name one (FR-008).
		return {
			kind: 'ambiguous',
			// detectSpeckit already sorts lexicographically.
			features: detection.features.map((f) => f.featureId),
		};
	}

	const specAbs = path.join(root, selectedFeature.specRelPath);
	const content = readTextBounded(specAbs);
	// Unreadable/oversized spec.md — fold into zero_requirements (nothing to project).
	if (content === null) {
		return { kind: 'zero_requirements', feature: selectedFeature.featureId };
	}

	const warnings: string[] = [];
	const usedIds = new Set<string>();

	const requirements = parseSpeckitRequirements(content, selectedFeature.specRelPath);

	// Mirror buildOpenSpecProjectionSync :450-453 — zero FRs → advisory (FR-013).
	if (requirements.length === 0) {
		return { kind: 'zero_requirements', feature: selectedFeature.featureId };
	}

	let mtimeMs = 0;
	try {
		mtimeMs = fs.lstatSync(specAbs).mtimeMs;
	} catch {
		// mtime unavailable — leave 0; caller sees mtime: null in the returned spec.
	}

	const lines: string[] = [
		'# Specification: Effective SDD Projection',
		'',
		'Generated from Spec-Kit feature artifacts. Update the source artifacts, then run `/swarm sdd project` to refresh this projection.',
		'',
		'## Source Artifacts',
		`- ${selectedFeature.specRelPath}`,
		'',
		'## Functional Requirements',
	];

	for (const req of requirements) {
		lines.push(renderRequirement(req, usedIds, warnings));
	}

	const projected = `${lines.join('\n')}\n`;

	if (projected.length > MAX_SPEC_BYTES) {
		// Requirements parsed successfully but the projected output is too large to use.
		// This is a distinct reason from zero_requirements — surface it accurately so the
		// command layer (FR-013 messaging) does not falsely report "no requirements".
		return {
			kind: 'too_large',
			feature: selectedFeature.featureId,
			bytes: projected.length,
		};
	}

	const validation = validateSpecContent(projected);
	if (!validation.valid) {
		warnings.push(
			...validation.issues.map(
				(issue) => `Projection line ${issue.line}: ${issue.message}`,
			),
		);
	}

	const spec: EffectiveSpec = {
		source: 'speckit_projection',
		content: projected,
		hash: hash(projected),
		mtime: mtimeMs > 0 ? new Date(mtimeMs).toISOString() : null,
		sourcePaths: [selectedFeature.specRelPath],
		warnings,
	};

	return { kind: 'ok', spec, feature: selectedFeature.featureId };
}

/**
 * Project a single Spec-Kit feature into an EffectiveSpec (FR-002, FR-003, FR-004, FR-005).
 *
 * Delegates all selection and build logic to {@link resolveSpeckitProjection} — that function
 * is the single source of truth for feature selection.  This wrapper preserves the existing
 * `EffectiveSpec | null` contract so all call sites (task 2.2, tests) are unchanged.
 *
 * Returns null when resolution is anything other than `ok` (not_speckit, empty, ambiguous,
 * unknown_feature, zero_requirements).  Callers that need the failure reason should call
 * {@link resolveSpeckitProjection} directly.
 */
export function buildSpeckitProjectionSync(
	directory: string,
	options: { feature?: string } = {},
): EffectiveSpec | null {
	const resolution = resolveSpeckitProjection(directory, options);
	return resolution.kind === 'ok' ? resolution.spec : null;
}

export function loadSddStatusSync(
	directory: string,
	opts?: ReadEffectiveSpecOpts,
): SddStatus {
	const root = path.resolve(directory);
	const swSpecPath = path.join(root, SWARM_SPEC_REL);
	const openSpecPath = path.join(root, OPENSPEC_ROOT);
	const errors: string[] = [];
	const warnings: string[] = [];
	const swSpecExists = fs.existsSync(swSpecPath);
	const openSpecExists = fs.existsSync(openSpecPath);
	const currentSpecs = walkSpecFiles(root, path.join(OPENSPEC_ROOT, 'specs'));
	const changes = listOpenSpecChanges(root);
	// Forward opts so an explicit --source selection is honored (FR-009); with no
	// opts this is byte-identical to the prior auto-detect behavior.
	const effectiveSpec = readEffectiveSpecSync(root, opts);

	if (openSpecExists && currentSpecs.length === 0 && changes.length === 0) {
		errors.push('openspec/ exists but contains no specs or active changes.');
	}
	for (const change of changes) {
		if (!change.proposal) {
			warnings.push(`Change ${change.id} is missing proposal.md.`);
		}
		if (!change.tasks) {
			warnings.push(
				`Change ${change.id} is missing tasks.md; tasks remain proposal input, not plan state.`,
			);
		}
		if (change.specs.length === 0) {
			errors.push(`Change ${change.id} has no specs/**/spec.md delta files.`);
		}
	}

	return {
		provider: effectiveSpec?.source ?? 'none',
		swSpecExists,
		openSpecExists,
		currentSpecs,
		changes,
		effectiveSpec,
		errors,
		warnings,
	};
}

export function buildOpenSpecProjectionSync(
	directory: string,
	options: { changeId?: string } = {},
): EffectiveSpec | null {
	const root = path.resolve(directory);
	const currentSpecs = walkSpecFiles(root, path.join(OPENSPEC_ROOT, 'specs'));
	const allChanges = listOpenSpecChanges(root);
	const changes = options.changeId
		? allChanges.filter((change) => change.id === options.changeId)
		: allChanges;
	const sourcePaths: string[] = [];
	const warnings: string[] = [];
	const usedIds = new Set<string>();
	const currentRequirements: ParsedRequirement[] = [];
	const changeRequirements = new Map<string, ParsedRequirement[]>();
	let parsedRequirementCount = 0;
	let mtimeMs = 0;

	if (options.changeId && changes.length === 0) return null;
	if (currentSpecs.length === 0 && changes.length === 0) return null;

	for (const artifact of currentSpecs) {
		const abs = path.join(root, artifact.relPath);
		const content = readTextBounded(abs);
		if (content === null) {
			warnings.push(
				`Skipped unreadable or oversized spec ${artifact.relPath}.`,
			);
			continue;
		}
		sourcePaths.push(artifact.relPath);
		mtimeMs = Math.max(mtimeMs, artifact.mtimeMs);
		const parsed = parseRequirements(content, artifact.relPath, 'CURRENT');
		currentRequirements.push(...parsed);
		parsedRequirementCount += parsed.length;
	}

	for (const change of changes) {
		const reqs: ParsedRequirement[] = [];
		for (const artifact of change.specs) {
			const abs = path.join(root, artifact.relPath);
			const content = readTextBounded(abs);
			if (content === null) {
				warnings.push(
					`Skipped unreadable or oversized spec ${artifact.relPath}.`,
				);
				continue;
			}
			sourcePaths.push(artifact.relPath);
			mtimeMs = Math.max(mtimeMs, artifact.mtimeMs);
			const parsed = parseRequirements(content, artifact.relPath, 'ADDED');
			reqs.push(...parsed);
			parsedRequirementCount += parsed.length;
		}
		changeRequirements.set(change.id, reqs);
	}

	if (sourcePaths.length > 0 && parsedRequirementCount === 0) {
		return null;
	}

	const lines: string[] = [
		'# Specification: Effective SDD Projection',
		'',
		'Generated from OpenSpec-compatible artifacts. Update the source artifacts, then run `/swarm sdd project` to refresh this projection.',
		'',
		'## Source Artifacts',
		...sourcePaths.map((rel) => `- ${rel}`),
		'',
		'## Current Requirements',
	];

	if (currentRequirements.length === 0) {
		lines.push('- No current OpenSpec requirements found in source artifacts.');
		warnings.push(
			'No current requirements found; projection includes an advisory note only.',
		);
	} else {
		for (const req of currentRequirements) {
			lines.push(renderRequirement(req, usedIds, warnings));
		}
	}

	for (const [changeId, reqs] of changeRequirements.entries()) {
		lines.push('', `## Pending Change: ${changeId}`);
		if (reqs.length === 0) {
			lines.push(
				`- ${nextFrId(usedIds, warnings)} SHOULD add OpenSpec delta requirements for change ${changeId}.`,
			);
			warnings.push(`Change ${changeId} contains no parsable requirements.`);
			continue;
		}
		for (const req of reqs) {
			lines.push(renderRequirement(req, usedIds, warnings));
		}
	}

	const content = `${lines.join('\n')}\n`;
	if (content.length > MAX_SPEC_BYTES) {
		warnings.push(
			`Projected spec exceeds ${MAX_SPEC_BYTES} bytes; refusing to use projection.`,
		);
		return null;
	}

	const validation = validateSpecContent(content);
	if (!validation.valid) {
		warnings.push(
			...validation.issues.map(
				(issue) => `Projection line ${issue.line}: ${issue.message}`,
			),
		);
	}

	return {
		source: 'openspec_projection',
		content,
		hash: hash(content),
		mtime: mtimeMs > 0 ? new Date(mtimeMs).toISOString() : null,
		sourcePaths,
		warnings,
	};
}

/**
 * Resolver options for {@link readEffectiveSpecSync} (task 2.1, FR-009).
 *
 * Both fields are optional so that all 13 existing single-argument call sites
 * continue to work unchanged.
 */
export interface ReadEffectiveSpecOpts {
	/**
	 * Explicit provider selection (FR-009 step b).
	 * When given, the specified provider is used directly after the native swarm
	 * spec check.  A `'swarm'` selection with no `.swarm/spec.md` returns null.
	 */
	source?: 'swarm' | 'openspec' | 'speckit';
	/**
	 * Feature selector forwarded to {@link buildSpeckitProjectionSync} when the
	 * effective provider is Spec-Kit.  Ignored for `source: 'openspec'` or
	 * `source: 'swarm'` (feature-vs-non-speckit source validation is enforced at
	 * the command layer in task 2.2, not here).
	 */
	feature?: string;
}

/**
 * Read (or build) the effective spec for a directory, applying deterministic
 * source precedence (FR-009, FR-010, FR-011).
 *
 * **Precedence:**
 * a. `.swarm/spec.md` present → return the native swarm spec.  This branch is
 *    IDENTICAL to the pre-task-2.1 code and wins even over an explicit
 *    `opts.source` — native swarm spec always wins (FR-009).
 * b. `opts.source` given → use that provider: `'openspec'` calls
 *    {@link buildOpenSpecProjectionSync}; `'speckit'` calls
 *    {@link buildSpeckitProjectionSync}; `'swarm'` with no `.swarm/spec.md`
 *    returns null.
 * c. Auto-detect:
 *    - **No `.specify/` marker** → byte-identical to pre-task-2.1 behavior:
 *      call {@link buildOpenSpecProjectionSync} and return its result (FR-011).
 *    - **`.specify/` present but no feature dirs** (empty marker) → Spec-Kit is
 *      NOT counted as a competing source; behaves like the no-marker case.
 *    - **`.specify/` with ≥1 feature dir and no openspec projection** → return
 *      the Spec-Kit projection.
 *    - **`.specify/` with ≥1 feature dir AND openspec yields a projection** →
 *      AMBIGUOUS (FR-010): emit a concrete diagnostic via `console.warn` (the
 *      anti-silent-suppression requirement; critic Finding 2) and return null.
 *      The diagnostic is independent of the return value so it fires even when
 *      no consumer inspects the null return (e.g. the drift gate, which only
 *      checks for null to decide advisory-vs-blocking mode).
 *
 * **Backward-compat (FR-011):** when `.detectSpeckit(directory).markerPresent`
 * is false, the function is byte-identical to pre-task-2.1.  The additional
 * `detectSpeckit` call (a single `fs.existsSync`) is the only overhead.
 *
 * **Deviation from task-2.1 literal text:** the task body says "Spec-Kit
 * present (`detectSpeckit(dir).markerPresent`)" but plan.md task 3.1 and the
 * test note both state that an empty `.specify/` "would never reach the
 * ambiguity branch."  `markerPresent` is true for empty-specify, so it cannot
 * be the discriminator.  We use `features.length > 0` instead, which is
 * symmetric with "OpenSpec present (yields a projection)" and makes empty
 * `.specify/` a non-competing source, matching both citations.
 */
export function readEffectiveSpecSync(
	directory: string,
	opts?: ReadEffectiveSpecOpts,
): EffectiveSpec | null {
	const root = path.resolve(directory);
	const swSpecPath = path.join(root, SWARM_SPEC_REL);

	// a. Native swarm spec always wins — EXACTLY today's behavior, unchanged.
	try {
		const stat = fs.lstatSync(swSpecPath);
		if (stat.isFile() && stat.size <= MAX_SPEC_BYTES) {
			const content = fs.readFileSync(swSpecPath, 'utf-8');
			return {
				source: 'swarm',
				content,
				hash: hash(content),
				mtime: stat.mtime.toISOString(),
				sourcePaths: [toPosix(SWARM_SPEC_REL)],
				warnings: [],
			};
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}

	// b. Explicit source selection — use the named provider directly.
	if (opts?.source) {
		switch (opts.source) {
			case 'openspec':
				return buildOpenSpecProjectionSync(root);
			case 'speckit':
				return buildSpeckitProjectionSync(root, { feature: opts.feature });
			case 'swarm':
				// No .swarm/spec.md present (already checked above) → null.
				return null;
		}
	}

	// c. Auto-detect: determine which projection sources are present.

	// BACKWARD-COMPAT (FR-011): when no .specify/ marker, behavior is
	// byte-identical to today — swarm spec (handled above) else openspec.
	const speckitDetection = detectSpeckit(root);
	if (!speckitDetection.markerPresent) {
		return buildOpenSpecProjectionSync(root);
	}

	// "Spec-Kit present" = marker present AND at least one valid feature dir.
	// An empty .specify/ (features.length === 0) is NOT a competing source —
	// fall through to openspec as if the marker were absent (plan.md task 3.1;
	// test note: "NOT empty, or it won't register as a competing source").
	const speckitPresent = speckitDetection.features.length > 0;

	if (!speckitPresent) {
		// .specify/ exists but is empty — not a competing source.
		return buildOpenSpecProjectionSync(root);
	}

	// Spec-Kit present: check whether OpenSpec is also present.
	// "OpenSpec present" = openspec/ layout yields a non-null projection.
	const openspecProjection = buildOpenSpecProjectionSync(root);
	const openspecPresent = openspecProjection !== null;

	if (openspecPresent) {
		// FR-010 / critic Finding 2: BOTH sources present, no --source given.
		// Emit a concrete resolver-side diagnostic BEFORE returning null.
		// This is INDEPENDENT of the null return value: the drift gate (and all
		// other consumers) see only the null; this warn fires regardless of
		// whether any consumer checks the return or its contents.
		console.warn(
			'[opencode-swarm] Multiple SDD sources detected (openspec and speckit). ' +
				'Enforcement/projection is suppressed until you disambiguate. ' +
				'Pass --source openspec or --source speckit to select a provider.',
		);
		return null;
	}

	// Only Spec-Kit present — return the Spec-Kit projection.
	return buildSpeckitProjectionSync(root, { feature: opts?.feature });
}

export function writeProjectedSpecSync(
	directory: string,
	options: {
		changeId?: string;
		dryRun?: boolean;
		/** When `'speckit'`, builds a Spec-Kit projection instead of OpenSpec (task 2.2). */
		source?: 'openspec' | 'speckit';
		/** Feature selector forwarded to buildSpeckitProjectionSync when source is speckit. */
		feature?: string;
	} = {},
): {
	written: boolean;
	projection: EffectiveSpec | null;
	archivePath?: string;
	path: string;
} {
	const root = path.resolve(directory);
	const projection =
		options.source === 'speckit'
			? buildSpeckitProjectionSync(root, { feature: options.feature })
			: buildOpenSpecProjectionSync(root, { changeId: options.changeId });
	const target = path.join(root, SWARM_SPEC_REL);
	if (!projection || options.dryRun) {
		return { written: false, projection, path: target };
	}

	fs.mkdirSync(path.dirname(target), { recursive: true });
	let archivePath: string | undefined;
	if (fs.existsSync(target)) {
		const prior = fs.readFileSync(target, 'utf-8');
		if (prior !== projection.content) {
			const archiveDir = path.join(root, '.swarm', 'spec-archive');
			fs.mkdirSync(archiveDir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			archivePath = path.join(archiveDir, `sdd-projection-${stamp}.md`);
			fs.writeFileSync(archivePath, prior, 'utf-8');
		}
	}

	const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, projection.content, 'utf-8');
	fs.renameSync(tmp, target);
	return { written: true, projection, archivePath, path: target };
}

/**
 * Validate Spec-Kit artifacts READ-ONLY (FR-007, task 2.3).
 *
 * MUST NOT write or modify any Spec-Kit artifact — it only reads spec.md and
 * tasks.md to report structural problems.
 *
 * Returns the {@link SpeckitResolution} from {@link resolveSpeckitProjection}
 * alongside a flat `problems` array.  Returning both avoids a second
 * `resolveSpeckitProjection` call in the command layer (which would need the
 * projection's hash / sourcePaths from `resolution.spec`).
 *
 * **Problems reported** (only when `resolution.kind` is `'ok'` or
 * `'zero_requirements'` — i.e. when we have a feature to inspect):
 * - Zero parsable functional requirements (`zero_requirements` kind, FR-013).
 * - Missing required spec.md sections (`SPECKIT_REQUIRED_SECTIONS`).
 * - `tasks.md` task lines that carry no `[US#]` user-story reference (FR-007).
 *
 * For other resolution kinds (`not_speckit`, `empty`, `ambiguous`,
 * `unknown_feature`, `too_large`) the command layer uses
 * {@link formatSpeckitError} on the returned resolution — same messaging path
 * as task 2.2 (plan.md task 2.3 requirement: no second messaging scheme).
 */
export function validateSpeckit(
	directory: string,
	options: { feature?: string } = {},
): { resolution: SpeckitResolution; problems: string[] } {
	const root = path.resolve(directory);
	const resolution = resolveSpeckitProjection(root, options);
	const problems: string[] = [];

	// Structural validation only applies when we resolved to a specific feature.
	if (resolution.kind !== 'ok' && resolution.kind !== 'zero_requirements') {
		return { resolution, problems };
	}

	// FR-013: surface zero parsable requirements as a problem.
	if (resolution.kind === 'zero_requirements') {
		problems.push(
			`Feature '${resolution.feature}' contains no parsable functional requirements.`,
		);
	}

	// Locate the feature entry to derive spec.md / tasks.md absolute paths.
	// detectSpeckit is read-only (no side effects) and deterministic.
	const detection = detectSpeckit(root);
	const featureEntry = detection.features.find(
		(f) => f.featureId === resolution.feature,
	);
	if (!featureEntry) {
		// Race condition: feature disappeared between the two reads. Be defensive.
		return { resolution, problems };
	}

	const specAbs = path.join(root, featureEntry.specRelPath);

	// --- spec.md structural check (READ-ONLY) ---
	let specContent: string | null = null;
	try {
		specContent = readTextBounded(specAbs);
	} catch {
		// File missing or unreadable — skip section checks.
	}

	if (specContent !== null) {
		const specLines = specContent.replace(/\r\n/g, '\n').split('\n');
		for (const requiredHeader of SPECKIT_REQUIRED_SECTIONS) {
			// Exact line match after stripping trailing whitespace.  This correctly
			// rejects `### Functional Requirements` (wrong level) and ignores
			// `## Functional Requirements Details` (extra text on the same line).
			if (!specLines.some((line) => line.trimEnd() === requiredHeader)) {
				problems.push(`Missing required spec.md section: ${requiredHeader}`);
			}
		}
	}

	// --- tasks.md structural check (READ-ONLY) ---
	// tasks.md sits alongside spec.md in the same feature directory.
	const tasksAbs = path.join(path.dirname(specAbs), 'tasks.md');
	let tasksContent: string | null = null;
	try {
		tasksContent = readTextBounded(tasksAbs);
	} catch {
		// tasks.md absent or unreadable — skip; it is optional.
	}

	if (tasksContent !== null) {
		const tasksLines = tasksContent.replace(/\r\n/g, '\n').split('\n');
		for (const line of tasksLines) {
			// Match a task checkbox line and capture the task id (T### pattern).
			const taskMatch = line.match(/^\s*-\s+\[[ xX]\]\s+(T\d+)/);
			if (!taskMatch) continue;
			const taskId = taskMatch[1]!;
			// FR-007: a task must carry a spec/requirement reference. Accept EITHER a
			// `[US#]` user-story tag OR an `FR-###` requirement id — flag only when the
			// task has neither (a task that explicitly references FR-001, or a setup task
			// tagged to a story, is a legitimate reference and must not be flagged).
			const hasStoryRef = /\[US\d+\]/i.test(line);
			const hasReqRef = /\bFR-\d{3}\b/i.test(line);
			if (!hasStoryRef && !hasReqRef) {
				problems.push(`Task ${taskId} has no spec/requirement reference.`);
			}
		}
	}

	return { resolution, problems };
}
