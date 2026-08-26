# Harden Dart, Ruby, and PHP Symbol Graph Support

## What

- **Dart (`.dart`)**: `_`-prefix privacy convention; `class`/`mixin`/`enum`/
  `extension`/`typedef` type defs including Dart 3 forms (`extension type`
  captures the type's name; `base`/`final`/`interface`/`sealed`/`abstract`
  modifiers don't change the captured name; unnamed `extension on X` produces
  no def); `import` directives with `show` named bindings and `as` prefix
  semantics (namespace, no fake named binding — including `as` combined with
  `show`/`hide`); `export` directives produce re-export edges with exported
  bindings; `package:` URIs recorded as specifiers (external, no file edge).
- **Ruby (`.rb`, `.rake`, `.gemspec`)**: `module`/`class`/constant defs;
  `def` methods typed `method` with bare `private`/`protected` section
  tracking (reset on class/module; the `private :sym` form targets one method
  and does not switch the section; heredoc bodies are skipped so string data
  never flips visibility or creates defs); singleton methods (`def self.x`)
  keyed by their literal `self.`-prefixed name; `require_relative 'x'`
  normalizes to `./x` and resolves to the target workspace file; `require`
  stays a namespace import.
- **PHP (`.php`, `.phtml`, `.blade.php`)**: namespace defs (`;` and brace
  forms), `trait`/`class`/`interface` defs, methods with
  `public`/`protected`/`private` visibility modifiers (default public) and
  `_`-prefix privacy; aliased `use A\B\C as D` now binds the SHORT name
  (`C`), matching what body expressions actually spell.
- **`symbols` tool**: new Dart/Ruby/PHP regex extractors (with a `_internals`
  DI seam); supported extensions extended accordingly.
- **`repo_map context_pack`**: dart/ruby/php joined the widened-range
  grammars, so member spans (Ruby/PHP methods) are served instead of
  "internal symbol — span unavailable" placeholders.
- Import fallback + semantic dedup plumbing so tree-sitter captures and
  line-based fallbacks for the same statement yield one import fact;
  commented-out declarations are masked before augmentation.

## Why

The 12-language support contract (KG roadmap, issue #1531) required
hardened graph extraction for Dart, Ruby, and PHP beyond the basic
tree-sitter scaffolding: public/private conventions, import/export edges,
method-level facts, and `context_pack` usability. A prior implementation
(PR #1681) was reviewed but landed on a side branch that never reached main;
this ports its Dart/Ruby/PHP subset onto the current architecture.

## How to use

- Rebuild the repo graph with `repo_map` action `build`.
- Query focused context with `repo_map` action `context_pack`, passing the
  target `file` and `symbol` — Ruby singleton methods are keyed as
  `self.build` (with the `self.` prefix).
- Use the `symbols` tool for direct exported-symbol inspection on `.dart`,
  `.rb`, `.rake`, `.gemspec`, `.php`, and `.phtml` files.

## Migration

No migration required. Graph payloads for these languages gain defs/edges;
other languages' payloads are unchanged (the import dedup only collapses
semantically identical statements).

## Dynamic limitations

Extraction is syntax-only; no language runtimes, Flutter, Bundler, or
Composer tooling are invoked. Ruby metaprogramming (`send`, `const_get`,
`define_method`) and `include`/`extend` composition produce no facts; PHP
variable functions/classes and grouped `use A\B, C\D;` statements are not
modeled; non-aliased PHP `use` FQNs do not resolve to files (composer PSR-4
awareness is out of scope); Blade directives are opaque to the extractor;
Dart class members (including Flutter `build` methods) are not method defs —
the enclosing type carries the span. See
`docs/repo-graph-symbol-graph.md` → "Dynamic language limitations".
