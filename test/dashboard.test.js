'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../docs/core.js');

function build() {
  const now = Date.UTC(2026, 10, 21, 3, 0, 0), day = 1440;
  const db = Core.seedDb(), sg = '320x120|20,20,100,90,150,40';
  const user = id => db.users.find(x => x.id === id);
  const run = (uid, ago, a, p) => { const r = Core.apply(db, { user: user(uid), nowMs: now - ago * 60000 }, a, p); assert.ok(r.ok, a + ' ' + r.message); };
  const iid = r => Core.activeInspOf(db, r).id;
  // ห้อง 101: ผ่านครบเมื่อ 3 วันก่อน (ขั้น 1/2/3 ใช้เวลา 10/40/40 นาที รวม 90)
  run('front', 3 * day + 300, 'checkin', { roomId: '101' }); run('front', 3 * day + 200, 'checkout', { roomId: '101' });
  run('maid01', 3 * day + 150, 'cleaned', { roomId: '101', idSeed: 'a' });
  run('maid01', 3 * day + 140, 'submitStep', { inspectionId: iid('101'), step: 1, failures: [], signature: sg });
  run('head', 3 * day + 100, 'submitStep', { inspectionId: iid('101'), step: 2, failures: [], signature: sg });
  run('front', 3 * day + 60, 'submitStep', { inspectionId: iid('101'), step: 3, failures: [], signature: sg });
  // ห้อง 102: พบปัญหาเมื่อวาน ยังไม่แก้
  run('front', day + 300, 'checkin', { roomId: '102' }); run('front', day + 200, 'checkout', { roomId: '102' });
  run('maid01', day + 150, 'cleaned', { roomId: '102', idSeed: 'b' });
  run('maid01', day + 140, 'submitStep', { inspectionId: iid('102'), step: 1, signature: sg, failures: [{ itemNo: 14, kind: 'missing', found: 2, note: 'x' }] });
  return { db, now };
}

test('dashboard: สรุปตัวเลขย้อนหลังถูกต้อง', () => {
  const { db, now } = build();
  const d = Core.dashboard(db, now, 7);
  assert.equal(d.daily.length, 7);
  assert.deepEqual([d.totals.started, d.totals.clean, d.totals.issue, d.totals.open], [2, 1, 1, 0]);
  assert.equal(d.totals.firstPassRate, 50);
  assert.equal(d.totals.avgDone, 90);
  assert.deepEqual(d.stepWait.map(x => x.avg), [10, 40, 40]);
  assert.equal(d.issues.reported, 1); assert.equal(d.issues.open, 1); assert.equal(d.issues.missing, 1);
  assert.deepEqual(d.topRooms, [{ roomId: '102', count: 1 }]);
});

test('dashboard: ช่วงวันที่สั้นกว่าไม่นับใบตรวจที่เก่ากว่า และค่าผิดปกติถูกจำกัด', () => {
  const { db, now } = build();
  assert.equal(Core.dashboard(db, now, 2).totals.started, 1);
  assert.equal(Core.dashboard(db, now, 'x').days, 7);
  assert.equal(Core.dashboard(db, now, 999).days, 90);
});

test('dashboard: ไม่มีข้อมูลก็ไม่พัง', () => {
  const d = Core.dashboard({ inspections: [], steps: [], issues: [] }, Date.now(), 7);
  assert.equal(d.totals.started, 0); assert.equal(d.totals.firstPassRate, null); assert.equal(d.totals.avgDone, null);
});
