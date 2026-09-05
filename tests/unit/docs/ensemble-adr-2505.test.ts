import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

/** Slice a `## <name>` section out of a markdown document (to the next `## ` heading or EOF). */
function section(markdown: string, heading: string): string {
	const start = markdown.indexOf(`## ${heading}`);
	if (start < 0) return '';
	const next = markdown.indexOf('\n## ', start + 1);
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
		// The pinned commit must be cited as a full 40-hex SHA, not truncated.
		expect(license).toMatch(/[0-9a-f]{40}/);
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
				const content = fs.readFileSync(full, 'utf8');
				if (content.includes(PORT_MARKER)) markerFiles.push(full);
			}
		};
		walk(srcDir);

		const noticesPath = path.join(repositoryRoot, 'THIRD_PARTY_NOTICES.md');
		if (markerFiles.length === 0) {
			expect(fs.existsSync(noticesPath)).toBe(false);
		} else {
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
		const fragment = read(
			'docs/releases/pending/2505-ensemble-adoption-adr.md',
		);
		expect(fragment).toMatch(/^# /m);
		expect(fragment).toContain('2505');
		expect(fragment).toContain('ADR 0002');
		expect(fragment).toContain('ensemble-adr-2505.test.ts');
	});
});
