// รัน: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../docs/core.js');
const Demo = require('../docs/demo.js');

const T0 = Date.UTC(2026, 10, 20, 2, 0, 0); // 20 พ.ย. 2026 09:00 เวลาไทย
const min = (n) => n * 60000;

function fresh() {
  const db = Core.seedDb();
  const u = (id) => db.users.find((x) => x.id === id);
  let clock = T0;
  const run = (uid, action, payload, advance) => {
    clock += min(advance == null ? 1 : advance);
    return Core.apply(db, { user: u(uid), nowMs: clock }, action, payload);
  };
  const ok = (uid, action, payload, advance) => {
    const r = run(uid, action, payload, advance);
    assert.equal(r.ok, true, `${uid}:${action} → ${r.message}`);
    return r;
  };
  return { db, run, ok, now: () => clock };
}
const room = (db, id) => db.rooms.find((r) => r.id === id);
const active = (db, id) => Core.activeInspOf(db, id);

test('เวลา: stamp/toMs เป็นเวลาไทย และย้อนกลับได้', () => {
  assert.equal(Core.stamp(T0), '2026-11-20 09:00:00');
  assert.equal(Core.toMs('2026-11-20 09:00:00'), T0);
  assert.equal(Core.dateOf(Date.UTC(2026, 10, 20, 18, 0, 0)), '2026-11-21'); // 01:00 ไทยของวันถัดไป
});

test('ข้อมูลตั้งต้น: 40 ห้อง 25 รายการ ตรงฟอร์มกระดาษ', () => {
  const db = Core.seedDb();
  assert.equal(db.rooms.length, 40);
  assert.deepEqual([...new Set(db.rooms.map((r) => r.floor))], [1, 2, 3, 4, 5]);
  assert.equal(db.rooms.filter((r) => r.floor === 5).length, 8);
  assert.equal(db.rooms[0].id, '101'); assert.equal(db.rooms[39].id, '508');
  const maids = db.users.filter((u) => u.role === 'maid');
  assert.deepEqual(maids.map((u) => u.floors), ['1', '2', '3', '4', '5'], 'แม่บ้านชั้นละ 1 คน');
  assert.deepEqual(maids.map((u) => u.name), ['แม่บ้าน ชั้น 1', 'แม่บ้าน ชั้น 2', 'แม่บ้าน ชั้น 3', 'แม่บ้าน ชั้น 4', 'แม่บ้าน ชั้น 5']);
  assert.equal(db.items.length, 25);
  assert.equal(db.items[13].name, 'น้ำดื่ม');
  assert.equal(db.items[13].qty, 4);
  assert.equal(db.items.reduce((s, i) => s + i.qty, 0), 2 + 1 + 2 + 3 + 1 + 1 + 1 + 1 + 2 + 2 + 2 + 2 + 2 + 4 + 2 + 2 + 2 + 2 + 2 + 1 + 4 + 6 + 6 + 6 + 5);
});

test('วงจรเต็ม: เช็กอิน → เช็กเอาท์ → ทำความสะอาด → ตรวจ 3 ขั้น → พร้อมขาย', () => {
  const { db, ok } = fresh();
  ok('front', 'checkin', { roomId: '203' });
  assert.equal(room(db, '203').status, 'occupied');
  ok('front', 'checkout', { roomId: '203' });
  assert.equal(room(db, '203').status, 'dirty');
  const r = ok('maid01', 'cleaned', { roomId: '203', idSeed: 'abc123' });
  assert.equal(r.result.inspectionId, 'I-203-abc123');
  assert.equal(room(db, '203').status, 'inspecting');
  const id = active(db, '203').id;
  ok('maid01', 'submitStep', { inspectionId: id, step: 1, failures: [] });
  assert.equal(active(db, '203').step, 2);
  ok('head', 'submitStep', { inspectionId: id, step: 2, failures: [] });
  assert.equal(active(db, '203').step, 3);
  assert.equal(room(db, '203').status, 'inspecting');
  ok('front', 'submitStep', { inspectionId: id, step: 3, failures: [] });
  assert.equal(room(db, '203').status, 'ready');
  assert.equal(active(db, '203'), null);
  assert.equal(Core.inspOf(db, id).status, 'passed');
  assert.deepEqual(db.steps.map((s) => [s.step, s.userId, s.okCount]), [[1, 'maid01', 25], [2, 'head', 25], [3, 'front', 25]]);
});

