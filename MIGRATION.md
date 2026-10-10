# IA#2 migration plan and runbook

## Goal and invariants

Move `menu_items.price` (REAL, thousands of dong) to `menu_items.price_vnd` (INTEGER, dong) while ports 3001 and 3002 serve requests against the same absolute `DB_PATH`.

- `order_items.unit_price` remains in thousands of dong. The order endpoint derives that value from the authoritative price and keeps the existing API total unit.
- Old clients may continue sending and receiving `price` throughout. New clients send/receive integer `priceVnd` after both instances are v2 or later.
- A positive old price maps to `Math.round(price * 1000)` VND. Requests with a price that rounds below one dong or conflicting `price`/`priceVnd` fields receive 400.
- v2 reads `price` and writes both columns. v3 reads `price_vnd` and writes both. v4 uses only `price_vnd` in database queries and derives response `price = price_vnd / 1000`.
- Rolling restarts stop one instance, wait for its in-flight requests to finish, then start the target version on the same port. The other instance remains available.

## Schema and compatibility sequence

| Step | Schema after step | Code on every instance when complete | Undo command / action | Earlier code compatible with this schema |
| --- | --- | --- | --- | --- |
| S0 | `price` | v1 / v1 | No change to undo | v1 |
| S1 / 002 | `price`, nullable `price_vnd` | v1 / v1 | `npm run migrate:down` (removes 002 on the selected DB) | v1 |
| S2A | same | v2 / v1 | Stop port 3001; ` .\scripts\serve-tag.ps1 -Tag v1 -Port 3001 -DbPath $db` | v1; v2 also works |
| S2B | same | v2 / v2 | Set new-client ratio to 0; restart each port with ` .\scripts\serve-tag.ps1 -Tag v1 -Port 3001 -DbPath $db` and ` .\scripts\serve-tag.ps1 -Tag v1 -Port 3002 -DbPath $db` | v1; v2 |
| S3 | both columns consistent | v2 / v2 | No schema undo needed; rerun `npm run backfill -- --batch-size=500 --delay-ms=0` | v1; v2 |
| S4A | same | v3 / v2 | Stop port 3001; ` .\scripts\serve-tag.ps1 -Tag v2 -Port 3001 -DbPath $db` | v1; v2; v3 |
| S4B | same | v3 / v3 | Stop both ports and start each with ` .\scripts\serve-tag.ps1 -Tag v2 -Port 3001 -DbPath $db` and ` .\scripts\serve-tag.ps1 -Tag v2 -Port 3002 -DbPath $db` | v1; v2; v3 |
| R1 | same | v2 / v2 after rollback from v3 | Rollback target v2 as in S4A/S4B; this is the rollback exercised under traffic | v1; v2; v3 |
| R2 | same | v3 / v3 after forward deploy | Stop each port and restart with the matching v3 command shown for S4 | v1; v2; v3 |
| S5A | both columns; old `price` may be stale | v4 / v3 | Stop port 3001; ` .\scripts\serve-tag.ps1 -Tag v3 -Port 3001 -DbPath $db` | v3; v4. v1/v2 are no longer safe once a v4-only write occurs |
| S5B | both columns; old `price` may be stale | v4 / v4 | Stop either port and restart it with the matching v3 command shown for S5A | v3; v4. Do not roll directly to v2 |
| S6 / 003 | `price_vnd` only | v4 / v4 | `npm run migrate:down` (re-adds `price` derived from `price_vnd / 1000.0`) | v4; deploy v3 only after restoring schema |
| S7 | `price_vnd` only | v4 / v4 | Continue serving on v4; restore the schema before using an older app | v4 |

The SQL commands for schema steps are `npm run migrate -- --to 002_expand_price_vnd` and `npm run migrate -- --to 003_drop_price`. Undo the last applied schema migration with `npm run migrate:down`. Each app version is a Git tag (`v1`–`v4`) and the demo launcher checks out each tag into its own temporary worktree. `node scripts/demo.js` replays the ordered restart/rollback commands and records the exact commands, version health checks, and results in `check-log.txt`.

For manual rollback from a PowerShell session at the repository root, set the database path once. Press Ctrl+C in the terminal for the instance being replaced, wait for its graceful stop, then run the matching serve-tag command from the table:

```powershell
$db = (Resolve-Path '.\data\demo.db').Path
.\scripts\serve-tag.ps1 -Tag v2 -Port 3001 -DbPath $db
```

For each two-instance rollback, repeat for port 3002 only after port 3001 is healthy. The normal deploy command uses the next tag the same way. The demo launcher performs this one-port-at-a-time sequence automatically.

