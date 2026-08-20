import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	collectEventContractErrors,
	collectLifecyclePairingErrors,
} from '../../../scripts/check-event-contract';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Tests for check 11 — the delegation lifecycle producer-inventory guardrail.
 *
 * The check itself is the recurrence guardrail for "a lifecycle pair acquires
 * producers for only one half". These tests exist so that a future edit to its
 * regex or its file walk cannot silently change what it detects: without them
 * the guardrail could be weakened to a no-op and every suite would stay green.
 *
 * Every case drives a synthetic fixture tree through the injectable `root`
 * parameter, so none of them depend on the real repository's current producer
 * layout (which the sibling assertion in the checker already pins).
 */

let root: string;

function writeSource(relativePath: string, contents: string): void {
	const absolute = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, contents);
}

/** Reproduces the real inventory's expectations so drift is the only variable. */
function writeCanonicalProducers(): void {
	// The session pair's only producer: one start, no end (its recorded knownGap).
	writeSource('src/state.ts', 'telemetry.sessionStarted(sessionId, agent);\n');
	writeSource(
		'src/index.ts',
		'telemetry.delegationBegin(a, b, c);\ntelemetry.delegationEnd(a, b, c, d, e);\n',
	);
	writeSource(
		'src/review/engine.ts',
		[
			'telemetry.delegationBegin(a, b, c);',
			'telemetry.delegationEnd(a, b, c, d, e);',
			'telemetry.delegationBegin(a, b, c);',
			'telemetry.delegationEnd(a, b, c, d, e);',
		].join('\n'),
	);
	writeSource(
		'src/hooks/review-receipt-collector.ts',
		'_internals.delegationBegin(a, b, c);\n_internals.delegationEnd(a, b, c, d, e);\n',
	);
}

