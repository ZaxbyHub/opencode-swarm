#!/usr/bin/env bun
/**
 * Issue #2910 (W1.3) — v2 host-contract drift check.
 *
 * `src/host/v2/types.ts` vendors the OpenCode 2 plugin API types behind a
 * provenance pin (`@opencode/plugin@2.0.26`) instead of installing the package.
 * Before this check existed, nothing watched the REAL published surface: a
 * `@opencode/plugin` release that renamed a domain member, moved a host file,
 * or changed the v1→v2 permission migration table would land silently and only
 * surface as runtime feature-detection misses.
 *
 * Dual-axis digest over TWO corpora (mirroring the v1 leg,
 * `scripts/check-host-contract.ts`, issue #2902):
 *   - structural axis (pass/fail): for every corpus file, the exported
 *     declaration/member signatures are reduced to a canonical statement list
 *     (per-file prefixed); sha256 over the newline-joined list must match the
 *     committed corpus (`tests/fixtures/host/expected-structure-v2.json`).
 *   - textual axis (advisory): a sha256 of the printer-normalized file text;
 *     formatting-only drift reports TEXTUAL_DRIFT_ONLY (exit 0).
 *
 * Corpus A (npm): the `@opencode/plugin` tarball's promise d.ts domains named
 * by the types.ts provenance — `dist/promise/{plugin,registration,tool,session,
 * worktree,command,agent,event,storage,permission}.d.ts` plus `dist/app.d.ts`
 * and `dist/options.d.ts` (those two live at the dist root at 2.0.26) — PLUS
 * `@opencode/schema`'s `dist/agent.d.ts` (Agent.Info permission/default
 * shapes) and `@opencode/client`'s `dist/promise/generated/client.d.ts` (the
 * permission-bearing API surface: request/create/list/get/reply), with the
 * schema/client versions resolved from @opencode/plugin's own package.json
 * dependencies inside the tarball.
 *
 * Corpus B (host source): `packages/core/src/session/model-request.ts`,
 * `packages/core/src/session/context.ts`, and
 * `packages/core/src/v1/config/migrate.ts` (the W2 permission-migration
 * dependency) from raw.githubusercontent.com/sst/opencode at `v<npm-version>`.
 *
 * Output tokens:
 *   `host-contract-v2: tag=<tag>` | `host-contract-v2: source=<path>`  (first)
 *   `host-contract-v2: structural-digest=<sha256-hex>`                 (always, post-extraction)
 *   `result=STRUCTURE_MATCH`      exit 0 — statements match
 *   `result=TEXTUAL_DRIFT_ONLY`   exit 0 — structure intact, normalized text differs
 *   `result=STRUCTURAL_DRIFT`     exit 1 — preceded by one
 *                                 `structural drift: added=[...] removed=[...]`
 *                                 line and a bounded unified diff
 *   `result=SOURCE_NOT_FOUND`     exit 1 — a corpus file was unfetchable /
 *                                 absent from its tarball (a moved or renamed
 *                                 host file is a FAILURE, never a pass)
 *   `result=CORPUS_INVALID`       exit 1 — the pinned corpus JSON failed to
 *                                 parse or shape-check (fail loudly with a reason)
 *
 * Exit codes: 0 structure intact (with or without textual drift), 1 structural
 * drift / source not found / corpus invalid / unsafe tag, 2 usage error.
 *
 * Tarball handling: node:zlib gunzip + a minimal in-memory tar reader (no
 * subprocess, fully portable — npm tarballs are plain ustar/gnu with short
 * names; GNU longname 'L' and pax 'x' path overrides are handled). Network
 * access is `fetch` + `AbortController` with bounded reads, mirroring the v1
 * leg and `scripts/lib/read-bounded.ts`. The only subprocess is `gh` for
 * optional tracking-issue routing, array-form `spawnSync` with explicit cwd,
 * `stdin: 'ignore'`, a timeout, and a bounded output buffer (invariant 3).
 *
 * Usage:
 *   bun scripts/check-host-contract-v2.ts                     # npm-latest tag, live fetch
 *   bun scripts/check-host-contract-v2.ts --tag 2.0.26        # explicit npm version
 *   bun scripts/check-host-contract-v2.ts --source <dir>      # offline corpus dir (fixture files)
 *   ... --route-on-drift [--dry-run]                          # tracking-issue routing
 *   bun scripts/check-host-contract-v2.ts --emit-expected [--tag 2.0.26 | --source <dir>] [--as-tag <tag>]
 *                                                            # regenerate the corpus fixture
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { readBounded } from './lib/read-bounded';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_REPO = 'ZaxbyHub/opencode-swarm'; // routing target (this repo)
const HOST_SOURCE_REPO = 'sst/opencode'; // the OpenCode 2 host monorepo
const EXPECTED_PATH = path.join(
	REPO_ROOT,
	'tests/fixtures/host/expected-structure-v2.json',
);
const TRACKING_TITLE_PREFIX = 'Host contract drift (v2): @opencode/plugin corpus';
const FETCH_TIMEOUT_MS = 20_000;
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 1_000_000;
const REPORT_DIFF_LIMIT = 40;
/** Per-declaration hash prefix length (64 bits — collisions are not a concern
 *  at corpus scale, and statements stay readable in drift diffs). */
const DECL_HASH_LEN = 16;

export const MAX_TARBALL_BYTES = 10_000_000;
export const MAX_SOURCE_BYTES = 10_000_000;
/** Max accepted bytes for a single file extracted out of a tarball. */
export const MAX_TARBALL_MEMBER_BYTES = 4_000_000;
export const MAX_TARBALL_TOTAL_BYTES = 40_000_000;
const NPM_DIST_TAGS_MAX_BYTES = 64 * 1024;

