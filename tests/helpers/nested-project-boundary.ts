import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import { safeRmRecursive } from './safe-test-dir';
import { canonicalMkdtemp } from './tmpdir';

export interface NestedBoundaryFixture {
	root: string;
	outer: string;
	nested: string;
	ordinary: string;
}

export function createNestedBoundaryFixture(
	marker: 'git-directory' | 'git-file' | 'opencode' = 'git-directory',
): NestedBoundaryFixture {
	const root = canonicalMkdtemp('nested-boundary-');
	const outer = path.join(root, 'outer');
	const nested = path.join(outer, 'nested');
	const ordinary = path.join(outer, 'ordinary');
	fs.mkdirSync(path.join(outer, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
	fs.mkdirSync(nested, { recursive: true });
	fs.mkdirSync(ordinary, { recursive: true });

	if (marker === 'git-directory') {
		fs.mkdirSync(path.join(nested, '.git'));
	} else if (marker === 'git-file') {
		fs.writeFileSync(path.join(nested, '.git'), 'gitdir: ../git-data\n');
	} else {
		fs.mkdirSync(path.join(nested, '.opencode'));
	}

	return { root, outer, nested, ordinary };
}

export function removeNestedBoundaryFixture(
	fixture: NestedBoundaryFixture,
): void {
	safeRmRecursive(fixture.root);
}

export function makeNestedPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Nested project boundary fixture',
		swarm: 'nested-boundary',
		current_phase: 1,
		migration_status: 'migrated',
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Exercise nested project state',
						depends: [],
						files_touched: ['src/nested.ts'],
					},
				],
			},
		],
	};
}

export function writeNestedPlan(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(makeNestedPlan(), null, 2),
	);
}
