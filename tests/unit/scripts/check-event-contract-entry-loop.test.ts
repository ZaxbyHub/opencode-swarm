import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	collectEntryErrors,
	collectEventContractErrors,
} from '../../../scripts/check-event-contract.ts';
import {
	CATALOG_KINDS,
	type CatalogEntry,
} from '../../../src/observability/catalog.ts';

/**
 * FB-011: end-to-end coverage of the gate's PER-ENTRY loop conditions.
 *
 * These conditions previously lived inline in a zero-parameter collector that
 * read the real repo, so neutering any one of them left the suite green — proven
 * by mutation during PR #2056 feedback. `collectEntryErrors` was extracted with
 * injectable root/doc paths precisely so each condition is reachable here.
 */
function fixtureRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-entry-'));
	fs.mkdirSync(path.join(root, 'src'), { recursive: true });
	fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src', 'p.ts'), "emit('k', {\n});\n");
	fs.writeFileSync(path.join(root, 'tests', 't.test.ts'), '');
	fs.writeFileSync(path.join(root, 'doc.md'), '#### k\nbody\n');
	return root;
}
const DOC = (root: string) => path.join(root, 'doc.md');

function good(): CatalogEntry {
	return {
		category: 'lifecycle',
		severity: 'info',
		privacyClass: 'operational',
		producer: 'src/p.ts:1',
		consumers: [],
		futureOwnerIssue: 2047,
		retentionOwnerIssue: 2047,
		requiredWorkflowIds: [],
		forbiddenWorkflowIds: [],
		requiresParent: false,
		allowsLinks: true,
		otelMapping: 'none',
		docAnchor: '#k',
		testFile: 'tests/t.test.ts',
	} as unknown as CatalogEntry;
}

describe('collectEntryErrors — per-entry gate conditions (FB-011)', () => {
	test('a fully valid entry yields no errors (anti-vacuity baseline)', () => {
		const root = fixtureRoot();
		expect(collectEntryErrors('k', good(), root, DOC(root))).toEqual([]);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('malformed producer format is reported', () => {
		const root = fixtureRoot();
		const e = { ...good(), producer: 'nope' } as CatalogEntry;
		expect(collectEntryErrors('k', e, root, DOC(root)).join('|')).toContain(
			'producer',
		);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('retention owner below the floor is reported', () => {
		const root = fixtureRoot();
		const e = { ...good(), retentionOwnerIssue: 1999 } as CatalogEntry;
		expect(collectEntryErrors('k', e, root, DOC(root)).join('|')).toContain(
			'retentionOwnerIssue',
		);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('missing docAnchor is reported', () => {
		const root = fixtureRoot();
		const e = { ...good(), docAnchor: '' } as CatalogEntry;
		expect(collectEntryErrors('k', e, root, DOC(root)).join('|')).toContain(
			'docAnchor',
		);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('docAnchor with no matching heading is reported', () => {
		const root = fixtureRoot();
		const e = { ...good(), docAnchor: '#absent' } as CatalogEntry;
		expect(collectEntryErrors('k', e, root, DOC(root)).join('|')).toContain(
			'absent',
		);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('missing testFile is reported', () => {
		const root = fixtureRoot();
		const e = { ...good(), testFile: '' } as CatalogEntry;
		expect(collectEntryErrors('k', e, root, DOC(root)).join('|')).toContain(
			'testFile',
		);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('empty consumers with no futureOwnerIssue is reported', () => {
		const root = fixtureRoot();
		const e = {
			...good(),
			consumers: [],
			futureOwnerIssue: undefined,
		} as unknown as CatalogEntry;
		expect(collectEntryErrors('k', e, root, DOC(root)).join('|')).toContain(
			'futureOwnerIssue',
		);
		fs.rmSync(root, { recursive: true, force: true });
	});

	/**
	 * FB-014: these two pin the DELIBERATE ABSENCE of an issue-number ceiling.
	 *
	 * `scripts/check-event-contract.ts` used to carry
	 * `MAX_RETENTION_OWNER_ISSUE = 2051` plus two `> MAX` clauses. Those were
	 * removed on purpose: once the #2030-#2051 programme closes, a pinned ceiling
	 * hard-fails any new kind whose real owner issue is numbered above the window,
	 * with no escape hatch — which pressures a contributor to cite a FALSE in-window
	 * issue just to get green. A stale-but-truthful citation beats an in-range lie.
	 *
	 * Nothing else in the suite feeds an ABOVE-window value, so re-adding the
	 * ceiling was a mutation that survived with everything green. These assertions
	 * fail the moment an upper bound comes back.
	 */
	test('an ABOVE-window retentionOwnerIssue is accepted (no upper bound)', () => {
		const root = fixtureRoot();
		const e = { ...good(), retentionOwnerIssue: 9999 } as CatalogEntry;
		expect(collectEntryErrors('k', e, root, DOC(root))).toEqual([]);
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('an ABOVE-window futureOwnerIssue is accepted (no upper bound)', () => {
		const root = fixtureRoot();
		const e = {
			...good(),
			consumers: [],
			futureOwnerIssue: 9999,
		} as CatalogEntry;
		expect(collectEntryErrors('k', e, root, DOC(root))).toEqual([]);
		fs.rmSync(root, { recursive: true, force: true });
	});
});

/**
 * FB-011 (round 2): the per-entry CALL SITE, not just the conditions.
 *
 * Extracting `collectEntryErrors` made its conditions reachable, but the loop in
 * `collectEventContractErrors` still called it directly — so replacing
 * `errors.push(...collectEntryErrors(kind, entry))` with a comment left the suite
 * byte-identical AND `check:events` still printed "Event contract check passed".
 * The gate could be gutted with zero signal.
 *
 * `scripts/check-event-contract.ts` now routes the loop through the `_internals`
 * DI seam (AGENTS.md invariant 7), so stubbing the collector proves the loop
 * really invokes it — once per catalogued kind, with that kind's key. If anyone
 * disconnects the loop, or inlines a direct call that bypasses the seam, the stub
 * stops being reached and these fail.
 */
describe('collectEventContractErrors — per-entry loop wiring (FB-011)', () => {
	const realCollectEntryErrors = _internals.collectEntryErrors;

	afterEach(() => {
		_internals.collectEntryErrors = realCollectEntryErrors;
	});

	test('the loop routes every catalogued kind through collectEntryErrors', () => {
		const seen: string[] = [];
		_internals.collectEntryErrors = (kind: string) => {
			seen.push(kind);
			return ['SENTINEL'];
		};

		const errors = collectEventContractErrors();

		expect(errors.filter((e) => e === 'SENTINEL')).toHaveLength(
			CATALOG_KINDS.length,
		);
		expect(seen).toEqual([...CATALOG_KINDS]);
	});

	test('the real (unstubbed) collector emits no SENTINEL — anti-vacuity', () => {
		expect(collectEventContractErrors()).not.toContain('SENTINEL');
	});
});
