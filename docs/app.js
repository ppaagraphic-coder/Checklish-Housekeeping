/* app.js — หน้าจอและการทำงานของแอป (4 บทบาท) */
(function () {
  'use strict';
  var CFG = window.APP_CONFIG || {};
  var OVERDUE = CFG.OVERDUE_MINUTES || 30;
  var POLL = (CFG.POLL_SECONDS || 25) * 1000;
  var ROLE = Core.ROLES;
  var STATUS = Core.ROOM_STATUS;

  var S = { user: null, db: null, tab: '', sel: {}, pick: {}, round: 'morning', floorTab: null, seen: null, busy: false, offline: false };
  var F = null; // สถานะฟอร์มตรวจที่เปิดอยู่

  // ---------- ตัวช่วย ----------
  function $(id) { return document.getElementById(id); }
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function hhmm(stamp) { return stamp ? String(stamp).slice(11, 16) : ''; }
  function fmtMin(m) { return m < 60 ? m + ' นาที' : Math.floor(m / 60) + ' ชม. ' + (m % 60 ? (m % 60) + ' นาที' : ''); }
  function waitMin(since) { return since ? Core.minutesSince(since, Date.now()) : 0; }
  function floorsOf(u) { return u && u.floors ? String(u.floors).split(',').map(function (s) { return Number(s.trim()); }).filter(Boolean) : []; }
  function toast(msg, cls) {
    var box = $('toast'), el = document.createElement('div');
    el.textContent = msg; if (cls) el.className = cls;
    while (box.children.length >= 2) box.removeChild(box.firstChild);
    box.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, cls === 'bad' ? 6000 : 3800);
  }
  var AC = null;
  function beep() {
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      var o = AC.createOscillator(), g = AC.createGain();
      o.frequency.value = 880; g.gain.value = 0.07; o.connect(g); g.connect(AC.destination);
      o.start(); o.stop(AC.currentTime + 0.18);
      if (navigator.vibrate) navigator.vibrate(120);
    } catch (e) { /* เบราว์เซอร์ไม่อนุญาตเสียง */ }
  }
  function ask(msg, okLabel, danger) {
    return new Promise(function (resolve) {
      $('dialog').innerHTML = '<div class="dialog" role="alertdialog" aria-modal="true"><div class="box"><p>' + h(msg) + '</p><div class="acts">' +
        '<button class="btn ghost" data-d="0">ยกเลิก</button><button class="btn' + (danger ? ' danger' : '') + '" data-d="1">' + h(okLabel || 'ตกลง') + '</button></div></div></div>';
      $('dialog').onclick = function (e) {
        var b = e.target.closest('[data-d]'); if (!b) return;
        $('dialog').innerHTML = ''; $('dialog').onclick = null; resolve(b.getAttribute('data-d') === '1');
      };
    });
  }

  // ---------- งานของฉัน ----------
  function myTasks() {
    return Core.tasksFor(S.db, S.user); // แม่บ้านได้เฉพาะชั้นตัวเอง (กรองใน Core แล้ว)
  }
  function taskKey(t) { return t.kind + '|' + t.roomId + '|' + t.inspectionId + '|' + t.step + '|' + t.since; }
  function canBulk() { return S.user.role === 'head_maid' || S.user.role === 'reception'; }
  function lastStep(inspId) {
    var r = null;
    S.db.steps.forEach(function (s) { if (s.inspectionId === inspId) r = s; });
    return r;
  }
  function typeLabel(t) { return t.type === 'checkout' ? 'หลังแขกออก' : (Core.ROUNDS[t.round] || 'ตรวจตามรอบ'); }

  // ---------- ส่วนประกอบ ----------
  function activeStep(roomId) { var i = Core.activeInspOf(S.db, roomId); return i ? i : null; }
  function statusText(room) {
    var i = room.status === 'inspecting' ? activeStep(room.id) : null;
    return i ? 'ตรวจขั้น ' + i.step + '/3' : STATUS[room.status];
  }
  function lateMap() {
    var m = {};
    Core.summary(S.db, Date.now(), OVERDUE).overdue.forEach(function (o) { m[o.roomId] = o; });
    return m;
  }
  function tagHtml(room, o) {
    o = o || {};
    var cls = 'tag s-' + room.status + (o.late ? ' late' : '') + (o.picked ? ' picked' : '') + (o.done ? ' done' : '');
    var label = o.label || statusText(room);
    return '<button class="' + cls + '"' + (o.disabled ? ' disabled' : '') + ' data-act="' + (o.act || 'room') + '" data-room="' + h(room.id) + '" aria-label="ห้อง ' + h(room.id) + ' ' + h(label) + '">' +
      '<span class="no">' + h(room.id) + '</span><span class="st">' + h(label) + '</span></button>';
  }
  function byFloor(rooms) {
    var m = {}, keys = [];
    rooms.forEach(function (r) { if (!m[r.floor]) { m[r.floor] = []; keys.push(r.floor); } m[r.floor].push(r); });
    keys.sort(function (a, b) { return a - b; });
    return keys.map(function (k) { return { floor: k, rooms: m[k] }; });
  }
  function cols(g) { return Math.max(1, Math.min(g.rooms.length, 10)); }
  function legendHtml(counts) {
    return '<div class="legend">' + ['ready', 'occupied', 'dirty', 'inspecting', 'issue'].map(function (k) {
      return '<span class="s-' + k + '"><i></i>' + STATUS[k] + '<b>' + (counts ? counts[k] : '') + '</b></span>';
    }).join('') + '</div>';
  }
  function boardHtml() {
    var late = lateMap();
    return byFloor(S.db.rooms).map(function (g) {
      return '<div class="floor"><h3 class="floor-h">ชั้น ' + g.floor + '</h3><div class="tags" style="--n:' + cols(g) + '">' +
        g.rooms.map(function (r) { return tagHtml(r, { late: !!late[r.id] }); }).join('') + '</div></div>';
    }).join('');
  }
  function emptyHtml(title, text) { return '<div class="empty"><b>' + h(title) + '</b>' + h(text) + '</div>'; }

  // ---------- หน้าเข้าสู่ระบบ ----------
  function renderLogin(errMsg) {
    var logo = '<svg class="mark-logo" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#17504B"/><rect x="136" y="104" width="240" height="320" rx="44" fill="#F5F7F6"/><circle cx="256" cy="164" r="26" fill="#17504B"/><circle cx="256" cy="164" r="12" fill="#F5F7F6"/><path d="M196 322l42 42 82-96" fill="none" stroke="#2F8F5B" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var body;
    if (Api.isLive) {
      body = '<form id="loginForm" autocomplete="on"><label class="field"><span>ชื่อผู้ใช้</span><input name="u" value="' + h(Api.lastUsername()) + '" autocapitalize="none" autocomplete="username" required></label>' +
        '<label class="field"><span>PIN</span><input name="p" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="current-password" required></label>' +
        '<div class="err" id="loginErr">' + h(errMsg || '') + '</div><button class="btn full" type="submit">เข้าสู่ระบบ</button></form>';
    } else {
      body = '<div class="role-btns">' + Api.demoUsers().map(function (u) {
        return '<button data-act="demoLogin" data-user="' + h(u.id) + '">' + h(u.name) + '<small>' + h(ROLE[u.role]) + '</small></button>';
      }).join('') + '</div><p class="note-demo"><b>โหมดทดลอง</b> ข้อมูลเป็นของจำลองและอยู่ในเครื่องนี้เท่านั้น ยังไม่ได้เชื่อม Google Sheet เลือกบทบาทเพื่อดูหน้าจอของแต่ละคน</p>';
    }
    $('app').innerHTML = '<div class="login">' + logo + '<h1>ตรวจห้องพัก</h1><p class="sub">' + h(CFG.HOTEL_NAME || '') + ' — เอกสารภายใน</p>' + body + '</div>';
    var f = $('loginForm');
    if (f) f.onsubmit = function (e) {
      e.preventDefault();
      var btn = f.querySelector('button'); btn.disabled = true;
      Api.login(f.u.value, f.p.value).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { $('loginErr').textContent = r.message; f.p.value = ''; return; }
        S.user = r.user; S.seen = null; S.tab = ''; S.floorTab = null;
        refresh(false);
      });
    };
  }

  // ---------- โครงหน้าหลัก ----------
  function tabsFor(role) {
    if (role === 'admin') return [{ id: 'overview', label: 'ภาพรวม' }, { id: 'issues', label: 'ปัญหา' }, { id: 'history', label: 'ประวัติ' }];
    if (role === 'reception') return [{ id: 'tasks', label: 'ตรวจขั้นสุดท้าย' }, { id: 'rooms', label: 'ห้องพัก' }];
    return [{ id: 'tasks', label: 'งานของฉัน' }, { id: 'routine', label: 'ตรวจตามรอบ' }, { id: 'rooms', label: 'ผังห้อง' }];
  }

  function render() {
    if (!S.user || !S.db) { renderLogin(); return; }
    var y = window.scrollY;
    var tabs = tabsFor(S.user.role);
    if (!tabs.some(function (t) { return t.id === S.tab; })) S.tab = tabs[0].id;
    var tasks = S.user.role === 'admin' ? [] : myTasks();
    var noFloor = S.user.role === 'maid' && !floorsOf(S.user).length;
    var demo = '';
    if (!Api.isLive) {
      demo = '<div class="demo-bar"><b>โหมดทดลอง</b><label>สลับบทบาท <select data-change="switchUser">' + Api.demoUsers().map(function (u) {
        return '<option value="' + h(u.id) + '"' + (u.id === S.user.id ? ' selected' : '') + '>' + h(u.name) + '</option>';
      }).join('') + '</select></label><button data-act="demoReset">เริ่มข้อมูลทดลองใหม่</button></div>';
    }
    var pend = Api.pending();
    var top = '<header class="topbar"><div class="brand"><small>' + h(CFG.HOTEL_NAME || '') + '</small><strong>ตรวจห้องพัก</strong></div>' +
      (pend ? '<span class="chip-pending">รอส่ง ' + pend + '</span>' : '') +
      (S.offline ? '<span class="chip-pending">ออฟไลน์</span>' : '') +
      '<div class="who"><b>' + h(S.user.name) + '</b>' + h(ROLE[S.user.role]) + '</div>' +
      '<button class="icon-btn" data-act="reload" aria-label="รีเฟรช">↻</button>' +
      '<button class="icon-btn" data-act="logout" aria-label="ออกจากระบบ">⎋</button></header>';
    var nav = '<nav class="nav" aria-label="เมนูหลัก">' + tabs.map(function (t) {
      var b = t.id === 'tasks' && tasks.length ? '<span class="badge">' + tasks.length + '</span>' : '';
      return '<button data-act="tab" data-tab="' + t.id + '"' + (t.id === S.tab ? ' aria-current="page"' : '') + '>' + h(t.label) + b + '</button>';
    }).join('') + '</nav>';
    var view = noFloor
      ? '<h1 class="page-h">ยังไม่ได้กำหนดชั้น</h1>' + emptyHtml('บัญชีนี้ยังไม่มีชั้นที่รับผิดชอบ', 'แจ้งผู้ดูแลระบบให้ใส่เลขชั้นในชีต Users (คอลัมน์ floors)')
      : { tasks: tasksView, routine: routineView, rooms: roomsView, overview: overviewView, issues: issuesView, history: historyView }[S.tab](tasks);
    $('app').innerHTML = demo + top + nav + '<main class="main">' + view + '</main>' + extraBar(tasks);
    document.title = (tasks.length ? '(' + tasks.length + ') ' : '') + 'ตรวจห้องพัก';
    window.scrollTo(0, y);
  }

  function extraBar(tasks) {
    if (S.tab === 'tasks') {
      var n = Object.keys(S.sel).length;
      if (n) return '<div class="bulkbar"><span>เลือก ' + n + ' ห้อง</span><button class="btn ghost sm" data-act="clearSel">ล้าง</button><button class="btn sm" data-act="bulkPass">ผ่านทั้งหมดที่เลือก</button></div>';
    }
    if (S.tab === 'routine') {
      var k = Object.keys(S.pick).length;
      return '<div class="footer-act"><button class="btn" data-act="startRoutine"' + (k ? '' : ' disabled') + '>' + (k ? 'เริ่มตรวจ' + Core.ROUNDS[S.round] + ' ' + k + ' ห้อง' : 'เลือกห้องที่จะเริ่มตรวจ') + '</button></div>';
    }
    return '';
  }

  // ---------- แท็บ: งานของฉัน ----------
  function taskCard(t) {
    var wait = waitMin(t.since), late = wait >= OVERDUE;
    var waitHtml = '<div class="twait' + (late ? ' late' : '') + '">รอ<br>' + h(fmtMin(wait)) + '</div>';
    if (t.kind === 'clean') {
      return '<div class="task clean' + (late ? ' overdue' : '') + '"><div class="tno">' + h(t.roomId) + '<small>ชั้น ' + t.floor + '</small></div>' +
        '<div class="tmain"><div class="tt">รอทำความสะอาด</div><div class="sub">แขกเช็กเอาท์แล้ว</div></div>' + waitHtml +
        '<button class="btn sm task-action" data-act="cleaned" data-room="' + h(t.roomId) + '">ทำเสร็จแล้ว</button></div>';
    }
    if (t.kind === 'fix') {
      var issues = S.db.issues.filter(function (x) { return x.inspectionId === t.inspectionId && x.status === 'open'; });
      return '<div class="task fix' + (late ? ' overdue' : '') + '" style="align-items:flex-start"><div class="tno">' + h(t.roomId) + '<small>ชั้น ' + t.floor + '</small></div>' +
        '<div class="tmain"><div class="tt">ต้องแก้ไข ' + issues.length + ' รายการ</div>' +
        '<div class="fix-box">' + issues.map(function (x) {
          var det = x.kind === 'damaged' ? 'ชำรุด' : 'ขาด/สูญหาย';
          return '<div><b>' + h(x.itemName) + '</b> มี ' + x.found + ' จาก ' + x.expected + ' (' + det + ')' + (x.note ? ' — ' + h(x.note) : '') + '</div>';
        }).join('') + '</div>' +
        '<div class="tmeta"><span class="pill issue">พบโดย' + h(Core.STEP_LABEL[t.step]) + '</span><span class="pill">' + h(typeLabel(t)) + '</span></div>' +
        '<button class="btn sm" style="margin-top:10px" data-act="fixed" data-insp="' + h(t.inspectionId) + '">แก้ไขแล้ว ส่งตรวจซ้ำ</button></div>' + waitHtml + '</div>';
    }
    var prev = lastStep(t.inspectionId);
    var chips = '<span class="pill">' + h(typeLabel(t)) + '</span>';
    if (t.recheck) chips += '<span class="pill warn">ตรวจซ้ำ ' + t.recheck + ' รายการ</span>';
    var from = prev && t.step > 1 && !t.recheck ? '<div class="sub">ผ่านขั้นก่อนหน้า ' + h(prev.userName) + ' ' + hhmm(prev.at) + ' น.</div>' : '';
    var box = canBulk() && !t.recheck ? '<button class="check" role="checkbox" aria-checked="' + (S.sel[t.inspectionId] ? 'true' : 'false') + '" aria-label="เลือกห้อง ' + h(t.roomId) + '" data-act="sel" data-insp="' + h(t.inspectionId) + '"><i>' + (S.sel[t.inspectionId] ? '✓' : '') + '</i></button>' : '';
    return '<div class="task' + (late ? ' overdue' : '') + '" data-act="openForm" data-insp="' + h(t.inspectionId) + '" role="button" tabindex="0">' + box +
      '<div class="tno">' + h(t.roomId) + '<small>ชั้น ' + t.floor + '</small></div>' +
      '<div class="tmain"><div class="tt">ตรวจขั้นที่ ' + t.step + '</div><div class="tmeta">' + chips + '</div>' + from + '</div>' + waitHtml + '</div>';
  }
  function floorList() {
    var m = {};
    S.db.rooms.forEach(function (r) { m[r.floor] = 1; });
    return Object.keys(m).map(Number).sort(function (a, b) { return a - b; });
  }
  // แท็บชั้นที่เลือกอยู่ + งานที่แสดง (แม่บ้านเปิดมาที่ชั้นของตัวเองก่อน ชั้นที่มีงาน)
  function tabState() {
    var all = Core.tasksFor(S.db, S.user), floors = floorList(), mine = floorsOf(S.user), tab = S.floorTab;
    if (tab !== 'all' && floors.indexOf(tab) < 0) {
      tab = 'all';
      if (S.user.role === 'maid' && mine.length) {
        tab = mine[0];
        for (var i = 0; i < mine.length; i++) {
          if (all.some(function (t) { return t.floor === mine[i]; })) { tab = mine[i]; break; }
        }
      }
    }
    S.floorTab = tab;
    return { all: all, floors: floors, mine: mine, tab: tab, list: tab === 'all' ? all : all.filter(function (t) { return t.floor === tab; }) };
  }
  function tasksView() {
    var st = tabState();
    var head = '<h1 class="page-h">' + (S.user.role === 'maid' ? 'งานของฉัน' : S.user.role === 'reception' ? 'รอตรวจขั้นสุดท้าย' : 'รอตรวจโดยหัวหน้าแม่บ้าน') + '</h1>';
    var oneFloor = S.user.role === 'maid' && st.floors.length < 2;
    var extra = st.mine.length && S.user.role === 'maid' ? '<p class="sub">ชั้นที่รับผิดชอบ: ' + st.mine.join(', ') + (oneFloor ? '' : ' (ป้ายแท็บขอบเข้ม)') + '</p>' : '';
    var strip = '<div class="ftabs" role="tablist" aria-label="เลือกชั้น">' + ['all'].concat(st.floors).map(function (f) {
      var n = f === 'all' ? st.all.length : st.all.filter(function (t) { return t.floor === f; }).length;
      var mine = f !== 'all' && st.mine.indexOf(f) >= 0 && S.user.role === 'maid';
      return '<button role="tab" class="' + (mine ? 'mine' : '') + '" data-act="floorTab" data-floor="' + f + '" aria-selected="' + (st.tab === f) + '">' +
        (f === 'all' ? 'ทั้งหมด' : 'ชั้น ' + f) + (n ? '<span class="n">' + n + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    if (oneFloor) strip = '';
    if (!st.list.length) {
      var hint = S.user.role === 'reception' ? 'ห้องที่หัวหน้าแม่บ้านตรวจผ่านแล้วจะขึ้นที่นี่' : S.user.role === 'head_maid' ? 'ห้องที่แม่บ้านตรวจผ่านแล้วจะขึ้นที่นี่' : 'ห้องที่เช็กเอาท์หรือถูกส่งกลับให้แก้ไขจะขึ้นที่นี่';
      return head + extra + strip + emptyHtml(st.tab === 'all' ? 'ไม่มีห้องรอคุณตอนนี้' : 'ชั้น ' + st.tab + ' ไม่มีห้องรอ', hint);
    }
    var selAll = '';
    if (canBulk()) {
      var el = st.list.filter(function (t) { return t.kind === 'check' && !t.recheck; }).length;
      if (el > 1) selAll = '<button class="link-btn" data-act="selAll">เลือกทุกห้องที่ไม่ต้องตรวจซ้ำ (' + el + ')</button>';
    }
    if (st.tab !== 'all') return head + extra + strip + selAll + st.list.map(taskCard).join('');
    var groups = {}, order = [];
    st.list.forEach(function (t) { if (!groups[t.floor]) { groups[t.floor] = []; order.push(t.floor); } groups[t.floor].push(t); });
    order.sort(function (a, b) { return a - b; });
    return head + extra + strip + selAll + order.map(function (f) {
      return '<div class="floor"><h3 class="floor-h">ชั้น ' + f + '<span class="sub">' + groups[f].length + ' ห้อง</span></h3>' + groups[f].map(taskCard).join('') + '</div>';
    }).join('');
  }

  // ---------- แท็บ: ตรวจตามรอบ ----------
  function routineView() {
    var today = Core.dateOf(Date.now()), done = {};
    S.db.inspections.forEach(function (i) {
      if (i.type === 'routine' && i.round === S.round && i.date === today && i.status !== 'cancelled') done[i.roomId] = true;
    });
    var floors = byFloor(S.db.rooms).map(function (g) {
      var free = g.rooms.filter(function (r) { return r.status === 'ready' && !done[r.id]; });
      return '<div class="floor"><h3 class="floor-h">ชั้น ' + g.floor + '<span class="sub">ว่างพร้อมตรวจ ' + free.length + ' ห้อง</span>' +
        (free.length ? '<button class="link-btn" data-act="pickFloor" data-floor="' + g.floor + '">เลือกทั้งชั้น</button>' : '') + '</h3><div class="tags" style="--n:' + cols(g) + '">' +
        g.rooms.map(function (r) {
          var ok = r.status === 'ready' && !done[r.id];
          return tagHtml(r, { act: 'pick', disabled: !ok, picked: !!S.pick[r.id], done: !!done[r.id], label: done[r.id] ? 'ตรวจแล้ว' : (r.status === 'ready' ? (S.pick[r.id] ? 'เลือกแล้ว' : 'ว่าง') : statusText(r)) });
        }).join('') + '</div></div>';
    }).join('');
    return '<h1 class="page-h">ตรวจตามรอบ</h1><p class="sub">เฉพาะห้องว่างที่พร้อมขาย ห้องที่มีแขกพักระบบข้ามให้</p>' +
      '<div style="margin:12px 0"><div class="seg" role="group" aria-label="รอบตรวจ"><button data-act="round" data-round="morning" aria-pressed="' + (S.round === 'morning') + '">รอบเช้า</button><button data-act="round" data-round="afternoon" aria-pressed="' + (S.round === 'afternoon') + '">รอบบ่าย</button></div></div>' + floors;
  }

  // ---------- แท็บ: ผังห้อง / ห้องพัก ----------
  function roomsView() {
    var s = Core.summary(S.db, Date.now(), OVERDUE);
    var front = S.user.role === 'reception';
    return '<h1 class="page-h">' + (front ? 'ห้องพัก' : 'ผังห้อง') + '</h1>' +
      (front ? '<p class="sub">แตะห้องเพื่อกดแขกเช็กอินหรือเช็กเอาท์</p>' : '') +
      '<div style="margin:10px 0 4px">' + legendHtml(s.counts) + '</div>' + boardHtml();
  }

  // ---------- admin ----------
  function overviewView() {
    var s = Core.summary(S.db, Date.now(), OVERDUE), total = S.db.rooms.length || 1;
    var strip = ['ready', 'occupied', 'dirty', 'inspecting', 'issue'].map(function (k) {
      return '<span class="s-' + k + '" style="width:' + (s.counts[k] / total * 100) + '%"></span>';
    }).join('');
    var rounds = [['checkout', 'ตรวจหลังแขกออก'], ['morning', 'ตรวจรอบเช้า'], ['afternoon', 'ตรวจรอบบ่าย']].map(function (r) {
      var g = s.groups[r[0]], t = g.total || 1;
      return '<div class="prog"><div class="prog-h"><b>' + r[1] + '</b><span>ผ่านแล้ว ' + g.passed + ' / ' + g.total + (g.fixing ? ' <span class="pill issue">มีปัญหา ' + g.fixing + '</span>' : '') + '</span></div>' +
        '<div class="bar"><span class="p" style="width:' + (g.passed / t * 100) + '%"></span><span class="o" style="width:' + (g.open / t * 100) + '%"></span><span class="f" style="width:' + (g.fixing / t * 100) + '%"></span></div></div>';
    }).join('');
    var overdue = s.overdue.length ? s.overdue.map(function (o) {
      var who = o.status === 'dirty' ? 'รอทำความสะอาด' : (o.status === 'fixing' ? 'รอแม่บ้านแก้ไข' : 'รอ' + Core.STEP_LABEL[o.step]);
      return '<button class="rowline" data-act="room" data-room="' + h(o.roomId) + '"><span class="rn">' + h(o.roomId) + '</span><span class="rt">' + h(who) + '</span><span class="rr" style="color:var(--issue-ink);font-weight:700">' + h(fmtMin(o.minutes)) + '</span></button>';
    }).join('') : '<p class="sub">ไม่มีห้องค้างเกิน ' + OVERDUE + ' นาที</p>';
    var max = s.topItems.length ? s.topItems[0].count : 1;
    var top = s.topItems.length ? s.topItems.map(function (x) {
      return '<div class="rowline"><span class="rt">' + h(x.name) + '<small>พบ ' + x.count + ' ครั้งใน ' + x.roomCount + ' ห้อง (ขาด ' + x.missing + ' / ชำรุด ' + x.damaged + ')</small><div class="hbar"><i style="width:' + (x.count / max * 100) + '%"></i></div></span></div>';
    }).join('') : '<p class="sub">ยังไม่มีรายการที่พบปัญหา</p>';
    return '<h1 class="page-h">ภาพรวมวันนี้</h1><div class="panel">' + '<div class="strip" role="img" aria-label="สัดส่วนสถานะห้อง">' + strip + '</div>' + legendHtml(s.counts) + '</div>' +
      '<div class="section"><h2>ผังห้อง<span class="sub">แตะห้องเพื่อดูรายละเอียด</span></h2>' + boardHtml() + '</div>' +
      '<div class="section grid2"><div><h2>ความคืบหน้าแต่ละรอบ</h2><div class="panel">' + rounds + '</div></div>' +
      '<div><h2>ห้องที่ค้างนานเกิน ' + OVERDUE + ' นาที</h2><div class="panel">' + overdue + '</div></div></div>' +
      '<div class="section"><h2>ของที่พบปัญหาบ่อย<span class="sub">ย้อนหลังตามข้อมูลที่โหลดมา</span></h2><div class="panel">' + top + '</div></div>';
  }
  function issuesView() {
    var open = S.db.issues.filter(function (x) { return x.status === 'open'; });
    var fixed = S.db.issues.filter(function (x) { return x.status === 'fixed'; }).sort(function (a, b) { return a.fixedAt < b.fixedAt ? 1 : -1; }).slice(0, 30);
    function row(x) {
      return '<button class="rowline" data-act="room" data-room="' + h(x.roomId) + '"><span class="rn">' + h(x.roomId) + '</span><span class="rt">' + h(x.itemName) + ' <small>มี ' + x.found + ' จาก ' + x.expected + ' (' + (x.kind === 'damaged' ? 'ชำรุด' : 'ขาด/สูญหาย') + ')' + (x.note ? ' — ' + h(x.note) : '') + '</small></span>' +
        '<span class="rr">' + h(x.reportedBy) + '<br>' + hhmm(x.reportedAt) + ' น.</span></button>';
    }
    return '<h1 class="page-h">รายการที่พบปัญหา</h1><div class="section" style="margin-top:0"><h2>ยังไม่แก้ไข <span class="pill ' + (open.length ? 'issue' : 'ok') + '">' + open.length + '</span></h2><div class="panel">' +
      (open.length ? open.map(row).join('') : '<p class="sub">ไม่มีรายการค้าง</p>') + '</div></div>' +
      '<div class="section"><h2>แก้ไขแล้วล่าสุด</h2><div class="panel">' + (fixed.length ? fixed.map(row).join('') : '<p class="sub">ยังไม่มี</p>') + '</div></div>';
  }
  function historyView() {
    var rows = S.db.steps.slice().reverse().slice(0, 80).map(function (s) {
      var insp = Core.inspOf(S.db, s.inspectionId);
      var res = s.result === 'pass' ? '<span class="pill ok">ผ่าน</span>' : '<span class="pill issue">พบ ' + s.failCount + ' รายการ</span>';
      return '<button class="rowline" data-act="room" data-room="' + h(insp ? insp.roomId : '') + '"><span class="rn">' + h(insp ? insp.roomId : '-') + '</span><span class="rt">ขั้น ' + s.step + ' ' + h(Core.STEP_LABEL[s.step]) + (s.mode === 'recheck' ? ' (ตรวจซ้ำ)' : '') + '<small>' + h(s.userName) + ' เวลา ' + h(String(s.at).slice(5, 16)) + '</small></span><span class="rr">' + res + '</span></button>';
    }).join('');
    return '<h1 class="page-h">ประวัติการตรวจล่าสุด</h1><p class="sub">แสดง 80 รายการล่าสุด ประวัติทั้งหมดอยู่ในชีต Steps และ Log ของ Google Sheet</p><div class="panel" style="margin-top:12px">' + (rows || '<p class="sub">ยังไม่มี</p>') + '</div>';
  }

  // ---------- แผ่นรายละเอียดห้อง ----------
  function openRoom(roomId) {
    var room = Core.roomOf(S.db, roomId); if (!room) return;
    var role = S.user.role, insp = Core.activeInspOf(S.db, roomId);
    var steps = '';
    if (insp) {
      var done = {}; S.db.steps.forEach(function (s) { if (s.inspectionId === insp.id && s.result === 'pass') done[s.step] = true; });
      steps = '<div class="steps" style="margin-top:12px">' + [1, 2, 3].map(function (n) {
        var c = done[n] && n < insp.step ? 'done' : (n === Number(insp.step) && insp.status === 'open' ? 'now' : (n === Number(insp.failedStep) ? 'now' : ''));
        return '<div class="' + c + '">' + n + '. ' + h(Core.STEP_LABEL[n]) + '</div>';
      }).join('') + '</div>';
    }
    var issues = S.db.issues.filter(function (x) { return x.roomId === room.id && x.status === 'open'; });
    var hist = S.db.inspections.filter(function (i) { return i.roomId === room.id; }).sort(function (a, b) { return a.startedAt < b.startedAt ? 1 : -1; }).slice(0, 5).map(function (i) {
      var st = { open: 'กำลังตรวจ', fixing: 'รอแก้ไข', passed: 'ผ่านครบ', cancelled: 'ยกเลิก' }[i.status];
      return '<div class="h"><b>' + (i.type === 'checkout' ? 'หลังแขกออก' : Core.ROUNDS[i.round]) + '</b> — ' + st + '<small>เริ่ม ' + h(String(i.startedAt).slice(5, 16)) + (i.finishedAt ? ' จบ ' + h(String(i.finishedAt).slice(11, 16)) : '') + '</small></div>';
    }).join('');
    var acts = '';
    if (role === 'reception' || role === 'admin') {
      acts += room.status === 'occupied'
        ? '<button class="btn full" data-act="checkout" data-room="' + h(room.id) + '">แขกเช็กเอาท์</button>'
        : '<button class="btn full" data-act="checkin" data-room="' + h(room.id) + '">แขกเช็กอิน</button>' +
          (room.status !== 'ready' ? '<p class="sub" style="margin-top:8px">ห้องนี้ยังไม่พร้อมขาย ระบบจะถามยืนยันก่อน</p>' : '');
    }
    if (role === 'admin' && insp) acts += '<button class="btn ghost full" style="margin-top:10px" data-act="cancelInsp" data-insp="' + h(insp.id) + '">ยกเลิกใบตรวจที่เปิดอยู่</button>';
    $('sheet').innerHTML = '<div class="overlay" data-act="closeSheet"><div class="sheet bottom" role="dialog" aria-modal="true"><div class="sheet-h"><h2>ห้อง ' + h(room.id) + '<small>ชั้น ' + room.floor + '</small></h2><span class="stat-chip s-' + room.status + '">' + h(statusText(room)) + '</span><button class="icon-btn" data-act="closeSheet" aria-label="ปิด">✕</button></div><div class="sheet-body">' +
      (acts ? '<div style="margin-bottom:14px">' + acts + '</div>' : '') + steps +
      (issues.length ? '<div class="section"><h2>รายการที่ยังไม่แก้ไข</h2><div class="fix-box">' + issues.map(function (x) { return '<div><b>' + h(x.itemName) + '</b> มี ' + x.found + ' จาก ' + x.expected + (x.note ? ' — ' + h(x.note) : '') + '</div>'; }).join('') + '</div></div>' : '') +
      '<div class="section"><h2>ประวัติการตรวจ</h2><div class="hist">' + (hist || '<p class="sub">ยังไม่มีข้อมูลในช่วงที่โหลดมา</p>') + '</div></div></div></div></div>';
  }
  function closeSheet() { $('sheet').innerHTML = ''; F = null; }

  // ---------- ฟอร์มตรวจ 25 รายการ ----------
  function openForm(inspId) {
    var insp = Core.inspOf(S.db, inspId); if (!insp || insp.status !== 'open') { toast('ใบตรวจนี้ไม่ได้รอคุณแล้ว', 'bad'); refresh(false); return; }
    var re = Core.recheckList(insp), prev = {};
    S.db.issues.forEach(function (x) { if (x.inspectionId === inspId && re.indexOf(x.itemNo) >= 0) prev[x.itemNo] = x; });
    F = { inspId: inspId, step: Number(insp.step), room: insp.roomId, recheck: re, prev: prev, showAll: false, items: {} };
    renderForm();
  }
  function renderForm(keepScroll) {
    var body = document.querySelector('#sheet .sheet-body'), y = body ? body.scrollTop : 0;
    var insp = Core.inspOf(S.db, F.inspId), items = S.db.items;
    var fails = Object.keys(F.items).filter(function (k) { return F.items[k].fail; }).length;
    var step = F.step, rc = F.recheck.length > 0;
    var stepsBar = '<div class="steps">' + [1, 2, 3].map(function (n) {
      return '<div class="' + (n < step ? 'done' : n === step ? 'now' : '') + '">' + n + '. ' + h(Core.STEP_LABEL[n]) + '</div>';
    }).join('') + '</div>';
    var note = rc && !F.showAll ? '<div class="note-box">ตรวจซ้ำเฉพาะรายการที่เคยพบปัญหา ' + F.recheck.length + ' รายการ ที่แม่บ้านแก้ไขแล้ว รายการอื่นผ่านไปแล้วจึงไม่ต้องตรวจใหม่</div>' : '';
    var list = items.filter(function (it) { return !rc || F.showAll || F.recheck.indexOf(Number(it.no)) >= 0; }).map(function (it) {
      var st = F.items[it.no], fail = st && st.fail, qty = Number(it.qty), p = F.prev[it.no];
      var more = '';
      if (fail) {
        more = '<div class="it-more"><div class="row"><span class="lbl">สาเหตุ</span><div class="seg" role="group">' +
          '<button data-act="kind" data-no="' + it.no + '" data-kind="missing" aria-pressed="' + (st.kind === 'missing') + '">ขาด/สูญหาย</button>' +
          '<button data-act="kind" data-no="' + it.no + '" data-kind="damaged" aria-pressed="' + (st.kind === 'damaged') + '">ชำรุด</button></div></div>' +
          (qty > 1 ? '<div class="row"><span class="lbl">เหลืออยู่</span><span class="step-n"><button data-act="found" data-no="' + it.no + '" data-d="-1" aria-label="ลด">−</button><output>' + st.found + ' / ' + qty + '</output><button data-act="found" data-no="' + it.no + '" data-d="1" aria-label="เพิ่ม">+</button></span></div>' : '') +
          '<div class="row"><span class="lbl">หมายเหตุ</span><input type="text" maxlength="200" data-note="' + it.no + '" value="' + h(st.note) + '" placeholder="เช่น แก้วแตก 1 ใบ"></div></div>';
      }
      return '<div class="it' + (fail ? ' fail' : '') + '"><button class="it-main" data-act="toggle" data-no="' + it.no + '" aria-pressed="' + !!fail + '"><span class="it-no">' + it.no + '</span><span class="it-name">' + h(it.name) + '<small>มาตรฐาน ' + qty + ' ชิ้น' + (p ? ' — ครั้งก่อน: ' + h(p.note || (p.kind === 'damaged' ? 'ชำรุด' : 'ขาด')) : '') + '</small></span><span class="mark">' + (fail ? '✗' : '✓') + '</span></button>' + more + '</div>';
    }).join('');
    var more = rc ? '<p style="margin-top:12px"><button class="link-btn" data-act="showAll">' + (F.showAll ? 'ซ่อนรายการอื่น' : 'ตรวจรายการอื่นด้วย') + '</button></p>' : '';
    var label = fails ? 'บันทึกพบปัญหา ' + fails + ' รายการ' : (step < 3 ? 'ผ่าน ส่งต่อให้' + Core.STEP_LABEL[step + 1] : 'ผ่าน ห้องพร้อมขาย');
    $('sheet').innerHTML = '<div class="overlay"><div class="sheet full" role="dialog" aria-modal="true"><div class="sheet-h"><h2>ห้อง ' + h(F.room) + '<small>ตรวจขั้นที่ ' + step + ' โดย' + h(Core.STEP_LABEL[step]) + (insp.type === 'checkout' ? ' (หลังแขกออก)' : ' (' + h(Core.ROUNDS[insp.round]) + ')') + '</small></h2><button class="icon-btn" data-act="closeForm" aria-label="ปิดโดยไม่บันทึก">✕</button></div>' +
      '<div class="sheet-body">' + stepsBar + note + '<div class="items">' + list + '</div>' + more + '</div>' +
      '<div class="sheet-foot"><span class="count' + (fails ? ' bad' : '') + '">' + (rc && !F.showAll ? 'ตรวจซ้ำ ' + F.recheck.length : 'ครบ ' + (items.length - fails) + '/' + items.length) + '</span>' +
      '<button class="btn' + (fails ? ' danger' : '') + '" data-act="submitForm"' + (S.busy ? ' disabled' : '') + '>' + h(label) + '</button></div></div></div>';
    var nb = document.querySelector('#sheet .sheet-body'); if (nb && keepScroll !== false) nb.scrollTop = y;
  }
  function formItem(no) { return S.db.items.filter(function (i) { return Number(i.no) === Number(no); })[0]; }
  function formToggle(no) {
    if (F.items[no] && F.items[no].fail) { delete F.items[no]; }
    else { var qty = Number(formItem(no).qty); F.items[no] = { fail: true, kind: 'missing', found: 0, note: '' }; }
    renderForm();
  }
  function submitForm() {
    var failures = Object.keys(F.items).filter(function (k) { return F.items[k].fail; }).map(function (k) {
      return { itemNo: Number(k), kind: F.items[k].kind, found: F.items[k].found, note: F.items[k].note };
    });
    var step = F.step, room = F.room, inspId = F.inspId;
    run('submitStep', { inspectionId: inspId, step: step, failures: failures }, function (res) {
      closeSheet();
      if (res.queued) return;
      var r = res.result || {};
      if (!r.passed) toast('ห้อง ' + room + ' บันทึกแล้ว แจ้งแม่บ้านให้แก้ไข ' + r.failCount + ' รายการ');
      else if (step < 3) toast('ห้อง ' + room + ' ผ่านแล้ว ส่งต่อให้' + Core.STEP_LABEL[step + 1]);
      else toast('ห้อง ' + room + ' ผ่านครบ พร้อมขายแล้ว');
    });
  }

  // ---------- เรียกคำสั่งไปที่ระบบ ----------
  function run(action, payload, onOk) {
    if (S.busy) return;
    S.busy = true; if (F) renderForm();
    Api.act(action, payload).then(function (res) {
      S.busy = false;
      if (res.code === 'AUTH') { toast(res.message, 'bad'); doLogout(); return; }
      if (res.ok) {
        if (res.queued) toast('เก็บไว้ในเครื่องแล้ว จะส่งให้อัตโนมัติเมื่อมีสัญญาณ', 'new');
        if (onOk) onOk(res);
      } else {
        toast(res.message || 'ทำรายการไม่สำเร็จ', 'bad');
        if (F) { closeSheet(); }
      }
      return after(res);
    });
  }
  // หลังส่งคำสั่ง: ถ้าแสดงผลทันทีจากข้อมูลในเครื่องแล้ว แค่วาดหน้าใหม่ (เซิร์ฟเวอร์ยืนยันเบื้องหลัง) ไม่ต้องโหลดซ้ำ
  function after(res) {
    if (res && res.ok && res.optimistic) { syncSeen(); render(); return Promise.resolve(); }
    return refresh(false);
  }
  // จำงานที่เห็นแล้ว กันเสียงเตือนเด้งจากสิ่งที่เราเพิ่งทำเอง
  function syncSeen() {
    if (!S.user || !S.db || S.user.role === 'admin') return;
    var keys = {}; myTasks().forEach(function (t) { keys[taskKey(t)] = t; });
    S.seen = {}; Object.keys(keys).forEach(function (k) { S.seen[k] = 1; });
    Object.keys(S.sel).forEach(function (id) { if (!Object.keys(keys).some(function (k) { return keys[k].inspectionId === id; })) delete S.sel[id]; });
  }

  // ---------- โหลดข้อมูล / แจ้งงานใหม่ ----------
  function refresh(notify) {
    return Api.state().then(function (r) {
      if (!r.ok && !r.offline) {
        if (r.code === 'AUTH') { toast(r.message, 'bad'); doLogout(); return; }
        toast(r.message || 'โหลดข้อมูลไม่สำเร็จ', 'bad'); return;
      }
      S.offline = !!r.offline;
      if (r.db) S.db = r.db;
      if (r.ok) { S.user = r.user || S.user; }
      if (!S.user || !S.db) { render(); return; }
      if (S.user.role !== 'admin') {
        var keys = {}; myTasks().forEach(function (t) { keys[taskKey(t)] = t; });
        if (notify && S.seen) {
          var fresh = Object.keys(keys).filter(function (k) { return !S.seen[k]; });
          if (fresh.length) {
            var t = keys[fresh[0]];
            toast(fresh.length === 1 ? 'ห้อง ' + t.roomId + (t.kind === 'fix' ? ' ต้องแก้ไข' : t.kind === 'clean' ? ' รอทำความสะอาด' : ' รอคุณตรวจ') : 'มีงานใหม่ ' + fresh.length + ' ห้อง', 'new');
            beep();
          }
        }
        S.seen = {}; Object.keys(keys).forEach(function (k) { S.seen[k] = 1; });
        Object.keys(S.sel).forEach(function (id) { if (!Object.keys(keys).some(function (k) { return keys[k].inspectionId === id; })) delete S.sel[id]; });
      }
      render();
    });
  }
  function tick() {
    if (!S.user || document.hidden || !Api.isLive || Api.busy()) return;
    Api.flush().then(function (f) {
      if (f.dropped.length) toast(f.dropped[0], 'bad');
      return Api.ping();
    }).then(function (p) {
      if (p && p.offline) { if (!S.offline) { S.offline = true; render(); } return; }
      if (p && !Api.busy() && (p.ver !== Api.version() || S.offline)) return refresh(true);
    });
  }
  function doLogout() {
    Api.logout(); S.user = null; S.db = null; S.seen = null; S.sel = {}; S.pick = {}; S.tab = ''; S.floorTab = null; closeSheet();
    if (Api.isLive) renderLogin(); else { Api.state().then(function () { renderLogin(); }); }
  }

  // ---------- เหตุการณ์คลิก ----------
  var ACT = {
    demoLogin: function (el) { S.user = Api.demoLogin(el.dataset.user); S.tab = ''; S.floorTab = null; S.seen = null; refresh(false); },
    demoReset: function () { ask('เริ่มข้อมูลทดลองใหม่ทั้งหมดหรือไม่?', 'เริ่มใหม่').then(function (y) { if (y) { Api.demoReset(); S.seen = null; refresh(false); toast('เริ่มข้อมูลทดลองใหม่แล้ว'); } }); },
    reload: function () { refresh(true).then(function () { toast('ข้อมูลล่าสุดแล้ว'); }); },
    logout: function () { doLogout(); },
    tab: function (el) { S.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
    floorTab: function (el) { S.floorTab = el.dataset.floor === 'all' ? 'all' : Number(el.dataset.floor); render(); },
    sel: function (el) { var id = el.dataset.insp; if (S.sel[id]) delete S.sel[id]; else S.sel[id] = 1; render(); },
    selAll: function () { tabState().list.forEach(function (t) { if (t.kind === 'check' && !t.recheck) S.sel[t.inspectionId] = 1; }); render(); },
    clearSel: function () { S.sel = {}; render(); },
    bulkPass: function () {
      var items = myTasks().filter(function (t) { return S.sel[t.inspectionId]; }).map(function (t) { return { inspectionId: t.inspectionId, step: t.step }; });
      ask('ยืนยันให้ ' + items.length + ' ห้องที่เลือกผ่านทั้งหมด (ครบทุกรายการ)?', 'ผ่านทั้งหมด').then(function (y) {
        if (!y) return;
        run('bulkPass', { items: items }, function (res) {
          S.sel = {};
          if (res.queued) return;
          var r = res.result;
          toast('ผ่านแล้ว ' + r.passed.length + ' ห้อง' + (r.skipped.length ? ' ข้าม ' + r.skipped.length + ' ห้อง: ' + r.skipped[0].message : ''), r.skipped.length ? 'bad' : '');
        });
      });
    },
    cleaned: function (el) { run('cleaned', { roomId: el.dataset.room, idSeed: Api.uid() }, function (res) { if (!res.queued) toast('ห้อง ' + el.dataset.room + ' ส่งตรวจแล้ว รอตรวจขั้นที่ 1'); }); },
    fixed: function (el) { run('markFixed', { inspectionId: el.dataset.insp }, function (res) { if (!res.queued) toast('ส่งตรวจซ้ำแล้ว'); }); },
    openForm: function (el) { openForm(el.dataset.insp); },
    round: function (el) { S.round = el.dataset.round; S.pick = {}; render(); },
    pick: function (el) { var r = el.dataset.room; if (S.pick[r]) delete S.pick[r]; else S.pick[r] = 1; render(); },
    pickFloor: function (el) {
      var f = Number(el.dataset.floor), today = Core.dateOf(Date.now()), done = {};
      S.db.inspections.forEach(function (i) { if (i.type === 'routine' && i.round === S.round && i.date === today && i.status !== 'cancelled') done[i.roomId] = 1; });
      S.db.rooms.forEach(function (r) { if (r.floor === f && r.status === 'ready' && !done[r.id]) S.pick[r.id] = 1; });
      render();
    },
    startRoutine: function () {
      var ids = Object.keys(S.pick), round = S.round;
      run('startRoutineMany', { round: round, roomIds: ids, idSeed: Api.uid() }, function (res) {
        S.pick = {};
        if (res.queued) return;
        var r = res.result;
        toast('เริ่มตรวจ' + Core.ROUNDS[round] + ' ' + r.started.length + ' ห้อง ส่งให้แม่บ้านแล้ว' + (r.skipped.length ? ' (ข้าม ' + r.skipped.length + ' ห้อง)' : ''), r.skipped.length ? 'bad' : '');
        if (S.user.role === 'maid') S.tab = 'tasks';
      });
    },
    room: function (el) { if (el.dataset.room) openRoom(el.dataset.room); },
    closeSheet: function (el, e) { if (e.target === el || el.tagName === 'BUTTON') closeSheet(); },
    checkin: function (el) {
      var room = el.dataset.room;
      Api.act('checkin', { roomId: room }).then(function (res) {
        if (res.ok) { closeSheet(); toast('ห้อง ' + room + ' แขกเช็กอินแล้ว'); return after(res); }
        if (res.code === 'NEEDS_CONFIRM') {
          return ask(res.message, 'ให้เข้าพักเลย', true).then(function (y) {
            if (!y) return;
            run('checkin', { roomId: room, force: true }, function () { closeSheet(); toast('ห้อง ' + room + ' แขกเช็กอินแล้ว (ยืนยันแล้ว)'); });
          });
        }
        toast(res.message, 'bad'); closeSheet(); return refresh(false);
      });
    },
    checkout: function (el) { var room = el.dataset.room; run('checkout', { roomId: room }, function () { closeSheet(); toast('ห้อง ' + room + ' เช็กเอาท์แล้ว แจ้งแม่บ้านชั้นนั้นแล้ว'); }); },
    cancelInsp: function (el) {
      ask('ยกเลิกใบตรวจที่เปิดอยู่ของห้องนี้? (ใช้เมื่อเปิดผิดห้อง)', 'ยกเลิกใบตรวจ', true).then(function (y) {
        if (y) run('cancelInspection', { inspectionId: el.dataset.insp, reason: 'ยกเลิกโดยผู้ดูแลระบบ' }, function () { closeSheet(); toast('ยกเลิกใบตรวจแล้ว'); });
      });
    },
    // ฟอร์มตรวจ
    toggle: function (el) { formToggle(el.dataset.no); },
    kind: function (el) { F.items[el.dataset.no].kind = el.dataset.kind; renderForm(); },
    found: function (el) {
      var st = F.items[el.dataset.no], max = Number(formItem(el.dataset.no).qty) - 1;
      st.found = Math.max(0, Math.min(max, st.found + Number(el.dataset.d))); renderForm();
    },
    showAll: function () { F.showAll = !F.showAll; renderForm(); },
    submitForm: function () { submitForm(); },
    closeForm: function () {
      var any = Object.keys(F.items).length;
      if (!any) return closeSheet();
      ask('ปิดโดยไม่บันทึกผลที่ติ๊กไว้?', 'ปิดโดยไม่บันทึก', true).then(function (y) { if (y) closeSheet(); });
    }
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || !ACT[el.dataset.act]) return;
    if (el.classList.contains('overlay') && e.target !== el) return; // คลิกในแผ่นไม่ปิดแผ่น
    ACT[el.dataset.act](el, e);
  });
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.task[role=button]')) { e.preventDefault(); e.target.click(); }
    if (e.key === 'Escape' && $('sheet').innerHTML && !$('dialog').innerHTML) { if (F) ACT.closeForm(); else closeSheet(); }
  });
  document.addEventListener('change', function (e) {
    if (e.target.matches('[data-change=switchUser]')) { S.user = Api.demoLogin(e.target.value); S.tab = ''; S.floorTab = null; S.seen = null; S.sel = {}; S.pick = {}; closeSheet(); refresh(false); }
  });
  document.addEventListener('input', function (e) {
    var n = e.target.getAttribute && e.target.getAttribute('data-note');
    if (n && F && F.items[n]) F.items[n].note = e.target.value;
  });
  document.addEventListener('pointerdown', function () { try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); } catch (er) { /* ignore */ } }, { once: true });
  window.addEventListener('online', function () { tick(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });

  // ---------- ผลที่ตามมาทีหลังการส่งเบื้องหลัง ----------
  Api.onEvent = function (type, data) {
    if (type === 'auth') { toast(data.message, 'bad'); doLogout(); return; }
    if (type === 'queued') { toast('ส่งไม่สำเร็จ เก็บไว้ในเครื่องแล้ว จะส่งให้อัตโนมัติ', 'new'); if (S.user && S.db) render(); return; }
    if (type === 'reject') { toast((data && data.message) || 'ทำรายการไม่สำเร็จ', 'bad'); refresh(false); }
  };

  // ---------- เริ่มทำงาน ----------
  Api.init();
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) navigator.serviceWorker.register('sw.js').catch(function () { /* ใช้ต่อได้ */ });
  var u = Api.currentUser();
  if (Api.isLive && u) {
    S.user = u;
    var cd = Api.cachedDb();
    if (cd) { S.db = cd; syncSeen(); render(); } // โชว์ข้อมูลล่าสุดที่จำไว้ทันที แล้วค่อยอัปเดต
    refresh(false);
  } else if (Api.isLive) { renderLogin(); } else { Api.state().then(function () { renderLogin(); }); }
  // ตรวจงานใหม่: ใช้งานอยู่เช็กถี่ (POLL) ไม่ได้แตะจอเกิน 3 นาทีเช็กห่างเป็น 30 วินาที (ประหยัดโควตา Apps Script)
  var lastTouch = Date.now();
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, function () { lastTouch = Date.now(); }, { passive: true }); });
  (function loop() {
    var idle = Date.now() - lastTouch > 180000;
    setTimeout(function () { tick(); loop(); }, idle ? 30000 : POLL);
  })();
})();
