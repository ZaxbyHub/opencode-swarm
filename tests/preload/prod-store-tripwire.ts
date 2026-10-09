/**
 * Bun test preload (issue #2033): install the production-store tripwire before ANY test
 * file loads, so the real platform knowledge-store paths are captured with pristine env
 * (no suite has redirected LOCALAPPDATA/XDG_DATA_HOME/HOME yet).
 *
 * Registered in bunfig.toml under [test] preload. Runs for every `bun test` invocation.
 * See tests/helpers/prod-store-tripwire.ts for the mechanism and rationale.
 *
 * Two global hooks (Bun supports hooks from preloads — verified by spike): an
 * afterEach that re-arms the fs guards after every test, and ONE afterAll bookend that
 * verifies the real stores are unchanged and that the checkout did not drift. They
 * share a single afterAll because a throw in a preload afterAll skips the next one:
 * both checks always run, and every failure is reported. Bun 1.3.14's mock.restore() does NOT strip
 * mock.module registrations (pinned by test), but if a future runtime changes that,
 * the re-arm keeps the guards active; the afterAll gives every suite a drift check
 * without growing individual over-cap test files (FR-006 line ratchet).
 */

import { afterAll, afterEach } from 'bun:test';
import * as path from 'node:path';
import {
	diffCheckout,
	reportCheckoutDrift,
	resolveDriftMode,
	resolveDriftRoot,
	snapshotCheckout,
} from '../helpers/checkout-drift.js';
import {
	ensureTripwireGuardsArmed,
	installProdStoreTripwire,
	verifyRealStoresUnchanged,
} from '../helpers/prod-store-tripwire.js';

installProdStoreTripwire();

// Checkout-drift bookend: snapshot the repo root + its .swarm/ before any test
// file loads (see tests/helpers/checkout-drift.ts for scope and modes).
const repoRoot = resolveDriftRoot(
	process.env,
	path.resolve(import.meta.dir, '..', '..'),
);
if (process.env.SWARM_TEST_CHECKOUT_DRIFT_ROOT?.trim()) {
	console.warn(
		`CHECKOUT DRIFT: SWARM_TEST_CHECKOUT_DRIFT_ROOT is set; guarding ${repoRoot} instead of the repository.`,
	);
}
const checkoutBaseline = snapshotCheckout(repoRoot);

afterEach(async () => {
	await ensureTripwireGuardsArmed();
});

// Global bookends, in ONE afterAll (see the header):
//  - issue #2033: EVERY suite must leave the real platform stores untouched.
//    Registering this from the preload avoids growing individual over-cap test
//    files (FR-006 line ratchet) and covers all suites uniformly. Verify uses
//    preload-time-captured fs functions, so it works even if a suite's own
//    mock.module/mock.restore replaced node:fs.
//  - checkout drift: no suite may leave new or modified entries in the
//    checkout root or its .swarm/ (gitignored, so `git status` never reveals
//    them).
afterAll(() => {
	const failures: unknown[] = [];
	try {
		verifyRealStoresUnchanged();
	} catch (error) {
		failures.push(error);
	}
	try {
		reportCheckoutDrift(
			diffCheckout(checkoutBaseline, snapshotCheckout(repoRoot)),
			resolveDriftMode(process.env),
			repoRoot,
		);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) {
		throw new AggregateError(
			failures,
			failures
				.map((error) =>
					error instanceof Error ? error.message : String(error),
				)
				.join('\n\n'),
		);
	}
});
