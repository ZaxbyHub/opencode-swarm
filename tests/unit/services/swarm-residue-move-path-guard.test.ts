/**
 * Issue #3836 D4 — quarantine MOVE path validates the residue name BEFORE the
 * rename. An eligible entry whose relPath fails the manifest trust grammar is
 * preserved in place with reason `unsafe-name`, never moved, and produces no
 * manifest record — the batch that IS written stays rollback-clean.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	quarantineSwarmResidue,
	RESIDUE_STALE_AGE_MS,
	rollbackResidueQuarantine,
} from '../../../src/services/swarm-residue';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const DEL = String.fromCharCode(0x7f);

let projectDir: string;
let swarmDir: string;
const realQueryTracked = _internals.queryTracked;

function makeResidue(rel: string, content = 'x'): string {
	const abs = path.join(swarmDir, ...rel.split('/'));
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, content, 'utf-8');
	const t = withFrozenClock(
		() => new Date(Date.now() - 3 * 60 * 60 * 1000),
		// anchor the frozen instant to the real clock so the fixture stays on
		// the stale side of the RESIDUE_STALE_AGE_MS window
		{ fixedNow: Date.now() },
	);
	utimesSync(abs, t, t);
	return abs;
}

function makeTarget(rel: string): string {
	const abs = path.join(swarmDir, ...rel.split('/'));
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, '{"target":true}', 'utf-8');
	return abs;
}

beforeEach(() => {
	projectDir = canonicalMkdtemp('residue-move-guard-');
	swarmDir = path.join(projectDir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	_internals.queryTracked = () => ({ tracked: new Set<string>() });
});

afterEach(() => {
	_internals.queryTracked = realQueryTracked;
	rmSync(projectDir, { recursive: true, force: true });
});

describe('quarantineSwarmResidue move-path name guard (#3836 D4)', () => {
	test('unsafe-named eligible entry is preserved with unsafe-name, never moved, and the written batch stays rollback-clean', async () => {
		// DEL is creatable in a Win32 filename (C0 is not) and admitted by the
		// registered temp grammar's character classes.
		const unsafeRel = `evil${DEL}-ctx.md.tmp.1710000000.abcdef`;
		const unsafeAbs = makeResidue(unsafeRel, 'unsafe-payload');
		makeTarget(`evil${DEL}-ctx.md`);
		// A safe sibling so the run still produces a real batch.
		const safeRel = 'safe.json.tmp.1710000000.111111111';
		makeResidue(safeRel, 'safe-payload');
		makeTarget('safe.json');

		const result = await quarantineSwarmResidue(projectDir, {
			trigger: 'test',
		});

		// Only the safe entry moved.
		expect(result.quarantined).toBe(1);
		expect(result.batchRelDir).toBeDefined();

		// The unsafe entry is still in place, byte-unchanged.
		expect(existsSync(unsafeAbs)).toBe(true);
		expect(readFileSync(unsafeAbs, 'utf-8')).toBe('unsafe-payload');

		// Reported as preserved with the typed reason.
		const preservedUnsafe = result.preserved.find(
			(p) => p.relPath === unsafeRel,
		);
		expect(preservedUnsafe?.status).toBe('preserved');
		expect([...(preservedUnsafe?.reasons ?? [])]).toContain('unsafe-name');

		// No manifest record for the unsafe name — the batch is clean.
		const batchDir = path.join(swarmDir, ...result.batchRelDir!.split('/'));
		const manifestText = readFileSync(
			path.join(batchDir, 'manifest.json'),
			'utf-8',
		);
		expect(manifestText.includes(DEL)).toBe(false);
		const manifest = JSON.parse(manifestText) as {
			entries: Array<{ original_rel_path: string }>;
		};
		expect(manifest.entries.map((e) => e.original_rel_path)).toEqual([safeRel]);

		// The batch rolls back cleanly (drained) — the skipped entry never
		// poisons the default rollback.
		const rb = await rollbackResidueQuarantine(projectDir);
		expect(rb.items.find((i) => i.relPath === safeRel)?.status).toBe(
			'restored',
		);
		expect(rb.drained).toBe(true);
		expect(existsSync(batchDir)).toBe(false);
		expect(
			readFileSync(path.join(swarmDir, ...safeRel.split('/')), 'utf-8'),
		).toBe('safe-payload');
		// The unsafe entry was never part of any batch.
		const quarantineRoot = path.join(swarmDir, 'quarantine');
		expect(
			existsSync(quarantineRoot) ? readdirSync(quarantineRoot) : [],
		).toEqual([]);
	});
});
