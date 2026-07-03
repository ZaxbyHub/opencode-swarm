import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRepoGraph, processFile } from '../../../src/graph/graph-builder';
import { updateGraphIncremental } from '../../../src/graph/graph-store';
import {
	extractImports,
	getLanguageFromExtension,
	SOURCE_EXTENSIONS,
} from '../../../src/graph/import-extractor';
import {
	REPO_GRAPH_SCHEMA_VERSION,
	type RepoGraph,
} from '../../../src/graph/types';

let root: string;

function write(rel: string, content: string): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

beforeEach(() => {
	root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-dotnet-graph-')),
	);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('legacy repo graph JVM/.NET support', () => {
	test('maps Java, Kotlin, and C# extensions to source languages', () => {
		expect(SOURCE_EXTENSIONS).toContain('.java');
		expect(SOURCE_EXTENSIONS).toContain('.kt');
		expect(SOURCE_EXTENSIONS).toContain('.kts');
		expect(SOURCE_EXTENSIONS).toContain('.cs');
		expect(SOURCE_EXTENSIONS).toContain('.csx');
		expect(getLanguageFromExtension('.java')).toBe('java');
		expect(getLanguageFromExtension('.kt')).toBe('kotlin');
		expect(getLanguageFromExtension('.kts')).toBe('kotlin');
		expect(getLanguageFromExtension('.cs')).toBe('csharp');
		expect(getLanguageFromExtension('.csx')).toBe('csharp');
	});

	test('extracts package import edges and exported API symbols', async () => {
		write(
			'com/example/MathUtil.java',
			`package com.example;
public class MathUtil {
  public static int max(int a, int b) { return a; }
}`,
		);
		write(
			'com/example/App.java',
			`package com.example;
import static com.example.MathUtil.max;
public class App {
  public int run() { return max(1, 2); }
}`,
		);
		write(
			'scripts/build.kts',
			`import com.example.App
class BuildTask
fun runBuild() = App()`,
		);
		write(
			'Example/Core/Service.cs',
			`namespace Example.Core;
public record Service(string Name);
public class Runner { public Runner() {} }`,
		);

		const appPath = path.join(root, 'com/example/App.java');
		const imports = extractImports({
			absoluteFilePath: appPath,
			workspaceRoot: root,
		});
		expect(imports).toContainEqual(
			expect.objectContaining({
				target: 'com/example/MathUtil.java',
				rawModule: 'com.example.MathUtil',
				importedSymbols: ['max'],
				importType: 'named',
			}),
		);

		const graph = await buildRepoGraph(root, { maxFiles: 10, concurrency: 2 });
		expect(graph.files['com/example/App.java']).toMatchObject({
			language: 'java',
			exports: expect.arrayContaining([
				expect.objectContaining({ name: 'App', kind: 'class' }),
				expect.objectContaining({ name: 'App.run', kind: 'method' }),
			]),
		});
		expect(graph.files['scripts/build.kts']).toMatchObject({
			language: 'kotlin',
			exports: expect.arrayContaining([
				expect.objectContaining({ name: 'BuildTask', kind: 'class' }),
				expect.objectContaining({ name: 'runBuild', kind: 'function' }),
			]),
		});
		expect(graph.files['Example/Core/Service.cs']).toMatchObject({
			language: 'csharp',
			exports: expect.arrayContaining([
				expect.objectContaining({ name: 'Service', kind: 'class' }),
				expect.objectContaining({ name: 'Runner', kind: 'class' }),
				expect.objectContaining({ name: 'Runner.Runner', kind: 'method' }),
			]),
		});

		const node = await processFile(
			path.join(root, 'Example/Core/Service.cs'),
			root,
		);
		expect(node?.language).toBe('csharp');
		expect(node?.exports.map((s) => s.name)).toContain('Service');
	});

	test('parses Java wildcard imports as namespace edges without truncating modules', () => {
		write(
			'com/example/model/User.java',
			'package com.example.model; public class User {}',
		);
		write(
			'com/example/MathUtil.java',
			'package com.example; public class MathUtil { public static int max(int a, int b) { return a; } }',
		);
		write(
			'com/example/App.java',
			`package com.example;
import com.example.model.*;
import static com.example.MathUtil.*;
public class App {}`,
		);

		const imports = extractImports({
			absoluteFilePath: path.join(root, 'com/example/App.java'),
			workspaceRoot: root,
		});
		expect(imports).toContainEqual(
			expect.objectContaining({
				rawModule: 'com.example.model.*',
				target: 'com/example/model/User.java',
				importedSymbols: ['*'],
				importType: 'namespace',
			}),
		);
		expect(imports).toContainEqual(
			expect.objectContaining({
				rawModule: 'com.example.MathUtil.*',
				target: 'com/example/MathUtil.java',
				importedSymbols: ['*'],
				importType: 'namespace',
			}),
		);
	});

	test('parses Kotlin wildcard imports as namespace edges without truncating modules', () => {
		write('com/example/model/User.kt', 'package com.example.model\nclass User');
		write(
			'com/example/App.kt',
			`package com.example
import com.example.model.*
class App`,
		);

		const imports = extractImports({
			absoluteFilePath: path.join(root, 'com/example/App.kt'),
			workspaceRoot: root,
		});
		expect(imports).toContainEqual(
			expect.objectContaining({
				rawModule: 'com.example.model.*',
				target: 'com/example/model/User.kt',
				importedSymbols: ['*'],
				importType: 'namespace',
			}),
		);
	});

	test('incremental graph updates accept csx scripts', async () => {
		const graph: RepoGraph = {
			version: REPO_GRAPH_SCHEMA_VERSION,
			buildTimestamp: new Date().toISOString(),
			rootDir: root,
			files: {},
		};
		write(
			'scripts/tool.csx',
			'public class ScriptTool { public void Run() {} }',
		);

		await updateGraphIncremental(root, ['scripts/tool.csx'], graph);
		expect(graph.files['scripts/tool.csx']).toMatchObject({
			language: 'csharp',
			exports: expect.arrayContaining([
				expect.objectContaining({ name: 'ScriptTool', kind: 'class' }),
			]),
		});
	});
});
