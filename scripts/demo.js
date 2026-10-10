// Replays the full IA#2 deployment and rollback sequence with two local
// instances. The optional rehearsal mode keeps its logs separate from hand-in
// evidence. This script never overwrites an existing database or log.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const rehearsal = process.argv.includes('--rehearsal');
const DATA = join(ROOT, 'data');
const suffix = rehearsal ? 'rehearsal-' + Date.now() : 'demo';
const DB = join(DATA, suffix + '.db');
const trafficLog = join(ROOT, rehearsal ? 'traffic-' + suffix + '.txt' : 'traffic-log.txt');
const checkLog = join(ROOT, rehearsal ? 'check-' + suffix + '.txt' : 'check-log.txt');
const control = join(DATA, suffix + '-traffic-control.json');
const ports = [3001, 3002];
const servers = new Map();
let traffic;
let trafficExit;
let cleaning = false;

mkdirSync(DATA, { recursive: true });
for (const path of [DB, trafficLog, checkLog, control]) {
  if (existsSync(path)) throw new Error('refusing to overwrite existing output: ' + path);
}
writeFileSync(checkLog, 'IA#2 ' + (rehearsal ? 'REHEARSAL' : 'OFFICIAL') +
  '\nStarted ' + new Date().toISOString() + '\nDB_PATH=' + DB + '\n');

function record(message) {
  appendFileSync(checkLog, message + '\n');
}

function run(executable, args, label, env = {}, cwd = ROOT) {
  record('\n=== ' + label + ' ===');
  const result = spawnSync(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    shell: process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd'),
  });
  if (result.stdout) record(result.stdout.trimEnd());
  if (result.stderr) record('STDERR:\n' + result.stderr.trimEnd());
  const code = result.status ?? 1;
  record('EXIT_CODE=' + code);
  if (result.error) throw result.error;
  return { code, output: (result.stdout || '') + '\n' + (result.stderr || '') };
}

function npm(args, label, db = DB) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return run(command, args, label, { DB_PATH: db });
}

function ok(result, label) {
  if (result.code !== 0) throw new Error(label + ' failed; see ' + checkLog);
}

function check(label, options = {}) {
  const allowLegacyStale = options.allowLegacyStale ?? false;
  const checkVnd = options.checkVnd ?? false;
  const expectedExplanation = options.expectedExplanation;
  const result = npm(['run', 'check'], label + ': npm run check');
  if (result.code !== 0) {
    if (!allowLegacyStale || !result.output.includes('INCONSISTENT'))
      throw new Error(label + ' consistency check failed; see ' + checkLog);
    if (!expectedExplanation) throw new Error(label + ' must explain its expected inconsistency');
    record('EXPECTED: ' + expectedExplanation);
  }
  if (checkVnd) {
    ok(npm(['run', 'check:vnd'], label + ': npm run check:vnd'), label + ' canonical VND check');
  }
}

function git(args, label) {
  ok(run('git', args, label), label);
}

function startServer(tag, port, cwd) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd,
    env: { ...process.env, DB_PATH: DB, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => record('[server ' + port + '] ' + chunk.toString().trimEnd()));
  }
  child.on('exit', (code, signal) => {
    if (!cleaning) record('[server ' + port + '] exited code=' + code + ' signal=' + signal);
  });
  servers.set(port, child);
}

async function healthy(port, tag) {
  for (let i = 0; i < 80; i++) {
    const child = servers.get(port);
    if (!child || child.exitCode !== null) throw new Error('server ' + port + ' exited before health check');
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      const versionOk = tag === 'v1' ? !body.version : body.version === tag;
      if (response.ok && body.ok && versionOk) {
        record('health port=' + port + ' version=' + tag + ' ok');
        return;
      }
    } catch {}
    await pause(250);
  }
  throw new Error('server ' + port + ' did not become healthy as ' + tag);
}

function stop(child, label, timeout = 10000) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  child.kill('SIGINT');
  return Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' did not stop gracefully')), timeout)),
  ]);
}