beforeEach(() => {
	root = canonicalMkdtemp('delegation-pairing-check-');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('collectLifecyclePairingErrors', () => {
	test('a fixture matching the inventory produces no errors', () => {
		writeCanonicalProducers();
		expect(collectLifecyclePairingErrors(root)).toEqual([]);
	});

	test('flags a file that ends a delegation lifecycle without beginning one', () => {
		writeCanonicalProducers();
		writeSource('src/rogue.ts', 'telemetry.delegationEnd(a, b, c, d, e);\n');

		const errors = collectLifecyclePairingErrors(root);
		expect(
			errors.some(
				(error) =>
					error.includes('src/rogue.ts') &&
					error.includes('no delegationBegin'),
			),
		).toBe(true);
	});

	test('flags a new producer file that is absent from the inventory', () => {
		writeCanonicalProducers();
		writeSource(
			'src/newcomer.ts',
			'telemetry.delegationBegin(a, b, c);\ntelemetry.delegationEnd(a, b, c, d, e);\n',
		);

		// Paired, so NOT a half-lifecycle — caught purely by the inventory ratchet.
		const errors = collectLifecyclePairingErrors(root);
		expect(
			errors.some(
				(error) =>
					error.includes('src/newcomer.ts') &&
					error.includes('not in LIFECYCLE_PAIR_INVENTORY'),
			),
		).toBe(true);
		expect(
			errors.some(
				(error) =>
					error.includes('src/newcomer.ts') &&
					error.includes('no delegationBegin'),
			),
		).toBe(false);
	});

	test('flags count drift inside a file that still contains other begins', () => {
		// The exact hole a file-level "does this file contain a begin?" check
		// misses: engine.ts keeps one paired begin and gains an unpaired end.
		writeCanonicalProducers();
		writeSource(
			'src/review/engine.ts',
			[
				'telemetry.delegationBegin(a, b, c);',
				'telemetry.delegationEnd(a, b, c, d, e);',
				'telemetry.delegationEnd(a, b, c, d, e);',
			].join('\n'),
		);

		const errors = collectLifecyclePairingErrors(root);
		expect(
			errors.some(
				(error) =>
					error.includes('src/review/engine.ts') &&
					error.includes('1 delegationBegin and 2 delegationEnd'),
			),
		).toBe(true);
	});

	test('flags a stale inventory entry whose file no longer produces events', () => {
		writeSource(
			'src/index.ts',
			'telemetry.delegationBegin(a, b, c);\ntelemetry.delegationEnd(a, b, c, d, e);\n',
		);

		const errors = collectLifecyclePairingErrors(root);
		expect(
			errors.some(
				(error) =>
					error.includes('src/review/engine.ts') &&
					error.includes('Remove the stale entry'),
			),
		).toBe(true);
	});

	test('fails loudly rather than vacuously when the scan finds no files', () => {
		// A broken walk or a wrong root must turn CI red, never silently green.
		const errors = collectLifecyclePairingErrors(
			path.join(root, 'does-not-exist'),
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('scanned 0 files');
	});

	test('a commented-out producer no longer counts, so the defect cannot return green', () => {
		// The most dangerous bypass: raw-text matching counted a commented-out
		// begin, leaving counts unchanged while the unpaired end was live again.
		writeCanonicalProducers();
		writeSource(
			'src/review/engine.ts',
			[
				'// telemetry.delegationBegin(a, b, c);',
				'telemetry.delegationEnd(a, b, c, d, e);',
				'telemetry.delegationBegin(a, b, c);',
				'telemetry.delegationEnd(a, b, c, d, e);',
			].join('\n'),
		);

		const errors = collectLifecyclePairingErrors(root);
		expect(
			errors.some(
				(error) =>
					error.includes('src/review/engine.ts') &&
					error.includes('1 delegationBegin and 2 delegationEnd'),
			),
		).toBe(true);
	});

	test('the recorded session_ended gap stays empty, and closing it trips the gate', () => {
		// The gap is mechanically encoded, not just prose: the first sessionEnded
		// producer must fail this check so the pair is closed deliberately.
		writeCanonicalProducers();
		expect(collectLifecyclePairingErrors(root)).toEqual([]);

		writeSource(
			'src/session-closer.ts',
			'telemetry.sessionStarted(s, a);\ntelemetry.sessionEnded(s, "done");\n',
		);
		const errors = collectLifecyclePairingErrors(root);
		expect(
			errors.some(
				(error) =>
					error.includes('known gap') &&
					error.includes('sessionEnded') &&
					error.includes('session'),
			),
		).toBe(true);
	});

	test('check 11 is actually wired into the aggregate the CLI and drift-check run', () => {
		// Without this pin, deleting the single call inside collectEventContractErrors
		// would silently disarm the guardrail while every other test stayed green.
		// Static-analysis pin, mirroring tests/unit/hooks/hook-composition.test.ts.
		const checkerPath = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			'../../../scripts/check-event-contract.ts',
		);
		const source = fs.readFileSync(checkerPath, 'utf-8');
		const aggregateStart = source.indexOf(
			'export function collectEventContractErrors',
		);
		// A rename of the aggregate must fail loudly, not make the slice vacuous.
		expect(aggregateStart).toBeGreaterThan(-1);
		// Bound the slice to the aggregate's OWN body — the file indents with tabs,
		// so the first `}` at column 0 after the declaration closes it. Slicing to
		// EOF would be satisfied by a call relocated into any later function.
		const bodyEnd = source.indexOf('\n}', aggregateStart);
		expect(bodyEnd).toBeGreaterThan(aggregateStart);
		// Drop comment lines so a commented-out call cannot satisfy the pin.
		const executableBody = source
			.slice(aggregateStart, bodyEnd)
			.split('\n')
			.filter((line) => !line.trim().startsWith('//'))
			.join('\n');
		expect(executableBody).toContain('collectLifecyclePairingErrors()');
		// And the aggregate really is callable against the live repo.
		expect(Array.isArray(collectEventContractErrors())).toBe(true);
	});

	test('ignores test files and the telemetry definition module', () => {
		writeCanonicalProducers();
		// Neither of these is a producer: tests are their own runtime, and
		// src/telemetry.ts defines the wrappers.
		writeSource(
			'src/rogue.test.ts',
			'telemetry.delegationEnd(a, b, c, d, e);\n',
		);
		writeSource(
			'src/telemetry.ts',
			'telemetry.delegationEnd(a, b, c, d, e);\n',
		);

		expect(collectLifecyclePairingErrors(root)).toEqual([]);
	});
});
