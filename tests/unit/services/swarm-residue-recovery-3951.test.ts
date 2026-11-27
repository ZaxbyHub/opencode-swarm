/**
 * Trace 3943-3951-close-residue-recoverability — #3951 AC5 supplementary
 * (D3: compensation, the two recovery surfaces, the three-surface rollback
 * reader, and collision-aware default advancement).
 *
 * Non-frozen companion to `swarm-residue-3951-ac5-manifest-strand.test.ts`;
 * drives the PUBLIC rollback surface through the states that check does
 * not construct: an uncompensated reverse-move failure, a differing-original
 * collision, a recovery-only batch on EITHER fallback surface, the combined
 * collision-newest + valid-older fixture (advancement proof: default #1
 * reports the collision, default #2 drains the older batch — no livelock),
 * the all-surfaces-dead triple fault, and rollback idempotence.
 *
 * Injection routes (cross-platform; the frozen check's manifest.json-as-
 * DIRECTORY trick is reused): a blocked metadata write pre-creates that
 * NAME as a directory, so the atomic write (temp + rename onto the target)
 * fails on Windows (EPERM) and Linux (ENOTDIR/EISDIR) alike. A reverse-move
 * failure needs `node:fs` `renameSync` overridden (spread-real, single
 * function, registered BEFORE the dynamic import) to throw ONLY when the
 * source is inside quarantine/ and the target is a designated ORIGINAL path
 * — compensation and rollback call `fs.renameSync` directly
 * (src/services/swarm-residue.ts:759, 993), which the
 * `_internals.renameResidueEntry` seam (FORWARD move only) cannot express.
 * Every other rename delegates to the pre-captured real function.
 *
 * Fixtures follow the frozen check: `git init` (array-form, stdin ignored,
 * bounded), a present target, and a stale `<target>.<32hex>.tmp` aged 2h.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Absolute ORIGINAL paths whose reverse (out-of-quarantine) rename throws. */
let reverseBlock = new Set<string>();
// Captured BEFORE registration: mock.module mutates the live node:fs
// namespace, so realFs.renameSync read back at call time would be this
// very override (self-recursion / RangeError).
const REAL_RENAME_SYNC = realFs.renameSync;

mock.module('node:fs', () => ({
	...realFs,
	renameSync: (from: string | URL, to: string | URL): void => {
		const f = String(from);
		const t = String(to);
		const q = `${path.sep}quarantine${path.sep}`;
		if (
			reverseBlock.has(path.normalize(t)) &&
			f.includes(q) &&
			!t.includes(q)
		) {
			const err = new Error(
				`EPERM: operation not permitted, rename '${f}' -> '${t}'`,
			) as NodeJS.ErrnoException;
			err.code = 'EPERM';
			throw err;
		}
		REAL_RENAME_SYNC(f, t);
	},
}));

const {
	quarantineSwarmResidue,
	rollbackResidueQuarantine,
	_internals: residueInternals,
} = await import('../../../src/services/swarm-residue.js');

const REAL_RENAME_ENTRY = residueInternals.renameResidueEntry;

interface Faults {
	blockManifest?: boolean;
	blockRecoveryInBatch?: boolean;
	blockParentSibling?: boolean;
	/** relPaths whose reverse (compensation) rename must fail. */
	failReverse?: string[];
	/** relPaths recreated at the ORIGINAL with different bytes after the move. */
	recreateDiffering?: string[];
}

interface FaultHandle {
	batchId: string | undefined;
	batchAbs: string | undefined;
	restore(): void;
}

function makeGitProject(prefix: string): string {
	const tmp = canonicalMkdtemp(prefix);
	realFs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
	const git = spawnSync('git', ['init', '--quiet'], {
		cwd: tmp,
		stdin: 'ignore',
		timeout: 30_000,
	});
	if (git.status !== 0) {
		throw new Error(`git init failed: ${git.stderr?.toString().slice(0, 160)}`);
	}
	return tmp;
}

