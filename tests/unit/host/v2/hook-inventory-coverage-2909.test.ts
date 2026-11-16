/**
 * #2909 durable coverage guardrails for the v1→v2 hook inventory.
 *
 * Two properties, both CI-permanent:
 *  1. Every hook surface the plugin registers (quoted hook keys and structural
 *     registrations in src/index.ts; ctx registration surfaces used by the
 *     src/host/v2 adapter) has a ROW in docs/host/v2-hook-inventory.md, and
 *     every AGENTS.md invariant-10 contract sentence has a coverage token in
 *     that document (issue #2909 AC1/AC7). Census honesty notes: hook-key
 *     extraction recognizes single-quoted literals and requires a
 *     `'key':` registration context (bracket-read mentions are filtered);
 *     a key re-spelled with double quotes or backticks would evade the
 *     extraction — re-derive the census if the registration style changes.
 *  2. The slot's acceptance evidence artifacts (dual-host spike logs with
 *     their dist-sha bindings, first-turn-window measurement rows, ADR
 *     appendices, release fragment-or-consumed trail) cannot be silently
 *     deleted (issue #2909 closure contract "add tests for every acceptance
 *     row").
 *
 * Reads files only; no mocks, no tmp, no clock.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const SRC_INDEX = path.join(REPO_ROOT, 'src', 'index.ts');
const INVENTORY = path.join(REPO_ROOT, 'docs', 'host', 'v2-hook-inventory.md');
const ADR = path.join(
	REPO_ROOT,
	'docs',
	'decisions',
	'0003-opencode-v2-plugin-api.md',
);
const SPIKE_DIR = path.join(REPO_ROOT, 'spikes', 'v2-dual-shape');

const HOOK_KEY_RE =
	/'(experimental\.[a-zA-Z0-9.]+|tool\.execute\.before|tool\.execute\.after|chat\.message|command\.execute\.before)'/g;

/** The registration surfaces the v2 adapter is allowed to use; mirrors the
 * frozen C7 census (trace 2909) — extend deliberately, never by regex drift. */
const V2_REGISTRATION_SURFACES = [
	'tool.transform',
	'tool.hook',
	'agent.transform',
	'command.transform',
	'session.hook',
	'event.subscribe',
] as const;

/** AGENTS.md invariant-10 contract sentences → acceptable inventory coverage
 * patterns. A superset of the frozen C1 token set (trace 2909). Each sentence
 * is independently asserted; some patterns can be satisfied by the same doc
 * region (e.g. row 7 satisfies both output.system tokens), which is accepted
 * — the census proves presence per sentence, not per distinct doc line. */
const INVARIANT_10_SENTENCE_TOKENS: Array<[string, RegExp]> = [
	['v1 output.system string surface', /output\.system/],
	[
		'multiple output.system entries arrive one-per-part',
		/multiple `output\.system` entries/,
	],
	['v1 in-place output mutation rule', /in place|in-place/],
	['v2 in-place event.system/event.messages mutation', /event\.messages/],
	[
		'USER-role carriers via system-guidance-carrier',
		/system-guidance-carrier|swarm-guidance/,
	],
	['carrier re-homing into event.system', /re-home|rehome/],
	['one destination per guidance unit', /one destination/],
	['zero system entries after materialization', /materializ/],
	[
		'event.agent Agent.Info normalization',
		/event\.agent|Agent\.Info|normalized to a name/,
	],
	['chat.params/chat.headers carve-out recorded', /chat\.params/],
	['deliveredGuidanceDelta host-render predicates', /deliveredGuidanceDelta/],
];

/** The four ablation legs the spike must produce, each carrying exactly one
 * computed MATCH verdict (end-anchored so a MISMATCH line never counts). */
