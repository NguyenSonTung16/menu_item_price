// Idempotent backfill. Each batch is one short transaction so live requests
// can continue between batches. Run only after every instance dual-writes.
import { open, DB_PATH } from '../src/db.js';

function option(name, fallback) {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  return arg ? Number(arg.slice(name.length + 3)) : fallback;
}

const batchSize = option('batch-size', 500);
const delayMs = option('delay-ms', 25);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000 ||
    !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000) {
  console.error('batch-size must be 1..5000 and delay-ms must be 0..60000');
  process.exit(2);
}

const db = open();
const cols = new Set(db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name));
if (!cols.has('price') || !cols.has('price_vnd')) {
  console.error(`backfill requires both price columns; found ${[...cols].join(', ')}`);
  process.exit(2);
}

const badSource = db.prepare("SELECT count(*) AS n FROM menu_items WHERE price IS NULL OR typeof(price) NOT IN ('integer', 'real') OR price <= 0 OR price > 100000").get().n;
if (badSource !== 0) {
  console.error(`refusing to backfill: ${badSource} source prices are null or outside the supported range`);
  process.exit(1);
}

const pick = db.prepare(`
  SELECT id FROM menu_items
  WHERE price_vnd IS NULL OR price_vnd <> CAST(round(price * 1000) AS INTEGER)
  ORDER BY id LIMIT ?
`);
const update = db.prepare('UPDATE menu_items SET price_vnd = CAST(round(price * 1000) AS INTEGER) WHERE id = ?');
let total = 0;
let batches = 0;
console.log(`backfill start db=${DB_PATH} batch_size=${batchSize} delay_ms=${delayMs}`);

while (true) {
  db.exec('BEGIN IMMEDIATE');
  let ids;
  try {
    ids = pick.all(batchSize).map((row) => row.id);
    for (const id of ids) update.run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (ids.length === 0) break;
  batches++;
  total += ids.length;
  console.log(`batch=${batches} repaired=${ids.length} total=${total}`);
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

console.log(`backfill done batches=${batches} repaired=${total}; rerunning now should repair 0 rows`);
