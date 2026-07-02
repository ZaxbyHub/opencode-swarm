import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { symbols } from './symbols';

let root: string;

async function callSymbols(args: Record<string, unknown>): Promise<any> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string | { output: string }>;
	};
	const out = await (symbols as unknown as Executable).execute(args, {
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
		fs.mkdtempSync(path.join(os.tmpdir(), 'symbols-jvm-dotnet-')),
	);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('symbols JVM/.NET extraction', () => {
	test('single-file mode extracts Java, Kotlin, and C# public API symbols', async () => {
		write(
			'src/main/java/com/example/App.java',
			'public class App { public int run() { return 1; } private void hidden() {} }',
		);
		write(
			'src/main/kotlin/com/example/Build.kt',
			'internal class Build { fun run() = Unit; private fun hidden() = Unit }\nfun topLevel() = Unit',
		);
		write(
			'src/Example/Core/Service.cs',
			'public record Service(string Name);\ninternal class Runner { public Runner() {} public void Run() {} private void Hidden() {} }',
		);

		const java = await callSymbols({
			file: 'src/main/java/com/example/App.java',
			exported_only: true,
		});
		expect(java.symbols.map((s: any) => s.name)).toEqual(['App', 'App.run']);

		const kotlin = await callSymbols({
			file: 'src/main/kotlin/com/example/Build.kt',
			exported_only: true,
		});
		expect(kotlin.symbols.map((s: any) => s.name)).toEqual(
			expect.arrayContaining(['Build', 'Build.run', 'topLevel']),
		);

		const csharp = await callSymbols({
			file: 'src/Example/Core/Service.cs',
			exported_only: true,
		});
		expect(csharp.symbols.map((s: any) => s.name)).toEqual(
			expect.arrayContaining([
				'Service',
				'Runner',
				'Runner.Runner',
				'Runner.Run',
			]),
		);
		expect(csharp.symbols.map((s: any) => s.name)).not.toContain(
			'Runner.Hidden',
		);
	});

	test('workspace mode scans java kt kts cs and csx files', async () => {
		write('A.java', 'public class Alpha {}');
		write('B.kt', 'class Beta');
		write('C.kts', 'fun Gamma() = Unit');
		write('D.cs', 'public class Delta {}');
		write('E.csx', 'public class Epsilon {}');

		const workspace = await callSymbols({
			workspace: true,
			exported_only: true,
		});
		const files = workspace.files.map((f: any) => f.file).sort();
		expect(files).toEqual(['A.java', 'B.kt', 'C.kts', 'D.cs', 'E.csx']);
	});

	test('does not invent methods from call sites or export default-private C# members', async () => {
		write(
			'App.java',
			'public class App { public int run() { return max(1, 2); } }',
		);
		write(
			'Runner.cs',
			'public class Runner { void Run() { Helper(); } public void Start() {} }',
		);

		const java = await callSymbols({ file: 'App.java', exported_only: false });
		expect(java.symbols.map((s: any) => s.name)).toEqual(['App', 'App.run']);

		const csharpAll = await callSymbols({
			file: 'Runner.cs',
			exported_only: false,
		});
		expect(csharpAll.symbols.map((s: any) => s.name)).toEqual([
			'Runner',
			'Runner.Run',
			'Runner.Start',
		]);
		const run = csharpAll.symbols.find((s: any) => s.name === 'Runner.Run');
		expect(run.exported).toBe(false);
		expect(csharpAll.symbols.map((s: any) => s.name)).not.toContain(
			'Runner.Helper',
		);

		const csharpExported = await callSymbols({
			file: 'Runner.cs',
			exported_only: true,
		});
		expect(csharpExported.symbols.map((s: any) => s.name)).toEqual([
			'Runner',
			'Runner.Start',
		]);
	});
});
