import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * #2107 §2: "avoid producer-order races by defining and testing the actual
 * hook composition order."
 *
 * The OpenCode host executes each hook chain in registration order, and the
 * plugin registers both chat transform chains as one composed handler each in
 * src/index.ts. This test source-scans those two registration arrays (the
 * chat-transform-rebind-guard precedent) and pins the ordering invariants the
 * per-turn producer ledger depends on:
 *
 * messages.transform:
 *   advisory drain  <  memory recall  <  knowledge injector  <
 *   system-entry materialization (final structure mutation, issue #2526)  <  final context accounting
 * system.transform:
 *   system-enhancer (begins the turn ledger)  <  context capsule (claims)
 *
 * Reversing or accidentally reordering any pair fails here with the two
 * out-of-order symbols.
 */

const INDEX_TS = path.join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'src',
	'index.ts',
);

const source = fs.readFileSync(INDEX_TS, 'utf-8');

/** Slice the source between two anchor strings (pure — no expect outside tests). */
function between(start: string, end: string): string {
	const i = source.indexOf(start);
	if (i < 0) {
		throw new Error(`anchor not found in src/index.ts: ${start}`);
	}
	const j = source.indexOf(end, i);
	if (j <= i) {
		throw new Error(`end anchor not found after start: ${end}`);
	}
	return source.slice(i, j);
}

const messagesChain = between(
	"'experimental.chat.messages.transform': composeHandlers(",
	"'experimental.text.complete'",
);
const systemChain = between(
	"'experimental.chat.system.transform': composeHandlers(",
	"'experimental.session.compacting'",
);

function orderOf(chain: string, symbol: string): number {
	const idx = chain.indexOf(symbol);
	if (idx < 0) {
		throw new Error(`symbol not found in chain: ${symbol}`);
	}
	return idx;
}

describe('messages.transform composition order (#2107 §2)', () => {
	test('advisory drain runs before memory recall', () => {
		expect(
			orderOf(messagesChain, 'durableBackgroundAdvisoryMessagesTransform'),
		).toBeLessThan(
			orderOf(messagesChain, 'memoryLifecycleHooks.messagesTransform'),
		);
	});

	test('memory recall runs before the knowledge injector', () => {
		expect(
			orderOf(messagesChain, 'memoryLifecycleHooks.messagesTransform'),
		).toBeLessThan(orderOf(messagesChain, 'knowledgeInjectorHook'));
	});

	test('knowledge injector runs before the system-entry materializer', () => {
		expect(orderOf(messagesChain, 'knowledgeInjectorHook')).toBeLessThan(
			orderOf(
				messagesChain,
				'materializeSystemGuidanceInPlace(output.messages)',
			),
		);
	});

	test('materializer runs before final context accounting', () => {
		expect(
			orderOf(
				messagesChain,
				'materializeSystemGuidanceInPlace(output.messages)',
			),
		).toBeLessThan(orderOf(messagesChain, 'finalContextAccountingStep'));
	});

	test('the materializer is the last STRUCTURE-mutating handler (accounting is read-mostly)', () => {
		const materializer = orderOf(
			messagesChain,
			'materializeSystemGuidanceInPlace(output.messages)',
		);
		const after = messagesChain
			.slice(materializer + 1)
			.slice(
				0,
				orderOf(
					messagesChain.slice(materializer + 1),
					'finalContextAccountingStep',
				),
			);
		// Nothing between the materializer and the accounting step may splice,
		// unshift, or reassign the messages array.
		expect(/messages\s*=\s|\.splice\(|\.unshift\(/.test(after)).toBe(false);
	});
});

describe('system.transform composition order (#2107 §2)', () => {
	test('system-enhancer (begins the turn ledger) runs before the capsule injector (claims from it)', () => {
		expect(
			orderOf(
				systemChain,
				"systemEnhancerHook['experimental.chat.system.transform']",
			),
		).toBeLessThan(
			orderOf(
				systemChain,
				"contextCapsuleInjectHook['experimental.chat.system.transform']",
			),
		);
	});

	test('the capsule injector runs before the swarm-command banner (both record emissions)', () => {
		expect(
			orderOf(
				systemChain,
				"contextCapsuleInjectHook['experimental.chat.system.transform']",
			),
		).toBeLessThan(orderOf(systemChain, 'swarmCommandSystemRuleHook'));
	});
});

describe('session compaction advances the ledger generation (#2107 §4)', () => {
	test('the compacting handler wraps advanceTurnGeneration before the customizer', () => {
		const region = between(
			"'experimental.session.compacting': (async (",
			'command.execute.before',
		);
		expect(region.indexOf('advanceTurnGeneration')).toBeGreaterThanOrEqual(0);
		expect(region.indexOf('advanceTurnGeneration')).toBeLessThan(
			region.indexOf("compactionHook['experimental.session.compacting']"),
		);
	});
});