/** The dist-tags endpoint for the v2 host package (URL-encoded scoped name). */
export const V2_PLUGIN_DIST_TAGS_URL =
	'https://registry.npmjs.org/-/package/%40opencode%2Fplugin/dist-tags';

const RAW_SOURCE = (tag: string, filePath: string) =>
	`https://raw.githubusercontent.com/${HOST_SOURCE_REPO}/${tag}/${filePath}`;

/** npm tarball URL for a scoped package and exact version. */
export function npmTarballUrl(pkg: string, version: string): string {
	const basename = pkg.startsWith('@') ? pkg.slice(pkg.indexOf('/') + 1) : pkg;
	return `https://registry.npmjs.org/${encodeURIComponent(pkg)}/-/${basename}-${version}.tgz`;
}

// ---------------------------------------------------------------------------
// Corpus definition (the load-bearing files; documented once, used everywhere)
// ---------------------------------------------------------------------------

export type CorpusOrigin = '@opencode/plugin' | '@opencode/schema' | '@opencode/client' | 'host-source';

export interface CorpusEntry {
	/** Stable statement prefix + fixture key. */
	id: string;
	origin: CorpusOrigin;
	/** Path inside the origin tarball ('package/'-stripped), or the host repo path. */
	path: string;
	/** File name inside a `--source` fixture directory (offline mode). */
	localName: string;
}

/**
 * The corpus list. Sizes verified against the real 2.0.26 tarballs:
 * app/options live at `dist/` root (NOT dist/promise/); permission.d.ts IS
 * under dist/promise/; the client permission API surface is the Effect
 * generated client (permission request/create/list/get/reply members).
 */
export const V2_CORPUS: readonly CorpusEntry[] = [
	// — Corpus A1: @opencode/plugin promise domains (types.ts provenance) —
	{ id: 'plugin/promise-plugin', origin: '@opencode/plugin', path: 'dist/promise/plugin.d.ts', localName: 'plugin-promise.d.ts' },
	{ id: 'plugin/promise-registration', origin: '@opencode/plugin', path: 'dist/promise/registration.d.ts', localName: 'plugin-registration.d.ts' },
	{ id: 'plugin/promise-tool', origin: '@opencode/plugin', path: 'dist/promise/tool.d.ts', localName: 'plugin-tool.d.ts' },
	{ id: 'plugin/promise-session', origin: '@opencode/plugin', path: 'dist/promise/session.d.ts', localName: 'plugin-session.d.ts' },
	{ id: 'plugin/promise-worktree', origin: '@opencode/plugin', path: 'dist/promise/worktree.d.ts', localName: 'plugin-worktree.d.ts' },
	{ id: 'plugin/promise-command', origin: '@opencode/plugin', path: 'dist/promise/command.d.ts', localName: 'plugin-command.d.ts' },
	{ id: 'plugin/promise-agent', origin: '@opencode/plugin', path: 'dist/promise/agent.d.ts', localName: 'plugin-agent.d.ts' },
	{ id: 'plugin/promise-event', origin: '@opencode/plugin', path: 'dist/promise/event.d.ts', localName: 'plugin-event.d.ts' },
	{ id: 'plugin/promise-storage', origin: '@opencode/plugin', path: 'dist/promise/storage.d.ts', localName: 'plugin-storage.d.ts' },
	{ id: 'plugin/promise-permission', origin: '@opencode/plugin', path: 'dist/promise/permission.d.ts', localName: 'plugin-permission.d.ts' },
	{ id: 'plugin/app', origin: '@opencode/plugin', path: 'dist/app.d.ts', localName: 'plugin-app.d.ts' },
	{ id: 'plugin/options', origin: '@opencode/plugin', path: 'dist/options.d.ts', localName: 'plugin-options.d.ts' },
	// — Corpus A2/A3: schema Agent.Info + client permission API (types.ts:4-8 names these) —
	{ id: 'schema/agent', origin: '@opencode/schema', path: 'dist/agent.d.ts', localName: 'schema-agent.d.ts' },
	{ id: 'client/generated-client', origin: '@opencode/client', path: 'dist/promise/generated/client.d.ts', localName: 'client-generated.d.ts' },
	// — Corpus B: host source (W2 permission migration dependency + session context/model request) —
	{ id: 'host/model-request', origin: 'host-source', path: 'packages/core/src/session/model-request.ts', localName: 'host-model-request.ts' },
	{ id: 'host/context', origin: 'host-source', path: 'packages/core/src/session/context.ts', localName: 'host-context.ts' },
	{ id: 'host/migrate', origin: 'host-source', path: 'packages/core/src/v1/config/migrate.ts', localName: 'host-migrate.ts' },
];

// ---------------------------------------------------------------------------
// Tag safety + bounded fetch (v1-leg idioms)
// ---------------------------------------------------------------------------

/**
 * A tag is interpolated into URL paths, so it must be a single conservative
 * path segment: alphanumeric start, then letters, digits and `. + _ -`.
 * Rejects `..`, `/`, `\`, `?`, `#`, whitespace and empty input.
 */
const SAFE_TAG = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
export function isSafeNpmTag(tag: unknown): tag is string {
	return typeof tag === 'string' && tag.length <= 128 && SAFE_TAG.test(tag) && !tag.includes('..');
}

/** Read a response body as BINARY with a hard byte cap (read-bounded discipline). */
export async function readBytesBounded(
	res: Response,
	capBytes: number,
): Promise<Uint8Array | null> {
	try {
		const declared = Number(res.headers.get('content-length') ?? '0');
		if (Number.isFinite(declared) && declared > capBytes) return null;
		if (!res.body) {
			const buf = new Uint8Array(await res.arrayBuffer());
			return buf.byteLength > capBytes ? null : buf;
		}
		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > capBytes) {
					await reader.cancel().catch(() => undefined);
					return null;
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	} catch {
		return null;
	}
}

