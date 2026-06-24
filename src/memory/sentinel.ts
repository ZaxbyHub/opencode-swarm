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