test('รอบการใช้ห้องใหม่: พักซ้ำแล้วสร้างใบตรวจใหม่ ใบเก่าเก็บเป็นประวัติ', () => {
  const { db, ok } = fresh();
  for (const seed of ['r1', 'r2']) {
    ok('front', 'checkin', { roomId: '101' });
    ok('front', 'checkout', { roomId: '101' });
    ok('maid01', 'cleaned', { roomId: '101', idSeed: seed });
    const id = active(db, '101').id;
    ok('maid01', 'submitStep', { inspectionId: id, step: 1, failures: [] });
    ok('head', 'submitStep', { inspectionId: id, step: 2, failures: [] });
    ok('front', 'submitStep', { inspectionId: id, step: 3, failures: [] });
  }
  const mine = db.inspections.filter((i) => i.roomId === '101');
  assert.equal(mine.length, 2);
  assert.ok(mine.every((i) => i.status === 'passed'));
  assert.notEqual(mine[0].id, mine[1].id);
});

test('สิทธิ์: แต่ละขั้นตรวจได้เฉพาะบทบาทของขั้นนั้น และ admin ตรวจไม่ได้', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '102' });
  ok('front', 'checkout', { roomId: '102' });
  ok('maid01', 'cleaned', { roomId: '102' });
  const id = active(db, '102').id;
  for (const who of ['head', 'front', 'admin']) {
    const r = run(who, 'submitStep', { inspectionId: id, step: 1, failures: [] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'FORBIDDEN');
  }
  assert.equal(run('maid01', 'checkin', { roomId: '105' }).code, 'FORBIDDEN');
  assert.equal(run('maid01', 'checkout', { roomId: '101' }).code, 'FORBIDDEN');
  assert.equal(run('head', 'cleaned', { roomId: '102' }).code, 'FORBIDDEN');
  assert.equal(run('front', 'cancelInspection', { inspectionId: id }).code, 'FORBIDDEN');
  ok('maid01', 'submitStep', { inspectionId: id, step: 1, failures: [] });
  assert.equal(run('maid01', 'submitStep', { inspectionId: id, step: 2, failures: [] }).code, 'FORBIDDEN');
});

test('กันส่งซ้ำ/ข้อมูลเก่า: step ไม่ตรงถูกปฏิเสธ และไม่แก้ข้อมูล', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '102' });
  ok('front', 'checkout', { roomId: '102' });
  ok('maid01', 'cleaned', { roomId: '102' });
  const id = active(db, '102').id;
  ok('maid01', 'submitStep', { inspectionId: id, step: 1, failures: [] });
  const before = JSON.stringify(db);
  const r = run('maid01', 'submitStep', { inspectionId: id, step: 1, failures: [] });
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(db), before);
});

test('พบปัญหา: ห้อง = มีปัญหา, สร้าง issue, ไม่ส่งต่อ, แจ้งแม่บ้านชั้นนั้น', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '208' });
  ok('front', 'checkout', { roomId: '208' });
  ok('maid01', 'cleaned', { roomId: '208' });
  const id = active(db, '208').id;
  const r = ok('maid01', 'submitStep', {
    inspectionId: id, step: 1,
    failures: [{ itemNo: 14, kind: 'missing', found: 2, note: 'หาย 2 ขวด' }, { itemNo: 9, kind: 'damaged', found: 1 }]
  });
  assert.equal(room(db, '208').status, 'issue');
  assert.equal(Core.inspOf(db, id).status, 'fixing');
  assert.equal(Core.inspOf(db, id).recheckItems, '14,9');
  assert.equal(db.issues.length, 2);
  assert.equal(db.issues[0].itemName, 'น้ำดื่ม');
  assert.equal(db.steps[0].okCount, 23);
  assert.equal(db.steps[0].result, 'fail');
  assert.deepEqual(r.notify[0].to, { role: 'maid', floor: 2 });
  assert.equal(r.notify[0].kind, 'issue');
  // ระหว่างแก้ ห้ามผ่านต่อ
  assert.equal(run('head', 'submitStep', { inspectionId: id, step: 1, failures: [] }).ok, false);
  assert.equal(run('maid01', 'submitStep', { inspectionId: id, failures: [] }).code, 'NEEDS_FIX');
});

