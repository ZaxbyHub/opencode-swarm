import * as fs from 'node:fs';
import * as path from 'node:path';
import { type EvaluationTaskV1, EvaluationTaskV1Schema } from './contracts.js';
import {
	computeTaskInputContentHash,
	resolveContainedExistingPath,
} from './hashing.js';

export const TIER1_FIXTURE_IDS = [
	'mutation-off-by-one',
	'null-substitution',
	'operator-swap',
	'guard-removal',
	'branch-swap',
	'side-effect-deletion',
	'curated-off-by-one',
	'missing-await',
	'swallowed-error',
	'injection-prone-string',
	'missing-auth-check',
	'boundary-error',
] as const;

export type Tier1FixtureId = (typeof TIER1_FIXTURE_IDS)[number];

export function resolveTier1FixtureRoot(packageRoot: string): string {
	return resolveContainedExistingPath(packageRoot, 'evaluation-fixtures/tier1');
}

export function resolveTier1FixtureDirectory(
	packageRoot: string,
	fixtureId: Tier1FixtureId,
): string {
	const root = resolveTier1FixtureRoot(packageRoot);
	return resolveContainedExistingPath(root, fixtureId);
}

export function listTier1FixtureManifests(packageRoot: string): string[] {
	const root = resolveTier1FixtureRoot(packageRoot);
	const expected = new Set<string>(TIER1_FIXTURE_IDS);
	const actual = fs
		.readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && expected.has(entry.name))
		.map((entry) => entry.name)
		.sort();
	if (actual.length !== TIER1_FIXTURE_IDS.length) {
		throw new Error(
			`Tier-1 evaluation fixture package is incomplete: expected ${TIER1_FIXTURE_IDS.length}, found ${actual.length}`,
		);
	}
	return actual.map((id) =>
		resolveContainedExistingPath(root, path.join(id, 'manifest.json')),
	);
}

/** Load packed Harbor-style manifests and rebase their package-relative paths. */
export function loadTier1EvaluationTasks(
	packageRoot: string,
): EvaluationTaskV1[] {
	return listTier1FixtureManifests(packageRoot).map((manifestPath) => {
		const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<
			string,
			unknown
		>;
		const id = raw.id;
		if (
			typeof id !== 'string' ||
			!TIER1_FIXTURE_IDS.includes(id as Tier1FixtureId)
		) {
			throw new Error(`Unknown Tier-1 fixture id in ${manifestPath}`);
		}
		const prefix = path.posix.join('evaluation-fixtures', 'tier1', id);
		const instructionPath = raw.instructionPath;
		const environment = raw.environment as Record<string, unknown> | undefined;
		const scorer = raw.scorer as Record<string, unknown> | undefined;
		if (
			typeof instructionPath !== 'string' ||
			typeof environment?.path !== 'string'
		) {
			throw new Error(`Malformed Tier-1 fixture paths in ${manifestPath}`);
		}
		const rebased = {
			...raw,
			instructionPath: path.posix.join(prefix, instructionPath),
			environment: {
				...environment,
				path: path.posix.join(prefix, environment.path),
			},
			scorer:
				scorer?.kind === 'project' && Array.isArray(scorer.argv)
					? {
							...scorer,
							argv: [
								path.posix.join(prefix, String(scorer.argv[0])),
								...scorer.argv.slice(1),
							],
						}
					: scorer,
		};
		const task = EvaluationTaskV1Schema.parse(rebased);
		if (computeTaskInputContentHash(packageRoot, task) !== task.contentHash) {
			throw new Error(`Tier-1 fixture ${id} failed its content hash`);
		}
		return task;
	});
}
