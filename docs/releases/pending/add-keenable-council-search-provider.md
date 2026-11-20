# Keenable is now an optional General Council web search provider

## What

`council.general.searchProvider` accepts a third value, `"keenable"`, alongside
`"tavily"` (still the default) and `"brave"`. Nothing changes unless you set it.

- **Keyless by default.** Keenable works without an API key: the council
  pre-search pass posts to `https://api.keenable.ai/v1/search/public`, so General
  Council web search can run before a Tavily or Brave key exists.
- **Optional key.** If `KEENABLE_API_KEY` is set, requests go to the keyed
  endpoint `https://api.keenable.ai/v1/search` with an `X-API-Key` header.
- **The shared `searchApiKey` is never sent to Keenable.** A `council.general.searchApiKey`
  value left in your configuration for Tavily or Brave is intentionally ignored when
  the provider is `keenable`, so a project-level config that only switches
  `searchProvider` cannot forward a key you set for another vendor. Keenable
  reads its key from the `KEENABLE_API_KEY` environment variable only.
- **Same safety rails as the other providers.** Requests share the existing timeout
  wrapper and typed errors, and refuse HTTP redirects (`redirect: 'error'`).
  Results map onto the existing `WebSearchResult` shape (`title`, `url`, and
  `snippet` with a `description` fallback).
- **Wiring.** The council and deep-research skills, the architect prompt, the
  `web_search` tool description and the command help no longer say a Tavily or
  Brave key is required, so a keyless Keenable configuration is no longer refused
  before the first search. The JSON schema and `docs/configuration.md` list the
  new value.

## Why

Tavily and Brave both need a key before the council can search the web at all.
Keenable removes that setup step for first-time users who want grounded council
answers.

## Migration

No action required. To opt in, set `council.general.searchProvider` to
`"keenable"`; add `KEENABLE_API_KEY` to your environment only if you have a
Keenable account.

## Caveats

- **Privacy.** Keyless requests are sent to Keenable's public endpoint, which logs the
  query text and your IP address. Keyless limits are 1,000 requests per hour and
  10 per second per IP (see https://docs.keenable.ai/rate-limits). Choose
  Tavily or Brave, or set `KEENABLE_API_KEY`, if that is not acceptable for your
  queries.
- **Freshness is not mapped.** The provider does not send a time-range filter to
  Keenable, so the `web_search` tool does not report `freshness` as applied for
  this provider. Stale years are still stripped from the query text.
- Tavily and Brave behavior is unchanged.
