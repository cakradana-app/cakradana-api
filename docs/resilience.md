# Availability, backup, and recovery

The objectives below are declared in code, in
[`app/domains/canonical/resilience.js`](../app/domains/canonical/resilience.js),
with the reasoning attached to each number. This page is the procedure. Where
the two differ, the code is what runs.

## The objectives

| | Target | Why this number |
|---|---|---|
| **Availability** | 99.5% of a calendar month, measured on the ingestion write path and the review queue (216 minutes of budget in a 30-day month) | One MongoDB process and one API container. Every restart, host reboot, and database upgrade is downtime rather than a failover. The work this serves — filings arriving in batches, a queue worked by people in business hours — is not harmed by minutes of unavailability the way a payment authorisation would be. |
| **RPO** | 6 hours | This is a full-dump deployment with no continuous capture, so the worst-case loss is exactly the interval between dumps. A lost donation is not a missing row: every cumulative rule computes over the donations it can see, so losing one *lowers* a donor's running total, an over-limit donor is cleared by the limit rules, and nothing anywhere reports an error. |
| **RTO** | 4 hours | Recovery is a manual procedure: somebody is paged, a database is provisioned, `scripts/restore.js` runs, and its verification is read. At this data volume the restore itself is minutes — the hours are people and provisioning. |

What would have to change before each could be tightened is recorded next to it
in the module, and is served at `GET /service/monitoring/resilience` so it
travels with the number rather than being findable only in the source.

Not every lost record costs the same. A paper form or a scraped page can be
ingested again from the source document; a digital-form submission exists
nowhere but here, and near a filing deadline the request to file again may
arrive after the deadline has passed.

## Taking a backup

```bash
npm run backup                              # MONGODB_URI from the environment, into backups/
node scripts/backup.js --uri "$URI" --out /var/backups/cakradana
node scripts/backup.js --allow-empty        # only when the store really is empty
```

Each run writes a timestamped archive directory containing one `.jsonl` file per
collection and a `manifest.json` recording what was captured, when, from which
host and database (never the credentials), the schema version, a fingerprint
computed from the schemas themselves, and per collection a document count, a
file checksum, and an order-independent content digest.

What is captured and why each collection cannot simply be rebuilt is listed in
`BACKUP_SET`; what is deliberately left out, and why, is listed in
`NOT_BACKED_UP` next to it.

Neither list is maintained on trust. A test loads the application, asks mongoose
which collections the service can write, and fails if any of them appears in
neither list — because a collection added later is not omitted from the backup
by anybody's decision, it is omitted because the lists live in a different file
from the model and nothing connected them. Six had accumulated that way when the
check was written, three of them holding judgement nothing regenerates: an
analyst's case narrative, the decisions about whether to tell a subject they had
been flagged, and the near matches a person had already resolved.

### Strong identifiers

`entityidentifiers` is in the set for the same reason as the labels: nothing
regenerates it. An identifier was recorded by somebody who saw a document, and
the keyed hash beside it is what lets two records be recognised as one person.

It is the one collection whose values are already encrypted where they sit, and
the key is not in the archive. That is deliberate — a dump copied somewhere it
should not be yields nothing — and it has a consequence for recovery: restoring
this collection without `IDENTIFIER_KEY` and `IDENTIFIER_PEPPER` recovers records
nobody can read, and the keyed hashes stop matching if the pepper differs. **The
secrets are part of the recovery and are not part of the backup.** Wherever they
are kept, a restore needs them back before this collection means anything.

### The legacy document

`services` — the single document the service began with — is in the backup set,
and the reason is worth stating because it looks like it should not be.
Ingestion no longer writes it, and every row written while both stores were
being updated has a canonical counterpart, so it reads as derived. It is not
derived for the rows written *before* the canonical collections existed: those
were never copied anywhere, and `scripts/backfill-canonical.js` is what moves
them. Until that has run against a deployment, the legacy document is the only
copy of those donations.

Getting this wrong in the safe-sounding direction loses data in silence.
Restore from an archive that skipped the singleton and those donations are gone;
run the backfill afterwards and it finds an empty document and reports "nothing
to move", which reads as success.

So it is measured rather than assumed, by `legacySingletonStatus`, on the
definition the backfill itself uses — a row whose `_id` appears in no
`Donation.legacyDonationId`:

