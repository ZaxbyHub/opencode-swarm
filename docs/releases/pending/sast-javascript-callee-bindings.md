# Binding-aware JavaScript SAST callees

Tier-A JavaScript and TypeScript SAST now verifies the binding behind
security-sensitive calls before assigning confirmed high or critical severity.
This removes permanent command-injection false positives from
`RegExp.prototype.exec()` and stops unrelated object methods such as
`math.eval()` from being reported as global code evaluation.

Confirmed `child_process.exec` calls remain critical across named, aliased,
namespace, CommonJS destructuring, direct-require, derived-alias, and
`node:child_process` forms. Calls whose binding cannot be proven are emitted as
new low-severity manual-review findings, so the default medium threshold does
not promote ambiguity to a confirmed vulnerability.

The JavaScript rule-family audit also hardened shadowable `Function`, string
timer, `document.write`, and message-listener identities. The `innerHTML` sink
and hardcoded-secret matcher are outside this callee-identity class and retain
their existing behavior. No configuration or migration is required; baseline
captures may record the new low-severity review rule IDs.
