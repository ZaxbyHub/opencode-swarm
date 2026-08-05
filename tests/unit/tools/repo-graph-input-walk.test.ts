import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	isGraphWideInputPath,
	walkRepoGraphInputs,
} from '../../../src/tools/repo-graph/builder';

const roots: string[] = [];

function workspace(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-input-walk-'));
	roots.push(root);
	return root;
}

function write(root: string, name: string): string {
	const target = path.join(root, name);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${name}\n`);
	return target;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('shared repo graph input walker', () => {
	test('enumerates source files and graph-wide manifests with metadata', async () => {
		const root = workspace();
		const source = write(root, 'src/a.ts');
		const manifest = write(root, 'packages/a/Cargo.toml');
		write(root, 'README.md');
		const walked = await walkRepoGraphInputs(root, { captureMetadata: true });
		expect(walked.sourceFiles).toEqual([source]);
		expect(walked.manifestFiles).toEqual([manifest]);
		expect(walked.metadata.map((entry) => entry.absolutePath).sort()).toEqual(
			[source, manifest].sort(),
		);
		expect(walked.metadata.every((entry) => entry.sizeBytes > 0)).toBe(true);
		expect(walked.incomplete).toBe(false);
		expect(walked.manifestDirs.has('packages/a')).toBe(true);
	});

	test('uses one shared graph-wide manifest classifier', () => {
		for (const name of [
			'package.json',
			'Cargo.toml',
			'pyproject.toml',
			'go.mod',
		]) {
			expect(isGraphWideInputPath(path.join('nested', name))).toBe(true);
		}
		expect(isGraphWideInputPath('nested/tsconfig.json')).toBe(false);
	});

	test('honors exclusions and reports cap truncation conservatively', async () => {
		const root = workspace();
		write(root, 'generated/skip.ts');
		write(root, 'src/a.ts');
		write(root, 'src/b.ts');
		const walked = await walkRepoGraphInputs(root, {
			captureMetadata: true,
			excludeDirs: ['generated'],
			maxFiles: 1,
		});
		expect(walked.sourceFiles).toHaveLength(1);
		expect(walked.sourceFiles[0]).not.toContain('generated');
		expect(walked.truncated).toBe(true);
		expect(walked.truncationReason).toBe('cap');
		expect(walked.incomplete).toBe(true);
	});
});