test('แก้แล้วตรวจซ้ำ: กลับขั้นเดิม เห็นเฉพาะรายการที่มีปัญหา แล้วผ่านต่อได้', () => {
  const { db, ok } = fresh();
  ok('front', 'checkin', { roomId: '304' });
  ok('front', 'checkout', { roomId: '304' });
  ok('maid04', 'cleaned', { roomId: '304' });
  const id = active(db, '304').id;
  ok('maid04', 'submitStep', { inspectionId: id, step: 1, failures: [] });
  ok('head', 'submitStep', { inspectionId: id, step: 2, failures: [{ itemNo: 7, kind: 'missing', found: 0 }] });
  assert.equal(room(db, '304').status, 'issue');
  // งานของแม่บ้านต้องมี "แก้ไข" และของหัวหน้าต้องยังไม่มี
  assert.equal(Core.tasksFor(db, db.users.find((u) => u.id === 'maid03')).filter((t) => t.kind === 'fix').length, 1);
  assert.equal(Core.tasksFor(db, db.users.find((u) => u.id === 'head')).length, 0);
  const fx = ok('maid04', 'markFixed', { inspectionId: id });
  assert.equal(fx.notify[0].to.role, 'head_maid');
  assert.equal(db.issues[0].status, 'fixed');
  const insp = Core.inspOf(db, id);
  assert.equal(insp.status, 'open');
  assert.equal(insp.step, 2);
  assert.deepEqual(Core.recheckList(insp), [7]);
  const t = Core.tasksFor(db, db.users.find((u) => u.id === 'head'));
  assert.equal(t.length, 1);
  assert.equal(t[0].recheck, 1);
  ok('head', 'submitStep', { inspectionId: id, step: 2, failures: [] });
  assert.equal(db.steps[db.steps.length - 1].mode, 'recheck');
  assert.equal(Core.inspOf(db, id).recheckItems, '');
  ok('front', 'submitStep', { inspectionId: id, step: 3, failures: [] });
  assert.equal(room(db, '304').status, 'ready');
});

test('ตรวจซ้ำแล้วยังไม่ผ่าน: วนกลับไปแก้อีกรอบ', () => {
  const { db, ok } = fresh();
  ok('front', 'checkin', { roomId: '101' });
  ok('front', 'checkout', { roomId: '101' });
  ok('maid01', 'cleaned', { roomId: '101' });
  const id = active(db, '101').id;
  ok('maid01', 'submitStep', { inspectionId: id, step: 1, failures: [{ itemNo: 8, kind: 'damaged', found: 0 }] });
  ok('maid01', 'markFixed', { inspectionId: id });
  ok('maid01', 'submitStep', { inspectionId: id, step: 1, failures: [{ itemNo: 8, kind: 'damaged', found: 0 }] });
  assert.equal(room(db, '101').status, 'issue');
  assert.equal(db.issues.length, 2);
  assert.equal(new Set(db.issues.map((x) => x.id)).size, 2);
});

