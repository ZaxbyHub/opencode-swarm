import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { warn } from './logger';

/** Maximum depth to walk up the directory tree before failing closed. */
export const MAX_PROJECT_ROOT_DEPTH = 20;

/** File/directory names that indicate a real ancestor project root. */
export const PROJECT_ROOT_INDICATORS = [
	'package.json',
	'.git',
	'.opencode',
	'Cargo.toml',
	'go.mod',
	'pyproject.toml',
	'Gemfile',
	'composer.json',
	'pom.xml',
	'build.gradle',
	'CMakeLists.txt',
] as const;

/** Direct declarations that make a nested directory an independent project root. */
const PROJECT_BOUNDARY_MARKERS = [
	{
		name: '.git',
		accepts: (stat: fs.Stats) => stat.isFile() || stat.isDirectory(),
	},
	{ name: '.opencode', accepts: (stat: fs.Stats) => stat.isDirectory() },
] as const;

function isAbsoluteDirectoryInput(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.trim().length > 0 &&
		path.isAbsolute(value)
	);
}

/**
 * Return whether `directory` directly declares its own project boundary.
 *
 * Markers are local declarations, not verified Git metadata. A direct `.git`
 * file/directory covers repositories, linked worktrees, and submodules; a
 * direct `.opencode` directory is the manual opt-in. `lstatSync` is deliberate:
 * marker symlinks/junctions do not grant an exemption. Missing, inaccessible,
 * or ambiguous markers fail closed.
 */
export function hasExplicitProjectBoundary(directory: unknown): boolean {
	if (!isAbsoluteDirectoryInput(directory)) return false;

	for (const marker of PROJECT_BOUNDARY_MARKERS) {
		try {
			const stat = _internals.lstatSync(path.join(directory, marker.name));
			if (!stat.isSymbolicLink() && marker.accepts(stat)) return true;
		} catch {
			// A failed marker probe cannot grant a project-root exemption. Continue
			// so one ambiguous/missing marker does not hide a valid second marker.
		}
	}
	return false;
}

/**
 * Test whether `candidate` is a strict lexical descendant of `root` using the
 * host platform's path semantics (including case-insensitive Windows paths).
 */
