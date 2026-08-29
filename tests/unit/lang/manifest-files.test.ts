import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	hasGitMarkerAncestor,
	hasManifestAncestor,
	hasSwarmState,
} from '../../../src/lang/manifest-files';

const tempDirs: string[] = [];

function makeTempDir(): string {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), 'opencode-swarm-manifest-files-'),
	);
	tempDirs.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('manifest-files startup preflights', () => {
	test('finds a manifest in the current directory or an ancestor', () => {
		const root = makeTempDir();
		const nested = path.join(root, 'src', 'nested');
		fs.mkdirSync(nested, { recursive: true });
		fs.mkdirSync(path.join(root, '.git'));
		fs.writeFileSync(path.join(root, 'package.json'), '{}');

		expect(hasManifestAncestor(root)).toBe(true);
		expect(hasManifestAncestor(nested)).toBe(true);
	});

	test('stops the manifest walk at a non-symlink Git boundary', () => {
		const root = makeTempDir();
		const nested = path.join(root, 'packages', 'core');
		fs.mkdirSync(nested, { recursive: true });
		fs.mkdirSync(path.join(root, '.git'));

		expect(hasManifestAncestor(nested)).toBe(false);
	});

	test('recognizes Git marker files and directories, but not absent markers', () => {
		const root = makeTempDir();
		const nested = path.join(root, 'src');
		fs.mkdirSync(nested);

		expect(hasGitMarkerAncestor(nested)).toBe(false);
		fs.writeFileSync(path.join(root, '.git'), 'gitdir: elsewhere');
		expect(hasGitMarkerAncestor(nested)).toBe(true);
	});

	test('detects existing .swarm state', () => {
		const root = makeTempDir();

		expect(hasSwarmState(root)).toBe(false);
		fs.mkdirSync(path.join(root, '.swarm'));
		expect(hasSwarmState(root)).toBe(true);
	});
});
