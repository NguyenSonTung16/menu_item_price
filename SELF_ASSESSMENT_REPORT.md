# Self-assessment report

| Criterion | Claimed points | Evidence |
| --- | ---: | --- |
| 1. Migration plan | 20 / 20 | `MIGRATION.md` lines 16–42: per-stage schema, code on both instances, rollback commands, compatible earlier tags, and the S5 boundary. `check-log.txt` lines 363–704 records the matching live stages. Tags `v1`–`v4` are present. |
| 2. Expand and dual-write | 20 / 20 | Tag `v1` retains the starter schema/code. `migrations/002_expand_price_vnd.up.sql` adds the column separately; tag `v2` writes both columns on POST and PATCH and supports `priceVnd`. `check-log.txt` lines 17–153 shows migrate:down checks for all three migrations on separate databases, including the 003 data restoration. All migrations have `.down.sql` files. |
| 3. Backfill | 15 / 15 | `scripts/backfill-price-vnd.js` processes short batches and repairs NULL or mismatched values. `check-log.txt` lines 398–470 shows it ran under traffic after both instances reached v2, repaired 19,294 rows, reran with zero repairs, and returned `CONSISTENT` with no NULL or disagreeing rows. |
| 4. Zero failed requests | 20 / 20 | `traffic-log.txt` lines 2–49 is one continuous run through every deploy and migration. It shows the client mix change after both instances reached v2, rolling down/back events, 50,922 successful requests, 12,843 new-client requests, zero error/contract/stale/unavailable counts, and `RESULT: zero failed requests`. |
| 5. Way back | 15 / 15 | `traffic-log.txt` lines 24–34 records rollback v3 → v2 and forward v2 → v3 under the same traffic run. `check-log.txt` lines 528–590 shows `CONSISTENT` before and after. `MIGRATION.md` lines 18–42 explains why this rollback is safe and why rollback from v4 to v2 is unsafe. |
| 6. Contract | 10 / 10 | `check-log.txt` lines 594–704 records v4 on both instances before migration 003, the post-drop schema check, old/new API probes for create/read/list/re-price/order, and final consistency. `traffic-log.txt` lines 42–49 shows clean traffic continuing after the drop. |
| **Total** | **100 / 100** | Evidence listed above. |

**What I did not manage:** No rubric criterion was left incomplete in this run. The exercise uses SQLite; a live PostgreSQL deployment was not part of the assignment.
