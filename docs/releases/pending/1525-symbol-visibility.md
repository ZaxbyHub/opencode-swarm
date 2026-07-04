## Symbol Graph

- Added a shared language-neutral symbol visibility framework for `extractFileSymbols`, including explanatory `visibilityInfo` metadata and a backward-compatible `defs[].exported` boolean.
- Public/addressable top-level symbols in supported non-ESM languages now flow into async repo-graph `exports`, `exportLines`, and `exportRanges` instead of being limited to explicit ESM export statements.
- Documented that visibility metadata is extraction-time API data and does not change the persisted repo graph schema.
