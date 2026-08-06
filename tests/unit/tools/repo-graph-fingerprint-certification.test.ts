import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildWorkspaceGraph } from '../../../src/tools/repo-graph/builder';
import {
	invalidateFreshnessCache,
	probeFreshness,
	writeFingerprint,
} from '../../../src/tools/repo-graph/freshness';

const roots: string[] = [];

function workspace(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-certification-'));
	roots.push(root);
	return root;
}

function write(root: string, name: string, content: string): string {
	const target = path.join(root, name);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return target;
}

afterEach(() => {
	invalidateFreshnessCache();
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('repo graph fingerprint certification', () => {
	test('refuses legacy nodes without exact numeric witnesses', async () => {
		const root = workspace();
		write(root, 'a.ts', 'export const a = 1;\n');
		const graph = buildWorkspaceGraph(root);
		expect(await writeFingerprint(root, graph)).toBe(true);
		const node = Object.values(graph.nodes)[0];
		delete node.sizeBytes;
		delete node.mtimeMs;
		expect(await writeFingerprint(root, graph)).toBe(false);
		expect((await probeFreshness(root)).state).toBe('no-fingerprint');
	});

	test('refuses to bless a file changed after graph extraction', async () => {
		const root = workspace();
		const target = write(root, 'a.ts', 'export const a = 1;\n');
		const graph = buildWorkspaceGraph(root);
		fs.appendFileSync(target, '// changed after extraction\n');
		expect(await writeFingerprint(root, graph)).toBe(false);
	});

	test('certifies deterministic oversized skips but not unexplained omissions', async () => {
		const root = workspace();
		write(root, 'large.ts', 'export const oversized = true;\n');
		const graph = buildWorkspaceGraph(root, { maxFileSizeBytes: 1 });
		expect(graph.diagnostics?.oversizedFiles).toEqual(['large.ts']);
		expect(await writeFingerprint(root, graph)).toBe(true);

		const unexplained = buildWorkspaceGraph(root, { maxFileSizeBytes: 1 });
		delete unexplained.diagnostics;
		expect(await writeFingerprint(root, unexplained)).toBe(false);
	});

	test('includes package manifests and stable skipped sources in the sidecar', async () => {
		const root = workspace();
		write(root, 'package.json', '{"name":"fixture"}\n');
		write(root, 'binary.ts', 'binary\0payload');
		const graph = buildWorkspaceGraph(root);
		expect(graph.diagnostics?.binaryFiles).toEqual(['binary.ts']);
		expect(await writeFingerprint(root, graph)).toBe(true);
		const sidecar = JSON.parse(
			fs.readFileSync(
				path.join(root, '.swarm', 'repo-graph.fingerprint.json'),
				'utf8',
			),
		) as { files: Record<string, unknown> };
		expect(Object.keys(sidecar.files)).toEqual(['binary.ts', 'package.json']);
	});

	test('certifies validation skips but refuses transient unreadable omissions', async () => {
		const root = workspace();
		const target = write(root, 'invalid.ts', 'export const invalid = true;\n');
		const stats = fs.statSync(target);
		const validationSkip = buildWorkspaceGraph(root);
		validationSkip.nodes = {};
		validationSkip.diagnostics = {
			validationSkippedFiles: ['invalid.ts'],
			extractorInputWitnesses: [
				{
					file: 'invalid.ts',
					kind: 'stable-skip',
					sizeBytes: stats.size,
					mtimeMs: stats.mtimeMs,
				},
			],
		};
		expect(await writeFingerprint(root, validationSkip)).toBe(true);

		const unreadable = buildWorkspaceGraph(root);
		unreadable.nodes = {};
		unreadable.diagnostics = { unreadableFiles: ['invalid.ts'] };
		expect(await writeFingerprint(root, unreadable)).toBe(false);
		expect((await probeFreshness(root)).state).toBe('no-fingerprint');
	});

	test('refuses a package manifest changed after graph extraction', async () => {
		const root = workspace();
		const manifest = write(root, 'package.json', '{"name":"before"}\n');
		write(root, 'a.ts', 'export const a = 1;\n');
		const graph = buildWorkspaceGraph(root);
		fs.appendFileSync(manifest, ' ');
		expect(await writeFingerprint(root, graph)).toBe(false);
	});

	test('refuses a stable skip changed after graph extraction', async () => {
		const root = workspace();
		const oversized = write(root, 'large.ts', 'export const large = true;\n');
		const graph = buildWorkspaceGraph(root, { maxFileSizeBytes: 1 });
		fs.appendFileSync(oversized, '// changed\n');
		expect(await writeFingerprint(root, graph)).toBe(false);
	});
});
