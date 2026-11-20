// ทดสอบการส่งเป็นชุด (batch): ฝั่ง Apps Script (Code.gs) จำลอง Google Sheet ในหน่วยความจำ และฝั่งเบราว์เซอร์ (api.js) จำลอง fetch
// รัน: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------------------------------------------------------------------------
// ฝั่ง Apps Script
// ---------------------------------------------------------------------------
function makeGas(opts) {
  opts = opts || {};
  const stats = { locks: 0, reads: {}, writes: {}, inserted: 0 };
  const store = {};
  const cacheData = {};
  let uuid = 0;
  function makeSheet(name, cols, maxRows) {
    const rows = [cols.slice()];
    let max = maxRows || 1000;
    const sh = {
      getLastRow: () => rows.length,
      getMaxRows: () => max,
      insertRowsAfter: (after, n) => { stats.inserted += n; max += n; },
      getRange: (r, c, nr, nc) => ({
        getValues: () => {
          stats.reads[name] = (stats.reads[name] || 0) + 1;
          const out = [];
          for (let i = 0; i < nr; i++) { const row = rows[r - 1 + i] || []; out.push(Array.from({ length: nc }, (_, j) => (row[c - 1 + j] == null ? '' : row[c - 1 + j]))); }
          return out;
        },
        setValues: (vals) => {
          stats.writes[name] = (stats.writes[name] || 0) + 1;
          if (r - 1 + nr > max) throw new Error('outside dimensions: ' + name);
          vals.forEach((v, i) => { rows[r - 1 + i] = v.slice(); });
        },
        setNumberFormat: () => ({})
      })
    };
    sh._rows = rows;
    return sh;
  }
  const sheets = {};
  const ctx = vm.createContext({
    console,
    Logger: { log() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null }) },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cacheData ? cacheData[k] : null),
        put: (k, v) => { cacheData[k] = String(v); },
        getAll: (ks) => { const o = {}; ks.forEach((k) => { if (k in cacheData) o[k] = cacheData[k]; }); return o; },
        putAll: (o) => { Object.keys(o).forEach((k) => { cacheData[k] = String(o[k]); }); },
        remove: (k) => { delete cacheData[k]; }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => { stats.locks++; return !opts.lockBusy; }, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => store[k] || null, setProperty: (k, v) => { store[k] = v; } }) },
    Utilities: { getUuid: () => 'uuid-' + (++uuid), formatDate: (d) => String(d) },
    ContentService: {}
  });
  vm.runInContext(read('apps-script/Core.gs'), ctx);
  vm.runInContext(read('apps-script/Code.gs'), ctx);
  const Core = ctx.Core;
  Object.keys(Core.SCHEMA).forEach((n) => { sheets[n] = makeSheet(n, Core.SCHEMA[n].cols, opts.logMax && n === 'Log' ? opts.logMax : 1000); });
  ctx.writeRows_('Rooms', Core.seedRooms(5, 8));
  ctx.writeRows_('Items', Core.seedItems());
  Object.keys(stats.reads).forEach((k) => delete stats.reads[k]);
  Object.keys(stats.writes).forEach((k) => delete stats.writes[k]);
  return { ctx, Core, stats, sheets, cacheData };
}

const U = (id, role, floors) => ({ id, name: id, role, floors: floors || '' });
const front = U('front', 'reception');
const maid01 = U('maid01', 'maid', '1');
const room = (g, id) => g.sheets.Rooms._rows.find((r) => String(r[0]) === id);
const op = (opId, action, payload) => ({ opId, action, payload });
const batch = (g, user, ops) => JSON.parse(JSON.stringify(g.ctx.batch_(user, { ops })));

