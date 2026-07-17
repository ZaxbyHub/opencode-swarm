/**
 * Node-target re-export barrel consumed ONLY by `scripts/repro-1873.mjs` (issue #1873).
 *
 * The plugin's SQLite entry points are not exported from the plugin manifest
 * (`src/index.ts`), so the Node harness cannot reach them through `dist/index.js`.
 * This tiny barrel is bundled `--target node` to a gitignored dir by
 * `bun run repro:1873`, letting the harness drive the REAL shipped DB + memory code
 * paths under Node (where `bun:sqlite` is absent) and prove the `node:sqlite` fallback.
 * It is a test harness entry only: never added to `package.json#files`, never shipped.
 */
export {
	closeAllProjectDbs,
	closeGlobalDb,
	getGlobalDb,
	getProjectDb,
} from '../src/db/index.js';
export {
	computeMemoryContentHash,
	createMemoryId,
} from '../src/memory/schema.js';
export { SQLiteMemoryProvider } from '../src/memory/sqlite-provider.js';