| `state` | Meaning |
|---|---|
| `load-bearing` | some rows exist nowhere else. Run `npm run backfill -- --apply`. Until then the collection must stay in the backup set |
| `derived` | every row has a canonical counterpart. The collection could be dropped from the set once the document itself is dropped from the deployment |
| `absent` | this deployment has no legacy document at all |
| `unknown` | the document could not be read — not the same as zero, and not a basis for dropping anything |

Reported at `GET /service/monitoring/resilience` and as
`cakradana_legacy_only_donations`. The reading is cached for five minutes,
because the document it reads can approach the sixteen-megabyte limit that is
the reason for retiring it, and the number changes only when a backfill runs.

Two behaviours are worth knowing before relying on it:

- **It refuses to produce an empty archive.** A dump against the wrong database,
  or the right one with the wrong `authSource`, produces zero documents and exits
  zero, and would keep doing so every six hours until somebody needed it.
  `--allow-empty` is the way to say the emptiness is expected.
- **An interrupted run leaves nothing that looks complete.** The archive is
  written to a `.partial` directory and renamed only after the manifest is
  committed.

Every run — including a failed one — is recorded in the `backupruns` collection,
which is what the health and metrics surfaces read. A run that fails and writes
nothing would otherwise be indistinguishable from a schedule that was never
created.

### Scheduling

Backups are scheduled by the operator rather than by the application process:
the API container has no archive volume, and a dump belongs on the host that
holds the storage. Every six hours, matching the RPO:

```
0 */6 * * *  cd /srv/cakradana-api && /usr/bin/node scripts/backup.js --out /var/backups/cakradana >> /var/log/cakradana-backup.log 2>&1
```

A schedule that was never created reports as `never` at
`GET /service/monitoring/resilience` and as `cakradana_backup_ever_completed 0`
in the metrics, rather than failing anywhere. That is the compensating control
for scheduling being outside the application, and it is only a control if
somebody alerts on it — see below.

Archives are kept 30 days, and each successful run deletes the ones past that.
They hold the same personal data the live store does and inherit the same
handling standard; without the pruning, a schedule running every six hours
accumulates an unbounded second copy of political-affiliation data on a disk
nobody is looking at, which is the retention problem relocated rather than
solved.

The pruning only ever considers directories inside `--out` that carry a manifest
this tooling wrote, and takes their age from the manifest rather than the
filesystem, since copying an archive resets every timestamp on it. Anything else
in that directory is left alone, and an archive whose manifest cannot be read is
reported and kept — deleting what cannot be identified is how a good archive
goes missing. `--keep-days` changes the period; `--no-prune` disables it.

## Restoring

```bash
node scripts/restore.js --from /var/backups/cakradana/20260817T060000Z --uri "$URI"
```

The procedure:

1. **Provision an empty database.** The restore refuses a target that already
   holds documents. Merging an archive into a live store produces something that
   is neither the archive nor the store; `--force` overrides this and is for the
   case where that is genuinely what is wanted.
2. **Run the restore.** It verifies the archive against its manifest *before*
   opening a connection — a half-written file inserted into an empty store is
   harder to recognise as a bad archive than one that never reached the database.
3. **Read the verification.** After inserting, it compares what actually landed
   against the manifest: counts and content digests, per collection. Any mismatch
   fails the run and prints what did not match. A restore that reports success
   without this check is the failure this script exists to remove — inserts that
   returned no error still leave a short collection when a file was truncated or
   a batch hit a duplicate key, and the difference between a complete recovery
   and one missing four hundred donations is invisible at the console.
4. **Start the application.** The archive carries documents, not indexes.
   Indexes are declared in the schemas and built on startup, so the first
   minutes against a restored store are slower rather than wrong.
5. **Run the retention pass.** Retention runs against the live store, not
   against archives. An archive taken before a sweep reinstates the records that
   sweep deleted. `ENFORCE_RETENTION=true` on the restored deployment, or run the
   pass by hand.
6. **Take a backup of the restored store.** The run history is deliberately not
   carried across, so the recovered deployment reports `never` until it has been
   backed up in its own right — which is true of it.

To check a store against an archive at any later point, without writing to
either:

```bash
node scripts/restore.js --from <archive> --uri "$URI" --verify-only
```

An archive taken under an older schema restores, with a warning naming both
schema versions and fingerprints. Refusing it would leave an operator holding a
verified archive and no way to use it.

## The drill

`test/resilience.test.js` performs a real backup and a real restore against a
real mongod, and runs on every commit as the **Restore drill** stage in CI. It
seeds a store, backs it up, restores the archive into a clean database, and
compares what came out against what went in — types included, since a date that
returns as a string and an amount that returns as a different number are both
restores that "worked". It also asserts the refusals: an empty archive, a
tampered archive, a non-empty target, a short restore, and a restore holding the
right number of the wrong documents.

