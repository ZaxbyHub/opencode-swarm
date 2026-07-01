/**
 * Spec-Kit test fixture helper — task 1.1 (issue #1228, v1).
 *
 * Writes a minimal, valid GitHub Spec-Kit layout into a caller-provided
 * temp directory.  The caller owns temp-dir lifecycle (create + cleanup);
 * this helper only writes files.
 *
 * Spec-Kit layout (verified against github.com/github/spec-kit templates):
 *   .specify/memory/constitution.md          — marker directory; stub content
 *   specs/NNN-feature-name/spec.md           — FR section in bold form
 *   specs/NNN-feature-name/tasks.md          — task list with [US#] references
 *
 * Usage:
 *   import { writeSpeckitFixture } from '../helpers/speckit-fixture';
 *   const descriptor = writeSpeckitFixture(dir, { variant: 'single-explicit-fr' });
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The six fixture variants the later tests (1.2–3.1) need.
 *
 * 1. single-explicit-fr         — happy path: one feature, explicit FR-### ids
 * 2. single-idless-requirements — FR-004 synthesis: obligations with no FR-### prefix
 * 3. multi-feature              — two feature dirs, each restarting at FR-001
 * 4. empty-specify              — .specify/ marker present; no specs/ dirs
 * 5. zero-fr                    — feature dir exists; spec.md has no FR bullets
 * 6. malformed                  — missing "## Success Criteria" section +
 *                                  a tasks.md task with no [US#]/FR reference
 */
export type SpeckitVariant =
	| 'single-explicit-fr'
	| 'single-idless-requirements'
	| 'multi-feature'
	| 'empty-specify'
	| 'zero-fr'
	| 'malformed';

