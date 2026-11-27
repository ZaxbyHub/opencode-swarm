# SpecStream as an opt-in General Council search provider

`council.general.searchProvider` accepts `"specstream"`, beside Tavily, Brave and Keenable. The default stays `tavily`, so nothing changes unless a config selects it.

- Each search is one `GET https://api.specstream.ai/v1/web-search` with `q` and `num`, authenticated with `SPECSTREAM_API_KEY` as a Bearer token. Redirects are refused.
- The key is read only from `SPECSTREAM_API_KEY`. A Tavily or Brave `council.general.searchApiKey` is never sent to SpecStream, the same scoping Keenable has (#3762).
- Without the key, `web_search` returns the structured missing key result and no request is made.
- Results map the reply's `data.sources` to the shared title, URL and snippet shape; sources without a snippet are dropped, as for the other providers.
- Freshness is not mapped for SpecStream, so it is not reported as applied.

No migration is needed. A config that selects `specstream` is rejected by plugin versions that predate it, so switch `searchProvider` back to a supported value before downgrading.