/** Registered-grammar stale residue: target present + a 2h-old temp. */
function seedStaleResidue(
	tmp: string,
	targetName: string,
	token: string,
): string {
	const swarmRoot = path.join(tmp, '.swarm');
	realFs.writeFileSync(
		path.join(swarmRoot, targetName),
		'{"probe":true}',
		'utf-8',
	);
	const tempPath = path.join(swarmRoot, `${targetName}.${token}.tmp`);
	realFs.writeFileSync(tempPath, 'partial-write', 'utf-8');
	const old = new Date(Date.now() - 2 * 60 * 60_000);
	realFs.utimesSync(tempPath, old, old);
	return tempPath;
}

const hex = (ch: string): string => ch.repeat(32);

function installFaults(tmp: string, faults: Faults): FaultHandle {
	const swarmRoot = path.join(tmp, '.swarm');
	const handle: FaultHandle = {
		batchId: undefined,
		batchAbs: undefined,
		restore: () => {
			residueInternals.renameResidueEntry = REAL_RENAME_ENTRY;
			reverseBlock = new Set<string>();
		},
	};
	reverseBlock = new Set(
		(faults.failReverse ?? []).map((r) =>
			path.normalize(path.join(swarmRoot, ...r.split('/'))),
		),
	);
	residueInternals.renameResidueEntry = ((from: string, to: string) => {
		if (handle.batchAbs === undefined) {
			// Entries are seeded at the .swarm root, so dirname(to) is the batch.
			handle.batchAbs = path.dirname(to);
			handle.batchId = path.basename(handle.batchAbs);
			if (faults.blockManifest) {
				realFs.mkdirSync(path.join(handle.batchAbs, 'manifest.json'), {
					recursive: true,
				});
			}
			if (faults.blockRecoveryInBatch) {
				realFs.mkdirSync(path.join(handle.batchAbs, 'manifest.recovery.json'), {
					recursive: true,
				});
			}
			if (faults.blockParentSibling) {
				realFs.mkdirSync(
					path.join(swarmRoot, 'quarantine', `${handle.batchId}.recovery.json`),
					{ recursive: true },
				);
			}
		}
		(REAL_RENAME_ENTRY as (a: string, b: string) => void)(from, to);
		const rel = (faults.recreateDiffering ?? []).find((r) =>
			to.endsWith(path.join(handle.batchAbs as string, ...r.split('/'))),
		);
		if (rel) {
			// A concurrent writer recreates the original with DIFFERENT bytes
			// before compensation runs (the never-overwrite case).
			realFs.writeFileSync(
				path.join(swarmRoot, ...rel.split('/')),
				`attacker-written-${rel}`,
				'utf-8',
			);
		}
	}) as typeof REAL_RENAME_ENTRY;
	return handle;
}

async function quarantineExpectingThrow(
	tmp: string,
	handle: FaultHandle,
): Promise<string> {
	let message = '';
	try {
		await quarantineSwarmResidue(tmp, { trigger: 'close' });
	} catch (err) {
		message = err instanceof Error ? err.message : String(err);
	} finally {
		handle.restore();
	}
	expect(message, 'the injected manifest-write failure did not throw').not.toBe(
		'',
	);
	return message;
}

/** Belt-and-braces seam restore: every fault wrapper is also released in
 *  its own finally, so an aborted test body can never leak it forward. */
afterEach(() => {
	mock.restore();
	residueInternals.renameResidueEntry = REAL_RENAME_ENTRY;
	reverseBlock = new Set<string>();
});

const cleanup = (tmp: string): void => {
	realFs.rmSync(tmp, { recursive: true, force: true });
	reverseBlock = new Set<string>();
};