test('batch: หลายคำสั่งในคำขอเดียว ล็อกครั้งเดียว อ่านชีต Rooms ครั้งเดียว เขียนครั้งเดียว', () => {
  const g = makeGas();
  const r = batch(g, front, [op('a', 'checkin', { roomId: '101' }), op('b', 'checkin', { roomId: '102' }), op('c', 'checkout', { roomId: '101' })]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true]);
  assert.equal(g.stats.locks, 1);
  assert.equal(g.stats.reads.Rooms, 1);
  assert.equal(g.stats.writes.Rooms, 1, 'เขียน Rooms ครั้งเดียวสำหรับทุกคำสั่ง');
  assert.equal(g.stats.writes.Log, 1);
  assert.equal(room(g, '101')[2], 'dirty');
  assert.equal(room(g, '102')[2], 'occupied');
  assert.equal(g.sheets.Log._rows.length - 1, 3);
  assert.notEqual(r.prev, r.ver);
});

test('batch: คำสั่งที่ผิดกฎถูกข้ามรายตัว ไม่ทำให้คำสั่งอื่นล้ม', () => {
  const g = makeGas();
  const r = batch(g, front, [op('a', 'checkin', { roomId: '101' }), op('b', 'checkin', { roomId: '101' }), op('c', 'checkin', { roomId: '102' })]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => x.ok), [true, false, true]);
  assert.equal(r.results[1].code, 'ALREADY_OCCUPIED');
  assert.equal(room(g, '101')[2], 'occupied');
  assert.equal(room(g, '102')[2], 'occupied');
  assert.equal(g.sheets.Log._rows.length - 1, 2);
});

test('batch: คำสั่งหลังเห็นผลของคำสั่งก่อนหน้า (ทำความสะอาด → ตรวจขั้น 1 ในชุดเดียว)', () => {
  const g = makeGas();
  batch(g, front, [op('a', 'checkin', { roomId: '101' }), op('b', 'checkout', { roomId: '101' })]);
  const r = batch(g, maid01, [
    op('c', 'cleaned', { roomId: '101', idSeed: 'zz1' }),
    op('d', 'submitStep', { inspectionId: 'I-101-zz1', step: 1, failures: [] })
  ]);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true], JSON.stringify(r.results));
  const insp = g.sheets.Inspections._rows[1];
  assert.equal(insp[0], 'I-101-zz1');
  assert.equal(insp[6], 2, 'ตรวจขั้น 1 ผ่านแล้วขึ้นขั้น 2');
  assert.equal(room(g, '101')[2], 'inspecting');
});

test('batch: ส่งซ้ำด้วย opId เดิมไม่ทำซ้ำ และไม่เปลี่ยนเวอร์ชัน', () => {
  const g = makeGas();
  const ops = [op('a', 'checkin', { roomId: '101' }), op('b', 'checkin', { roomId: '102' })];
  const first = batch(g, front, ops);
  const logs = g.sheets.Log._rows.length;
  const again = batch(g, front, ops);
  assert.deepEqual(again.results.map((x) => x.ok), [true, true]);
  assert.equal(g.sheets.Log._rows.length, logs);
  assert.equal(again.ver, first.ver);
  // ชุดที่ส่งซ้ำปนคำสั่งใหม่: ทำเฉพาะคำสั่งใหม่
  const mixed = batch(g, front, [ops[0], op('c', 'checkin', { roomId: '103' })]);
  assert.deepEqual(mixed.results.map((x) => x.ok), [true, true]);
  assert.equal(room(g, '103')[2], 'occupied');
  assert.equal(g.sheets.Log._rows.length, logs + 1);
});

test('batch: ผลที่ถูกปฏิเสธก็จำไว้ ส่งซ้ำได้ผลเดิม', () => {
  const g = makeGas();
  batch(g, front, [op('a', 'checkin', { roomId: '101' })]);
  const r1 = batch(g, front, [op('x', 'checkin', { roomId: '101' }), op('y', 'checkin', { roomId: '102' })]);
  const r2 = batch(g, front, [op('x', 'checkin', { roomId: '101' }), op('y', 'checkin', { roomId: '102' })]);
  assert.deepEqual(r2.results, r1.results);
  assert.equal(r2.results[0].code, 'ALREADY_OCCUPIED');
});