async function roll(port, tag, worktrees) {
  record('\n=== rolling restart port=' + port + ' tag=' + tag + ' ===');
  await stop(servers.get(port), 'server ' + port);
  servers.delete(port);
  startServer(tag, port, worktrees.get(tag));
  await healthy(port, tag);
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setControl(step, ratio, stop = false) {
  const temp = control + '.tmp';
  writeFileSync(temp, JSON.stringify({ STEP: step, NEW_CLIENTS: ratio, STOP: stop }, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, control);
      return;
    } catch (error) {
      if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await pause(25 * (attempt + 1));
    }
  }
}

async function checkTrafficRunning() {
  await pause(1000);
  if (traffic.exitCode !== null) throw new Error('traffic process exited early; see ' + trafficLog);
}

function assertNoTrafficFailures() {
  const text = readFileSync(trafficLog, 'utf8');
  const counts = [...text.matchAll(/(?:error|contract|stale|unavailable)=(\d+)/g)].map((m) => Number(m[1]));
  const failureLine = text.split('\n').find((line) => /\s(?:ERROR|CONTRACT|STALE|UNAVAILABLE)\s/.test(line));
  if (counts.some((count) => count !== 0) || failureLine)
    throw new Error('traffic recorded a failed request; see ' + trafficLog);
}

function verifyDownMigrations(scratch) {
  const db001 = join(scratch, '001.db');
  ok(npm(['run', 'migrate', '--', '--to', '001_init'], 'DOWN CHECK 001 up', db001), '001 up');
  ok(npm(['run', 'migrate:down'], 'DOWN CHECK 001 migrate:down', db001), '001 down');
  ok(npm(['run', 'migrate:status'], 'DOWN CHECK 001 status', db001), '001 down status');

  const db002 = join(scratch, '002.db');
  ok(npm(['run', 'migrate', '--', '--to', '002_expand_price_vnd'], 'DOWN CHECK 002 up', db002), '002 up');
  ok(npm(['run', 'seed', '--', '2'], 'DOWN CHECK 002 seed', db002), '002 seed');
  ok(npm(['run', 'migrate:down'], 'DOWN CHECK 002 migrate:down', db002), '002 down');
  ok(npm(['run', 'check'], 'DOWN CHECK 002 check after down', db002), '002 restored schema');

  const db003 = join(scratch, '003.db');
  ok(npm(['run', 'migrate', '--', '--to', '002_expand_price_vnd'], 'DOWN CHECK 003 expand', db003), '003 setup');
  ok(npm(['run', 'seed', '--', '2'], 'DOWN CHECK 003 seed', db003), '003 seed');
  ok(npm(['run', 'backfill', '--', '--delay-ms=0'], 'DOWN CHECK 003 backfill', db003), '003 backfill');
  ok(npm(['run', 'migrate', '--', '--to', '003_drop_price'], 'DOWN CHECK 003 contract up', db003), '003 up');
  ok(npm(['run', 'migrate:down'], 'DOWN CHECK 003 migrate:down', db003), '003 down');
  ok(npm(['run', 'check'], 'DOWN CHECK 003 check after down', db003), '003 restored schema');
  const checkData = run(process.execPath, ['--input-type=module', '-e',
    "import {open} from './src/db.js'; const d=open(); const r=d.prepare('SELECT price,price_vnd FROM menu_items LIMIT 1').get(); if(!r||r.price<15||r.price>250||Math.round(r.price*1000)!==r.price_vnd)process.exit(2); console.log(JSON.stringify(r)); d.close();",
  ], 'DOWN CHECK 003 verify re-derived price', { DB_PATH: db003 });
  ok(checkData, '003 restored data');
}

