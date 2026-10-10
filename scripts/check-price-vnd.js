// Check the canonical price column during step 5, when the old column may
// already be stale and scripts/check.js intentionally reports that mismatch.
import { open, DB_PATH } from '../src/db.js';

const db = open();
const cols = new Set(db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name));
if (!cols.has('price_vnd')) {
  console.error('price_vnd is missing');
  process.exit(1);
}
const total = db.prepare('SELECT count(*) AS n FROM menu_items').get().n;
const nulls = db.prepare('SELECT count(*) AS n FROM menu_items WHERE price_vnd IS NULL').get().n;
const invalid = db.prepare("SELECT count(*) AS n FROM menu_items WHERE typeof(price_vnd) <> 'integer' OR price_vnd <= 0").get().n;
console.log(`db ${DB_PATH}`);
console.log(`rows=${total} price_vnd_null=${nulls} price_vnd_invalid=${invalid}`);
if (cols.has('price')) console.log('legacy price column is present; compare/ignore only after the documented point where v4 stopped writing it');
const ok = nulls === 0 && invalid === 0;
console.log(ok ? 'CANONICAL PRICE_VND VALID' : 'CANONICAL PRICE_VND INVALID');
process.exit(ok ? 0 : 1);
