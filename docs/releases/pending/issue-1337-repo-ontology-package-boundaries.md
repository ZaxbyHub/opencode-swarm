## feat: repo-map ontology and package-boundary context (#1337)

Adds richer repository intelligence to the existing `repo_map` surface:

- `repo_map action="build"` now writes the same `src/tools/repo-graph` schema
  used by startup graph injection, eliminating the legacy `src/graph` vs.
  startup-graph mismatch.
- Repo graph nodes now include conservative ontology facts: file roles, route
  facts, data-operation facts, security-related detections, conventions, and
  findings.
- New `repo_map` actions expose `ontology`, `package_boundaries`, and
  `preflight_packet` data for planning and review.
- Coder/reviewer graph injections and semantic-diff consumer counts now read
  the active startup graph schema.
- `package.json#exports` now declares the root plugin entry and package
  metadata boundary without changing the published `dist/index.js` runtime
  contract; the Bun-targeted CLI remains exposed through `bin`.
- Swarm and issue-tracer skills now require implementation reviewer approval
  plus a separate final critic approval on the latest diff and evidence before
  changed-work completion can be claimed.

The ontology extractor is bounded and startup-safe; it does not load
tree-sitter grammars during plugin initialization.
