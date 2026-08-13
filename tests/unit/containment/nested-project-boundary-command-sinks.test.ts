import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleAcknowledgeSpecDriftCommand } from '../../../src/commands/acknowledge-spec-drift.js';
import { handleIssueCommand } from '../../../src/commands/issue.js';
import { withSafeTestDir } from '../../helpers/safe-test-dir.js';

function createOuterProject(base: string): string {
	const outer = path.join(base, 'outer');
	fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
	fs.mkdirSync(path.join(outer, '.swarm'), { recursive: true });
	return outer;
}

function createNested(
	outer: string,
	name: string,
	marker?: 'git-file' | 'opencode',
): string {
	const nested = path.join(outer, name);
	fs.mkdirSync(path.join(nested, '.swarm'), { recursive: true });
	if (marker === 'git-file') {
		fs.writeFileSync(path.join(nested, '.git'), 'gitdir: ../metadata\n');
	} else if (marker === 'opencode') {
		fs.mkdirSync(path.join(nested, '.opencode'));
	}
	return nested;
}

function snapshotTree(root: string): string[] {
	const entries: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of fs
			.readdirSync(directory, { withFileTypes: true })
			.sort((left, right) => left.name.localeCompare(right.name))) {
			const absolute = path.join(directory, entry.name);
			const relative = path.relative(root, absolute);
			if (entry.isDirectory()) {
				entries.push(`dir:${relative}`);
				visit(absolute);
			} else {
				entries.push(
					`file:${relative}:${fs.readFileSync(absolute).toString('base64')}`,
				);
			}
		}
	};
	visit(root);
	return entries;
}

describe('nested project boundaries — command mutation sinks', () => {
	test('ordinary descendants reject issue and drift mutations without changing state', async () => {
		await withSafeTestDir(async (base) => {
			const ordinary = createNested(createOuterProject(base), 'ordinary');
			const stalenessPath = path.join(
				ordinary,
				'.swarm',
				'spec-staleness.json',
			);
			fs.writeFileSync(stalenessPath, '{ malformed');
			const before = snapshotTree(ordinary);

			const issueResult = handleIssueCommand(ordinary, [
				'https://github.com/ZaxbyHub/opencode-swarm/issues/2127',
			]);
			expect(issueResult).toContain('project root');
			await expect(
				handleAcknowledgeSpecDriftCommand(ordinary, [], 'user'),
			).rejects.toThrow('project root');

			expect(snapshotTree(ordinary)).toEqual(before);
			expect(fs.readFileSync(stalenessPath, 'utf8')).toBe('{ malformed');
		});
	});

	test('direct .git-file and .opencode roots keep command writes available', async () => {
		await withSafeTestDir(async (base) => {
			const outer = createOuterProject(base);
			for (const [name, marker] of [
				['git-root', 'git-file'],
				['opencode-root', 'opencode'],
			] as const) {
				const root = createNested(outer, name, marker);
				const issueResult = handleIssueCommand(root, [
					'https://github.com/ZaxbyHub/opencode-swarm/issues/2127',
				]);
				expect(issueResult).toContain('[MODE: ISSUE_INGEST');
				expect(
					fs.existsSync(path.join(root, '.swarm', 'issue-reference.json')),
				).toBe(true);

				const stalenessPath = path.join(root, '.swarm', 'spec-staleness.json');
				fs.writeFileSync(stalenessPath, '{ malformed');
				expect(
					await handleAcknowledgeSpecDriftCommand(root, [], 'user'),
				).toContain('corrupted');
				expect(fs.existsSync(stalenessPath)).toBe(false);
			}
		});
	});
});
