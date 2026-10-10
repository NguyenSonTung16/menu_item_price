import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { open } from '../src/db.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const up = (name) => readFileSync(join(root, 'migrations', name), 'utf8');

test('backfill repairs null and stale values in small batches and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia2-backfill-'));
  const dbPath = join(dir, 'fixture.db');
  try {
    const db = open(dbPath);
    db.exec(up('001_init.up.sql'));
    db.exec(up('002_expand_price_vnd.up.sql'));
    const insert = db.prepare('INSERT INTO menu_items (name, price, price_vnd) VALUES (?, ?, ?)');
    insert.run('NULL value', 45.5, null);
    insert.run('Stale value', 46, 45500);
    insert.run('Already correct', 25, 25000);
    db.close();

    const run = () => spawnSync(process.execPath, ['scripts/backfill-price-vnd.js', '--batch-size=1', '--delay-ms=0'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DB_PATH: dbPath },
    });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /repaired=2/);
    const verify = open(dbPath);
    assert.deepEqual(verify.prepare('SELECT price_vnd FROM menu_items ORDER BY id').all().map((r) => r.price_vnd), [45500, 46000, 25000]);
    verify.close();

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /repaired=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backfill refuses a price that cannot be represented as positive VND', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia2-backfill-invalid-'));
  const dbPath = join(dir, 'fixture.db');
  try {
    const db = open(dbPath);
    db.exec(up('001_init.up.sql'));
    db.exec(up('002_expand_price_vnd.up.sql'));
    db.prepare('INSERT INTO menu_items (name, price) VALUES (?, ?)').run('Sub-dong price', 0.0001);
    db.close();
    const result = spawnSync(process.execPath, ['scripts/backfill-price-vnd.js'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DB_PATH: dbPath },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to backfill/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
