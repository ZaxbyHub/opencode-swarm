# Training vault remediation for already-stored v1 content

> Applies from the #3840 redaction widening (`TRAINING_REDACTION_VERSION` 2).
> Audience: operators of a project whose `.swarm/training/v1/` vault already
> holds records captured under the v1 redactor.

## Already-stored v1 records

Existing v1 vault records — including any that carry a bare well-known
credential the v1 pattern set did not redact — **stay on disk, stay readable,
and survive the expiry sweep** after the upgrade. The v2 reader accepts every
record version 1..2, and the sweep retains version-only-quarantined lines, so
nothing is deleted or quarantined by the upgrade itself.

## Expiry is append-triggered, not timed

`sweepTrainingVaultExpiry` runs only every **256 accepted appends**. There is
NO timer: if capture stops (consent withdrawn, quota reached, plugin unused),
expired records — including old v1 records — remain on disk indefinitely.
Operators who want them gone should withdraw (see below) — deleting the vault
file by hand bypasses the withdrawal tombstone and the export revocation.

## Exports, withdrawal, and copies outside plugin control

- `/swarm dataset export` copies records to `.swarm/training/v1/exports/…`;
  those exports are bound to plugin control — **withdrawal REVOKES them**
  (`REVOKED.json` markers) rather than deleting them.
- Withdrawal (`/swarm dataset consent --revoke`) stops capture immediately;
  `/swarm dataset withdraw` deletes the vault content and revokes exports.
- **Copy anything you need OUTSIDE plugin control (e.g. a plain copy in a
  private directory) BEFORE withdrawing** — after withdrawal the plugin-side
  exports are revoked markers.

## Credential rotation is the real remedy

Local redaction upgrades and purges do NOT revoke anything at the provider.
A credential that was captured unredacted into a v1 record must be
**rotated at its provider** (new key, revoke the old one). Deleting local
records after the fact does not un-leak anything already exposed.

## Safe-downgrade procedure (downgrade after v2 records exist)

A downgrade reinstates the OLD literal-version reader AND the OLD
sweep-on-rewrite behavior — v2 records would quarantine `schema_invalid` and
then be **physically deleted at the next 256-append sweep**. To downgrade
without losing v2 records:

1. `export` the vault;
2. **copy the export outside plugin control** (withdrawal will revoke the
   plugin-side copy);
3. withdraw consent (`REVOKED.json` markers appear; capture stops);
4. run the withdraw/purge so no v2 records remain;
5. now downgrade safely.

Step 3 also covers the consent record itself: a v2 consent file stamps
`redaction_version: 2`, and the downgraded v1 reader (a literal `1`) treats
that consent as ABSENT — capture stays off until the consent is granted
again. Withdrawing and re-granting after the downgrade restores it.

The alternative is to **accept the loss**: skip steps 1-4 and let the next
sweep delete the v2 records. The replay-identity sidecar files
(`.swarm/pr-review/<runId>/replay-identity.json`) are inert under downgrade
and can be deleted at will — but the SALT file
(`.swarm/pr-review/replay-identity.salt`) is not: deleting it makes every
stored fingerprint unreproducible, so the next run generates a new salt and
the old fingerprints no longer match.