test('batch: ชุดว่างหรือใหญ่เกินกำหนดถูกปฏิเสธ, ล็อกไม่ว่างได้ BUSY', () => {
  const g = makeGas();
  assert.equal(g.ctx.batch_(front, { ops: [] }).code, 'ERROR');
  const many = Array.from({ length: 31 }, (_, i) => op('m' + i, 'checkin', { roomId: '101' }));
  assert.equal(g.ctx.batch_(front, { ops: many }).code, 'ERROR');
  const busy = makeGas({ lockBusy: true });
  assert.equal(busy.ctx.batch_(front, { ops: [op('a', 'checkin', { roomId: '101' })] }).code, 'BUSY');
});

test('writeRows_: เมื่อแถวเต็มชีตจะเพิ่มแถวให้ก่อนเขียน (ไม่ล้ม)', () => {
  const g = makeGas({ logMax: 4 });
  batch(g, front, [op('a', 'checkin', { roomId: '101' }), op('b', 'checkin', { roomId: '102' }), op('c', 'checkin', { roomId: '103' }), op('d', 'checkin', { roomId: '104' })]);
  assert.ok(g.stats.inserted > 0);
  assert.equal(g.sheets.Log._rows.length - 1, 4);
});

// ---------------------------------------------------------------------------
// ฝั่งเบราว์เซอร์ (api.js)
// ---------------------------------------------------------------------------
function makeClient(server, extra) {
  const ls = Object.assign({ rc_token: 'tok', rc_user: JSON.stringify(front) }, extra || {});
  const sent = [];
  const events = [];
  const ctx = vm.createContext({
    console, setTimeout, Promise, JSON, Date, Math,
    window: { APP_CONFIG: { API_URL: 'https://example.test/exec' } },
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
    fetch: (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      return new Promise((res) => setTimeout(() => res({ json: () => Promise.resolve(server(body)) }), 15));
    }
  });
  vm.runInContext(read('docs/core.js'), ctx);
  vm.runInContext(read('docs/demo.js'), ctx);
  vm.runInContext(read('docs/api.js'), ctx);
  ctx.Api.init();
  ctx.Api.onEvent = (t, d) => events.push([t, d]);
  return { Api: ctx.Api, sent, events, ls };
}

// เซิร์ฟเวอร์จำลองที่รู้จัก state/single/batch
function fakeServer(o) {
  o = o || {};
  const core = vm.createContext({});
  vm.runInContext(read('docs/core.js'), core);
  let ver = 0;
  const seen = {};
  return (req) => {
    if (req.action === 'state') return { ok: true, user: front, ver: 'v' + ver, db: vm.runInContext('Core.seedDb()', core) };
    if (req.action === 'ping') return { ok: true, ver: 'v' + ver };
    if (req.action === 'batch') {
      if (o.noBatch) return { ok: false, code: 'UNKNOWN', message: 'ไม่รู้จักคำสั่ง batch' };
      const prev = 'v' + ver; ver++;
      return { ok: true, prev, ver: 'v' + ver, results: req.ops.map((x) => (o.rejectRoom === x.payload.roomId ? { opId: x.opId, ok: false, code: 'NOT_OCCUPIED', message: 'x' } : { opId: x.opId, ok: true })) };
    }
    const prev = 'v' + ver; ver++;
    seen[req.opId] = 1;
    return { ok: true, prev, ver: 'v' + ver };
  };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 60));