describe('quarantine compensation + durable recovery (#3951 AC5 / D3)', () => {
	test('a reverse-move failure is uncompensated-but-recoverable: the recovery surface publishes and explicit rollback restores it', async () => {
		const tmp = makeGitProject('ac5-rec-a-');
		try {
			const strandedRel = `plan.json.${hex('0')}.tmp`;
			const strandedOriginal = seedStaleResidue(tmp, 'plan.json', hex('0'));
			seedStaleResidue(tmp, 'state.json', hex('1'));
			const h = installFaults(tmp, {
				blockManifest: true,
				failReverse: [strandedRel],
			});
			const msg = await quarantineExpectingThrow(tmp, h);
			const batchId = h.batchId as string;
			const batchAbs = h.batchAbs as string;

			// Compensation summary: names the batch, the counts, and the strand.
			expect(msg).toContain(batchId);
			expect(msg).toContain('1 restored');
			expect(msg).toContain('1 uncompensated');
			expect(msg).toContain(strandedRel);
			expect(msg).toContain(batchAbs);

			// No-recursive-delete guard: payload retained in a batch that now
			// carries a readable recovery surface.
			expect(realFs.existsSync(batchAbs)).toBe(true);
			expect(realFs.existsSync(path.join(batchAbs, strandedRel))).toBe(true);
			expect(
				realFs.existsSync(path.join(batchAbs, 'manifest.recovery.json')),
			).toBe(true);

			const res = await rollbackResidueQuarantine(tmp, batchId);
			expect(res.items.find((i) => i.relPath === strandedRel)?.status).toBe(
				'restored',
			);
			expect(realFs.existsSync(strandedOriginal)).toBe(true);
			// Honest contract: the sibling entry compensation ALREADY restored
			// has no stored copy left, so this batch reports missing-copy and is
			// not drained — the payload-side outcome, not a wedged state.
			expect(res.drained).toBe(false);
		} finally {
			cleanup(tmp);
		}
	}, 30_000);

	test('a differing original collides: stored copy kept, original preserved, reported by every later rollback (idempotent)', async () => {
		const tmp = makeGitProject('ac5-rec-b-');
		try {
			const rel = `plan.json.${hex('2')}.tmp`;
			const original = seedStaleResidue(tmp, 'plan.json', hex('2'));
			seedStaleResidue(tmp, 'notes.json', hex('3'));
			const h = installFaults(tmp, {
				blockManifest: true,
				recreateDiffering: [rel],
			});
			const msg = await quarantineExpectingThrow(tmp, h);
			const batchId = h.batchId as string;
			const batchAbs = h.batchAbs as string;

			expect(msg).toContain('1 collision-kept');
			expect(msg).toContain('1 restored');
			expect(msg).toContain(rel);

			// Never overwrite: the concurrent writer's bytes stand and the stored
			// copy is retained in the batch (no recursive delete with payload).
			expect(realFs.readFileSync(original, 'utf-8')).toBe(
				`attacker-written-${rel}`,
			);
			expect(realFs.existsSync(path.join(batchAbs, rel))).toBe(true);
			expect(
				realFs.existsSync(path.join(batchAbs, 'manifest.recovery.json')),
			).toBe(true);

			for (const attempt of [1, 2]) {
				const res = await rollbackResidueQuarantine(tmp, batchId);
				expect(
					res.items.find((i) => i.relPath === rel)?.status,
					`rollback attempt ${attempt}`,
				).toBe('collision');
				expect(res.drained, `rollback attempt ${attempt}`).toBe(false);
				expect(realFs.readFileSync(original, 'utf-8')).toBe(
					`attacker-written-${rel}`,
				);
				expect(realFs.existsSync(path.join(batchAbs, rel))).toBe(true);
			}
		} finally {
			cleanup(tmp);
		}
	}, 30_000);
});

