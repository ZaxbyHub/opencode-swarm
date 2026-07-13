import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import type {
	EvaluationCandidateV1,
	EvaluationRunV1,
	EvaluationTaskV1,
	GateAuditManifestV1,
	TaskSetSnapshotV1,
} from './contracts.js';

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return value;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value))
			throw new TypeError('canonical JSON rejects non-finite numbers');
		return Object.is(value, -0) ? 0 : value;
	}
	if (value === undefined) return undefined;
	if (typeof value !== 'object') {
		throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
	}
	if (ancestors.has(value))
		throw new TypeError('canonical JSON rejects cyclic values');
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((entry) => {
				const encoded = canonicalize(entry, ancestors);
				return encoded === undefined ? null : encoded;
			});
		}
		const record = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			const encoded = canonicalize(record[key], ancestors);
			if (encoded !== undefined) result[key] = encoded;
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value, new Set()));
}

export function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

export function canonicalHash(value: unknown): string {
	return sha256(canonicalJson(value));
}

export function contentHashWithout<T extends Record<string, unknown>>(
	value: T,
	keys: readonly (keyof T)[],
): string {
	const copy = { ...value };
	for (const key of keys) delete copy[key];
	return canonicalHash(copy);
}

export function computeTaskContentHash(
	task: Omit<EvaluationTaskV1, 'contentHash'> | EvaluationTaskV1,
): string {
	return contentHashWithout(
		task as EvaluationTaskV1 & Record<string, unknown>,
		['contentHash'],
	);
}

export function computeCandidateInputContentHash(
	projectRoot: string,
	candidate: Omit<EvaluationCandidateV1, 'contentHash'> | EvaluationCandidateV1,
): string {
	return canonicalHash({
		candidate: JSON.parse(
			canonicalJson({ ...candidate, contentHash: undefined }),
		) as Record<string, unknown>,
		payload: hashTree(projectRoot, candidate.payloadPath, {
			maxFiles: 5_000,
			maxBytes: 50 * 1024 * 1024,
		}),
	});
}

interface TreeHashEntry {
	path: string;
	type: 'directory' | 'file';
	bytes?: number;
	sha256?: string;
}

export interface TaskInputHashLimits {
	maxFiles?: number;
	maxBytes?: number;
}

function hashTree(
	projectRoot: string,
	relativePath: string,
	limits: Required<TaskInputHashLimits>,
): TreeHashEntry[] {
	const target = resolveContainedExistingPath(projectRoot, relativePath);
	const canonicalRoot = realpathSync(projectRoot);
	const entries: TreeHashEntry[] = [];
	let files = 0;
	let bytes = 0;
	const visit = (absolutePath: string): void => {
		const stat = lstatSync(absolutePath);
		if (stat.isSymbolicLink()) {
			throw new Error(
				`evaluation input contains a symlink or reparse point: ${relativePath}`,
			);
		}
		const relative = path
			.relative(canonicalRoot, absolutePath)
			.replace(/\\/g, '/');
		if (stat.isDirectory()) {
			entries.push({ path: relative, type: 'directory' });
			for (const child of readdirSync(absolutePath).sort()) {
				visit(path.join(absolutePath, child));
			}
			return;
		}
		if (!stat.isFile()) {
			throw new Error(
				`evaluation input must contain only regular files: ${relative}`,
			);
		}
		files++;
		bytes += stat.size;
		if (files > limits.maxFiles || bytes > limits.maxBytes) {
			throw new Error('evaluation input exceeds the canonical hashing budget');
		}
		const content = readFileSync(absolutePath);
		entries.push({
			path: relative,
			type: 'file',
			bytes: content.byteLength,
			sha256: sha256(content),
		});
	};
	visit(target);
	return entries;
}

/** Hash task metadata plus the exact admitted instruction, fixture/container, and project scorer bytes. */
export function computeTaskInputContentHash(
	projectRoot: string,
	task: Omit<EvaluationTaskV1, 'contentHash'> | EvaluationTaskV1,
	limits: TaskInputHashLimits = {},
): string {
	const bounded = {
		maxFiles: limits.maxFiles ?? 5_000,
		maxBytes: limits.maxBytes ?? 50 * 1024 * 1024,
	};
	if (bounded.maxFiles <= 0 || bounded.maxBytes <= 0) {
		throw new Error('task input hash limits must be positive');
	}
	const inputTrees = [
		...hashTree(projectRoot, task.instructionPath, bounded),
		...hashTree(projectRoot, task.environment.path, bounded),
	];
	if (task.scorer.kind === 'project' && task.scorer.argv[0]) {
		inputTrees.push(...hashTree(projectRoot, task.scorer.argv[0], bounded));
	}
	return canonicalHash({
		task: JSON.parse(
			canonicalJson({ ...task, contentHash: undefined }),
		) as Record<string, unknown>,
		inputs: inputTrees.sort((left, right) =>
			`${left.path}\u0000${left.type}`.localeCompare(
				`${right.path}\u0000${right.type}`,
			),
		),
	});
}

