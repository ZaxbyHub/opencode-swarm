# Safe repository-first build discovery

Build checks now honor repository-defined package scripts before language-profile fallbacks. An available Bun runtime remains the default preference when a project does not declare `packageManager`; explicit package-manager declarations are respected and unavailable runtimes are reported as structured, non-failing environment skips.

Plugin-generated TypeScript/JavaScript build, typecheck, and test commands no longer use `npx` fallbacks that can download similarly named registry packages. Undeclared tools are resolved only from the existing PATH or the repository's `node_modules/.bin` directory, including Windows `.cmd` shims.

Build-check evidence now distinguishes projects with no supported build files from projects whose required toolchain is unavailable. Profile-only skips include structured required-command diagnostics, while unrelated runtime failures are suppressed when no matching build file exists.

No migration is required for projects that declare scripts or local tool dependencies. Projects that previously relied on the plugin implicitly downloading undeclared tools must add the dependency locally or define the corresponding package script.
