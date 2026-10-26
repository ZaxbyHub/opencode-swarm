# v2 context bridge keeps tool-call pairing for id-less host messages

## What

- On OpenCode V2, the `session.hook('context')` bridge (`onV2ContextEvent`) now stamps every v1 view with its index in the original `event.messages` (`info.swarmV2Origin`) and pairs each transformed view back to its v2 message by **object identity**, then **`id`**, then that **origin stamp**. There is no positional fallback.
- A message that carries non-text parts (tool calls, tool results, media) is not dropped when the chain drops its view (other than a consumed carrier source, below). Messages are rebuilt in the host's order.
- A message consumed as a guidance carrier source is removed from the list (its text is delivered once, in `event.system`), so each guidance unit has exactly one destination.
- Transformed text is written back **in position**, so an assistant's preamble stays before its tool call.
- Message content that is not an array (out of contract) is left untouched instead of being split or throwing.

## Why

The v2 host's context messages carry no `id`, so every message was paired back by position. The v1 chain changes the view count: `materializeSystemGuidanceInPlace` converts a mid-history system entry into a re-homed carrier, and other stages splice in verdicts. Every later view then landed on the wrong message and the trailing message was dropped. An assistant `tool-call` lost its `tool-result`, and the provider rejected the request (`unexpected tool_use_id found in tool_result blocks`). The guardrails retry rollback replaces every view with a `structuredClone`, which defeats identity pairing; the origin stamp is a plain string key, so it survives the clone.

## Migration steps

None.

## Known caveats

- On the v2 host, id-less views inserted by the v1 chain (the full-auto verdict and continuation messages) have no origin and are dropped. They are not delivered to the model. Previously they were written onto an unrelated message.
- The v1 host path and the v1 hook chain are unchanged.
- The live-run figures (2 of 5 runs failed before, 0 of 8 after, opencode 2.1.3, three-step shell scenario with opencode-swarm as the only plugin; 0 of 3 failed with a full plugin set) are the PR author's manual measurement taken before the origin-stamp change. They are not reproducible in CI.
