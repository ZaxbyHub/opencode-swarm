## chore(deps): bump actions/stale from 10.2.0 to 11.0.0

Dependabot bump of the `actions/stale` workflow action from v10.2.0 to
v11.0.0 (pinned by SHA) in `.github/workflows/stale.yml`. v11.0.0 is a
supply-chain hardening release: it overrides `brace-expansion` to 5.0.8,
resolving 24 reported high-severity advisories in the action's dependency
tree. Behavior of the stale-labeling workflow itself is unchanged
(same `days-before-stale: 30` / `days-before-close: 7` inputs).