**Point where rollback to the old reader stops being safe:** the first v4-only write in S5. v4 no longer updates `price`, so v1/v2 can read a stale value even though the request returned 200. v3 remains a safe rollback because it reads `price_vnd`. Dropping `price` at S6 adds a schema barrier; migration 003 down can reconstruct the legacy column, but it does not make a direct rollback to v2 safe until values are reconciled.

## Backfill

Run only after both ports report v2. During S2A/S2B, `price_vnd` may still be NULL or may disagree with `price` because v1 can write only the old column. The backfill repairs both cases, in batches of 500 rows; each batch uses a short `BEGIN IMMEDIATE` transaction. It selects and updates within the same transaction, commits, and pauses before the next batch.

```powershell
npm run backfill -- --batch-size=500 --delay-ms=25
npm run backfill -- --batch-size=500 --delay-ms=0
npm run check
```

The second run is the idempotence check; it should report `repaired=0`. After the first run, `npm run check` must show `price_vnd_null 0`, `price_vnd_not_integer 0`, `disagree 0`, and `CONSISTENT` before any v3 instance starts. `scripts/backfill-price-vnd.js` refuses NULL, out-of-range, or sub-dong source values rather than silently inventing a converted value.

## Continuous traffic and rolling sequence

The single traffic process starts with `NEW_CLIENTS=0`. `scripts/traffic.js` polls the JSON file named by `TRAFFIC_CONTROL_FILE`; the demo atomically changes it to `{"STEP":"S2B both dual-write; enable new clients","NEW_CLIENTS":0.3}` after both ports report v2. This avoids restarting traffic or resetting its expected-write map and counters. The same run stays active across each deploy, both rollback passes, and migration 003. It ends only after the final API checks; the control file asks traffic to finish in-flight work and write `FINAL` and `RESULT`.

The traffic checker counts 5xx, API contract breaks, stale reads after an acknowledged write, and moments when no instance answers. `rerouted` during one-at-a-time restarts is recorded separately. The run must end with `error=0 contract=0 stale=0 unavailable=0` and `RESULT: zero failed requests`; it must also show a positive `client_new` count and a logged transition to `NEW_CLIENTS=0.3`.

| Stage | Operation | Required checks |
| --- | --- | --- |
| S0 | Initialize 001, seed 20,000 rows, start both v1 instances and traffic | baseline and live `npm run check`; traffic has old clients only |
| S1 | Apply 002 under traffic | checker may report all new-column values NULL; v1 remains healthy |
| S2A/S2B | Roll A, then B from v1 to v2 | health and check after each; enable new clients only after both are v2 |
| S3 | Run backfill twice while traffic continues | first run fixes NULL/mismatch values; second run repairs zero; `CONSISTENT` |
| S4 | Roll A, then B to v3 | health and `CONSISTENT` after each |
| R1/R2 | Roll v3 back to v2 A then B; roll forward to v3 A then B | one continuous traffic run; `CONSISTENT` before and after; zero failed requests |
| S5 | Roll A, then B to v4 | each version health check; `check:vnd` validates the canonical column |
| S6 | Apply 003 only after both instances report v4 | schema contains `price_vnd`, no `price`; original checker returns to `CONSISTENT` |
| S7 | Probe old/new clients, list/detail/order; continue traffic and stop cleanly | both contracts pass; final traffic counters are zero; `RESULT: zero failed requests` |

At S5, the original `npm run check` may correctly print `INCONSISTENT` because it compares the no-longer-maintained legacy column. This output is retained, labelled and explained. `npm run check:vnd` separately confirms that every canonical price is a positive integer and non-NULL. The original checker must be fully `CONSISTENT` again after S6 removes the legacy column.

## Migration down verification

`node scripts/demo.js` tests each down migration on a disposable database before the official sequence: 001 creates then removes the starter schema; 002 down returns to a working legacy schema; 003 down restores `price` from `price_vnd / 1000.0` and verifies all sampled rows agree. These runs are labelled separately from the live database in `check-log.txt`.

## Evidence files

- `traffic-log.txt`: one continuous official run. It includes `CONTROL` step markers, rolling `down`/`back` events, old/new client counts and final result.
- `check-log.txt`: down migration checks, tests at each tag, exact migrate/backfill commands, health/version confirmations, and labelled checks after every live stage.
- `AI-LOG.md`: AI contribution record.
- `SELF_ASSESSMENT_REPORT.md`: six criteria, claimed points and links/line references to actual evidence. Fill it only after the official logs exist.