/**
 * Hash the stable task input identity used for split isolation. Mutable catalog
 * metadata is excluded so aliases cannot move identical inputs across splits.
 * Derived tasks are linked to their admitted parent by the store instead.
 */
export function computeTaskLineageInputHash(
	projectRoot: string,
	task: Omit<EvaluationTaskV1, 'contentHash'> | EvaluationTaskV1,
	limits: TaskInputHashLimits = {},
): string {
	const bounded = {
		maxFiles: limits.maxFiles ?? 5_000,
		maxBytes: limits.maxBytes ?? 50 * 1024 * 1024,
	};
	if (bounded.maxFiles <= 0 || bounded.maxBytes <= 0) {
		throw new Error('task input hash limits must be positive');
	}
	const normalizedTree = (relativePath: string) => {
		const canonicalRoot = realpathSync(projectRoot);
		const target = resolveContainedExistingPath(projectRoot, relativePath);
		const targetRelative = path
			.relative(canonicalRoot, target)
			.replace(/\\/g, '/');
		return hashTree(projectRoot, relativePath, bounded).map((entry) => ({
			...entry,
			path: path.posix.relative(targetRelative, entry.path) || '.',
		}));
	};
	const scorerArgv = [...task.scorer.argv];
	const projectScorer =
		task.scorer.kind === 'project' && scorerArgv[0]
			? normalizedTree(scorerArgv[0])
			: undefined;
	if (projectScorer) scorerArgv[0] = '<project-scorer>';
	return canonicalHash({
		instruction: normalizedTree(task.instructionPath),
		environment: {
			kind: task.environment.kind,
			tree: normalizedTree(task.environment.path),
		},
		scorer: {
			kind: task.scorer.kind,
			argv: scorerArgv,
			timeoutMs: task.scorer.timeoutMs,
			scoreRange: task.scorer.scoreRange,
			projectScorer,
		},
	});
}

export function computeTaskSetContentHash(
	snapshot:
		| Omit<TaskSetSnapshotV1, 'contentHash' | 'createdAt'>
		| TaskSetSnapshotV1,
): string {
	return contentHashWithout(
		snapshot as TaskSetSnapshotV1 & Record<string, unknown>,
		['contentHash', 'createdAt'],
	);
}

export function computeRunIntegrityHash(
	run: Omit<EvaluationRunV1, 'integrityHash'> | EvaluationRunV1,
): string {
	return contentHashWithout(run as EvaluationRunV1 & Record<string, unknown>, [
		'integrityHash',
	]);
}

export function computeManifestContentHash(
	manifest: Omit<GateAuditManifestV1, 'contentHash'> | GateAuditManifestV1,
): string {
	return contentHashWithout(
		manifest as GateAuditManifestV1 & Record<string, unknown>,
		['contentHash'],
	);
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === '' ||
		(!relative.startsWith('..') && !path.isAbsolute(relative))
	);
}

/** Resolve an existing path and reject traversal plus symlink/junction/reparse components. */
export function resolveContainedExistingPath(
	root: string,
	relativePath: string,
): string {
	if (
		path.isAbsolute(relativePath) ||
		/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(relativePath) ||
		relativePath.includes('\0')
	) {
		throw new Error('evaluation path must be a non-NUL relative path');
	}
	const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
	if (segments.length === 0 || segments.some((segment) => segment === '..')) {
		throw new Error('evaluation path traversal is not allowed');
	}
	const canonicalRoot = realpathSync(root);
	let cursor = canonicalRoot;
	for (const segment of segments) {
		if (segment === '.') continue;
		cursor = path.join(cursor, segment);
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink()) {
			throw new Error(
				`evaluation path contains a symlink or reparse point: ${relativePath}`,
			);
		}
	}
	const canonicalCandidate = realpathSync(cursor);
	if (!isWithin(canonicalRoot, canonicalCandidate)) {
		throw new Error('evaluation path escapes its admitted root');
	}
	return canonicalCandidate;
}
