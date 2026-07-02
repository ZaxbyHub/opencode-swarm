import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { batch_symbols } from './batch-symbols';

let root: string;

async function callBatch(files: string[]): Promise<any> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string | { output: string }>;
	};
	const out = await (batch_symbols as unknown as Executable).execute(
		{ files, exported_only: true },
		{ directory: root },
	);
	return JSON.parse(typeof out === 'string' ? out : out.output);
}

function write(rel: string, content: string): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

beforeEach(() => {
	root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'batch-symbols-jvm-dotnet-')),
	);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('batch_symbols JVM/.NET support', () => {
	test('processes Java, Kotlin script, and C# script files in one batch', async () => {
		write('App.java', 'public class App { public int run() { return 1; } }');
		write('build.kts', 'fun buildTask() = Unit');
		write('tool.csx', 'public class Tool { public void Run() {} }');

		const parsed = await callBatch(['App.java', 'build.kts', 'tool.csx']);
		expect(parsed.successCount).toBe(3);
		expect(parsed.failureCount).toBe(0);
		expect(
			parsed.results.map((r: any) => r.symbols.map((s: any) => s.name)),
		).toEqual([['App', 'App.run'], ['buildTask'], ['Tool', 'Tool.Run']]);
	});
});
