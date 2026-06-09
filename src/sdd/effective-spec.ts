import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSpecContent } from '../config/spec-schema';

const SWARM_SPEC_REL = path.join('.swarm', 'spec.md');
const OPENSPEC_ROOT = 'openspec';
const MAX_SPEC_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_SPEC_FILES = 100;
const MAX_WALK_DEPTH = 10;

export type EffectiveSpecSource = 'swarm' | 'openspec_projection';

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

export function loadSddStatusSync(directory: string): SddStatus {
	const root = path.resolve(directory);
	const swSpecPath = path.join(root, SWARM_SPEC_REL);
	const openSpecPath = path.join(root, OPENSPEC_ROOT);
	const errors: string[] = [];
	const warnings: string[] = [];
	const swSpecExists = fs.existsSync(swSpecPath);
	const openSpecExists = fs.existsSync(openSpecPath);
	const currentSpecs = walkSpecFiles(root, path.join(OPENSPEC_ROOT, 'specs'));
	const changes = listOpenSpecChanges(root);
	const effectiveSpec = readEffectiveSpecSync(root);

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
		lines.push(
			'- FR-001 SHOULD define at least one current OpenSpec requirement before planning.',
		);
		usedIds.add('FR-001');
		warnings.push(
			'No current requirements found; projection includes a warning requirement.',
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

export function readEffectiveSpecSync(directory: string): EffectiveSpec | null {
	const root = path.resolve(directory);
	const swSpecPath = path.join(root, SWARM_SPEC_REL);
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
	return buildOpenSpecProjectionSync(root);
}

export function writeProjectedSpecSync(
	directory: string,
	options: { changeId?: string; dryRun?: boolean } = {},
): {
	written: boolean;
	projection: EffectiveSpec | null;
	archivePath?: string;
	path: string;
} {
	const root = path.resolve(directory);
	const projection = buildOpenSpecProjectionSync(root, {
		changeId: options.changeId,
	});
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
