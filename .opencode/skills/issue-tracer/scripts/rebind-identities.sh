#!/usr/bin/env bash
set -eu
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(git rev-parse --show-toplevel)"
git diff --quiet HEAD -- || { echo 'rebind-identities: tracked changes must be committed' >&2; exit 1; }
exec node "$script_dir/rebind-identities.mjs" "$root" "$(git rev-parse HEAD)" "$(git rev-parse 'HEAD^{tree}')" "$@"
