/**
 * #1850: diagnostics no-leakage (acceptance #13 — category #13).
 * Verifies status/diagnostics surfaces do NOT emit memory record text or
 * unrelated-repo identifiers when cohort-linked.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { writeMemoryLinkPointer } from '../../../src/memory/memory-link';
import { computeKnowledgeDebug } from '../../../src/services/knowledge-diagnostics';

function makeTmp(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

describe('#1850 diagnostics no-leakage (acceptance #13 — category #13)', () => {
	const dirs: string[] = [];
	let prevXdg: string | undefined;
	let prevHome: string | undefined;
	let prevLocalAppData: string | undefined;
	let prevAppData: string | undefined;

	beforeEach(() => {
		prevXdg = process.env.XDG_DATA_HOME;
		prevHome = process.env.HOME;
		prevLocalAppData = process.env.LOCALAPPDATA;
		prevAppData = process.env.APPDATA;
		// LOCALAPPDATA is required on Windows: resolveDataDir's win32 branch reads it
		// FIRST, so an XDG-only redirect silently resolves the REAL platform root (#2033).
		const dataDir = makeTmp('diag-data-');
		dirs.push(dataDir);
		process.env.XDG_DATA_HOME = dataDir;
		process.env.HOME = dataDir;
		process.env.LOCALAPPDATA = dataDir;
		process.env.APPDATA = dataDir;
	});

	afterEach(() => {
		// delete-if-undefined restore (assigning undefined coerces to the string).
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = prevLocalAppData;
		if (prevAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = prevAppData;
		for (const d of dirs.splice(0)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	});

	test('F-20: knowledge-diagnostics memory block carries no record text', async () => {
		const dir = makeTmp('diag-leak-');
		dirs.push(dir);
		await writeMemoryLinkPointer(dir, {
			version: 2,
			linkId: 'leak-test-cohort',
			createdAt: new Date().toISOString(),
			cohortId: 'leak-cohort-id',
		});
		const debug = await computeKnowledgeDebug(dir);
		expect(debug.memory).toBeDefined();
		expect(debug.memory.linked).toBe(true);
		// The memory block must NOT contain record text — only structural fields.
		const serialized = JSON.stringify(debug.memory);
		expect(serialized).not.toContain('lesson');
		expect(serialized).not.toContain('text');
		expect(serialized).not.toContain('rationale');
	});

	test('F-21: unlinked worktree reports memory.linked=false cleanly', async () => {
		const dir = makeTmp('diag-unlinked-');
		dirs.push(dir);
		const debug = await computeKnowledgeDebug(dir);
		expect(debug.memory.linked).toBe(false);
	});
});