async function fetchBytes(
	url: string,
	capBytes: number,
	fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, { signal: controller.signal });
		if (!res.ok) return null;
		return await readBytesBounded(res, capBytes);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchText(
	url: string,
	capBytes: number,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, { signal: controller.signal });
		if (!res.ok) return null;
		return await readBounded(res, capBytes);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolve npm `latest` for @opencode/plugin; '' on any failure (an empty tag
 * becomes `result=SOURCE_NOT_FOUND`); a one-line reason goes to stderr.
 */
export async function resolveV2LatestTag(
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const fail = (reason: string): string => {
		console.error(`host-contract-v2: npm latest-tag unresolved: ${reason}`);
		return '';
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetchImpl(V2_PLUGIN_DIST_TAGS_URL, { signal: controller.signal });
		if (!res.ok) return fail(`HTTP ${res.status}`);
		const body = await readBounded(res, NPM_DIST_TAGS_MAX_BYTES);
		if (body === null) return fail('response unreadable or over cap');
		let tags: { latest?: unknown };
		try {
			tags = JSON.parse(body) as { latest?: unknown };
		} catch {
			return fail('response is not valid JSON');
		}
		if (typeof tags?.latest !== 'string' || tags.latest === '') {
			return fail('no string `latest` dist-tag');
		}
		if (!isSafeNpmTag(tags.latest)) return fail('`latest` is not a safe version tag');
		return tags.latest;
	} catch (error) {
		return fail(
			controller.signal.aborted
				? `timed out after ${FETCH_TIMEOUT_MS}ms`
				: `request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Minimal tar reader (node:zlib; no subprocess)
// ---------------------------------------------------------------------------

/** NUL-terminated string from a tar header field. */
function headerCStr(block: Uint8Array, offset: number, length: number): string {
	let end = offset;
	const max = Math.min(offset + length, block.byteLength);
	while (end < max && block[end] !== 0) end++;
	// Tar header name fields are ASCII; latin1 preserves the raw bytes.
	return String.fromCharCode(...block.subarray(offset, end));
}

/** Extract a pax `path=` record value, or null when the header has none. */
function paxPath(data: Uint8Array): string | null {
	const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
	for (const line of text.split('\n')) {
		const space = line.indexOf(' ');
		if (space <= 0) continue;
		const record = line.slice(space + 1);
		const eq = record.indexOf('=');
		if (eq > 0 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
	}
	return null;
}

/**
 * Parse a gunzipped tarball into a name -> bytes map, or null when the archive
 * is truncated, a member exceeds `maxFileBytes`, or a header is malformed.
 * Handles ustar prefixes, GNU 'L' long names, and pax 'x' path overrides.
 */
export function parseTar(
	plain: Uint8Array,
	maxFileBytes: number,
): Map<string, Uint8Array> | null {
	const files = new Map<string, Uint8Array>();
	const BLOCK = 512;
	let offset = 0;
	let pendingLongName: string | null = null;
	let pendingPaxPath: string | null = null;
	while (offset + BLOCK <= plain.byteLength) {
		const block = plain.subarray(offset, offset + BLOCK);
		if (block.every((byte) => byte === 0)) break; // end-of-archive marker
		const name = headerCStr(block, 0, 100);
		const sizeField = headerCStr(block, 124, 12).trim();
		const size = Number.parseInt(sizeField, 8);
		if (!Number.isFinite(size) || size < 0) return null;
		const type = String.fromCharCode(block[156] ?? 0);
		const prefix = headerCStr(block, 345, 155);
		const dataStart = offset + BLOCK;
		const dataEnd = dataStart + size;
		if (dataEnd > plain.byteLength) return null; // truncated member
		const data = plain.subarray(dataStart, dataEnd);
		const next = dataStart + Math.ceil(size / BLOCK) * BLOCK;
		if (type === 'L') {
			pendingLongName = new TextDecoder('utf-8', { fatal: false }).decode(data).replace(/\0+$/, '');
		} else if (type === 'x' || type === 'X') {
			const override = paxPath(data);
			if (override !== null) pendingPaxPath = override;
		} else if (type === '0' || type === '\0' || type === '7') {
			if (size > maxFileBytes) return null;
			let entryName = pendingLongName ?? pendingPaxPath ?? name;
			if (pendingLongName === null && pendingPaxPath === null && prefix !== '') {
				entryName = `${prefix}/${name}`;
			}
			files.set(entryName.replace(/^\.\//, ''), data.slice());
			pendingLongName = null;
			pendingPaxPath = null;
		}
		offset = next;
	}
	return files;
}

/**
 * Gunzip + parse a tarball, bounded on both the compressed and plain sizes.
 * FAIL-CLOSED (review PRR-032, swarm-pr-review pr3444-20261025): every
 * gunzip failure — including the maxOutputLength
 * capacity abort (ERR_BUFFER_TOO_LARGE / "Too large") — REJECTS the corpus
 * (null → SOURCE_NOT_FOUND). The former unbounded-retry fallback ("some
 * runtimes ignore maxOutputLength; retry unbounded gunzip and bound-check
 * the result") is itself the unbounded-decompression hazard: a
 * decompression-bomb tarball under the COMPRESSED cap could exhaust memory
 * before the post-hoc bound check ran, and no bounded gunzip variant exists
 * for a runtime that ignores maxOutputLength — so there is no legitimate
 * non-capacity fallback to keep either (corrupt data fails the bounded call
 * the same way).
 */
export function extractTarballEntries(
	tgz: Uint8Array,
): Map<string, Uint8Array> | null {
	let plain: Uint8Array;
	try {
		plain = new Uint8Array(zlib.gunzipSync(tgz, { maxOutputLength: MAX_TARBALL_TOTAL_BYTES }));
	} catch {
		return null;
	}
	return parseTar(plain, MAX_TARBALL_MEMBER_BYTES);
}

/** Look a file up inside a parsed tarball, tolerating the `package/` prefix. */
function tarGet(files: Map<string, Uint8Array>, memberPath: string): Uint8Array | null {
	return files.get(`package/${memberPath}`) ?? files.get(memberPath) ?? null;
}

// ---------------------------------------------------------------------------
// Structural digest (TS-AST)
// ---------------------------------------------------------------------------

export interface FileDigest {
	id: string;
	/** Canonical statement list, each already prefixed with the file id. */
	statements: string[];
	/** sha256 hex of the printer-normalized file text (textual axis). */
	textualDigest: string;
}

export interface ExpectedStructureV2 {
	pinnedTag: string;
	pinnedHostTag: string;
	schemaVersion: string;
	clientVersion: string;
	corpus: Array<{ id: string; origin: string; path: string }>;
	statements: string[];
	structuralDigest: string;
	textualDigests: Record<string, string>;
}

export interface CorpusDigest {
	statements: string[];
	structuralDigest: string;
	textualDigests: Record<string, string>;
}

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

function nodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
	return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
}

function declHash(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, DECL_HASH_LEN);
}

function isExported(node: ts.Node): boolean {
	const modifiers = (node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
	return (
		modifiers?.some(
			(m) => m.kind === ts.SyntaxKind.ExportKeyword,
		) === true
	);
}

function memberName(name: ts.PropertyName | ts.BindingPattern): string {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}
	return '[computed]';
}

function heritageText(nodes: readonly ts.HeritageClause[] | undefined, sourceFile: ts.SourceFile): string {
	if (!nodes || nodes.length === 0) return '';
	return nodes.map((clause) => clause.types.map((t) => nodeText(t, sourceFile)).join(', ')).join(', ');
}

function typeParamsText(nodes: readonly ts.TypeParameterDeclaration[] | undefined, sourceFile: ts.SourceFile): string {
	if (!nodes || nodes.length === 0) return '';
	return `<${nodes.map((p) => nodeText(p, sourceFile)).join(', ')}>`;
}

function interfaceMembers(prefix: string, members: readonly ts.TypeElement[], sourceFile: ts.SourceFile): string[] {
	const statements: string[] = [];
	for (const member of members) {
		const readonly = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) === true;
		if (ts.isPropertySignature(member) || ts.isMethodSignature(member)) {
			const optional = member.questionToken !== undefined;
			const typeText = member.type ? nodeText(member.type, sourceFile) : '';
			const text = ts.isMethodSignature(member)
				? `${readonly}|${optional}|${nodeText(member, sourceFile)}`
				: `${readonly}|${optional}|${typeText}`;
			statements.push(`${prefix}.${memberName(member.name)} : ${declHash(text)}`);
			continue;
		}
		if (ts.isIndexSignatureDeclaration(member)) {
			statements.push(`${prefix}.[index] : ${declHash(nodeText(member, sourceFile))}`);
			continue;
		}
		// CallSignature / ConstructSignature / accessors in ambient positions.
		statements.push(
			`${prefix}.<${ts.SyntaxKind[member.kind]}> : ${declHash(nodeText(member, sourceFile))}`,
		);
	}
	return statements;
}

function classMembers(prefix: string, members: readonly ts.ClassElement[], sourceFile: ts.SourceFile): string[] {
	const statements: string[] = [];
	for (const member of members) {
		if (
			ts.isPropertyDeclaration(member) ||
			ts.isMethodDeclaration(member) ||
			ts.isGetAccessorDeclaration(member) ||
			ts.isSetAccessorDeclaration(member)
		) {
			const name = memberName(member.name);
			const readonly = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) === true;
			const optional = member.questionToken !== undefined;
			const typeText = member.type ? nodeText(member.type, sourceFile) : '';
			statements.push(`${prefix}.${name} : ${declHash(`${readonly}|${optional}|${typeText}`)}`);
			continue;
		}
		statements.push(
			`${prefix}.<${ts.SyntaxKind[member.kind]}> : ${declHash(nodeText(member, sourceFile))}`,
		);
	}
	return statements;
}

/**
 * Reduce one corpus file to its canonical statement list (id-prefixed) and
 * textual digest. Exported top-level declarations only, in source order —
 * the spec axis is "exported interface/type member signatures"; internal
 * rewrites ride the textual axis.
 */
export function digestCorpusFile(id: string, text: string): FileDigest {
	const fileName = id.includes('/') ? `${id.replace('/', '-')}.d.ts` : `${id}.d.ts`;
	const sourceFile = ts.createSourceFile(
		fileName,
		text,
		ts.ScriptTarget.Latest,
		true,
		id.endsWith('.ts') && !id.endsWith('.d.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TS,
	);
	const statements: string[] = [];
	for (const statement of sourceFile.statements) {
		if (ts.isInterfaceDeclaration(statement) && isExported(statement)) {
			const name = statement.name.text;
			statements.push(`${id} export-interface ${name}`);
			const head = `${typeParamsText(statement.typeParameters, sourceFile)}|${heritageText(statement.heritageClauses, sourceFile)}`;
			statements.push(`${id} export-interface ${name}#head : ${declHash(head)}`);
			statements.push(
				...interfaceMembers(`${id} export-interface ${name}`, statement.members, sourceFile),
			);
			continue;
		}
		if (ts.isTypeAliasDeclaration(statement) && isExported(statement)) {
			statements.push(
				`${id} export-type ${statement.name.text} : ${declHash(nodeText(statement, sourceFile))}`,
			);
			continue;
		}
		if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
			const parts: string[] = [typeParamsText(statement.typeParameters, sourceFile)];
			parts.push(
				`(${statement.parameters.map((p) => nodeText(p, sourceFile)).join(', ')})`,
			);
			if (statement.type) parts.push(nodeText(statement.type, sourceFile));
			const name = statement.name?.text ?? '<anonymous>';
			statements.push(`${id} export-function ${name} : ${declHash(parts.join(' '))}`);
			continue;
		}
		if (ts.isVariableStatement(statement) && isExported(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name)) continue;
				const kind = statement.declarationList.flags & ts.NodeFlags.Let ? 'let' : statement.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'var';
				statements.push(
					`${id} export-${kind} ${declaration.name.text} : ${declHash(nodeText(declaration, sourceFile))}`,
				);
			}
			continue;
		}
		if (ts.isClassDeclaration(statement) && statement.name && isExported(statement)) {
			const name = statement.name.text;
			statements.push(`${id} export-class ${name}`);
			const head = `${typeParamsText(statement.typeParameters, sourceFile)}|${heritageText(statement.heritageClauses, sourceFile)}`;
			statements.push(`${id} export-class ${name}#head : ${declHash(head)}`);
			statements.push(...classMembers(`${id} export-class ${name}`, statement.members, sourceFile));
			continue;
		}
		if (ts.isEnumDeclaration(statement) && isExported(statement)) {
			statements.push(
				`${id} export-enum ${statement.name.text} : ${declHash(nodeText(statement, sourceFile))}`,
			);
			continue;
		}
		if (ts.isModuleDeclaration(statement) && isExported(statement) && statement.name) {
			const name = ts.isIdentifier(statement.name) ? statement.name.text : '[string]';
			statements.push(
				`${id} export-namespace ${name} : ${declHash(nodeText(statement, sourceFile))}`,
			);
			continue;
		}
		if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
			statements.push(
				`${id} export-from : ${declHash(nodeText(statement, sourceFile))}`,
			);
			continue;
		}
	}
	const normalized = printer.printFile(sourceFile);
	return {
		id,
		statements,
		textualDigest: createHash('sha256').update(normalized).digest('hex'),
	};
}