describe('rollback selection across recovery surfaces (#3951 AC5 / D3)', () => {
	test('combined fixture: default #1 reports the newest collision batch, default #2 drains the older valid batch (advancement, no livelock), explicit still reaches the collision batch', async () => {
		const tmp = makeGitProject('ac5-rec-c-');
		try {
			// 1. An OLDER batch quarantined cleanly (real manifest.json).
			const olderTemp = seedStaleResidue(tmp, 'older.json', hex('4'));
			const first = await quarantineSwarmResidue(tmp, { trigger: 'close' });
			expect(first.quarantined).toBe(1);
			const olderBatchId = (first.batchRelDir as string).split('/')[1];

			// 2. A NEWER batch whose manifest write failed and whose one entry
			//    collided — readable ONLY through the in-batch recovery surface.
			const collideRel = `plan.json.${hex('5')}.tmp`;
			seedStaleResidue(tmp, 'plan.json', hex('5'));
			seedStaleResidue(tmp, 'notes.json', hex('6'));
			const h = installFaults(tmp, {
				blockManifest: true,
				recreateDiffering: [collideRel],
			});
			await quarantineExpectingThrow(tmp, h);
			const newerBatchId = h.batchId as string;
			const collisionBatchAbs = h.batchAbs as string;
			// Selection precondition (loud, not silent, if the fixture assumes
			// the wrong order): batch ids sort by their ISO timestamp prefix.
			expect(olderBatchId < newerBatchId).toBe(true);

			// 3. DEFAULT #1: the newest readable batch, reported not drained,
			//    and stamped with the advancement marker.
			const r1 = await rollbackResidueQuarantine(tmp);
			expect(r1.batchRelDir).toContain(newerBatchId);
			expect(r1.drained).toBe(false);
			expect(r1.items.some((i) => i.status === 'collision')).toBe(true);
			expect(
				realFs.existsSync(path.join(collisionBatchAbs, 'rollback.attempted')),
				'the default attempt must record advancement on the unresolved batch',
			).toBe(true);
			expect(
				realFs.existsSync(olderTemp),
				'default #1 must not have drained the older batch',
			).toBe(false);

			// 4. DEFAULT #2 — advancement: the marked batch is skipped and the
			//    older valid batch drains (the livelock this clause forbids is
			//    re-selecting the collision batch forever).
			const r2 = await rollbackResidueQuarantine(tmp);
			expect(r2.batchRelDir).toContain(olderBatchId);
			expect(r2.drained).toBe(true);
			expect(realFs.existsSync(olderTemp)).toBe(true);

			// 5. EXPLICIT ignores the marker and still reaches the collision
			//    batch, with BOTH copies preserved (stored + the differing
			//    original the concurrent writer left).
			const r3 = await rollbackResidueQuarantine(tmp, newerBatchId);
			expect(r3.batchRelDir).toContain(newerBatchId);
			expect(r3.items.find((i) => i.relPath === collideRel)?.status).toBe(
				'collision',
			);
			expect(realFs.existsSync(path.join(collisionBatchAbs, collideRel))).toBe(
				true,
			);
			expect(
				realFs.readFileSync(path.join(tmp, '.swarm', collideRel), 'utf-8'),
			).toBe(`attacker-written-${collideRel}`);
		} finally {
			cleanup(tmp);
		}
	}, 30_000);

	test('a batch recovered only through the PARENT-SIBLING surface drains and removes that orphaned sibling metadata', async () => {
		const tmp = makeGitProject('ac5-rec-d-');
		try {
			const rels = [`plan.json.${hex('7')}.tmp`, `notes.json.${hex('8')}.tmp`];
			const originals = [
				seedStaleResidue(tmp, 'plan.json', hex('7')),
				seedStaleResidue(tmp, 'notes.json', hex('8')),
			];
			const h = installFaults(tmp, {
				blockManifest: true,
				blockRecoveryInBatch: true,
				failReverse: rels,
			});
			const msg = await quarantineExpectingThrow(tmp, h);
			const batchId = h.batchId as string;
			const batchAbs = h.batchAbs as string;
			expect(msg).toContain('2 uncompensated');
			const sibling = path.join(
				tmp,
				'.swarm',
				'quarantine',
				`${batchId}.recovery.json`,
			);
			// In-batch recovery blocked → the parent-sibling is the only surface.
			expect(realFs.existsSync(sibling)).toBe(true);
			expect(realFs.existsSync(originals[0])).toBe(false);

			const res = await rollbackResidueQuarantine(tmp, batchId);
			expect(res.drained).toBe(true);
			expect(originals.every((p) => realFs.existsSync(p))).toBe(true);
			expect(realFs.existsSync(batchAbs)).toBe(false);
			expect(
				realFs.existsSync(sibling),
				'the drained batch left its parent-sibling recovery metadata behind',
			).toBe(false);
		} finally {
			cleanup(tmp);
		}
	}, 30_000);

	test('triple fault: every surface unwritable — the error names the batch dir and every stranded relPath, and explicit rollback hard-errors', async () => {
		const tmp = makeGitProject('ac5-rec-e-');
		try {
			const rels = [`plan.json.${hex('9')}.tmp`, `notes.json.${hex('a')}.tmp`];
			seedStaleResidue(tmp, 'plan.json', hex('9'));
			seedStaleResidue(tmp, 'notes.json', hex('a'));
			const h = installFaults(tmp, {
				blockManifest: true,
				blockRecoveryInBatch: true,
				blockParentSibling: true,
				failReverse: rels,
			});
			const msg = await quarantineExpectingThrow(tmp, h);
			const batchId = h.batchId as string;
			const batchAbs = h.batchAbs as string;

			// Maximal honest state: payload retained + the error names the batch
			// dir and EVERY stranded relPath for manual recovery.
			expect(msg).toContain(batchAbs);
			expect(msg).toContain('2 uncompensated');
			for (const rel of rels) expect(msg).toContain(rel);
			for (const rel of rels) {
				expect(realFs.existsSync(path.join(batchAbs, rel))).toBe(true);
			}
			expect(realFs.existsSync(batchAbs)).toBe(true);

			// No surface published (all three are the blocking DIRECTORIES), so
			// an EXPLICIT request for that batch is a hard error naming it — it
			// must never silently select a different batch.
			let error = '';
			try {
				await rollbackResidueQuarantine(tmp, batchId);
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
			expect(error).toContain('no readable manifest surface');
			expect(error).toContain(batchId);
		} finally {
			cleanup(tmp);
		}
	}, 30_000);

	test('idempotence after draining: the drained batch is gone, so an explicit re-request names it and a bare sweep reports no batches', async () => {
		const tmp = makeGitProject('ac5-rec-g-');
		try {
			// Seeded one at a time: a single quarantine call drains every
			// eligible entry present, so the second batch needs its own residue.
			const tempA = seedStaleResidue(tmp, 'plan.json', hex('b'));
			const qA = await quarantineSwarmResidue(tmp, { trigger: 'close' });
			const batchA = (qA.batchRelDir as string).split('/')[1];
			const tempB = seedStaleResidue(tmp, 'notes.json', hex('c'));
			const qB = await quarantineSwarmResidue(tmp, { trigger: 'close' });
			const batchB = (qB.batchRelDir as string).split('/')[1];

			const first = await rollbackResidueQuarantine(tmp, batchA);
			expect(first.drained).toBe(true);
			expect(realFs.existsSync(tempA)).toBe(true);
			expect(
				realFs.existsSync(path.join(tmp, '.swarm', 'quarantine', batchA)),
			).toBe(false);

			// The real drained contract (asserted as implemented): the batch
			// directory no longer exists, so a re-request is an explicit
			// not-found error — never a silent no-op and never another batch.
			let notFound = '';
			try {
				await rollbackResidueQuarantine(tmp, batchA);
			} catch (err) {
				notFound = err instanceof Error ? err.message : String(err);
			}
			expect(notFound).toContain('Quarantine batch not found');
			expect(notFound).toContain(batchA);

			// Nothing was re-drained by the refused call: B is intact.
			expect(realFs.existsSync(tempB)).toBe(false);

			const second = await rollbackResidueQuarantine(tmp);
			expect(second.batchRelDir).toContain(batchB);
			expect(second.drained).toBe(true);
			expect(realFs.existsSync(tempB)).toBe(true);

			// With zero batches left the bare sweep keeps its existing contract.
			let empty = '';
			try {
				await rollbackResidueQuarantine(tmp);
			} catch (err) {
				empty = err instanceof Error ? err.message : String(err);
			}
			expect(empty).toContain('No quarantine batches found');
		} finally {
			cleanup(tmp);
		}
	}, 30_000);
});
