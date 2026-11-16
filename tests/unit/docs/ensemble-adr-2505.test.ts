import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// ADR review checklist for issue #2505 (Workstream G slot G1). This test is
// the executable "ADR review checklist" the issue requires: it mechanically
// pins the license/provenance record, the per-capability decisions, the
// G2-G5 port gate, and the port obligation recorded in
// docs/decisions/0002-opencode-ensemble-adoption.md. Deleting or weakening
// any pinned fact in that record turns this suite red.
const repositoryRoot = path.resolve(import.meta.dir, '..', '..', '..');
const ADR_REL = 'docs/decisions/0002-opencode-ensemble-adoption.md';
const ADR_PATH = path.join(repositoryRoot, ADR_REL);

function read(relativePath: string): string {
	return fs
		.readFileSync(path.join(repositoryRoot, relativePath), 'utf8')
		.replace(/\r\n/g, '\n');
}

// Consumption-aware source resolution (#3511, the merged-#3507 pattern):
// while the pending fragment exists it is the sole authority; once a
// release-fragment cleanup consumes it, the narration must be found in the
// materialized release history (docs/releases/vX.Y.Z.md) instead. Exclusive
// arms — never a union — so a stale re-added same-slug fragment cannot hide
// a dropped sentence behind an older archive hit. Returns null when neither
// surface carries the fragment (the pin then fails, never passes vacuously).
function adoptionAdrFragmentText(root: string): string | null {
	const pendingFragment = path.join(
		root,
		'docs/releases/pending/2505-ensemble-adoption-adr.md',
	);
	if (fs.existsSync(pendingFragment)) {
		return fs.readFileSync(pendingFragment, 'utf8').replace(/\r\n/g, '\n');
	}
	// #3519 feedback: the consumed obligation resolves through the fragment's
	// MANIFEST CLAIM (the claiming tag's vX.md carries it), never through a
	// name-blind aggregate of every release body — 'ADR 0002' and '2505'
	// appear in unrelated history, so the aggregate arm passed for
	// never-consumed fragments.
	const manifestsDir = path.join(root, 'docs/releases/manifests');
	if (!fs.existsSync(manifestsDir)) return null;
	const claims: Array<{ tag: string; manifest: string }> = [];
	for (const name of fs.readdirSync(manifestsDir)) {
		if (!name.toLowerCase().endsWith('.json')) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(
				fs.readFileSync(path.join(manifestsDir, name), 'utf8'),
			);
		} catch {
			continue;
		}
		const manifest = parsed as {
			schemaVersion?: unknown;
			tag?: unknown;
			fragments?: Array<{ path?: unknown }>;
		};
		if (
			manifest?.schemaVersion !== 1 ||
			!Array.isArray(manifest.fragments) ||
			typeof manifest.tag !== 'string'
		) {
			continue;
		}
		const claimed = manifest.fragments.some(
			(fragment) =>
				fragment?.path ===
				'docs/releases/pending/2505-ensemble-adoption-adr.md',
		);
		if (claimed) claims.push({ tag: manifest.tag, manifest: name });
	}
	if (claims.length === 0) return null;
	claims.sort(
		(a, b) =>
			tagOrderOf(b.tag) - tagOrderOf(a.tag) ||
			(a.manifest < b.manifest ? 1 : a.manifest > b.manifest ? -1 : 0),
	);
	const archivedBody = path.join(root, 'docs/releases', `${claims[0].tag}.md`);
	if (!fs.existsSync(archivedBody)) return null;
	return fs.readFileSync(archivedBody, 'utf8').replace(/\r\n/g, '\n');
}

/** Parse `v?X.Y.Z` into a comparable number; unparseable tags sort lowest. */
function tagOrderOf(tag: string): number {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
	if (!m) return -1;
	return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);
}

