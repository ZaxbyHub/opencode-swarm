# CI package artifact validation

CI now validates the npm package artifact that would be published by building
with the pinned Bun toolchain, running `npm pack`, checking required runtime
files and grammar assets, installing the generated tarball in a temporary
project, and smoke-testing the installed plugin import and CLI.

The release publish workflow now uses the same Bun version and `bun run build`
path as CI before publishing, including declaration generation.
