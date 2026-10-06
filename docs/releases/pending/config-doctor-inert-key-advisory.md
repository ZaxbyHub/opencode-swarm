# Config-doctor inert-key advisory: seam + both-arms pins (issue #2957)

## What changed

Follow-up to the config-consumption ratchet (#2904, whose advisory announcement
is carried by its own fragment in this release): the advisory collector
`collectRawInertKeyFindings` is now exported with a default-parameter DI seam,
and the new both-arms suite (`tests/unit/services/config-doctor-inert-keys.test.ts`)
pins the advisory's inert and consumed declaration arms on any tree — the
production map stays silent on `harness_opt` and `skill_opt` (consumed since
the harness-opt/skill-opt config wiring, issue #2949), `parallelization`
remains the one declared-inert key and keeps warning, and injected
declarations prove either arm without `mock.module` — including that the seam
is replace-not-merge and reads declarations own-property only.
`CONFIG_CONSUMERS` is now frozen. A hand-written "Inert config-key advisory"
section documents the behavior in `docs/configuration.md`.

No behavior change to the advisory itself; no migration required.
