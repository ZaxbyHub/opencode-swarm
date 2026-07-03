import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { repo_map } from '../../../src/tools/repo-map';

let root: string;

async function callRepoMap(args: Record<string, unknown>): Promise<any> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string | { output: string }>;
	};
	const out = await (repo_map as unknown as Executable).execute(args, {
		directory: root,
	});
	return JSON.parse(typeof out === 'string' ? out : out.output);
}

function write(rel: string, content: string): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

beforeEach(() => {
	root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-jvm-dotnet-')),
	);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('repo_map JVM/.NET context surfaces', () => {
	test('build records package boundaries and context_pack spans for Java symbols', async () => {
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

		const build = await callRepoMap({ action: 'build' });
		expect(build.success).toBe(true);
		expect(build.fileCount).toBe(2);

		const ontology = await callRepoMap({
			action: 'ontology',
			file: 'com/example/App.java',
		});
		expect(ontology.success).toBe(true);
		expect(ontology.ontology.packageBoundary).toBe('com.example');

		const context = await callRepoMap({
			action: 'context_pack',
			file: 'com/example/App.java',
			symbol: 'App',
			top_n: 3,
		});
		expect(context.success).toBe(true);
		expect(context.target).toMatchObject({
			file: 'com/example/App.java',
			symbol: 'App',
		});
		expect(
			context.spans.some((span: any) => span.file === 'com/example/App.java'),
		).toBe(true);
	});

	test('context_pack returns all Java overload spans for a symbol name', async () => {
		write(
			'App.java',
			`
public class App {
  public int run() { return 1; }
  public int run(int value) { return value; }
}
`,
		);

		const build = await callRepoMap({ action: 'build' });
		expect(build.success).toBe(true);

		const context = await callRepoMap({
			action: 'context_pack',
			file: 'App.java',
			symbol: 'run',
			top_n: 5,
		});
		expect(context.success).toBe(true);
		const runSpans = context.spans.filter(
			(span: any) => span.file === 'App.java' && span.symbol === 'run',
		);
		expect(runSpans.map((span: any) => span.startLine)).toEqual([3, 4]);
	});
});
