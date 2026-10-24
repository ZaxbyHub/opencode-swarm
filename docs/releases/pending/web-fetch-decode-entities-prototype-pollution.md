# Fix: HTML entity decode in web-fetch returned Object.prototype.constructor for &constructor;

## What changed

`decodeEntities` in `src/tools/web-fetch.ts` looked up HTML named entities with the `in` operator against a plain object literal (`NAMED_ENTITIES`). Because `in` traverses the prototype chain, `&constructor;` (any casing) resolved to `Object.prototype.constructor` and was decoded as `function Object() { [native code] }`, corrupting both `extractTitle` titles and `htmlToText` body text delivered to the agent from untrusted HTML.

Switched the lookup to `Object.hasOwn(NAMED_ENTITIES, key)`, which consults only own properties. Valid entities (`&amp;`, `&lt;`, `&gt;`, `&nbsp;`, etc.) continue to decode correctly.

## Why

Defense against corrupted agent-visible content when `web_fetch` processes attacker-controlled HTML. Reading a property name that happens to exist on `Object.prototype` (such as `constructor`) is not prototype pollution itself, but it is the same class of key-confusion bug. `Object.hasOwn` is the repo's established convention for own-property checks (see `src/failures/action-identity.ts`, `src/tools/create-tool.ts`).

## Impact

- `&constructor;`, `&CONSTRUCTOR;`, `&Constructor;` no longer decode to `function Object() { [native code] }`; they are left as-is (unknown entity).
- All previously-working named entities remain unaffected.

## Migration

No migration required. Pure bug fix restoring intended decoding behavior.