function digestCorpusFiles(files: Map<string, string>): CorpusDigest {
	const statements: string[] = [];
	const textualDigests: Record<string, string> = {};
	for (const entry of V2_CORPUS) {
		const text = files.get(entry.id);
		if (text === undefined) continue;
		const digest = digestCorpusFile(entry.id, text);
		statements.push(...digest.statements);
		textualDigests[entry.id] = digest.textualDigest;
	}
	return {
		statements,
		structuralDigest: createHash('sha256').update(statements.join('\n')).digest('hex'),
		textualDigests,
	};
}

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

export interface CorpusLoadResult {
	/** id -> file text for every corpus entry that resolved. */
	files: Map<string, string>;
	/** Human-readable failures for entries that did not resolve. */
	failures: string[];
	schemaVersion?: string;
	clientVersion?: string;
	hostTag?: string;
}

async function defaultFetchTarball(pkg: string, version: string): Promise<Uint8Array | null> {
	return fetchBytes(npmTarballUrl(pkg, version), MAX_TARBALL_BYTES);
}

async function defaultFetchHostSource(hostTag: string, filePath: string): Promise<string | null> {
	return fetchText(RAW_SOURCE(hostTag, filePath), MAX_SOURCE_BYTES);
}

/** DI seam per AGENTS.md invariant 7 (preferred over `mock.module`). */
export const _internals = {
	resolveLatestTag: (): Promise<string> => resolveV2LatestTag(),
	fetchTarball: defaultFetchTarball,
	fetchHostSource: defaultFetchHostSource,
	runGh: defaultRunGh,
	/** Corpus fixture location, injectable so tests never touch the committed file. */
	expectedPath: EXPECTED_PATH,
};

