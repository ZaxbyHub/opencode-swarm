Fixes sync/async config-loader drift, `full_auto.locked` OR-merge gap in the
async path, and silent gates-strip recovery metadata (#1900).

- **Shared core**: `buildConfigWithMeta` is now the single source of truth for
  the merge → `full_auto.locked` OR → migrate → sanitize → parse → fallback
  pipeline. All three entry points (`loadPluginConfig`,
  `loadPluginConfigWithMeta`, `loadPluginConfigWithMetaAsync`) call it, making
  sync/async drift structurally impossible.
- **`full_auto.locked` async fix**: the async path (`loadPluginConfigWithMetaAsync`,
  used by the plugin init path per issue #704) now correctly applies the
  `full_auto.locked` OR-merge, closing the administrative hard-off bypass that
  existed when user config set `locked: true` and project config set
  `locked: false`.
- **Gates-strip visibility**: `loadPluginConfigWithMeta[Async]` now returns
  `recovery: 'stripped_keys'` and lists the stripped dotted key paths in
  `removedKeys` when `sanitizeGatesConfig` silently discards unknown `gates.*`
  keys. Previously both functions returned `recovery: 'none'` even when gates
  keys were stripped.
- **Recovery metadata**: both functions return `recovery` (`'none'` |
  `'stripped_keys'` | `'user_only'` | `'guardrails_defaults'`),
  `removedKeys: string[]`, and `warnings: string[]` so consumers can surface
  config-health information without re-parsing the advisory buffer.
- **Parity test**: `tests/unit/config/loader.metadata.parity.test.ts` runs both
  loaders against ten fixture types, including separate invalid-project and
  invalid-both JSON cases plus invalid `external_skills`, and
  asserts semantic equality on config + recovery metadata (with removed-key
  order intentionally ignored); a future edit to one path that forgets the
  other will fail this test immediately.

No migration required.
