/**
 * Shared stub for the settlement-artifact lifecycle admission gate (#3409).
 *
 * The fake-root fixtures in the lean-turbo merge-back and worktree suites
 * isolate Git cleanup/removal behavior; they have no real `.swarm` WAL, so the
 * lifecycle admission gate would reject them. Real WAL admission is covered by
 * the settlement-artifact-lifecycle/cleanup-sinks #3409 tests.
 *
 * Usage: call `install(_internals)` in the `beforeEach` of the describe blocks
 * that need it, and `restore(_internals)` in the file-level `afterEach`.
 */

import type {
	assertSettlementArtifactsRemovable,
	withSettlementArtifactLifecycle,
} from '../../src/worktree/settlement-artifact-lifecycle';

/** The two `_internals` DI seams this stub overrides. */
export interface ArtifactAdmissionSeams {
	withSettlementArtifactLifecycle: typeof withSettlementArtifactLifecycle;
	assertSettlementArtifactsRemovable: typeof assertSettlementArtifactsRemovable;
}

/** Real seam implementations, captured once per `_internals` object. */
const realSeams = new WeakMap<ArtifactAdmissionSeams, ArtifactAdmissionSeams>();

/**
 * Replaces both admission seams with pass-throughs: the lifecycle wrapper runs
 * the operation directly and the removability check always succeeds. The real
 * implementations are captured on the first call for this `_internals` object
 * so `restore` can put them back.
 */
export function install(internals: ArtifactAdmissionSeams): void {
	if (!realSeams.has(internals)) {
		realSeams.set(internals, {
			withSettlementArtifactLifecycle:
				internals.withSettlementArtifactLifecycle,
			assertSettlementArtifactsRemovable:
				internals.assertSettlementArtifactsRemovable,
		});
	}
	internals.withSettlementArtifactLifecycle = async (_directory, operation) =>
		operation();
	internals.assertSettlementArtifactsRemovable = async () => {};
}

/**
 * Restores the real admission seams captured by `install`. A no-op when
 * `install` was never called for this `_internals` object (the seams were
 * never replaced).
 */
export function restore(internals: ArtifactAdmissionSeams): void {
	const real = realSeams.get(internals);
	if (!real) return;
	internals.withSettlementArtifactLifecycle =
		real.withSettlementArtifactLifecycle;
	internals.assertSettlementArtifactsRemovable =
		real.assertSettlementArtifactsRemovable;
}