const ABLATION_LOGS = [
	'v1-nosetup-ablation.log',
	'v1-noserver-ablation.log',
	'v2-noserver-ablation.log',
	'v2-nosetup-ablation.log',
] as const;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('hook inventory coverage (#2909 AC1/AC7)', () => {
	const indexSrc = fs.readFileSync(SRC_INDEX, 'utf8');
	const inventory = fs.readFileSync(INVENTORY, 'utf8');

	test('every quoted hook key REGISTERED in src/index.ts has its own inventory ROW', () => {
		const mentioned = [
			...new Set([...indexSrc.matchAll(HOOK_KEY_RE)].map((m) => m[1])),
		];
		// Anti-vacuity: the census must extract the full registration set.
		expect(mentioned.length).toBeGreaterThanOrEqual(8);
		// Registration context filter: a `'key':` object-key occurrence, not a
		// bracket-read mention like !!pipelineHook['key'],.
		const registered = mentioned.filter((k) =>
			new RegExp(`'${escapeRegExp(k)}'\\s*:`).test(indexSrc),
		);
		expect(registered.length).toBeGreaterThanOrEqual(8);
		// ROW-scoped: the key must open a numbered inventory row's surface cell
		// (`| 13 | `chat.message` …`), so substring mentions in other rows do
		// not satisfy a deleted row (feedback PRR-001/TC-4).
		const missing = registered.filter(
			(k) =>
				!new RegExp(`\\| \\d+ \\| \\\`${escapeRegExp(k)}\\\``).test(inventory),
		);
		expect(missing).toEqual([]);
	});

	test('structural registrations exist in src/index.ts AND have inventory rows', () => {
		// Source side (the registration really is wired).
		expect(indexSrc).toMatch(/tool: buildPluginToolObject/);
		expect(indexSrc).toMatch(/\n\t\tevent: async/);
		expect(indexSrc).toMatch(/\n\t\tconfig: async/);
		expect(indexSrc).toMatch(/automation: automationManager/);
		// Inventory side (the row documents it).
		expect(inventory).toContain('buildPluginToolObject');
		expect(inventory).toMatch(/`event` observer/);
		expect(inventory).toMatch(/`config` hook/);
		expect(inventory).toMatch(/\| \d+ \| `automation:`/);
	});

	test('every AGENTS.md invariant-10 contract sentence has a coverage token', () => {
		for (const [sentence, pattern] of INVARIANT_10_SENTENCE_TOKENS) {
			expect(
				pattern.test(inventory),
				`invariant-10 sentence uncovered: ${sentence}`,
			).toBe(true);
		}
	});

	test('every v2 ctx registration surface used by the adapter has an inventory row', () => {
		const adapterDir = path.join(REPO_ROOT, 'src', 'host', 'v2');
		const adapterSrc = fs
			.readdirSync(adapterDir)
			.filter((f) => f.endsWith('.ts'))
			.map((f) => fs.readFileSync(path.join(adapterDir, f), 'utf8'))
			.join('\n');
		const used = V2_REGISTRATION_SURFACES.filter((s) => adapterSrc.includes(s));
		// Anti-vacuity: the adapter must still use the full registration set.
		expect(used).toEqual([...V2_REGISTRATION_SURFACES]);
		const missing = used.filter((s) => !inventory.includes(s));
		expect(missing).toEqual([]);
	});
});