test('api: คำสั่งที่กดระหว่างรอ รวมเป็นชุดเดียว และรักษาลำดับ', async () => {
  const c = makeClient(fakeServer());
  await c.Api.state();
  const rooms = ['101', '102', '103', '104', '105'];
  const rs = [await c.Api.act('checkin', { roomId: rooms[0] })];
  assert.equal(rs[0].optimistic, true);
  for (const id of rooms.slice(1)) rs.push(await c.Api.act('checkin', { roomId: id }));
  assert.ok(rs.every((r) => r.ok && r.optimistic), 'แสดงผลทันทีทุกคำสั่ง');
  assert.equal(c.Api.busy(), true);
  await tick(150);
  assert.equal(c.Api.busy(), false);
  const acts = c.sent.filter((s) => s.action !== 'state');
  assert.equal(acts.length, 2, 'คำสั่งแรกส่งเดี่ยว ที่เหลือรวมเป็นชุดเดียว: ' + JSON.stringify(acts.map((a) => a.action)));
  assert.equal(acts[0].action, 'checkin');
  assert.equal(acts[1].action, 'batch');
  assert.deepEqual(acts[1].ops.map((o) => o.payload.roomId), ['102', '103', '104', '105']);
  assert.equal(c.Api.version(), 'v2', 'เวอร์ชันของเราเองไม่ทำให้โหลดข้อมูลซ้ำ');
  assert.equal(c.Api.pending(), 0);
  assert.deepEqual(c.events, []);
});

test('api: เซิร์ฟเวอร์ปฏิเสธบางคำสั่งในชุด → แจ้ง reject หนึ่งครั้ง และคำสั่งอื่นไม่ถูกส่งซ้ำ', async () => {
  const c = makeClient(fakeServer({ rejectRoom: '103' }));
  await c.Api.state();
  for (const id of ['101', '102', '103', '104']) await c.Api.act('checkin', { roomId: id });
  await tick(150);
  assert.equal(c.Api.busy(), false);
  const rej = c.events.filter((e) => e[0] === 'reject');
  assert.equal(rej.length, 1);
  assert.equal(rej[0][1].code, 'NOT_OCCUPIED');
  assert.equal(c.Api.pending(), 0, 'การปฏิเสธตามกฎไม่เข้าคิวส่งซ้ำ');
});

test('api: เซิร์ฟเวอร์เวอร์ชันเก่า (ไม่รู้จัก batch) ถอยไปส่งทีละคำสั่งตามลำดับ', async () => {
  const c = makeClient(fakeServer({ noBatch: true }));
  await c.Api.state();
  for (const id of ['101', '102', '103', '104']) await c.Api.act('checkin', { roomId: id });
  await tick(300);
  assert.equal(c.Api.busy(), false);
  const singles = c.sent.filter((s) => s.action === 'checkin').map((s) => s.payload.roomId);
  assert.deepEqual(singles, ['101', '102', '103', '104'], 'ส่งครบ ลำดับไม่สลับ ไม่ซ้ำ');
  assert.equal(c.events.filter((e) => e[0] === 'reject').length, 0);
});

test('api: คิวที่ค้างตอนสัญญาณหลุด flush ส่งเป็นชุดเดียว', async () => {
  const queued = ['101', '102', '103'].map((id, i) => ({ opId: 'q' + i, action: 'checkin', payload: { roomId: id }, user: front }));
  const c = makeClient(fakeServer(), { rc_queue: JSON.stringify(queued) });
  assert.equal(c.Api.pending(), 3);
  const r = await c.Api.flush();
  assert.equal(r.sent, 3);
  assert.equal(r.dropped.length, 0);
  assert.equal(c.Api.pending(), 0);
  assert.equal(JSON.parse(c.ls.rc_queue).length, 0);
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].action, 'batch');
  assert.deepEqual(c.sent[0].ops.map((o) => o.opId), ['q0', 'q1', 'q2']);
});

test('api: flush เจอคำสั่งที่เซิร์ฟเวอร์ปฏิเสธ → ทิ้งพร้อมข้อความ ที่เหลือส่งสำเร็จ', async () => {
  const queued = ['101', '102', '103'].map((id, i) => ({ opId: 'q' + i, action: 'checkin', payload: { roomId: id }, user: front }));
  const c = makeClient(fakeServer({ rejectRoom: '102' }), { rc_queue: JSON.stringify(queued) });
  const r = await c.Api.flush();
  assert.equal(r.sent, 2);
  assert.equal(r.dropped.length, 1);
  assert.equal(c.Api.pending(), 0);
});