/** True when `index` sits outside any fenced code block (even number of ``` before it). */
function outsideFences(markdown: string, index: number): boolean {
	return (markdown.slice(0, index).match(/```/g)?.length ?? 0) % 2 === 0;
}

/** Slice a `## <name>` section out of a markdown document (to the next `## ` heading or EOF). */
function section(markdown: string, heading: string): string {
	const start = markdown.indexOf(`## ${heading}`);
	if (start < 0 || !outsideFences(markdown, start)) return '';
	let next = markdown.indexOf('\n## ', start + 1);
	while (next >= 0 && !outsideFences(markdown, next)) {
		next = markdown.indexOf('\n## ', next + 1);
	}
	return next < 0 ? markdown.slice(start) : markdown.slice(start, next);
}

const PINNED_UPSTREAM_COMMIT = 'eaf9e84a6e872e6af9ad8bb5a8fd274ce926a878';
const UPSTREAM_COPYRIGHT = 'Copyright (c) 2026 opencode-ensemble contributors';
const PORT_MARKER = 'ported-from: opencode-ensemble';
const CAPABILITIES = [
	'watchdog',
	'breaker/rate-limit',
	'merge safety',
	'purge pattern',
	'dashboard',
] as const;

describe('ensemble adoption ADR (issue #2505) — review checklist', () => {
	test('ADR exists at the pinned path with ADR metadata and required sections', () => {
		expect(fs.existsSync(ADR_PATH)).toBe(true);
		const adr = read(ADR_REL);
		expect(adr.startsWith('# ADR 0002:')).toBe(true);
		expect(adr).toContain('**Status:** Accepted');
		expect(adr).toContain('**Resolves:** #2505');
		for (const heading of [
			'## Context',
			'## License and provenance',
			'## Decision',
			'## Per-capability decisions',
			'## G2-G5 port gate',
			'## Port obligation for future adoption',
			'## Re-evaluation triggers',
			'## Consequences',
		]) {
			expect(adr).toContain(heading);
		}
	});

	test('license and provenance record pins upstream URL, MIT, copyright, commit, and deps', () => {
		const license = section(read(ADR_REL), 'License and provenance');
		expect(license).toContain('https://github.com/hueyexe/opencode-ensemble');
		expect(license).toContain('MIT');
		expect(license).toContain(UPSTREAM_COPYRIGHT);
		expect(license).toContain(PINNED_UPSTREAM_COMMIT);
		expect(license).toContain('@opencode-ai/plugin');
		expect(license).toContain('@opencode-ai/sdk');
	});

	test('decision section records reimplementation-first with adopted ideas credited', () => {
		const decision = section(read(ADR_REL), 'Decision');
		expect(decision).toContain('Reimplement every capability');
		expect(decision.toLowerCase()).toContain('port no upstream code');
	});

	test('per-capability decisions table covers all five capabilities with one decision token each', () => {
		const table = section(read(ADR_REL), 'Per-capability decisions');
		const rows = table
			.split('\n')
			.filter((line) => line.trimStart().startsWith('|'));
		for (const capability of CAPABILITIES) {
			const matching = rows.filter((row) => row.includes(capability));
			expect(matching.length).toBe(1);
			const row = matching[0] as string;
			// Exactly one whole-word decision token (case-sensitive, matching
			// the frozen acceptance check C2 in the issue trace).
			const reimplementCount = (
				row.match(/(^|[^A-Za-z0-9_])REIMPLEMENT([^A-Za-z0-9_]|$)/g) ?? []
			).length;
			const adoptCount = (
				row.match(/(^|[^A-Za-z0-9_])ADOPT([^A-Za-z0-9_]|$)/g) ?? []
			).length;
			expect(reimplementCount + adoptCount).toBe(1);
			// Rationale presence: the row must carry real content beyond the
			// capability name and decision token (C2 requires >= 80 chars).
			expect(row.length).toBeGreaterThanOrEqual(80);
		}
	});

	test('G2-G5 port gate names all four gated issues and the binding rule', () => {
		const gate = section(read(ADR_REL), 'G2-G5 port gate');
		for (const issue of ['#2506', '#2507', '#2508', '#2509']) {
			expect(gate).toContain(issue);
		}
		expect(gate).toContain('before this ADR lands');
		expect(gate).toContain('#2532');
	});

	test('port obligation pins the provenance marker and third-party notice contract', () => {
		const obligation = section(
			read(ADR_REL),
			'Port obligation for future adoption',
		);
		expect(obligation).toContain(PORT_MARKER);
		expect(obligation).toContain('THIRD_PARTY_NOTICES.md');
		expect(obligation).toContain(UPSTREAM_COPYRIGHT);
		expect(obligation).toContain('provenance header');
	});

	test('marker/notice symmetry: no port markers exist while no notice file ships', () => {
		// While the ADR's decision is reimplementation-first, nothing under
		// src/ may carry the port marker, and no notice file may ship. The
		// moment a marker appears, THIRD_PARTY_NOTICES.md must exist and carry
		// the upstream copyright line (forward guard from the plan critic).
		const srcDir = path.join(repositoryRoot, 'src');
		const markerFiles: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				if (!entry.name.endsWith('.ts')) continue;
				const content = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
				if (content.includes(PORT_MARKER)) markerFiles.push(full);
			}
		};
		walk(srcDir);

		const noticesPath = path.join(repositoryRoot, 'THIRD_PARTY_NOTICES.md');
		if (markerFiles.length === 0) {
			expect(fs.existsSync(noticesPath)).toBe(false);
		} else {
			// Every marker line must carry the full provenance header the ADR
			// mandates: ported-from: opencode-ensemble <commit-sha> <path>.
			// A leading comment prefix (//, #, *) is allowed — the header is a
			// comment line in the ported file.
			for (const file of markerFiles) {
				const lines = fs
					.readFileSync(file, 'utf8')
					.replace(/\r\n/g, '\n')
					.split('\n');
				for (const line of lines) {
					if (!line.includes(PORT_MARKER)) continue;
					expect(line).toMatch(
						/^\s*(?:[/#*]+)\s*ported-from: opencode-ensemble [0-9a-f]{40} \S+/,
					);
				}
			}
			expect(fs.existsSync(noticesPath)).toBe(true);
			expect(fs.readFileSync(noticesPath, 'utf8')).toContain(
				UPSTREAM_COPYRIGHT,
			);
		}
	});

	test('ADR 0001 (MXC deferral) remains intact alongside the new record', () => {
		const adr0001 = read('docs/decisions/0001-mxc-sandbox-backend.md');
		expect(adr0001).toContain('# ADR 0001:');
		expect(adr0001).toContain('## Decision');
		expect(adr0001).toContain('**Status:**');
	});

	test('release fragment for the adoption ADR is present and narrates the change', () => {
		// Consumption-aware (#3511, the #3507 pattern): while the pending
		// fragment exists it is the sole authority; once a release-fragment
		// cleanup consumes it, the narration must be found in the materialized
		// release history instead. Exclusive arms — never a union — so a stale
		// re-added same-slug fragment cannot hide behind an old archive hit.
		const fragment = adoptionAdrFragmentText(repositoryRoot);
		expect(fragment).not.toBeNull();
		expect(fragment).toMatch(/^# /m);
		expect(fragment).toContain('2505');
		expect(fragment).toContain('ADR 0002');
		expect(fragment).toContain('ensemble-adr-2505.test.ts');
	});

	test('consumption-aware resolution fails closed when neither surface carries the fragment', () => {
		// Strength leg (#3511): the resolver must return null when the pending
		// fragment is consumed and no materialized history carries its text —
		// the pin above then fails instead of passing vacuously.
		const empty = canonicalMkdtemp('swarm-ensemble-adr-2505-empty-');
		try {
			expect(adoptionAdrFragmentText(empty)).toBeNull();
		} finally {
			fs.rmSync(empty, { recursive: true, force: true });
		}
		const exclusive = canonicalMkdtemp('swarm-ensemble-adr-2505-excl-');
		try {
			fs.mkdirSync(path.join(exclusive, 'docs/releases/pending'), {
				recursive: true,
			});
			fs.mkdirSync(path.join(exclusive, 'docs/releases'), {
				recursive: true,
			});
			// Pending present but MISSING the pinned sentence, while a stale
			// archive carries it: pending is the sole authority, so the pin
			// fails — a UNION resolver would pass by leaking the archive text
			// (the stale re-add hazard the exclusive arms exist to kill).
			fs.writeFileSync(
				path.join(
					exclusive,
					'docs/releases/pending/2505-ensemble-adoption-adr.md',
				),
				'# adoption ADR record without the pinned sentences',
			);
			fs.writeFileSync(
				path.join(exclusive, 'docs/releases/v0.0.0.md'),
				'# stale archive hit with ADR 0002 and 2505 narration',
			);
			const resolved = adoptionAdrFragmentText(exclusive);
			expect(resolved).not.toContain('ADR 0002');
			expect(resolved).not.toContain('2505');
		} finally {
			fs.rmSync(exclusive, { recursive: true, force: true });
		}
		const archivedOnly = canonicalMkdtemp('swarm-ensemble-adr-2505-arch-');
		try {
			fs.mkdirSync(path.join(archivedOnly, 'docs/releases/manifests'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(archivedOnly, 'docs/releases/v0.0.0.md'),
				'# archived narration for ADR 0002 (issue 2505)' + '\n',
			);
			// #3519 feedback: a stray vX.md WITHOUT a manifest claim for this
			// exact path must NOT satisfy the pin (name-blind aggregate defect
			// this round fixes) — resolution requires the claim.
			expect(adoptionAdrFragmentText(archivedOnly)).toBeNull();
			fs.writeFileSync(
				path.join(archivedOnly, 'docs/releases/manifests/v0.0.0.json'),
				JSON.stringify({
					schemaVersion: 1,
					tag: 'v0.0.0',
					tagCommit: 'a'.repeat(40),
					targetCommitish: 'a'.repeat(40),
					releaseBodySha256: '0'.repeat(64),
					fragments: [
						{
							prNumber: null,
							order: 0,
							path: 'docs/releases/pending/2505-ensemble-adoption-adr.md',
							sha256: '3'.repeat(64),
						},
					],
				}),
			);
			const text = adoptionAdrFragmentText(archivedOnly);
			expect(text).toContain('ADR 0002');
			expect(text).toContain('2505');
			// Claim-without-body fails closed: the claiming tag's vX.md missing
			// must not fabricate an obligation.
			fs.rmSync(path.join(archivedOnly, 'docs/releases/v0.0.0.md'));
			expect(adoptionAdrFragmentText(archivedOnly)).toBeNull();
		} finally {
			fs.rmSync(archivedOnly, { recursive: true, force: true });
		}
	});
});
