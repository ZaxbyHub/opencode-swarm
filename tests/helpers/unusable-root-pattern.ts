/**
 * A root that cannot host a project must be refused (issue #1619).
 *
 * The wording moved with the mechanism: the six call sites in `run-memory.ts`
 * and `context-budget-service.ts` used to apply `validateDirectory`, which
 * rejects every absolute path by design and therefore also rejected the
 * always-absolute project root the plugin host injects — making both features
 * silently dead. They now use `validateProjectDirectory`, which requires an
 * absolute root AND rejects filesystem/drive roots and system locations.
 *
 * This pattern accepts the pre-#1619 phrasing and both `assertNotSystemLocation`
 * reasons, because what these suites assert is that the call THROWS for an
 * unusable root — that is the security property, not the error text.
 */
export const REJECTS_UNUSABLE_ROOT =
	/filesystem root|system location|absolute path|Invalid (?:project )?directory/;
