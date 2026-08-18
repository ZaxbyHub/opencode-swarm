/**
 * Bun test preload (issue #2033): install the production-store tripwire before ANY test
 * file loads, so the real platform knowledge-store paths are captured with pristine env
 * (no suite has redirected LOCALAPPDATA/XDG_DATA_HOME/HOME yet).
 *
 * Registered in bunfig.toml under [test] preload. Runs for every `bun test` invocation.
 * See tests/helpers/prod-store-tripwire.ts for the mechanism and rationale.
 *
 * Two global hooks (Bun supports hooks from preloads — verified by spike): an
 * afterEach that re-arms the fs guards after every test, and an afterAll bookend that
 * verifies the real stores are unchanged. Bun 1.3.14's mock.restore() does NOT strip
 * mock.module registrations (pinned by test), but if a future runtime changes that,
 * the re-arm keeps the guards active; the afterAll gives every suite a drift check
 * without growing individual over-cap test files (FR-006 line ratchet).
 */

import { afterAll, afterEach } from 'bun:test';
import {
	ensureTripwireGuardsArmed,
	installProdStoreTripwire,
	verifyRealStoresUnchanged,
} from '../helpers/prod-store-tripwire.js';

installProdStoreTripwire();

afterEach(async () => {
	await ensureTripwireGuardsArmed();
});

// Global bookend (issue #2033): EVERY suite must leave the real platform stores
// untouched. Registering this from the preload avoids growing individual over-cap test
// files (FR-006 line ratchet) and covers all suites uniformly. Verify uses
// preload-time-captured fs functions, so it works even if a suite's own
// mock.module/mock.restore replaced node:fs.
afterAll(() => {
	verifyRealStoresUnchanged();
});
