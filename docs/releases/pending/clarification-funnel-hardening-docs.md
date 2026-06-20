Adds documentation for clarification funnel hardening patterns from issue #1052 council findings: standardizes Overconfidence guard capitalization across all 6 skill files, documents research_needed_timeout_ms behavior in clarify/plan skills, adds mechanical enforcement DROP protection guidelines. No production code changes — documentation and test coverage only.

## Migration
No migration required.

## Caveats
- Mechanical enforcement of DROP protection is documented as a recommended future pattern, not implemented in code
- research_needed_timeout_ms behavior is documented; implementation is deferred as future work
