import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildWorkspaceGraphAsync,
	clearCache,
} from '../../../src/tools/repo-graph';

describe('repo-graph async builder symbol visibility', () => {
	let tempDir: string;
	let workspacePath: string;

	beforeEach(async () => {
		tempDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'repo-graph-vis-')),
		);
		workspacePath = tempDir;
	});

	afterEach(async () => {
		clearCache(workspacePath);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function write(rel: string, content: string): Promise<void> {
		const full = path.join(tempDir, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content);
	}

	test('non-ESM public symbols reach exports, exportLines, and exportRanges', async () => {
		await write(
			'pkg/main.go',
			`package main

func PublicAPI() {}
func privateHelper() {}
`,
		);

		const graph = await buildWorkspaceGraphAsync(workspacePath);
		const node = Object.values(graph.nodes).find((n) =>
			n.filePath.endsWith(path.join('pkg', 'main.go')),
		);

		expect(node).toBeDefined();
		expect(node!.exports).toEqual(['PublicAPI']);
		expect(node!.exportLines).toEqual({ PublicAPI: 3 });
		expect(node!.exportRanges).toEqual({
			PublicAPI: { startLine: 3, endLine: 3 },
		});
		expect(node!.exports).not.toContain('privateHelper');
	});

	test('Python decorator ranges and Rust/Go exported names reach async graph metadata', async () => {
		await write(
			'pkg/__init__.py',
			`__all__ = ['_private_api']

@decorator
def _private_api():
    return 1

def hidden():
    return 2
`,
		);
		await write(
			'lib.rs',
			`pub(crate) struct InternalThing;
pub enum Mode { Fast }
pub trait Runner {}
mod private_mod {}
`,
		);
		await write(
			'cmd/main.go',
			`package main

var Version = "1"
const MaxRetries = 3
func PublicFunc() {}
func privateFunc() {}
`,
		);

		const graph = await buildWorkspaceGraphAsync(workspacePath);
		const py = Object.values(graph.nodes).find((n) =>
			n.filePath.endsWith(path.join('pkg', '__init__.py')),
		);
		const rust = Object.values(graph.nodes).find((n) =>
			n.filePath.endsWith('lib.rs'),
		);
		const go = Object.values(graph.nodes).find((n) =>
			n.filePath.endsWith(path.join('cmd', 'main.go')),
		);

		expect(py).toBeDefined();
		expect(py!.exports).toEqual(['_private_api']);
		expect(py!.exportRanges).toEqual({
			_private_api: { startLine: 3, endLine: 5 },
		});

		expect(rust).toBeDefined();
		expect(rust!.exports).toEqual(['InternalThing', 'Mode', 'Runner']);
		expect(rust!.exportRanges).toEqual({
			InternalThing: { startLine: 1, endLine: 1 },
			Mode: { startLine: 2, endLine: 2 },
			Runner: { startLine: 3, endLine: 3 },
		});

		expect(go).toBeDefined();
		expect(go!.exports).toEqual(['Version', 'MaxRetries', 'PublicFunc']);
		expect(go!.exportRanges).toEqual({
			Version: { startLine: 3, endLine: 3 },
			MaxRetries: { startLine: 4, endLine: 4 },
			PublicFunc: { startLine: 5, endLine: 5 },
		});
	});

	test('temp fixture is created inside the workspace root', () => {
		expect(fsSync.existsSync(tempDir)).toBe(true);
		expect(path.resolve(workspacePath)).toBe(tempDir);
	});
});