type GhResult = { ok: boolean; stdout: string; error?: string };

function defaultRunGh(args: string[]): GhResult {
	const proc = spawnSync('gh', args, {
		cwd: REPO_ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: GH_TIMEOUT_MS,
		maxBuffer: GH_MAX_BUFFER,
		encoding: 'utf8',
	});
	if (proc.error) return { ok: false, stdout: '', error: String(proc.error) };
	if (proc.status !== 0) return { ok: false, stdout: proc.stdout ?? '', error: `gh exited ${proc.status}` };
	return { ok: true, stdout: proc.stdout ?? '' };
}

async function loadNpmCorpus(tag: string): Promise<CorpusLoadResult> {
	const result: CorpusLoadResult = { files: new Map(), failures: [] };
	const hostTag = tag.startsWith('v') ? tag : `v${tag}`;
	result.hostTag = hostTag;

	const pluginTar = await _internals.fetchTarball('@opencode/plugin', tag);
	if (pluginTar === null) {
		result.failures.push(`@opencode/plugin tarball at ${tag} (registry.npmjs.org)`);
		return result;
	}
	const pluginFiles = extractTarballEntries(pluginTar);
	if (pluginFiles === null) {
		result.failures.push(`@opencode/plugin tarball at ${tag} (gunzip/parse failed or over cap)`);
		return result;
	}
	const decoder = new TextDecoder('utf-8', { fatal: false });

	// Resolve the schema/client corpus versions from the plugin's OWN
	// dependencies inside the tarball (they move in lockstep with the host).
	let schemaVersion = '';
	let clientVersion = '';
	const pluginPkgRaw = tarGet(pluginFiles, 'package.json');
	if (pluginPkgRaw !== null) {
		try {
			const deps = (JSON.parse(decoder.decode(pluginPkgRaw)) as {
				dependencies?: Record<string, string>;
			}).dependencies;
			schemaVersion = deps?.['@opencode/schema'] ?? '';
			clientVersion = deps?.['@opencode/client'] ?? '';
		} catch {
			// fall through: named as failures below
		}
	}
	if (schemaVersion === '' || clientVersion === '') {
		result.failures.push(
			`@opencode/plugin@${tag} package.json dependencies (schema=${schemaVersion || 'unresolved'}, client=${clientVersion || 'unresolved'})`,
		);
		return result;
	}
	result.schemaVersion = schemaVersion;
	result.clientVersion = clientVersion;

	const tarballs = new Map<string, Map<string, Uint8Array>>([
		['@opencode/plugin', pluginFiles],
	]);
	for (const [pkg, version] of [
		['@opencode/schema', schemaVersion],
		['@opencode/client', clientVersion],
	] as const) {
		const tar = await _internals.fetchTarball(pkg, version);
		const files = tar === null ? null : extractTarballEntries(tar);
		if (files === null) {
			result.failures.push(`${pkg}@${version} tarball (registry.npmjs.org)`);
			continue;
		}
		tarballs.set(pkg, files);
	}

	for (const entry of V2_CORPUS) {
		if (entry.origin === 'host-source') continue;
		const files = tarballs.get(entry.origin);
		if (files === undefined) continue; // already recorded as a tarball failure
		const bytes = tarGet(files, entry.path);
		if (bytes === null) {
			result.failures.push(`${entry.origin} ${entry.path} (absent from tarball)`);
			continue;
		}
		result.files.set(entry.id, decoder.decode(bytes));
	}

	for (const entry of V2_CORPUS) {
		if (entry.origin !== 'host-source') continue;
		const text = await _internals.fetchHostSource(hostTag, entry.path);
		if (text === null) {
			result.failures.push(`${HOST_SOURCE_REPO}@${hostTag} ${entry.path} (moved, renamed, or network failure)`);
			continue;
		}
		result.files.set(entry.id, text);
	}
	return result;
}