describe('acceptance evidence durability (#2909 closure contract)', () => {
	test('dual-host spike evidence present with entrypoint, hook-firing, version, and ablation markers', () => {
		const readme = fs.readFileSync(path.join(SPIKE_DIR, 'README.md'), 'utf8');
		expect(readme).toContain('Method');
		expect(readme).toContain('Warnings');
		expect(readme).toContain('1.19.0');
		expect(readme).toContain('2.0.29');

		const v1Log = fs.readFileSync(
			path.join(SPIKE_DIR, 'logs', 'v1-host.log'),
			'utf8',
		);
		expect(v1Log).toMatch(/^HOST:.*1\.19\.0/m);
		// Anchored past the colon: the marker must NAME server() as the invoked
		// entrypoint, not merely contain the substring somewhere in the line
		// (implementation-review finding 1: prose mentioning the other host's
		// key satisfied the loose form).
		expect(v1Log).toMatch(/^ENTRYPOINT: server/m);
		expect(v1Log).toMatch(/^HOOK-FIRED:/m);

		const v2Log = fs.readFileSync(
			path.join(SPIKE_DIR, 'logs', 'v2-host.log'),
			'utf8',
		);
		expect(v2Log).toMatch(/^HOST:.*2\.0\.29/m);
		expect(v2Log).toMatch(/^ENTRYPOINT: setup/m);
		expect(v2Log).toMatch(/^HOOK-FIRED:/m);

		// Per-leg ablation assertions (feedback PRR-018): each canonical leg
		// carries exactly one computed MATCH verdict; the end anchor keeps a
		// MISMATCH line from ever counting as a MATCH.
		expect(
			fs.existsSync(path.join(SPIKE_DIR, 'logs', 'v2-nosetup-ablation.log')),
			'the v2 no-setup ablation log must exist',
		).toBe(true);
		for (const leg of ABLATION_LOGS) {
			const logPath = path.join(SPIKE_DIR, 'logs', leg);
			expect(fs.existsSync(logPath), `missing ablation leg ${leg}`).toBe(true);
			const text = fs.readFileSync(logPath, 'utf8');
			expect(
				(text.match(/^ABLATION:[^\n]*— MATCH$/gm) ?? []).length,
				`${leg} must carry exactly one computed MATCH verdict`,
			).toBe(1);
			expect(text).not.toMatch(/— MISMATCH|HARNESS ERROR/);
		}
		// The v2 negative leg quotes the host's literal decode error.
		expect(
			fs.readFileSync(
				path.join(SPIKE_DIR, 'logs', 'v2-nosetup-ablation.log'),
				'utf8',
			),
		).toContain(
			'Plugin must export a default definition with an id and an effect or setup function.',
		);
	});

	test('every committed spike log binds its build via a dist sha256 line (capture-time provenance; see README limitation)', () => {
		for (const name of ['v1-host.log', 'v2-host.log', ...ABLATION_LOGS]) {
			const text = fs.readFileSync(path.join(SPIKE_DIR, 'logs', name), 'utf8');
			expect(text, `${name} must carry a dist sha256 binding line`).toMatch(
				/dist sha256 [0-9a-f]{64}/,
			);
		}
	});

	test('first-turn-window measurement rows are pinned (the ADR numbers of record)', () => {
		const logsDir = path.join(SPIKE_DIR, 'logs');
		const rows = fs
			.readdirSync(logsDir)
			.filter((f) => /^first-turn-window-v1-run\d+\.json$/.test(f))
			.sort();
		expect(
			rows.length,
			'at least three committed v1 measurement rows',
		).toBeGreaterThanOrEqual(3);
		for (const name of rows) {
			const row = JSON.parse(
				fs.readFileSync(path.join(logsDir, name), 'utf8'),
			) as {
				distSha?: string;
				sessionCreatedToSyncLastMs?: number | null;
				firstTurnArrivedBeforeSyncDone?: boolean | null;
				capturedAt?: string;
			};
			expect(row.distSha, `${name} distSha`).toMatch(/^[0-9a-f]{64}$/);
			expect(
				row.firstTurnArrivedBeforeSyncDone,
				`${name} firstTurnArrivedBeforeSyncDone`,
			).toBe(true);
			expect(
				typeof row.sessionCreatedToSyncLastMs === 'number' &&
					row.sessionCreatedToSyncLastMs > 0,
				`${name} sessionCreatedToSyncLastMs must be a positive ms figure`,
			).toBe(true);
			expect(typeof row.capturedAt, `${name} capturedAt`).toBe('string');
		}
	});

	test('ADR-0003 status contract, first-turn appendix, and section-scoped invalidation re-check', () => {
		const adr = fs.readFileSync(ADR, 'utf8');
		// AC3 durable arm (final-critic finding 3): the ADR's status contract
		// must not silently flip after the trace-local frozen checks die.
		expect(adr).toContain('Accepted (2026-09-30)');
		expect(adr).toMatch(/^\*\*GO\.\*\*/m);
		// First-turn appendix: assert the LATEST section, so a future appended
		// erratum is what gets validated (feedback PRR-012; first-match pinned
		// the oldest section forever).
		const firstTurnMatches = [
			...adr.matchAll(
				/#[# ]*[^\n]*First-turn window[^\n]*\n([\s\S]*?)(\n#[#] |\n$)/g,
			),
		];
		expect(firstTurnMatches.length).toBeGreaterThanOrEqual(1);
		const section = firstTurnMatches[firstTurnMatches.length - 1][1];
		expect(section).toContain('Method');
		expect(section).toMatch(/\d+\s*ms/);
		expect(section).toMatch(/\d+\.\d+\.\d+/);
		// Invalidation re-check: asserted WITHIN its own section (stripping the
		// section's date must fail the test), not document-wide.
		const invalidation =
			/#[# ]*[^\n]*Invalidation re-check[^\n]*\n([\s\S]*?)(\n#[#] |\n$)/.exec(
				adr,
			);
		expect(invalidation).toBeTruthy();
		const invalidationSection = invalidation?.[1] ?? '';
		expect(invalidationSection).toMatch(/Re-checked 2026-\d{2}-\d{2}/);
		expect(invalidationSection).toContain('migrate-v1');
		expect(invalidationSection).toMatch(/no V1 compatibility shim/i);
	});

	test('release fragment for #2909: pending, or consumed with a manifest/body trail', () => {
		const fragmentName = '2909-adr0003-v2-hook-inventory-closure.md';
		const pending = fs.existsSync(
			path.join(REPO_ROOT, 'docs', 'releases', 'pending', fragmentName),
		);
		if (pending) return; // arm 1: still pending
		const releasesDir = path.join(REPO_ROOT, 'docs', 'releases');
		// arm 2: a release manifest records the consumed fragment path
		const manifests = fs
			.readdirSync(path.join(releasesDir, 'manifests'))
			.filter((f) => f.endsWith('.json'));
		const inManifest = manifests.some((f) =>
			fs
				.readFileSync(path.join(releasesDir, 'manifests', f), 'utf8')
				.includes(`docs/releases/pending/${fragmentName}`),
		);
		// arm 3: the fragment body's unique token landed in a release history doc
		const histories = fs
			.readdirSync(releasesDir)
			.filter((f) => /^v.*\.md$/.test(f));
		const inBody = histories.some((f) =>
			fs
				.readFileSync(path.join(releasesDir, f), 'utf8')
				.includes('2909-adr0003-v2-hook-inventory'),
		);
		expect(
			inManifest || inBody,
			`fragment ${fragmentName} neither pending nor consumed with a trail`,
		).toBe(true);
	});
});
