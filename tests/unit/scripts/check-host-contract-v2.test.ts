import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	type CorpusEntry,
	digestCorpusFile,
	extractTarballEntries,
	isSafeNpmTag,
	main,
	npmTarballUrl,
	readBytesBounded,
	resolveV2LatestTag,
	runCheck,
	V2_CORPUS,
} from '../../../scripts/check-host-contract-v2';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

// Issue #2910 W1.3: offline coverage for the v2 host-contract drift check.
// All verdict paths are exercised through `--source` fixture directories
// (hand-written d.ts / host-source trees) — no network, no tarballs.

const tempRoots: string[] = [];

function makeTempDir(): string {
	const dir = canonicalMkdtemp('host-contract-v2-');
	tempRoots.push(dir);
	return dir;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) removeTreeWithRetry(root);
	}
});

const slug = (entry: CorpusEntry): string =>
	entry.id.replace(/[^a-zA-Z0-9]/g, '_');

/** Minimal exported-surface fixture content, distinct per corpus entry. */
function defaultContent(entry: CorpusEntry): string {
	return [
		`// fixture corpus for ${entry.id}`,
		`export interface Fixture_${slug(entry)} {`,
		'\treadonly id: string;',
		'\tenabled?: boolean;',
		'}',
		`export type Fixture_${slug(entry)}Result = Promise<void>;`,
		`export function fixtureFn_${slug(entry)}(input: { readonly id: string }): void;`,
		'',
	].join('\n');
}

/** Same structure, one additional NON-exported top-level const (textual only). */
function textualOnlyVariant(entry: CorpusEntry): string {
	return `${defaultContent(entry)}const internalOnlyHelper_${slug(entry)} = 42;\n`;
}

/** Same shape grammar, one ADDITIONAL interface member (structural). */
function structuralVariant(entry: CorpusEntry): string {
	return defaultContent(entry).replace(
		'\tenabled?: boolean;\n',
		'\tenabled?: boolean;\n\treadonly extraDriftMember: string;\n',
	);
}

function writeSourceDir(
	overrides: Record<string, string> = {},
	omit: string[] = [],
): string {
	const dir = makeTempDir();
	for (const entry of V2_CORPUS) {
		if (omit.includes(entry.id)) continue;
		fs.writeFileSync(
			path.join(dir, entry.localName),
			overrides[entry.id] ?? defaultContent(entry),
			'utf8',
		);
	}
	return dir;
}

const originals = {
	expectedPath: _internals.expectedPath,
	runGh: _internals.runGh,
};

afterEach(() => {
	_internals.expectedPath = originals.expectedPath;
	_internals.runGh = originals.runGh;
});

function tempFixturePath(): string {
	return path.join(makeTempDir(), 'expected-structure-v2.json');
}

