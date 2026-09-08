/**
 * Issue #2486: disk-pressure floor for training-content capture.
 *
 * Source contract #2050 §8 (adopted by the re-baseline): capture stops before
 * free space on the vault's volume falls below the greater of 2 GiB or 10% of
 * the volume. `fs.statfs` is available on every supported runtime of this
 * plugin (Bun and Node >= 22.13; statfs exists since Node 18.15) and is read
 * through plain `node:fs` — no `bun:` import (AGENTS.md invariant 2).
 *
 * Fail-open policy: if `statfs` is genuinely unavailable or throws on this
 * runtime/filesystem, the CHECK reports ok (the consent-clamped byte/record
 * caps remain the pressure bound); the append path still fails closed with a
 * typed `disk_floor` stop reason on ENOSPC-style write errors and on writes
 * that cannot be synchronously confirmed as durable.
 */
import * as fs from 'node:fs';
import { trainingRootDir } from './paths';

/** Hard free-space floor: max(2 GiB, 10% of the volume size). */
export const TRAINING_DISK_FLOOR_BYTES = 2_147_483_648;

export interface DiskFloorCheck {
	ok: boolean;
	freeBytes?: number;
	floorBytes: number;
	reason?: 'disk_floor';
}

type StatFsLike = {
	bavail: number;
	bsize: number;
	blocks: number;
};

/**
 * Check the free-space floor for the volume holding the training tree.
 * The reported `floorBytes` is the guaranteed constant floor; the ok/not-ok
 * decision uses the stricter of that floor and 10% of the volume size.
 * Never throws: an unprobeable volume reports ok with the byte caps as the
 * remaining bound (see module doc).
 */
export function checkTrainingDiskFloor(directory: string): DiskFloorCheck {
	const root = trainingRootDir(directory);
	try {
		const stats = fs.statfsSync(root) as unknown as StatFsLike;
		const freeBytes = stats.bavail * stats.bsize;
		const effectiveFloor = Math.max(
			TRAINING_DISK_FLOOR_BYTES,
			Math.floor((stats.blocks * stats.bsize) / 10),
		);
		if (!Number.isFinite(freeBytes) || freeBytes < 0) {
			return { ok: true, floorBytes: TRAINING_DISK_FLOOR_BYTES };
		}
		if (freeBytes < effectiveFloor) {
			return {
				ok: false,
				freeBytes,
				floorBytes: TRAINING_DISK_FLOOR_BYTES,
				reason: 'disk_floor',
			};
		}
		return { ok: true, freeBytes, floorBytes: TRAINING_DISK_FLOOR_BYTES };
	} catch {
		return { ok: true, floorBytes: TRAINING_DISK_FLOOR_BYTES };
	}
}
