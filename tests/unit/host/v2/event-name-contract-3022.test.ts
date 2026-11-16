import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PUMP_SIDE_READ_EVENT_NAMES } from '../../../../src/host/v2/events';

/**
 * Issue #3022 guardrail (Phase 4.2, plan Part F): the v2 event mapper's
 * case-label set is pinned EXACTLY. Every label is either a live plugin-stream
 * name (D3 capture, @opencode/cli 2.0.21), an SDK SSE/REST-dialect name, or a
 * documented vendored-era legacy name. Adding or removing a label without
 * updating this frozen set (and the inventory row) is a contract change the
 * test forces you to make consciously — the #3022 defect class was exactly an
 * unverified name drifting from every real host dialect.
 */
const FROZEN_CASE_LABELS = [
	'session.idle',
	'session.status.updated',
	'session.status',
	'session.error',
	'session.execution.failed',
	'session.deleted',
	'session.created',
	'session.text.delta',
	'session.tool.called',
	'session.tool.input.delta',
	// #3401: subagent-gated synthesis of the v1 scope-activation ToolPart from
	// the child-identity progress event (live capture 2.0.29; schema at 2.0.32).
	'session.tool.progress',
	'session.text.ended',
	'session.tool.success',
	'session.tool.failed',
] as const;

describe('#3022 v2 event-name contract (mapV2EventToV1 case labels)', () => {
	test('the mapper case-label set matches the frozen contract exactly', () => {
		const sourcePath = path.resolve(
			import.meta.dir,
			'../../../../src/host/v2/events.ts',
		);
		const source = fs.readFileSync(sourcePath, 'utf-8');
		const labels = [...source.matchAll(/^\t\tcase '([^']+)':/gm)].map(
			(m) => m[1] as string,
		);
		expect([...labels].sort()).toEqual([...FROZEN_CASE_LABELS].sort());
	});

	// #3401 (PR #3402 review PRR-004): names read PUMP-SIDE (not mapper case
	// labels) are equally load-bearing — the subagent gate depends on
	// `session.tool.input.started`. Scrape the pump-side read literals from
	// the module source and require set-equality with the exported list, so a
	// rename in EITHER direction (list entry vs production read) fails — the
	// #3022 defect class (an unverified name drifting from every real host
	// dialect) cannot silently disable the feature with all tests green.
	test('the pump-side read event names match the exported list exactly', () => {
		const sourcePath = path.resolve(
			import.meta.dir,
			'../../../../src/host/v2/events.ts',
		);
		const source = fs.readFileSync(sourcePath, 'utf-8');
		// Pump-side reads compare the envelope type against a literal in one
		// of two shapes (`envelope?.type !== '…'` in the registry reader,
		// `type !== '…'` in the identity seeder); the mapper's own reads are
		// `case` labels, pinned above. Subtract the case labels so the set is
		// exactly the pump-side-only names.
		const pumpReads = [
			...new Set(
				[
					...source.matchAll(/envelope\?\.type !== '([^']+)'/g),
					...source.matchAll(/type !== '([^']+)'/g),
				].map((m) => m[1] as string),
			),
		];
		const pumpOnly = pumpReads.filter(
			(name) => !(FROZEN_CASE_LABELS as readonly string[]).includes(name),
		);
		expect([...pumpOnly].sort()).toEqual(
			[...PUMP_SIDE_READ_EVENT_NAMES].sort(),
		);
		// The registry reader is wired into the pump, not dead code.
		expect(source).toContain('rememberToolNameFromEnvelope(envelope);');
		expect(source).toContain(
			'mapV2EventToV1(envelope, lookupToolNameForDispatch);',
		);
	});
});