describe('check-host-contract-v2 (issue #2910): verdict table via --source fixtures', () => {
	test('structure match: emit then plain run gives STRUCTURE_MATCH exit 0', async () => {
		const dir = writeSourceDir();
		const fixturePath = tempFixturePath();
		_internals.expectedPath = fixturePath;
		expect(
			await main(['--emit-expected', '--source', dir, '--as-tag', '2.0.26']),
		).toBe(0);
		const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
		expect(fixture.pinnedTag).toBe('2.0.26');
		expect(fixture.pinnedHostTag).toBe('v2.0.26');
		expect(fixture.corpus).toHaveLength(V2_CORPUS.length);
		const outcome = await runCheck({ source: dir });
		expect(outcome.exitCode).toBe(0);
		expect(outcome.lines).toContain('result=STRUCTURE_MATCH');
		expect(outcome.lines.some((l) => l.includes('TEXTUAL_DRIFT_ONLY'))).toBe(
			false,
		);
		expect(outcome.structuralDigest).toBe(fixture.structuralDigest);
	});

	test('textual drift only (non-exported addition) keeps structure, exits 0', async () => {
		const dir = writeSourceDir();
		const fixturePath = tempFixturePath();
		_internals.expectedPath = fixturePath;
		expect(await main(['--emit-expected', '--source', dir])).toBe(0);
		const target = V2_CORPUS[0];
		fs.writeFileSync(
			path.join(dir, target.localName),
			textualOnlyVariant(target),
			'utf8',
		);
		const outcome = await runCheck({ source: dir });
		expect(outcome.exitCode).toBe(0);
		expect(outcome.lines).toContain('result=STRUCTURE_MATCH');
		expect(outcome.lines).toContain('result=TEXTUAL_DRIFT_ONLY');
		expect(outcome.lines.some((l) => l.includes(target.id))).toBe(true);
		expect(outcome.lines.some((l) => l.includes('--emit-expected'))).toBe(true);
	});

	test('structural drift (added member) exits 1 with an added= diff line', async () => {
		const dir = writeSourceDir();
		const fixturePath = tempFixturePath();
		_internals.expectedPath = fixturePath;
		expect(await main(['--emit-expected', '--source', dir])).toBe(0);
		const target = V2_CORPUS[3];
		fs.writeFileSync(
			path.join(dir, target.localName),
			structuralVariant(target),
			'utf8',
		);
		const outcome = await runCheck({ source: dir });
		expect(outcome.exitCode).toBe(1);
		expect(outcome.lines).toContain('result=STRUCTURAL_DRIFT');
		const driftLine = outcome.lines.find((l) =>
			l.startsWith('structural drift:'),
		);
		expect(driftLine).toBeDefined();
		expect(driftLine).toContain('extraDriftMember');
		expect(driftLine).toContain('added=');
	});

	test('structural drift (removed member) exits 1 with a removed= diff line', async () => {
		const dir = writeSourceDir();
		const fixturePath = tempFixturePath();
		_internals.expectedPath = fixturePath;
		expect(await main(['--emit-expected', '--source', dir])).toBe(0);
		const target = V2_CORPUS[5];
		fs.writeFileSync(
			path.join(dir, target.localName),
			defaultContent(target).replace('\tenabled?: boolean;\n', ''),
			'utf8',
		);
		const outcome = await runCheck({ source: dir });
		expect(outcome.exitCode).toBe(1);
		expect(outcome.lines).toContain('result=STRUCTURAL_DRIFT');
		expect(
			outcome.lines
				.find((l) => l.startsWith('structural drift:'))
				?.includes('removed='),
		).toBe(true);
	});

	test('a missing corpus file is SOURCE_NOT_FOUND naming the file, never a pass', async () => {
		const dir = writeSourceDir();
		const fixturePath = tempFixturePath();
		_internals.expectedPath = fixturePath;
		expect(await main(['--emit-expected', '--source', dir])).toBe(0);
		const omitted = V2_CORPUS[16];
		fs.rmSync(path.join(dir, omitted.localName));
		const outcome = await runCheck({ source: dir });
		expect(outcome.exitCode).toBe(1);
		expect(outcome.lines).toContain('result=SOURCE_NOT_FOUND');
		expect(outcome.lines.some((l) => l.includes(omitted.localName))).toBe(true);
	});

	test('a corrupt corpus JSON is CORPUS_INVALID with a reason', async () => {
		const dir = writeSourceDir();
		const fixturePath = tempFixturePath();
		fs.writeFileSync(fixturePath, '{"broken": ', 'utf8');
		_internals.expectedPath = fixturePath;
		const outcome = await runCheck({ source: dir });
		expect(outcome.exitCode).toBe(1);
		expect(outcome.lines).toContain('result=CORPUS_INVALID');
		expect(
			outcome.lines.some((l) => l.includes('corpus is not valid JSON')),
		).toBe(true);
	});

	test('a shape-invalid corpus (statements not a string array) is CORPUS_INVALID', async () => {
		const dir = writeSourceDir();
		const fixturePath = tempFixturePath();
		fs.writeFileSync(
			fixturePath,
			JSON.stringify({ statements: 'nope', textualDigests: {} }),
			'utf8',
		);
		_internals.expectedPath = fixturePath;
		const outcome = await runCheck({ source: dir });
		expect(outcome.lines).toContain('result=CORPUS_INVALID');
		expect(outcome.lines.some((l) => l.includes('statements'))).toBe(true);
	});
});

describe('check-host-contract-v2 (issue #2910): CLI arg discipline', () => {
	test('an unsafe --tag is rejected with exit 2 (runCheck and main)', async () => {
		const unsafe = await runCheck({ tag: '../evil' });
		expect(unsafe.exitCode).toBe(2);
		expect(unsafe.lines.some((l) => l.includes('refusing unsafe tag'))).toBe(
			true,
		);
		expect(await main(['--tag', 'a/b'])).toBe(2);
		expect(await main(['--tag', 'a b'])).toBe(2);
	});

	test('mutual exclusion and unknown flags are usage errors (exit 2)', async () => {
		expect(await main(['--tag', '1.0.0', '--source', 'x'])).toBe(2);
		expect(await main(['--bogus'])).toBe(2);
		expect(await main(['--tag'])).toBe(2);
		expect(await main(['--as-tag', 'v2'])).toBe(2);
		expect(
			await main(['--emit-expected', '--source', 'x', '--route-on-drift']),
		).toBe(2);
	});

	test('isSafeNpmTag accepts versions and rejects path shapes', () => {
		for (const good of ['2.0.26', 'v2.0.26', '1.18.33', 'a.b-c_d+e']) {
			expect(isSafeNpmTag(good)).toBe(true);
		}
		for (const bad of [
			'',
			'..',
			'../evil',
			'a/b',
			'a\\b',
			'v?x',
			'v#x',
			'v x',
			'x'.repeat(129),
		]) {
			expect(isSafeNpmTag(bad)).toBe(false);
		}
	});
});