export function isStrictPathDescendant(
	candidate: unknown,
	root: unknown,
): boolean {
	if (!isAbsoluteDirectoryInput(candidate) || !isAbsoluteDirectoryInput(root)) {
		return false;
	}
	const relative = path.relative(root, candidate);
	return (
		relative !== '' &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

type ProjectRootProbeDependencies = Pick<
	typeof fs,
	'realpathSync' | 'statSync'
>;

export type { ProjectRootProbeDependencies };

/**
 * Outcome of the shared boundary walk used by both `assertProjectRoot` and
 * `resolveProjectRootDecision`, so the two consumers cannot drift.
 */
type BoundaryWalkResult =
	| { outcome: 'marker-root' }
	| { outcome: 'claimed'; ancestor: string }
	| { outcome: 'unclaimed' }
	| {
			outcome: 'fail-closed';
			reason: 'depth' | 'ancestor-swarm' | 'ancestor-indicators';
			path?: string;
	  };

function walkProjectBoundary(
	resolved: string,
	dependencies: ProjectRootProbeDependencies,
): BoundaryWalkResult {
	if (hasExplicitProjectBoundary(resolved)) return { outcome: 'marker-root' };

	let current = resolved;
	let depth = 0;
	while (true) {
		if (depth >= MAX_PROJECT_ROOT_DEPTH) {
			return { outcome: 'fail-closed', reason: 'depth' };
		}
		depth++;
		const parent = path.dirname(current);
		if (parent === current) return { outcome: 'unclaimed' };
		if (path.dirname(parent) === parent) {
			current = parent;
			continue;
		}

		const parentSwarm = path.join(parent, '.swarm');
		let parentSwarmStat: fs.Stats;
		try {
			parentSwarmStat = dependencies.statSync(parentSwarm);
		} catch (error) {
			if (isMissingPathError(error)) {
				current = parent;
				continue;
			}
			return {
				outcome: 'fail-closed',
				reason: 'ancestor-swarm',
				path: parentSwarm,
			};
		}

		if (parentSwarmStat.isDirectory()) {
			const indicatorState = projectIndicatorState(parent, dependencies, {
				allowConfigOnly: !isWeakConfigContainerRoot(parent, dependencies),
			});
			if (indicatorState === 'inaccessible') {
				return {
					outcome: 'fail-closed',
					reason: 'ancestor-indicators',
					path: parent,
				};
			}
			if (indicatorState === 'present') {
				return { outcome: 'claimed', ancestor: parent };
			}
		}
		current = parent;
	}
}

function isMissingPathError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

function isWeakConfigContainerRoot(
	directory: string,
	dependencies: ProjectRootProbeDependencies,
): boolean {
	try {
		const resolved = dependencies.realpathSync(directory);
		return (
			resolved === dependencies.realpathSync(os.tmpdir()) ||
			resolved === dependencies.realpathSync(os.homedir())
		);
	} catch {
		const resolved = path.resolve(directory);
		return (
			resolved === path.resolve(os.tmpdir()) ||
			resolved === path.resolve(os.homedir())
		);
	}
}

type ProjectIndicatorState = 'absent' | 'present' | 'inaccessible';

function projectIndicatorState(
	directory: string,
	dependencies: ProjectRootProbeDependencies,
	options: { allowConfigOnly?: boolean } = {},
): ProjectIndicatorState {
	const allowConfigOnly = options.allowConfigOnly ?? true;
	for (const indicator of PROJECT_ROOT_INDICATORS) {
		if (!allowConfigOnly && indicator === '.opencode') continue;
		try {
			const indicatorStat = dependencies.statSync(
				path.join(directory, indicator),
			);
			if (indicatorStat.isFile() || indicatorStat.isDirectory())
				return 'present';
		} catch (error) {
			if (!isMissingPathError(error)) return 'inaccessible';
		}
	}
	return 'absent';
}

/**
 * Authoritative write-time project-root assertion shared by persistence sinks.
 *
 * Direct boundary markers exempt a nested project from ancestor checks. Ordinary
 * descendants are rejected when an ancestor contains both `.swarm/` and a
 * project indicator. Ambiguous ancestor state fails closed.
 */
export function assertProjectRoot(
	directory: string,
	dependencies: ProjectRootProbeDependencies = fs,
	artifactLabel = 'runtime state',
): void {
	let resolved: string;
	try {
		resolved = dependencies.realpathSync(directory);
	} catch {
		warn(
			`[project-boundary] Cannot canonicalize directory "${directory}" — failing closed`,
		);
		throw new Error(
			`Cannot verify project root for "${directory}" — directory may not exist or is inaccessible`,
		);
	}
	const walk = walkProjectBoundary(resolved, dependencies);
	if (walk.outcome === 'marker-root' || walk.outcome === 'unclaimed') return;
	if (walk.outcome === 'claimed') {
		warn(
			`[project-boundary] Rejecting write to subdirectory "${resolved}" — parent "${walk.ancestor}" already contains .swarm/`,
		);
		throw new Error(
			`Cannot write ${artifactLabel} in "${resolved}" — parent directory "${walk.ancestor}" already contains a .swarm/ folder. Runtime state must be written to the project root.`,
		);
	}
	if (walk.reason === 'depth') {
		warn(
			`[project-boundary] Ancestor search exceeded ${MAX_PROJECT_ROOT_DEPTH} levels for "${resolved}" — failing closed`,
		);
		throw new Error(
			`Cannot verify project root for "${resolved}" — ancestor search exceeded ${MAX_PROJECT_ROOT_DEPTH} levels`,
		);
	}
	if (walk.reason === 'ancestor-swarm') {
		warn(
			`[project-boundary] Cannot inspect ancestor state "${walk.path}" — failing closed`,
		);
		throw new Error(
			`Cannot verify project root for "${resolved}" — ancestor state "${walk.path}" is inaccessible`,
		);
	}
	warn(
		`[project-boundary] Cannot inspect project indicators in ancestor "${walk.path}" — failing closed`,
	);
	throw new Error(
		`Cannot verify project root for "${resolved}" — project indicators in ancestor "${walk.path}" are inaccessible`,
	);
}

/**
 * Decision form of the same boundary policy (#2679): non-throwing, for the
 * bootstrap path where the outcome must (a) name the owning project root for an
 * ordinary child so every init/first-write consumer can target it, and
 * (b) fail closed (no runtime-state writes) when ownership cannot be
 * determined, while the plugin manifest stays fail-open.
 *
 * - `root`: the directory is a standalone root or declares its own boundary
 *   (`.git` file/dir, `.opencode` dir) — use it verbatim (canonicalized).
 * - `redirect`: an ancestor owns `.swarm/` plus a project indicator — use
 *   `owningRoot` for all project-surface reads/writes and surface an
 *   actionable hint naming it.
 * - `fail-closed`: ownership is indeterminable (inaccessible ancestor probes
 *   or depth exhaustion) — write no runtime state anywhere.
 *
 * Silent by design: messaging is the caller's job (`assertProjectRoot` keeps
 * its warn/throw contract; bootstrap emits one bounded operational hint).
 */
export type ProjectRootDecision =
	| { kind: 'root'; directory: string }
	| { kind: 'redirect'; directory: string; owningRoot: string }
	| { kind: 'fail-closed'; directory: string; reason: string };

export function resolveProjectRootDecision(
	directory: string,
	dependencies: ProjectRootProbeDependencies = fs,
): ProjectRootDecision {
	let resolved: string;
	try {
		resolved = dependencies.realpathSync(directory);
	} catch {
		return {
			kind: 'fail-closed',
			directory,
			reason: `cannot canonicalize directory "${directory}" — it may not exist or is inaccessible`,
		};
	}
	const walk = walkProjectBoundary(resolved, dependencies);
	if (walk.outcome === 'marker-root' || walk.outcome === 'unclaimed') {
		return { kind: 'root', directory: resolved };
	}
	if (walk.outcome === 'claimed') {
		return {
			kind: 'redirect',
			directory: resolved,
			owningRoot: walk.ancestor,
		};
	}
	const reason =
		walk.reason === 'depth'
			? `ancestor search exceeded ${MAX_PROJECT_ROOT_DEPTH} levels`
			: walk.reason === 'ancestor-swarm'
				? `ancestor state "${walk.path}" is inaccessible`
				: `project indicators in ancestor "${walk.path}" are inaccessible`;
	return { kind: 'fail-closed', directory: resolved, reason };
}

/** Narrow filesystem seam for deterministic marker error tests. */
export const _internals: { lstatSync: typeof fs.lstatSync } = {
	lstatSync: fs.lstatSync,
};