test('เช็กอินห้องที่ยังตรวจไม่ครบ: ต้องยืนยัน, ยืนยันแล้วยกเลิกใบตรวจค้าง', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '106' });
  ok('front', 'checkout', { roomId: '106' });
  assert.equal(run('front', 'checkin', { roomId: '106' }).code, 'NEEDS_CONFIRM'); // dirty
  ok('maid01', 'cleaned', { roomId: '106' });
  const r = run('front', 'checkin', { roomId: '106' });
  assert.equal(r.code, 'NEEDS_CONFIRM');
  assert.match(r.message, /ยังตรวจไม่ครบ/);
  assert.equal(room(db, '106').status, 'inspecting');
  ok('front', 'checkin', { roomId: '106', force: true });
  assert.equal(room(db, '106').status, 'occupied');
  assert.equal(db.inspections.find((i) => i.roomId === '106').status, 'cancelled');
  assert.equal(run('front', 'checkin', { roomId: '106' }).code, 'ALREADY_OCCUPIED');
});

test('เช็กเอาท์ได้เฉพาะห้องที่มีแขก / ทำความสะอาดได้เฉพาะห้องที่รอทำความสะอาด', () => {
  const { ok, run } = fresh();
  assert.equal(run('front', 'checkout', { roomId: '101' }).code, 'NOT_OCCUPIED');
  assert.equal(run('maid01', 'cleaned', { roomId: '101' }).code, 'NOT_DIRTY');
  assert.equal(run('front', 'checkin', { roomId: '999' }).code, 'NO_ROOM');
  const r = ok('front', 'checkin', { roomId: '101' });
  assert.deepEqual(r.notify, []);
  const o = ok('front', 'checkout', { roomId: '101' });
  assert.deepEqual(o.notify[0].to, { role: 'maid', floor: 1 });
});

test('ตรวจตามรอบ: เริ่มได้เฉพาะห้องว่าง, ห้ามซ้ำรอบเดียวกันในวัน, หลายห้องพร้อมกัน', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '102' });
  const r = ok('head', 'startRoutineMany', { round: 'morning', roomIds: ['101', '102', '103'] });
  assert.equal(r.result.started.length, 2);
  assert.equal(r.result.skipped[0].roomId, '102');
  assert.equal(room(db, '101').status, 'inspecting');
  assert.equal(room(db, '102').status, 'occupied');
  assert.equal(run('head', 'startRoutine', { roomId: '101', round: 'morning' }).code, 'NOT_READY');
  // ผ่านครบแล้วเริ่มรอบเดิมอีกไม่ได้ แต่รอบบ่ายได้
  const id = active(db, '101').id;
  ok('maid01', 'submitStep', { inspectionId: id, step: 1, failures: [] });
  ok('head', 'submitStep', { inspectionId: id, step: 2, failures: [] });
  ok('front', 'submitStep', { inspectionId: id, step: 3, failures: [] });
  assert.equal(run('head', 'startRoutine', { roomId: '101', round: 'morning' }).code, 'ALREADY_DONE');
  ok('head', 'startRoutine', { roomId: '101', round: 'afternoon' });
  assert.equal(run('head', 'startRoutine', { roomId: '104', round: 'night' }).code, 'BAD_ROUND');
  assert.equal(run('front', 'startRoutine', { roomId: '104', round: 'morning' }).code, 'FORBIDDEN');
});

test('ผ่านทั้งหมดที่เลือก (bulkPass): ผ่านเฉพาะที่ถึงคิวและมีสิทธิ์', () => {
  const { db, ok, run } = fresh();
  ok('head', 'startRoutineMany', { round: 'morning', roomIds: ['101', '102', '103'] });
  const ids = ['101', '102', '103'].map((r) => active(db, r).id);
  for (const id of ids.slice(0, 2)) ok('maid01', 'submitStep', { inspectionId: id, step: 1, failures: [] });
  // 103 ยังอยู่ขั้น 1 → ถูกข้าม
  const items = ids.map((id) => ({ inspectionId: id, step: 2 }));
  const r = ok('head', 'bulkPass', { items });
  assert.equal(r.result.passed.length, 2);
  assert.equal(r.result.skipped.length, 1);
  assert.equal(run('maid01', 'bulkPass', { items: [{ inspectionId: ids[0], step: 3 }] }).result.passed.length, 0);
  assert.equal(Core.inspOf(db, ids[0]).step, 3);
});

