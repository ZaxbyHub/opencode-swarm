/**
 * Dotted-module resolution for JVM/.NET imports (issue #1529).
 *
 * Split out of `repo-graph-jvm-dotnet-regressions.test.ts` to stay under the
 * 500-line FR-006 cap. These cover `findDottedModuleCandidate`: which root
 * prefixes are searched, how a package/namespace resolves to a representative
 * file, and when the parent-as-file (nested type) probe may and may not run.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	buildWorkspaceGraph,
	buildWorkspaceGraphAsync,
} from '../../../src/tools/repo-graph/builder';
import { getContextPack } from '../../../src/tools/repo-graph/query';
import type { RepoGraph } from '../../../src/tools/repo-graph/types';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('jvm-dotnet-graph-');
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeFile(relPath: string, contents: string) {
	const full = path.join(tempDir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, contents);
}

function nodeFor(graph: RepoGraph, relPath: string) {
	const target = path.normalize(relPath).replace(/\\/g, '/');
	const match = Object.values(graph.nodes).find((n: any) =>
		n.moduleName.replace(/\\/g, '/').endsWith(target),
	);
	return match as any;
}

describe('repo-graph JVM/.NET dotted-module resolution', () => {
	test('a package import resolves to a representative file, deterministically', async () => {
		// A package specifier names a directory, so — exactly as this module
		// already does for Go package imports — the edge points at a
		// representative member. What must hold is that the choice is
		// deterministic (code-unit order, not host-dependent ICU collation) and
		// that it is a FILE, never a directory that happens to end in .java.
		writeFile(
			'com/example/Main.java',
			'package com.example;\n\nimport com.example.util.*;\n\npublic class Main { public void run() {} }\n',
		);
		writeFile(
			'com/example/util/Zzz.java',
			'package com.example.util;\n\npublic class Zzz {}\n',
		);
		writeFile(
			'com/example/util/Aaa.java',
			'package com.example.util;\n\npublic class Aaa {}\n',
		);
		// A directory whose name ends in .java must be skipped, not resolved.
		fs.mkdirSync(path.join(tempDir, 'com/example/util/Decoy.java'), {
			recursive: true,
		});

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const mainNode = nodeFor(graph, 'com/example/Main.java');
		const targets = graph.edges
			.filter((e) => e.source === mainNode.filePath)
			.map((e) => path.basename(e.target));

		expect(targets).toContain('Aaa.java');
		expect(targets).not.toContain('Decoy.java');
	});

	test('a directory that looks like a source file is skipped, even when it sorts first', async () => {
		// The isFile guard only bites when the decoy sorts BEFORE any real file.
		// 'AA.java' precedes 'Aaa.java' in code-unit order, so without the guard
		// readdirSync's directory entry would be returned as the import target.
		// (It must not be a case-variant of the real file — NTFS is
		// case-insensitive, so 'AAA.java' beside 'Aaa.java' is EEXIST.)
		writeFile(
			'q/Main.java',
			'package q;\n\nimport q.pkg.*;\n\npublic class Main {}\n',
		);
		writeFile('q/pkg/Aaa.java', 'package q.pkg;\n\npublic class Aaa {}\n');
		fs.mkdirSync(path.join(tempDir, 'q/pkg/AA.java'), { recursive: true });

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const mainNode = nodeFor(graph, 'q/Main.java');
		const targets = graph.edges
			.filter((e) => e.source === mainNode.filePath)
			.map((e) => path.basename(e.target));

		expect(targets).toContain('Aaa.java');
		expect(targets).not.toContain('AA.java');
	});

	test('a package prefers its same-named file over an alphabetically earlier sibling', async () => {
		// Directory case MUST match the namespace. JVM/.NET package-to-directory
		// mapping is case-sensitive by spec and `findDottedModuleCandidate`
		// builds the path verbatim from the specifier, so a lowercase `r/` tree
		// under `using R.Data;` resolves on case-insensitive NTFS/APFS and fails
		// on ext4 — it passed on Windows and macOS and broke only the Linux CI
		// shard. Note `nodeFor` matches with case-sensitive `endsWith`, so its
		// argument has to move with the fixture or it throws on every platform.
		//
		// HONEST LIMIT: a CONSISTENT lowercase revert of all four sites still
		// passes on a case-insensitive host (NTFS/APFS) and fails only on the
		// Linux CI shard. No local assertion can catch that, so this alignment
		// is enforced by CI, not by this test.
		writeFile(
			'R/Program.cs',
			'namespace R;\n\nusing R.Data;\n\npublic class Program {}\n',
		);
		writeFile(
			'R/Data/Alpha.cs',
			'namespace R.Data;\n\npublic class Alpha {}\n',
		);
		writeFile('R/Data/Data.cs', 'namespace R.Data;\n\npublic class Data {}\n');

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const programNode = nodeFor(graph, 'R/Program.cs');
		const targets = graph.edges
			.filter((e) => e.source === programNode.filePath)
			.map((e) => path.basename(e.target));

		// Data.cs is the meaningful representative even though Alpha.cs sorts first.
		expect(targets).toContain('Data.cs');
		expect(targets).not.toContain('Alpha.cs');
	});

	test('a C# namespace using does not resolve to a same-named type file', async () => {
		// The parent-as-file probe exists for nested types (`a.b.Outer.Inner` ->
		// `a/b/Outer.java`). It must NOT fire when the full path already exists
		// as a directory, or a plain `using App.Data;` resolves to an unrelated
		// `App.cs` — an edge the source never referenced. The asymmetry is
		// language-level: a Java non-wildcard import names a TYPE, a C#
		// `using X.Y;` names a NAMESPACE with no `.*` marker to distinguish it.
		writeFile('App.cs', 'namespace Unrelated;\n\npublic class App {}\n');
		writeFile(
			'App/Data/Repositories/UserRepo.cs',
			'namespace App.Data.Repositories;\n\npublic class UserRepo {}\n',
		);
		writeFile(
			'Program.cs',
			'namespace Top;\n\nusing App.Data;\n\npublic class Program {}\n',
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const programNode = nodeFor(graph, 'Program.cs');
		const targets = graph.edges
			.filter((e) => e.source === programNode.filePath)
			.map((e) => path.basename(e.target));

		expect(targets).not.toContain('App.cs');
	});

	test('a genuine nested-type import still resolves to its enclosing type file', async () => {
		// The companion to the test above: with no directory at the full path,
		// the parent-as-file probe is the feature, not a bug.
		writeFile(
			'com/acme/Outer.java',
			'package com.acme;\n\npublic class Outer { public static class Inner {} }\n',
		);
		writeFile(
			'com/acme/Main.java',
			'package com.acme;\n\nimport com.acme.Outer.Inner;\n\npublic class Main {}\n',
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const mainNode = nodeFor(graph, 'com/acme/Main.java');
		const targets = graph.edges
			.filter((e) => e.source === mainNode.filePath)
			.map((e) => path.basename(e.target));

		expect(targets).toContain('Outer.java');
	});

	test('a package representative skips test classes, but a test-only package still resolves', async () => {
		// Mirrors the Go precedent's `!entry.endsWith('_test.go')` filter. Without
		// it, alphabetical order makes AaaTests.cs beat the real type.
		writeFile('Program.cs', 'namespace App;\n\nusing Pkg;\nusing OnlyT;\n');
		writeFile(
			'Pkg/AaaTests.cs',
			'namespace Pkg;\n\npublic class AaaTests {}\n',
		);
		writeFile('Pkg/Real.cs', 'namespace Pkg;\n\npublic class Real {}\n');
		writeFile(
			'OnlyT/ZTests.cs',
			'namespace OnlyT;\n\npublic class ZTests {}\n',
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const programNode = nodeFor(graph, 'Program.cs');
		const targets = graph.edges
			.filter((e) => e.source === programNode.filePath)
			.map((e) => path.basename(e.target));

		expect(targets).toContain('Real.cs');
		expect(targets).not.toContain('AaaTests.cs');
		// A package containing only tests must not lose its edge entirely.
		expect(targets).toContain('ZTests.cs');
	});

	test('a conventional Maven/Gradle source root resolves', async () => {
		// JVM_DOTNET_DOTTED_ROOTS carries 'src', 'src/main/java' and
		// 'src/main/kotlin' for the standard build layouts, but every other
		// fixture in these suites uses the package-rooted '' layout — deleting
		// those three entries would not have failed the suite.
		writeFile(
			'src/main/java/com/acme/App.java',
			'package com.acme;\n\nimport com.acme.Helper;\n\npublic class App {}\n',
		);
		writeFile(
			'src/main/java/com/acme/Helper.java',
			'package com.acme;\n\npublic class Helper {}\n',
		);
		writeFile(
			'src/main/kotlin/com/acme/Svc.kt',
			'package com.acme\n\nimport com.acme.Helper\n\nfun go() {}\n',
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const appNode = nodeFor(graph, 'src/main/java/com/acme/App.java');
		const helperNode = nodeFor(graph, 'src/main/java/com/acme/Helper.java');
		expect(
			graph.edges.some(
				(e) =>
					e.source === appNode.filePath && e.target === helperNode.filePath,
			),
		).toBe(true);
		expect(appNode.ontology?.packageBoundary).toBe('com.acme');
	});

	test('probe specificity outranks root specificity for a Java nested-type shape', async () => {
		// Behavior change worth pinning: the three probes each sweep ALL roots
		// before the next begins, so a package-directory match under
		// src/main/java now beats a parent-as-file match at the repo root.
		// Previously the probes were interleaved per-root and the '' root's
		// parent probe won. A real directory at the full dotted path is strong
		// evidence the specifier names a package, so the more specific probe is
		// preferred.
		writeFile(
			'z/Outer.java',
			'package z;\n\npublic class Outer { public static class Inner {} }\n',
		);
		writeFile(
			'src/main/java/z/Outer/Inner/M.java',
			'package z.Outer.Inner;\n\npublic class M {}\n',
		);
		writeFile(
			'z/Main.java',
			'package z;\n\nimport z.Outer.Inner;\n\npublic class Main {}\n',
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const mainNode = nodeFor(graph, 'z/Main.java');
		const targets = graph.edges
			.filter((e) => e.source === mainNode.filePath)
			.map((e) => path.basename(e.target));

		expect(targets).toContain('M.java');
		expect(targets).not.toContain('Outer.java');
	});

	test('a namespace directory holding only subdirectories yields no edge', async () => {
		// The firstSourceFileIn + parent-probe interaction. The directory exists
		// but holds no direct source file, so the package probe finds nothing;
		// the parent probe must not then fall back to an unrelated same-named
		// type file. Correct today, previously untested.
		writeFile('App.cs', 'namespace Unrelated;\n\npublic class App {}\n');
		writeFile(
			'App/Data/Sub/Deep.cs',
			'namespace App.Data.Sub;\n\npublic class Deep {}\n',
		);
		writeFile(
			'Main.cs',
			'namespace Top;\n\nusing App.Data;\n\npublic class Main {}\n',
		);

		const graph = await buildWorkspaceGraphAsync(tempDir);
		const mainNode = nodeFor(graph, 'Main.cs');
		const targets = graph.edges
			.filter((e) => e.source === mainNode.filePath)
			.map((e) => path.basename(e.target));

		expect(targets).not.toContain('App.cs');
		expect(targets).not.toContain('Deep.cs');
	});
});