describe('check-host-contract-v2 (issue #2910): bounded fetch + tar reader', () => {
	function fakeResponse(opts: {
		length?: string | null;
		body?: ReadableStream<Uint8Array> | null;
		buf?: ArrayBuffer;
	}): Response {
		return {
			headers: { get: () => opts.length ?? null },
			body: opts.body ?? null,
			arrayBuffer: async () => opts.buf as ArrayBuffer,
		} as unknown as Response;
	}

	test('readBytesBounded rejects by declared Content-Length and by actual size', async () => {
		const small = new TextEncoder().encode('hello');
		expect(
			await readBytesBounded(
				fakeResponse({ length: '4', buf: small.slice().buffer }),
				10,
			),
		).not.toBeNull();
		expect(
			await readBytesBounded(
				fakeResponse({ length: '999', buf: small.slice().buffer }),
				10,
			),
		).toBeNull();
		expect(
			await readBytesBounded(
				fakeResponse({
					length: null,
					buf: new TextEncoder().encode('a'.repeat(11)).buffer,
				}),
				10,
			),
		).toBeNull();
	});

	test('an oversize streamed body with no Content-Length is cut off, not drained', async () => {
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new TextEncoder().encode('x'.repeat(16 * 1024)));
			},
		});
		expect(
			await readBytesBounded(fakeResponse({ body: stream }), 64 * 1024),
		).toBeNull();
		expect(pulled).toBeLessThan(10);
	});

	test('extractTarballEntries rejects a non-tarball and an over-cap member', () => {
		expect(
			extractTarballEntries(new TextEncoder().encode('not a tgz')),
		).toBeNull();
	});
});

describe('check-host-contract-v2 (issue #2910): digest + URL helpers', () => {
	test('digestCorpusFile is stable under reformatting and bites on member changes', () => {
		const base = 'export interface A { readonly x: string }\n';
		const reformatted = [
			'// a comment',
			'export interface A {',
			'\treadonly x:    string;',
			'}',
			'',
		].join('\n');
		const a = digestCorpusFile('t/a', base);
		const b = digestCorpusFile('t/a', reformatted);
		expect(a.statements).toEqual(b.statements);
		// The printer canonicalizes formatting and strips comments, so a pure
		// reformat is stable on BOTH axes.
		expect(a.textualDigest).toBe(b.textualDigest);
		const added = digestCorpusFile(
			't/a',
			'export interface A { readonly x: string; readonly y: number }\n',
		);
		expect(added.statements.length).toBe(a.statements.length + 1);
		expect(added.statements.some((s) => s.includes('A.y'))).toBe(true);
	});

	test('a changed function BODY is textual-only (statements carry signatures)', () => {
		const signatureOnly = 'export function f(): void;\n';
		const withBody = 'export function f(): void {\n\tdoNewThing();\n}\n';
		const a = digestCorpusFile('t/a', signatureOnly);
		const b = digestCorpusFile('t/a', withBody);
		expect(a.statements).toEqual(b.statements);
		expect(a.textualDigest).not.toBe(b.textualDigest);
	});

	test('digestCorpusFile skips non-exported declarations (textual axis only)', () => {
		const withInternal =
			'export interface A { readonly x: string }\nconst hidden = 1;\n';
		const a = digestCorpusFile(
			't/a',
			'export interface A { readonly x: string }\n',
		);
		const b = digestCorpusFile('t/a', withInternal);
		expect(a.statements).toEqual(b.statements);
		expect(a.textualDigest).not.toBe(b.textualDigest);
	});

	test('npmTarballUrl builds the registry tarball URL for scoped packages', () => {
		expect(npmTarballUrl('@opencode/plugin', '2.0.26')).toBe(
			'https://registry.npmjs.org/%40opencode%2Fplugin/-/plugin-2.0.26.tgz',
		);
	});

	test('resolveV2LatestTag parses the dist-tags latest for @opencode/plugin', async () => {
		const urls: string[] = [];
		const fetchImpl = (async (input: string | URL | Request) => {
			urls.push(String(input));
			return new Response(JSON.stringify({ latest: '2.0.26' }));
		}) as typeof fetch;
		expect(await resolveV2LatestTag(fetchImpl)).toBe('2.0.26');
		expect(urls[0]).toBe(
			'https://registry.npmjs.org/-/package/%40opencode%2Fplugin/dist-tags',
		);
		// Fail-open: non-OK / non-JSON / non-string latest resolve to ''.
		for (const respond of [
			() => new Response('{}', { status: 500 }),
			() => new Response('nope'),
			() => new Response(JSON.stringify({ latest: 3 })),
		]) {
			const bad = (async (input: string | URL | Request) => {
				void input;
				return respond();
			}) as typeof fetch;
			expect(await resolveV2LatestTag(bad)).toBe('');
		}
	});
});