/** Paths returned by writeSpeckitFixture so callers avoid hardcoding names. */
export interface SpeckitFixtureDescriptor {
	/** Absolute path to the .specify/ directory (always written). */
	specifyDir: string;
	/**
	 * Absolute paths to specs/NNN-.../ feature directories, sorted
	 * lexicographically.  Empty for the 'empty-specify' variant.
	 */
	featureDirs: string[];
	/**
	 * Absolute paths to spec.md files, index-parallel to featureDirs.
	 * Empty for the 'empty-specify' variant.
	 */
	specPaths: string[];
	/**
	 * Absolute paths to tasks.md files, index-parallel to featureDirs.
	 * Empty for the 'empty-specify' variant.
	 */
	tasksPaths: string[];
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/**
 * Minimal content for `.specify/memory/constitution.md`.
 * This is Spec-Kit's unambiguous marker directory.
 */
const CONSTITUTION_CONTENT =
	'# Spec-Kit Constitution\n\nThis repository uses GitHub Spec-Kit for specification-driven development.\n';

/**
 * Canonical valid spec.md for a single feature with explicit FR-### identifiers.
 * Tests FR-001–FR-003, FR-005, SC-001.
 */
const SPEC_SINGLE_EXPLICIT_FR = `\
# 001-auth-service — Authentication Service

## Functional Requirements

- **FR-001**: System MUST authenticate users with valid credentials.
- **FR-002**: System SHALL invalidate sessions after 24 hours of inactivity.
- **FR-003**: System SHOULD support multi-factor authentication.

## User Scenarios & Testing

### Scenario: Successful login
- **Given** a registered user with valid credentials
- **When** the user submits their credentials
- **Then** the system grants access and creates a session

### Scenario: Session expiry
- **Given** an authenticated user with an inactive session
- **When** the inactivity threshold is exceeded
- **Then** the system invalidates the session and requires re-authentication

## Success Criteria

- **SC-001**: Authenticated users can access protected resources.
- **SC-002**: Sessions expire after the configured inactivity period.
`;

/**
 * Valid tasks.md for a single feature (used by explicit-fr, idless, multi variants).
 * Format: `- [ ] T### [P] [US#] <description> <file path>`
 * [P] = parallelizable flag (task can run simultaneously with others, different files)
 * [US#] = user story assignment (required for user-story-phase tasks)
 */
const TASKS_SINGLE = `\
- [ ] T001 [P] [US1] Implement credential validation src/auth/credential-validator.ts
- [ ] T002 [P] [US1] Implement session management src/auth/session-manager.ts
- [ ] T003 [US2] Implement session expiry job src/auth/session-expiry.ts
`;

/**
 * Spec.md for a feature whose requirements are id-less obligation bullets.
 * These have MUST/SHALL/SHOULD but no FR-### prefix — the FR-004 synthesis path.
 * Three bullets give the stability test (SC-003) ordering to exercise.
 */
const SPEC_SINGLE_IDLESS = `\
# 001-auth-service — Authentication Service

## Functional Requirements

- System MUST authenticate users with valid credentials.
- System SHALL invalidate sessions after 24 hours of inactivity.
- System SHOULD support multi-factor authentication.

## User Scenarios & Testing

### Scenario: Successful login
- **Given** a registered user with valid credentials
- **When** the user submits their credentials
- **Then** the system grants access and creates a session

## Success Criteria

- Users can access protected resources after authentication.
- Sessions expire automatically after the configured period.
`;

/**
 * spec.md for feature 001-alpha (multi-feature variant).
 * Starts at FR-001 — Spec-Kit resets per feature.
 */
const SPEC_ALPHA = `\
# 001-alpha — Alpha Feature

## Functional Requirements

- **FR-001**: System MUST provide the alpha capability.
- **FR-002**: System SHALL report alpha telemetry metrics.

## User Scenarios & Testing

### Scenario: Alpha invocation
- **Given** a configured alpha integration
- **When** the user requests alpha processing
- **Then** the system delivers the alpha result and records metrics

## Success Criteria

- **SC-001**: Alpha capability is available and observable.
`;

const TASKS_ALPHA = `\
- [ ] T001 [P] [US1] Implement alpha capability src/alpha/capability.ts
- [ ] T002 [P] [US1] Implement alpha metrics src/alpha/metrics.ts
`;

/**
 * spec.md for feature 002-beta (multi-feature variant).
 * Also starts at FR-001 — demonstrates per-feature collision that Follow-up A must resolve.
 */
const SPEC_BETA = `\
# 002-beta — Beta Feature

## Functional Requirements

- **FR-001**: System MUST provide the beta capability.
- **FR-002**: System SHALL report beta telemetry metrics.

## User Scenarios & Testing

### Scenario: Beta invocation
- **Given** a configured beta integration
- **When** the user requests beta processing
- **Then** the system delivers the beta result and records metrics

## Success Criteria

- **SC-001**: Beta capability is available and observable.
`;

const TASKS_BETA = `\
- [ ] T001 [P] [US1] Implement beta capability src/beta/capability.ts
- [ ] T002 [P] [US1] Implement beta metrics src/beta/metrics.ts
`;

/**
 * spec.md for variant 5 (zero-fr): has the required Spec-Kit headings but NO
 * FR-### bullets.  The `## Functional Requirements` section exists with prose only —
 * this tests the "zero parsable FRs" advisory path (FR-013).
 */
const SPEC_ZERO_FR = `\
# 001-empty-feature — Empty Feature

## Functional Requirements

This feature is currently in discovery. No functional requirements have been
defined yet. Requirements will be added once the design phase is complete.

## User Scenarios & Testing

TBD — scenarios will be defined alongside functional requirements.

## Success Criteria

TBD — success criteria will be defined once functional requirements are known.
`;

const TASKS_ZERO_FR = `\
- [ ] T001 [P] [US1] Scaffold the feature directory src/empty-feature/index.ts
`;

/**
 * spec.md for variant 6 (malformed): has a valid FR-001 but is MISSING the
 * `## Success Criteria` section.  This tests the "missing required section"
 * validation path (FR-007).
 *
 * Note: the missing section is `## Success Criteria`, NOT `## Functional
 * Requirements` — that would collapse this into the zero-fr variant.
 */
const SPEC_MALFORMED = `\
# 001-broken-feature — Broken Feature

## Functional Requirements

- **FR-001**: System MUST process requests correctly.
- **FR-002**: System SHALL return errors for invalid input.

## User Scenarios & Testing

### Scenario: Valid request
- **Given** a valid incoming request
- **When** the system processes it
- **Then** the correct response is returned

`;
// Intentionally omits "## Success Criteria"

/**
 * tasks.md for variant 6 (malformed): T001 has no [US#]/FR reference —
 * this tests the "task lacking a requirement reference" validation path (FR-007).
 * T001 keeps [P] (parallelizable flag) to ensure the validator keys on the
 * missing story/requirement reference specifically, not on mere bracket absence.
 * T002 is fully valid so the test can distinguish exactly which task is flagged.
 */
const TASKS_MALFORMED = `\
- [ ] T001 [P] Implement request processing without any spec reference src/broken/handler.ts
- [ ] T002 [P] [US1] Implement error handling for invalid input src/broken/error-handler.ts
`;

// ---------------------------------------------------------------------------
// Writer utility
// ---------------------------------------------------------------------------

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a minimal, valid GitHub Spec-Kit layout into `dir`.
 *
 * @param dir      Absolute path to the root of a temp directory.
 * @param options  `{ variant }` — selects which of the six fixture layouts to write.
 * @returns        A descriptor with absolute paths for all written files.
 *
 * Variant summary:
 *   'single-explicit-fr'         — 1 feature, 3 explicit FR-### ids
 *   'single-idless-requirements' — 1 feature, 3 id-less obligation bullets (FR-004 path)
 *   'multi-feature'              — 2 features (001-alpha, 002-beta), each with FR-001..FR-002
 *   'empty-specify'              — .specify/ marker only; no specs/ dirs
 *   'zero-fr'                    — 1 feature; spec.md has no FR bullets
 *   'malformed'                  — 1 feature; missing ## Success Criteria + unreferenced task
 */
export function writeSpeckitFixture(
	dir: string,
	options: { variant: SpeckitVariant },
): SpeckitFixtureDescriptor {
	const { variant } = options;

	// Always write the marker directory
	const specifyDir = path.join(dir, '.specify');
	writeFile(
		path.join(specifyDir, 'memory', 'constitution.md'),
		CONSTITUTION_CONTENT,
	);

	const specsRoot = path.join(dir, 'specs');

	if (variant === 'empty-specify') {
		return { specifyDir, featureDirs: [], specPaths: [], tasksPaths: [] };
	}

	if (variant === 'single-explicit-fr') {
		const featureDir = path.join(specsRoot, '001-auth-service');
		const specPath = path.join(featureDir, 'spec.md');
		const tasksPath = path.join(featureDir, 'tasks.md');
		writeFile(specPath, SPEC_SINGLE_EXPLICIT_FR);
		writeFile(tasksPath, TASKS_SINGLE);
		return {
			specifyDir,
			featureDirs: [featureDir],
			specPaths: [specPath],
			tasksPaths: [tasksPath],
		};
	}

	if (variant === 'single-idless-requirements') {
		const featureDir = path.join(specsRoot, '001-auth-service');
		const specPath = path.join(featureDir, 'spec.md');
		const tasksPath = path.join(featureDir, 'tasks.md');
		writeFile(specPath, SPEC_SINGLE_IDLESS);
		writeFile(tasksPath, TASKS_SINGLE);
		return {
			specifyDir,
			featureDirs: [featureDir],
			specPaths: [specPath],
			tasksPaths: [tasksPath],
		};
	}

	if (variant === 'multi-feature') {
		const alphaDir = path.join(specsRoot, '001-alpha');
		const betaDir = path.join(specsRoot, '002-beta');
		const alphaSpec = path.join(alphaDir, 'spec.md');
		const alphaTasks = path.join(alphaDir, 'tasks.md');
		const betaSpec = path.join(betaDir, 'spec.md');
		const betaTasks = path.join(betaDir, 'tasks.md');
		writeFile(alphaSpec, SPEC_ALPHA);
		writeFile(alphaTasks, TASKS_ALPHA);
		writeFile(betaSpec, SPEC_BETA);
		writeFile(betaTasks, TASKS_BETA);
		// Sorted lexicographically — 001-alpha before 002-beta
		return {
			specifyDir,
			featureDirs: [alphaDir, betaDir],
			specPaths: [alphaSpec, betaSpec],
			tasksPaths: [alphaTasks, betaTasks],
		};
	}

	if (variant === 'zero-fr') {
		const featureDir = path.join(specsRoot, '001-empty-feature');
		const specPath = path.join(featureDir, 'spec.md');
		const tasksPath = path.join(featureDir, 'tasks.md');
		writeFile(specPath, SPEC_ZERO_FR);
		writeFile(tasksPath, TASKS_ZERO_FR);
		return {
			specifyDir,
			featureDirs: [featureDir],
			specPaths: [specPath],
			tasksPaths: [tasksPath],
		};
	}

	// variant === 'malformed'
	const featureDir = path.join(specsRoot, '001-broken-feature');
	const specPath = path.join(featureDir, 'spec.md');
	const tasksPath = path.join(featureDir, 'tasks.md');
	writeFile(specPath, SPEC_MALFORMED);
	writeFile(tasksPath, TASKS_MALFORMED);
	return {
		specifyDir,
		featureDirs: [featureDir],
		specPaths: [specPath],
		tasksPaths: [tasksPath],
	};
}