test('admin ยกเลิกใบตรวจ: หลังแขกออก → รอทำความสะอาดใหม่, ตามรอบ → พร้อมขาย', () => {
  const { db, ok, run } = fresh();
  ok('front', 'checkin', { roomId: '101' });
  ok('front', 'checkout', { roomId: '101' });
  ok('maid01', 'cleaned', { roomId: '101' });
  ok('admin', 'cancelInspection', { inspectionId: active(db, '101').id, reason: 'กดผิดห้อง' });
  assert.equal(room(db, '101').status, 'dirty');
  ok('head', 'startRoutine', { roomId: '102', round: 'morning' });
  ok('admin', 'cancelInspection', { inspectionId: active(db, '102').id });
  assert.equal(room(db, '102').status, 'ready');
  assert.equal(run('admin', 'cancelInspection', { inspectionId: db.inspections[0].id }).code, 'CLOSED');
});

test('ตรวจข้อมูลรายการที่ ✗: รายการไม่มีจริงถูกปฏิเสธ, found ไม่เกินจำนวนมาตรฐาน-1', () => {
  const { db, ok, run } = fresh();
  ok('head', 'startRoutine', { roomId: '101', round: 'morning' });
  const id = active(db, '101').id;
  assert.equal(run('maid01', 'submitStep', { inspectionId: id, step: 1, failures: [{ itemNo: 99 }] }).code, 'BAD_ITEM');
  assert.equal(db.steps.length, 0);
  ok('maid01', 'submitStep', { inspectionId: id, step: 1, failures: [{ itemNo: 14, found: 99 }, { itemNo: 14, found: 0 }] });
  assert.equal(db.issues.length, 1);
  assert.equal(db.issues[0].found, 3);
});

test('summary: นับสถานะ รอบ ห้องค้าง รายการเกิดซ้ำ', () => {
  const db = Demo.make(T0);
  const s = Core.summary(db, T0, 30);
  assert.equal(Object.values(s.counts).reduce((a, b) => a + b, 0), 40);
  assert.equal(s.counts.occupied, 17);
  assert.ok(s.counts.dirty >= 3);
  assert.equal(s.groups.morning.passed, 4);
  assert.equal(s.groups.morning.open, 1);
  assert.ok(s.overdue.some((o) => o.roomId === '103' && o.waitingFor === 'reception'));
  assert.ok(s.overdue.some((o) => o.roomId === '205' && o.status === 'dirty'));
  assert.ok(!s.overdue.some((o) => o.roomId === '402')); // เพิ่งเช็กเอาท์ 8 นาที
  assert.equal(s.openIssues.length, 2);
  assert.equal(s.topItems.length, 3);
});

test('โหมดทดลอง: สร้างได้ ทุกบทบาทมีงานให้ทำ', () => {
  const db = Demo.make(T0);
  const t = (id) => Core.tasksFor(db, db.users.find((u) => u.id === id));
  assert.ok(t('maid02').some((x) => x.kind === 'clean' && x.floor === 2));
  assert.ok(t('maid02').some((x) => x.kind === 'fix' && x.roomId === '208'));
  assert.ok(t('maid02').some((x) => x.kind === 'check' && x.roomId === '207'));
  assert.deepEqual(t('head').map((x) => x.roomId).sort(), ['106', '304', '306']);
  assert.deepEqual(t('front').map((x) => x.roomId), ['103']);
  assert.deepEqual(t('admin'), []);
});

test('apply กับคำสั่งแปลก ๆ ไม่พัง', () => {
  const { db } = fresh();
  const ctx = { user: db.users[0], nowMs: T0 };
  assert.equal(Core.apply(db, ctx, 'constructor', {}).code, 'UNKNOWN');
  assert.equal(Core.apply(db, ctx, 'nope', {}).code, 'UNKNOWN');
  assert.equal(Core.apply(db, { nowMs: T0 }, 'checkin', {}).code, 'AUTH');
});