function loadSourceCorpus(sourceDir: string): CorpusLoadResult {
	const result: CorpusLoadResult = { files: new Map(), failures: [] };
	const abs = path.resolve(REPO_ROOT, sourceDir);
	for (const entry of V2_CORPUS) {
		const full = path.join(abs, entry.localName);
		try {
			result.files.set(entry.id, fs.readFileSync(full, 'utf8'));
		} catch {
			result.failures.push(`${entry.localName} (missing from --source directory ${sourceDir})`);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Expected-corpus loading + comparison (v1 ergonomics)
// ---------------------------------------------------------------------------

function loadExpectedChecked(): ExpectedStructureV2 {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(_internals.expectedPath, 'utf8'));
	} catch (error) {
		throw new Error(`corpus is not valid JSON: ${String(error)}`);
	}
	const corpus = parsed as Partial<ExpectedStructureV2>;
	if (!Array.isArray(corpus.statements) || corpus.statements.some((s) => typeof s !== 'string')) {
		throw new Error('corpus field statements is missing or not a string array');
	}
	if (typeof corpus.structuralDigest !== 'string') {
		throw new Error('corpus field structuralDigest is missing or not a string');
	}
	if (
		corpus.textualDigests === null ||
		typeof corpus.textualDigests !== 'object' ||
		Array.isArray(corpus.textualDigests) ||
		Object.values(corpus.textualDigests).some((v) => typeof v !== 'string')
	) {
		throw new Error('corpus field textualDigests is missing or not a string record');
	}
	if (typeof corpus.pinnedTag !== 'string' || typeof corpus.pinnedHostTag !== 'string') {
		throw new Error('corpus fields pinnedTag/pinnedHostTag are missing or not strings');
	}
	return corpus as ExpectedStructureV2;
}

function unifiedDiff(expected: string[], actual: string[]): string[] {
	const lines: string[] = ['--- expected statements', '+++ actual statements'];
	const max = Math.max(expected.length, actual.length);
	for (let i = 0; i < max; i++) {
		const e = expected[i];
		const a = actual[i];
		if (e === a) continue;
		if (e !== undefined) lines.push(`-${e}`);
		if (a !== undefined) lines.push(`+${a}`);
	}
	return lines;
}

function summarizeList(items: string[]): string {
	const capped = items.slice(0, REPORT_DIFF_LIMIT);
	const suffix =
		items.length > REPORT_DIFF_LIMIT ? `, …(+${items.length - REPORT_DIFF_LIMIT} more)` : '';
	return `${capped.join(', ')}${suffix}`;
}

interface TextualDriftFile {
	id: string;
	expected: string;
	actual: string;
}

function textualDriftFiles(expected: Record<string, string>, actual: Record<string, string>): TextualDriftFile[] {
	const drifted: TextualDriftFile[] = [];
	for (const id of Object.keys(actual)) {
		if (expected[id] !== actual[id]) {
			drifted.push({ id, expected: expected[id] ?? '(absent)', actual: actual[id] });
		}
	}
	return drifted;
}

// ---------------------------------------------------------------------------
// Routing (v1 contract: dedup onto a bot-owned tracking issue)
// ---------------------------------------------------------------------------

function driftReport(tag: string, digest: string, added: string[], removed: string[], diff: string[]): string {
	return [
		`Host contract drift (v2): @opencode/plugin corpus @ ${tag}`,
		'',
		'The vendored v2 plugin types (src/host/v2/types.ts) no longer match the',
		'structural shape of the published @opencode/plugin + host-source corpus',
		'(issue #2910). Re-verify the adapter surfaces, then regenerate the corpus with:',
		'  bun scripts/check-host-contract-v2.ts --emit-expected --tag <version>',
		'',
		`structural-digest=${digest}`,
		`structural drift: added=[${added.join(', ')}] removed=[${removed.join(', ')}]`,
		'',
		...diff.slice(0, REPORT_DIFF_LIMIT),
	]
		.join('\n')
		.slice(0, 6000);
}

interface RouteOptions {
	tag: string;
	digest: string;
	added: string[];
	removed: string[];
	diff: string[];
	dryRun: boolean;
}

function routeDrift(options: RouteOptions): string[] {
	const actions: string[] = [];
	const repo =
		process.env.GH_REPO && process.env.GH_REPO.trim() !== ''
			? process.env.GH_REPO.trim()
			: HOST_REPO;
	const report = driftReport(options.tag, options.digest, options.added, options.removed, options.diff);
	const list = _internals.runGh([
		'issue',
		'list',
		'--repo',
		repo,
		'--state',
		'open',
		'--json',
		'number,title,author',
		'--limit',
		'500',
	]);
	if (!list.ok) {
		actions.push(
			`host-contract-v2: ROUTE-FAILED gh issue list: ${list.error ?? 'unknown error'} (no issue created)`,
		);
		return actions;
	}
	let existing: { number: number; title: string; author?: { login?: string } }[] = [];
	try {
		existing = JSON.parse(list.stdout) as { number: number; title: string; author?: { login?: string } }[];
	} catch (error) {
		actions.push(`host-contract-v2: ROUTE-FAILED gh issue list output: ${String(error)} (no issue created)`);
		return actions;
	}
	const match = existing.find(
		(issue) =>
			issue.title.startsWith(TRACKING_TITLE_PREFIX) &&
			issue.author?.login === 'github-actions[bot]',
	);
	if (match) {
		const args = ['issue', 'comment', String(match.number), '--repo', repo, '--body', report];
		if (options.dryRun) {
			actions.push(`host-contract-v2: dry-run gh ${args.join(' ').slice(0, 120)}...`);
			return actions;
		}
		const res = _internals.runGh(args);
		actions.push(
			res.ok
				? `host-contract-v2: routed drift to existing issue #${match.number}`
				: `host-contract-v2: gh issue comment failed: ${res.error ?? 'unknown error'} (verdict unchanged)`,
		);
		return actions;
	}
	const title = `${TRACKING_TITLE_PREFIX} @ ${options.tag}`;
	const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', report, '--label', 'area:ci'];
	if (options.dryRun) {
		actions.push(`host-contract-v2: dry-run gh ${args.join(' ').slice(0, 120)}...`);
		return actions;
	}
	const res = _internals.runGh(args);
	actions.push(
		res.ok
			? 'host-contract-v2: opened tracking issue'
			: `host-contract-v2: gh issue create failed: ${res.error ?? 'unknown error'} (verdict unchanged)`,
	);
	return actions;
}

// ---------------------------------------------------------------------------
// Check + emit + CLI
// ---------------------------------------------------------------------------

export interface CheckOptionsV2 {
	tag?: string;
	source?: string;
	routeOnDrift?: boolean;
	dryRun?: boolean;
}

export interface CheckOutcomeV2 {
	exitCode: number;
	lines: string[];
	tag: string | null;
	sourcePath: string | null;
	structuralDigest: string | null;
	routed: string[];
}

export async function runCheck(options: CheckOptionsV2): Promise<CheckOutcomeV2> {
	const lines: string[] = [];
	const routed: string[] = [];
	let tag: string | null = null;
	let sourcePath: string | null = null;

	if (options.tag && options.source) {
		lines.push('host-contract-v2: --tag and --source are mutually exclusive');
		return { exitCode: 2, lines, tag: null, sourcePath: null, structuralDigest: null, routed };
	}
	if (options.tag !== undefined && options.tag !== '' && !isSafeNpmTag(options.tag)) {
		lines.push(`host-contract-v2: refusing unsafe tag: ${JSON.stringify(options.tag)}`);
		return { exitCode: 2, lines, tag: null, sourcePath: null, structuralDigest: null, routed };
	}

	let corpus: CorpusLoadResult;
	if (options.source) {
		sourcePath = options.source;
		lines.push(`host-contract-v2: source=${options.source}`);
		corpus = loadSourceCorpus(options.source);
	} else {
		tag = options.tag && options.tag.trim() !== '' ? options.tag.trim() : await _internals.resolveLatestTag();
		if (!isSafeNpmTag(tag)) {
			if (tag) console.error('host-contract-v2: refusing unsafe tag for source URL');
			lines.push('host-contract-v2: could not resolve npm-latest tag for @opencode/plugin');
			lines.push('result=SOURCE_NOT_FOUND');
			return { exitCode: 1, lines, tag: null, sourcePath: null, structuralDigest: null, routed };
		}
		lines.push(`host-contract-v2: tag=${tag}`);
		corpus = await loadNpmCorpus(tag);
	}

	if (corpus.failures.length > 0) {
		for (const failure of corpus.failures) {
			lines.push(`host-contract-v2: could not load corpus file: ${failure}`);
		}
		lines.push('result=SOURCE_NOT_FOUND');
		return { exitCode: 1, lines, tag, sourcePath, structuralDigest: null, routed };
	}

	const digested = digestCorpusFiles(corpus.files);
	lines.push(`host-contract-v2: structural-digest=${digested.structuralDigest}`);

	let expected: ExpectedStructureV2;
	try {
		expected = loadExpectedChecked();
	} catch (error) {
		lines.push(
			`host-contract-v2: pinned corpus invalid (${String(error instanceof Error ? error.message : error)})`,
		);
		lines.push('result=CORPUS_INVALID');
		return { exitCode: 1, lines, tag, sourcePath, structuralDigest: digested.structuralDigest, routed };
	}

	if (digested.statements.join('\n') !== expected.statements.join('\n')) {
		const actualSet = new Set(digested.statements);
		const expectedSet = new Set(expected.statements);
		const added = digested.statements.filter((s) => !expectedSet.has(s));
		const removed = expected.statements.filter((s) => !actualSet.has(s));
		if (added.length === 0 && removed.length === 0) {
			lines.push('structural drift: added=[] removed=[] (statement order changed)');
		} else {
			lines.push(`structural drift: added=[${summarizeList(added)}] removed=[${summarizeList(removed)}]`);
		}
		const diff = unifiedDiff(expected.statements, digested.statements);
		const diffCapped = diff.slice(0, REPORT_DIFF_LIMIT);
		if (diff.length > REPORT_DIFF_LIMIT) {
			diffCapped.push(`… (+${diff.length - REPORT_DIFF_LIMIT} more changed statements)`);
		}
		lines.push(...diffCapped);
		lines.push(`host-contract-v2: pinned corpus ${expected.pinnedTag} (host ${expected.pinnedHostTag})`);
		lines.push('result=STRUCTURAL_DRIFT');
		if (options.routeOnDrift) {
			routed.push(
				...routeDrift({
					tag: tag ?? options.source ?? 'local',
					digest: digested.structuralDigest,
					added,
					removed,
					diff,
					dryRun: options.dryRun ?? false,
				}),
			);
		}
		lines.push(...routed);
		return { exitCode: 1, lines, tag, sourcePath, structuralDigest: digested.structuralDigest, routed };
	}

	lines.push('result=STRUCTURE_MATCH');
	const driftedFiles = textualDriftFiles(expected.textualDigests, digested.textualDigests);
	if (driftedFiles.length > 0) {
		lines.push(
			`host-contract-v2: textual-only drift vs pinned corpus in ${driftedFiles.length} file(s): ${summarizeList(driftedFiles.map((f) => f.id))} (structure unchanged)`,
		);
		lines.push(
			'host-contract-v2: refresh the pinned corpus with: bun scripts/check-host-contract-v2.ts --emit-expected --tag <version>',
		);
		lines.push('result=TEXTUAL_DRIFT_ONLY');
	}
	return { exitCode: 0, lines, tag, sourcePath, structuralDigest: digested.structuralDigest, routed };
}

export interface EmitOptionsV2 {
	/** Provenance recorded in the corpus — MUST describe the source being emitted. */
	asTag?: string;
}

function emitExpected(corpus: CorpusLoadResult, tag: string, options: EmitOptionsV2): number {
	if (corpus.failures.length > 0) {
		for (const failure of corpus.failures) {
			console.error(`host-contract-v2: could not load corpus file: ${failure}`);
		}
		return 1;
	}
	const digested = digestCorpusFiles(corpus.files);
	const fixture: ExpectedStructureV2 = {
		pinnedTag: options.asTag ?? tag,
		pinnedHostTag: corpus.hostTag ?? (tag.startsWith('v') ? tag : `v${tag}`),
		schemaVersion: corpus.schemaVersion ?? 'local',
		clientVersion: corpus.clientVersion ?? 'local',
		corpus: V2_CORPUS.map((entry) => ({ id: entry.id, origin: entry.origin, path: entry.path })),
		statements: digested.statements,
		structuralDigest: digested.structuralDigest,
		textualDigests: digested.textualDigests,
	};
	fs.writeFileSync(_internals.expectedPath, `${JSON.stringify(fixture, null, '\t')}\n`);
	console.log(
		`host-contract-v2: wrote ${path.relative(REPO_ROOT, _internals.expectedPath)} (digest ${digested.structuralDigest})`,
	);
	return 0;
}

function usage(): number {
	console.error('usage: bun scripts/check-host-contract-v2.ts [--tag X.Y.Z | --source <dir>] [--route-on-drift] [--dry-run]');
	console.error('       bun scripts/check-host-contract-v2.ts --emit-expected [--tag X.Y.Z | --source <dir>] [--as-tag <tag>]');
	return 2;
}

export async function main(argv: string[]): Promise<number> {
	let tag = '';
	let source = '';
	let routeOnDrift = false;
	let dryRun = false;
	let emit = false;
	let asTag = '';
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--tag': {
				const next = argv[++i];
				if (next === undefined) return usage();
				tag = next;
				break;
			}
			case '--source': {
				const next = argv[++i];
				if (next === undefined) return usage();
				source = next;
				break;
			}
			case '--route-on-drift':
				routeOnDrift = true;
				break;
			case '--dry-run':
				dryRun = true;
				break;
			case '--emit-expected':
				emit = true;
				break;
			case '--as-tag': {
				const next = argv[++i];
				if (next === undefined) return usage();
				asTag = next;
				break;
			}
			default:
				return usage();
		}
	}
	if (tag !== '' && !isSafeNpmTag(tag)) {
		console.error(`host-contract-v2: refusing unsafe tag: ${JSON.stringify(tag)}`);
		return 2;
	}
	// The as-tag is recorded as provenance in the emitted corpus, but it is
	// still validated like every other tag so the corpus cannot carry
	// path-shaped or multi-line text.
	if (asTag !== '' && !isSafeNpmTag(asTag)) return usage();
	if (emit) {
		if (routeOnDrift || dryRun || (asTag !== '' && source === '')) return usage();
		let corpus: CorpusLoadResult;
		let provenanceTag = tag;
		if (source !== '') {
			corpus = loadSourceCorpus(source);
			provenanceTag = asTag !== '' ? asTag : 'local';
		} else {
			const resolved = tag !== '' ? tag : await _internals.resolveLatestTag();
			if (!isSafeNpmTag(resolved)) {
				console.error('host-contract-v2: could not resolve npm-latest tag for @opencode/plugin');
				return 1;
			}
			corpus = await loadNpmCorpus(resolved);
			provenanceTag = resolved;
		}
		return emitExpected(corpus, provenanceTag, asTag !== '' && source !== '' ? { asTag } : {});
	}
	if (asTag !== '') return usage();
	const outcome = await runCheck({ tag, source, routeOnDrift, dryRun });
	for (const line of outcome.lines) console.log(line);
	return outcome.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(`host-contract-v2: unexpected error ${String(error)}`);
			process.exit(1);
		});
}
