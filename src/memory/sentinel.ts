/**
 * Single source of truth for the recall-injection sentinel header.
 *
 * DEPENDENCY-FREE leaf module. The injector emits this header to mark an
 * injected "## Retrieved Swarm Memory" block, and `messagesContainRecall`
 * uses it to avoid double-injection. Because that check trusts the substring,
 * stored memory text must never be allowed to contain it (DD-14): a memory
 * whose text embeds the sentinel, once injected, would make a later injection
 * believe recall already happened and silently skip it.
 *
 * Both the emitter (`prompt-block.ts`) and the write-time guard
 * (`schema.ts:validateMemoryRecordRules`) import from here so the header and
 * the guard can never drift apart.
 */
export const MEMORY_RECALL_SENTINEL = '## Retrieved Swarm Memory';

/**
 * #1466 (DD-14): the unforgeable recall-injection anchor. Every injected
 * recall block embeds the bundle id produced by `createBundleId`
 * (schema.ts — `bundle_<14 digits>_<8 hex>`), and `messagesContainRecall`
 * accepts ONLY that marker (plus the write-banned full sentinel header, for
 * blocks injected by pre-#1466 builds still in flight). Stored memory text
 * containing the literal `bundle_` prefix is rejected at write time
 * (`validateMemoryRecordRules`), so no stored memory can forge the anchor.
 * The regex pins the exact `createBundleId` shape to avoid prose false
 * positives.
 */
export const RECALL_BUNDLE_MARKER_RE = /\bbundle_\d{14}_[0-9a-f]{8}\b/;
