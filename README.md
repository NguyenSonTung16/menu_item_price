# IA#2 — zero downtime price migration

This repository migrates menu prices from `price` (thousands of dong, REAL) to `price_vnd` (dong, INTEGER) while two versions serve traffic. The implementation uses the expand, migrate, contract sequence and keeps the old `price` API field throughout.

## Requirements

- Node.js 22.5 or later. The service uses built-in `node:sqlite`; no npm packages need to be installed.
- Windows PowerShell is supported by the automated demo. Node, npm, and Git must be available on PATH.

## Versions and migrations

| Tag | Behavior |
| --- | --- |
| `v1` | Starter: reads and writes only `price` |
| `v2` | Reads `price`; writes both columns; accepts and returns `priceVnd` |
| `v3` | Reads `price_vnd`; writes both columns for rollback |
| `v4` | Reads and writes only `price_vnd`; derives legacy API `price` |

`002_expand_price_vnd` adds the nullable integer column. Run `npm run migrate -- --to 002_expand_price_vnd` to stop at this step; plain `npm run migrate` applies all pending migrations. `003_drop_price` is the contract step and must run only after every instance is on v4.

The backfill runs in bounded transactions and repairs both NULL and mismatched values. Run it only when all instances are on v2 or later. Use `npm run check` after every deployment, backfill, rollback, and schema step. During step 5, the retired `price` column can be stale by design; `npm run check:vnd` validates the canonical integer column during that interval.

## Run the assignment sequence

The complete sequence, including migration-down checks on disposable databases, tests for all four tags, two live service instances, one continuous traffic process, rollback, and the final contract migration, is automated:

```powershell
npm run demo -- --rehearsal
```

This rehearsal uses a separate database and separate log names. After reviewing the rehearsal, run the hand-in sequence once:

```powershell
npm run demo
```

The official run creates `traffic-log.txt`, `check-log.txt`, and an ignored database under `data/`. It refuses to overwrite existing outputs. The traffic controller turns on 30% new clients only after both instances run v2, marks every step, then asks the traffic process to finish in-flight requests and record its final totals. Rehearsal files are not part of the hand-in.

If a run fails, preserve its logs while investigating the cause. For another clean run, remove only the generated run's log and database files after saving any evidence you need, then start with a fresh database.

## Manual commands

```powershell
$env:DB_PATH = 'C:\absolute\path\to\data\app.db'
npm run migrate -- --to 001_init
npm run seed -- 20000
npm run check
npm run backfill -- --batch-size=500 --delay-ms=25
npm run check
npm run check:vnd
npm run migrate:status
npm run migrate:down
npm test
```

Start each version from its tag in a separate Git worktree, set the same absolute `DB_PATH` in each server terminal, and restart one port at a time. `scripts/serve-tag.ps1` creates or reuses a tag worktree and starts that version on a selected port. Start traffic with `NEW_CLIENTS=0` and `TRAFFIC_CONTROL_FILE` pointing to a JSON control file. Update its `NEW_CLIENTS` field after both instances support the new API. Do not roll v4 back directly to v2: v4 no longer keeps the old database column current.

## Submission files

The repository must include the `.git` directory and tags `v1` through `v4`, plus both up/down files for each migration, `scripts/backfill-price-vnd.js`, `MIGRATION.md`, `traffic-log.txt`, `check-log.txt`, `AI-LOG.md`, and `SELF_ASSESSMENT_REPORT.md`. Name the ZIP `<StudentID>_<total>.zip`. Confirm the tags can be checked out and the run can be replayed from the ZIP before submitting.
