# Restore LF checkout rules for repository text files

## What changed

Removed the leading UTF-8 BOM from .gitattributes, preserving its existing LF checkout rules.

## Why

Git could fail to recognize the wildcard attribute rule when the file began with a BOM. Fresh checkouts using core.autocrlf=true could then materialize workflow YAML and other text files with CRLF line endings.

## Migration

No migration is required. Re-check out or renormalize an existing working tree if it was materialized with unintended CRLF line endings.

## Breaking changes

None.

## Caveats

This changes checkout normalization for repositories using these attributes; it does not rewrite unrelated committed file contents.
