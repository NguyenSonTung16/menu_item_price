import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { open } from '../src/db.js';
import { createApp } from '../src/app.js';

let server, base, dbRef, supportsPrice, supportsPriceVnd;
before(async () => {
  const db = open(':memory:');
  dbRef = db;
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.up.sql')).sort())
    db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const columns = new Set(db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name));
  supportsPrice = columns.has('price');
  supportsPriceVnd = columns.has('price_vnd');
  if (supportsPrice && supportsPriceVnd) {
    db.prepare('INSERT INTO menu_items (name, price, price_vnd) VALUES (?, ?, ?)').run('Phở bò', 45.5, 45500);
    db.prepare('INSERT INTO menu_items (name, price, price_vnd) VALUES (?, ?, ?)').run('Trà đá', 5, 5000);
  } else if (supportsPriceVnd) {
    db.prepare('INSERT INTO menu_items (name, price_vnd) VALUES (?, ?)').run('Phở bò', 45500);
    db.prepare('INSERT INTO menu_items (name, price_vnd) VALUES (?, ?)').run('Trà đá', 5000);
  } else {
    db.exec("INSERT INTO menu_items (name, price) VALUES ('Phở bò', 45.5), ('Trà đá', 5)");
  }
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('GET /menu/:id keeps the legacy price contract', async () => {
  const r = await call('GET', '/menu/1');
  assert.equal(r.status, 200);
  assert.deepEqual({ id: r.body.id, name: r.body.name, price: r.body.price }, { id: 1, name: 'Phở bò', price: 45.5 });
  if (supportsPriceVnd) assert.equal(r.body.priceVnd, 45500);
});

test('PATCH /menu/:id accepts the legacy price and updates the new column too', async () => {
  const r = await call('PATCH', '/menu/2', { price: 6 });
  assert.equal(r.status, 200);
  assert.equal(r.body.price, 6);
  if (supportsPriceVnd) {
    assert.equal(r.body.priceVnd, 6000);
    assert.equal(dbRef.prepare('SELECT price_vnd FROM menu_items WHERE id = 2').get().price_vnd, 6000);
    if (supportsPrice) assert.equal(dbRef.prepare('SELECT price FROM menu_items WHERE id = 2').get().price, 6);
    assert.equal(dbRef.prepare('SELECT price_vnd FROM menu_items WHERE id = 2').get().price_vnd, 6000);
  }
});

test('POST /orders totals at the current price in thousands of dong', async () => {
  const r = await call('POST', '/orders', { items: [{ menuItemId: 1, qty: 2 }, { menuItemId: 2, qty: 1 }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 97);
});

test('v2+ accepts integer priceVnd on create and re-pricing', async (t) => {
  if (!supportsPriceVnd) return t.skip('priceVnd is added in v2');
  const created = await call('POST', '/menu', { name: 'Cà phê', priceVnd: 27500 });
  assert.equal(created.status, 201);
  assert.equal(created.body.price, 27.5);
  assert.equal(created.body.priceVnd, 27500);

  const changed = await call('PATCH', `/menu/${created.body.id}`, { priceVnd: 31000 });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.price, 31);
  assert.equal(changed.body.priceVnd, 31000);
});

test('v2+ rejects fractional and conflicting priceVnd input', async (t) => {
  if (!supportsPriceVnd) return t.skip('priceVnd is added in v2');
  assert.equal((await call('POST', '/menu', { name: 'Bad', priceVnd: 12.5 })).status, 400);
  assert.equal((await call('PATCH', '/menu/1', { price: 45.5, priceVnd: 46000 })).status, 400);
});

test('errors retain the starter shape', async () => {
  assert.equal((await call('GET', '/menu/999')).body.error, 'not_found');
  assert.equal((await call('PATCH', '/menu/1', { price: -1 })).status, 400);
});