async function smokeApi() {
  const base = 'http://127.0.0.1:' + ports[0];
  const legacy = await fetch(base + '/menu/20000', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ price: 66.5 }),
  });
  const legacyBody = await legacy.json();
  if (legacy.status !== 200 || legacyBody.price !== 66.5 || legacyBody.priceVnd !== 66500)
    throw new Error('legacy PATCH contract failed after dropping price');
  record('old client PATCH /menu/20000 -> ' + legacy.status + ' price=' + legacyBody.price + ' priceVnd=' + legacyBody.priceVnd);

  const created = await fetch(base + '/menu', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'IA2 probe', priceVnd: 123456 }),
  });
  const createdBody = await created.json();
  if (created.status !== 201 || createdBody.price !== 123.456 || createdBody.priceVnd !== 123456)
    throw new Error('new client POST contract failed after dropping price');
  record('new client POST /menu -> ' + created.status + ' price=' + createdBody.price + ' priceVnd=' + createdBody.priceVnd);

  const item = await fetch(base + '/menu/' + createdBody.id);
  const itemBody = await item.json();
  const list = await fetch(base + '/menu?limit=2&offset=0');
  const listBody = await list.json();
  const order = await fetch(base + '/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ menuItemId: 1, qty: 2 }] }),
  });
  const orderBody = await order.json();
  if (item.status !== 200 || itemBody.priceVnd !== 123456 || list.status !== 200 ||
      !Array.isArray(listBody) || listBody.some((row) => typeof row.price !== 'number') ||
      order.status !== 201 || typeof orderBody.total !== 'number')
    throw new Error('GET/list/order API contract probe failed');
  record('GET detail=' + item.status + ' list=' + list.status + ' POST order=' + order.status + ' total=' + orderBody.total);
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'ia2-demo-'));
  const worktreeRoot = join(scratch, 'worktrees');
  mkdirSync(worktreeRoot);
  const worktrees = new Map();
  try {
    record('=== verify every migration down on disposable databases ===');
    verifyDownMigrations(join(scratch, 'down'));
    for (const tag of ['v1', 'v2', 'v3', 'v4']) {
      const path = join(worktreeRoot, tag);
      git(['worktree', 'add', '--detach', path, tag], 'create worktree ' + tag);
      worktrees.set(tag, path);
    }
    for (const tag of ['v1', 'v2', 'v3', 'v4']) {
      const result = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], 'PREFLIGHT ' + tag + ' npm test', {}, worktrees.get(tag));
      ok(result, tag + ' tests');
    }

    ok(npm(['run', 'migrate', '--', '--to', '001_init'], 'S0 initialize v1 schema'), '001 init');
    ok(npm(['run', 'seed', '--', '20000'], 'S0 seed 20,000 rows'), 'seed');
    check('S0 baseline');
    for (const port of ports) {
      startServer('v1', port, worktrees.get('v1'));
      await healthy(port, 'v1');
    }
    await setControl('S0 old clients only', 0);
    traffic = spawn(process.execPath, [join(ROOT, 'scripts', 'traffic.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        DURATION: '0',
        NEW_CLIENTS: '0',
        TARGETS: 'http://127.0.0.1:' + ports[0] + ',http://127.0.0.1:' + ports[1],
        TRAFFIC_CONTROL_FILE: control,
        LOG: trafficLog,
      },
      stdio: 'ignore',
    });
    traffic.on('exit', (code) => { trafficExit = code; });
    await checkTrafficRunning();
    check('S0 live traffic');

    await setControl('S1 expand', 0);
    ok(npm(['run', 'migrate', '--', '--to', '002_expand_price_vnd'], 'S1 add nullable price_vnd under traffic'), '002 up');
    check('S1 expand');

    await roll(ports[0], 'v2', worktrees);
    await setControl('S2A A=v2 B=v1', 0);
    check('S2A mixed versions', {
      allowLegacyStale: true,
      expectedExplanation: 'pre-backfill mixed deployment: v1 writes only price, so price_vnd may be NULL or stale; do not start a v3 reader yet.',
    });
    assertNoTrafficFailures();
    await roll(ports[1], 'v2', worktrees);
    await setControl('S2B both dual-write; enable new clients', 0.3);
    await pause(1000);
    check('S2B both v2', {
      allowLegacyStale: true,
      expectedExplanation: 'pre-backfill: historical rows may still have NULL or stale price_vnd even though both instances now dual-write; S3 must make the data consistent before v3 starts.',
    });

    await setControl('S3 backfill', 0.3);
    ok(npm(['run', 'backfill', '--', '--batch-size=500', '--delay-ms=25'], 'S3 backfill under traffic'), 'backfill');
    ok(npm(['run', 'backfill', '--', '--batch-size=500', '--delay-ms=0'], 'S3 idempotence rerun'), 'backfill rerun');
    check('S3 after backfill');
    assertNoTrafficFailures();

    await roll(ports[0], 'v3', worktrees);
    await setControl('S4A A=v3 B=v2', 0.3);
    check('S4A mixed readers');
    await roll(ports[1], 'v3', worktrees);
    await setControl('S4B both read price_vnd and dual-write', 0.3);
    check('S4B both v3');
    assertNoTrafficFailures();

    await roll(ports[0], 'v2', worktrees);
    await setControl('R1A rollback A to v2', 0.3);
    check('R1A A=v2 B=v3');
    await roll(ports[1], 'v2', worktrees);
    await setControl('R1B rollback both to v2', 0.3);
    check('R1B both v2');
    assertNoTrafficFailures();

    await roll(ports[0], 'v3', worktrees);
    await setControl('R2A forward A to v3', 0.3);
    check('R2A A=v3 B=v2');
    await roll(ports[1], 'v3', worktrees);
    await setControl('R2B forward both to v3', 0.3);
    check('R2B both v3');
    assertNoTrafficFailures();

    await roll(ports[0], 'v4', worktrees);
    await setControl('S5A v4 writes only price_vnd', 0.3);
    const probe = await fetch('http://127.0.0.1:' + ports[0] + '/menu/20000', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priceVnd: 123456 }),
    });
    const probeBody = await probe.json();
    if (probe.status !== 200 || probeBody.priceVnd !== 123456) throw new Error('v4-only write probe failed');
    record('S5A probe: v4 PATCH /menu/20000 -> ' + probe.status + ' price=' + probeBody.price + ' priceVnd=' + probeBody.priceVnd);
    check('S5A A=v4 B=v3 legacy mismatch expected', {
      allowLegacyStale: true,
      checkVnd: true,
      expectedExplanation: 'v4 has stopped writing legacy price; check:vnd below verifies the authoritative price_vnd column.',
    });
    await roll(ports[1], 'v4', worktrees);
    await setControl('S5B both v4', 0.3);
    check('S5B both v4 legacy mismatch expected', {
      allowLegacyStale: true,
      checkVnd: true,
      expectedExplanation: 'both instances run v4 and no longer write legacy price; check:vnd below verifies the authoritative price_vnd column.',
    });
    assertNoTrafficFailures();

    await setControl('S6 contract migration: drop legacy price while both instances serve v4', 0.3);
    await pause(350); // Let the single traffic process record the S6 marker before DDL starts.
    await checkTrafficRunning();
    ok(npm(['run', 'migrate', '--', '--to', '003_drop_price'], 'S6 drop price after all instances use v4'), '003 up');
    check('S6 after contract');
    await smokeApi();
    check('S6 after API probes');
    await setControl('S7 traffic after drop', 0.3);
    await pause(6000);
    assertNoTrafficFailures();
    await setControl('S7 finishing traffic log', 0.3, true);
    await Promise.race([
      new Promise((resolve) => traffic.once('exit', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('traffic did not finish after control stop')), 15000)),
    ]);
    traffic = undefined;
    if (trafficExit !== 0) throw new Error('traffic exited with code ' + trafficExit);
    check('S7 final');
    const logText = readFileSync(trafficLog, 'utf8');
    if (!logText.includes('NEW_CLIENTS=0 -> 0.3') ||
        !logText.includes('RESULT: zero failed requests') ||
        !logText.includes('client_new='))
      throw new Error('traffic log is missing required evidence');
    record('DEMO SUCCESS: all migrations, rolling deploys, rollback, and final traffic completed.');
  } finally {
    cleaning = true;
    if (traffic) await stop(traffic, 'traffic cleanup').catch((e) => record('cleanup warning: ' + e.message));
    for (const [port, child] of servers) await stop(child, 'server ' + port + ' cleanup').catch((e) => record('cleanup warning: ' + e.message));
    // Delete the temporary checkout tree first, then prune its now-stale Git
    // administrative records. This avoids Windows/OneDrive failing while Git
    // tries to delete its own metadata at the same time as the checkout.
    rmSync(scratch, { recursive: true, force: true });
    run('git', ['worktree', 'prune', '--expire=now', '--verbose'], 'cleanup temporary worktree metadata');
  }
}

main().catch((error) => {
  record('DEMO FAILED: ' + (error.stack || error.message));
  console.error(error.message);
  process.exitCode = 1;
});