It runs against a server already provided — `RESILIENCE_TEST_URI`, or the
`MONGO_TEST_URI` the other write-path tests use — in preference to starting one,
and falls back to `mongodb-memory-server`:

```bash
docker compose up -d mongodb
MONGO_TEST_URI='mongodb://admin:password@localhost:27017/?authSource=admin' \
  node --test test/resilience.test.js
```

When no database can be reached it fails and says so. It is never skipped: a
drill that skips is a recovery plan nobody has tested, reported as a passing
suite.

CI proves the mechanism. It does not prove the RTO, which is a claim about
people and provisioning at production data volumes — that needs a drill against
a production-sized store, every 30 days (`BACKUP_POLICY.drillIntervalDays`).

## Watching it

| Where | What |
|---|---|
| `GET /ready` | The declared objectives and the age of the last verified backup, under `recovery`. Reported, never enforced: `rpo_affects_readiness` is `false`, because withdrawing from rotation over a stale backup would stop the ingestion whose records are the thing at risk. |
| `GET /metrics` | `cakradana_backup_age_seconds`, `cakradana_backup_last_success_timestamp_seconds`, `cakradana_backup_ever_completed`, and the objectives themselves as `cakradana_rpo_objective_seconds`, `cakradana_rto_objective_seconds`, `cakradana_availability_objective_ratio`. The objective gauges are emitted even when the database cannot be read, because the scrape most worth having is the one taken during an incident. |
| `GET /service/monitoring/resilience` | The objectives with their reasoning, the backup set, the current position, and what is not covered. |

The alert worth having is `cakradana_backup_age_seconds >
cakradana_rpo_objective_seconds`, with a second one on
`cakradana_backup_ever_completed == 0`. They are separate because they are
different failures: a schedule that slipped, and a schedule that was never
created.

`cakradana_legacy_only_donations > 0` is worth watching too, though it is a
migration signal rather than a backup one: it counts donations that exist only
in the legacy document, and it should fall to zero once the backfill has run and
stay there.

`cakradana_store_metrics_available 0` means the gauges could not be read, which
is not the same as a breach and must not page the same person for the same
reason.

## What is not covered

Stated plainly, because the gap between "there are backups" and "we can recover"
is where recovery plans usually fail, and leaving it unmentioned does not close
it.

- **No multi-region deployment.** Losing the hosting region is outside these
  objectives entirely. Neither the RPO nor the RTO describes that case.
- **No automated failover, and no standby.** Every recovery starts with a person
  being paged. The RTO is written around that and cannot be lower while it is
  true.
- **No continuous capture.** The RPO is bounded by the dump interval and nothing
  else. A replica set with oplog capture would bound it in seconds; there is no
  replica set.
- **Backups are scheduled outside the application.** A schedule that was never
  created is visible in the health and metrics surfaces and nowhere else. If
  nobody alerts on those, this reduces to a documented intention.
- **Archives are not encrypted by this tooling.** They hold
  political-affiliation data and rely on the storage they are written to for
  confidentiality. Writing them somewhere with encryption at rest and access
  control is part of deploying this, not part of running the script. The one
  exception is `entityidentifiers`, whose values are encrypted before they are
  ever stored — and whose key the archive deliberately does not carry, which is
  a recovery dependency as much as a protection.
- **The secrets are not backed up.** `IDENTIFIER_KEY`, `IDENTIFIER_PEPPER`,
  `JWT_SECRET`, and the mail and provider credentials live in the environment,
  not in the database, so none of them are in an archive. A restore that has the
  data and not the secrets is not a recovered service. Where they are kept, and
  how they are recovered, is outside what these scripts can promise.
- **The published dataset is not backed up.** It is materialised from donations
  on a schedule by `public.scheduler.js`, so it is rebuildable by construction —
  and restoring a stale copy would republish figures that may since have been
  corrected. Losing it costs a rebuild, not a record. It survives a *failed*
  rebuild, which is a different property and one the build had to be changed to
  provide: the new dataset is assembled in a staging collection and swapped in
  with a rename, so a build that dies at any point leaves the previous one
  serving. `GET /public/operations` reports whether the dataset exists, when it
  was last built, and whether the last build failed, because an endpoint that
  keeps answering says nothing about having stopped being refreshed.
