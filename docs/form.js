/*
 * form.js — วาด "ตรวจเช็กรายการของใช้ภายในห้องพัก" ตามแบบฟอร์มกระดาษ ลงผืนผ้าใบ (canvas) แล้วดาวน์โหลดเป็นรูป PNG
 * ข้อมูลมาจาก Core.formData(db, inspectionId) — ตำแหน่งทุกอย่างอิงหน้ากระดาษ A4 ขนาดอ้างอิง 827 × 1170 (ขยายเป็น 1240 × 1755 พิกเซล)
 */
var FormImage = (function () {
  'use strict';
  var W = 827, H = 1170, PX = 1240;
  var SCALE = PX / W;
  var FONT = '"IBM Plex Sans Thai","Noto Sans Thai","Sarabun",Tahoma,sans-serif';
  var INK = '#111', LINE = '#111', GREEN = '#1b7a46', RED = '#c0362c', PEN = '#13307a';

  // คอลัมน์ตารางหลัก (x เริ่มต้น → สิ้นสุด)
  var X = { l: 32, no: 78, name: 267, qty: 321, c1: 351, c2: 380, c3: 409, r: 793 };
  var T = { top: 207, head: 76, row: 26, n: 25 };

  var MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  function thaiDate(d) {
    var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d || '');
    return m ? (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + (+m[1] + 543) : '';
  }
  var SHORT_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  function shortDate(s) {
    var m = /^(\d{4})-(\d\d)-(\d\d)/.exec(s || '');
    return m ? (+m[3]) + ' ' + SHORT_M[+m[2] - 1] + ' ' + (+m[1] + 543) : '';
  }
  function hhmm(s) { return s ? String(s).slice(11, 16) : ''; }
  var ROUND = { morning: 'ตรวจรอบเช้า', afternoon: 'ตรวจรอบบ่าย' };
  function kindText(d) { return d.type === 'checkout' ? 'ตรวจหลังแขกออก' : (ROUND[d.round] || 'ตรวจตามรอบ'); }
  function statusText(d) {
    if (d.status === 'passed') return 'ผ่านครบ 3 ขั้น';
    if (d.status === 'cancelled') return 'ยกเลิกใบตรวจ';
    if (d.status === 'fixing') return 'พบปัญหา รอแก้ไข (ขั้น ' + d.failedStep + ')';
    return 'อยู่ระหว่างตรวจ (ขั้น ' + d.step + ' จาก 3)';
  }
  // ชื่อไฟล์เป็นอังกฤษล้วน (บางเบราว์เซอร์/มือถือเปลี่ยนชื่อไฟล์ที่มีภาษาไทยเป็น "download")
  function fileName(d) { return 'room-' + String(d.roomId).replace(/[^A-Za-z0-9]/g, '') + '_' + d.date + '_' + String(d.inspectionId).replace(/^I-[^-]*-/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) + '.png'; }

  function loadImage(src) {
    return new Promise(function (res) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { res(null); };
      im.src = src;
    });
  }
  function loadFonts() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var q = ['400 14px "IBM Plex Sans Thai"', '600 14px "IBM Plex Sans Thai"', '700 14px "IBM Plex Sans Thai"'].map(function (f) {
      return document.fonts.load(f, 'ก').catch(function () { /* ใช้ฟอนต์สำรอง */ });
    });
    return Promise.all(q);
  }

  // ---------- ตัวช่วยวาด ----------
  function font(c, size, weight) { c.font = (weight || 400) + ' ' + size + 'px ' + FONT; }
  function text(c, str, x, y, o) {
    o = o || {};
    font(c, o.size || 12, o.weight);
    c.fillStyle = o.color || INK;
    c.textAlign = o.align || 'left';
    c.textBaseline = 'middle';
    c.fillText(str, x, y);
  }
  function hline(c, x1, x2, y, w) { c.lineWidth = w || 0.7; c.strokeStyle = LINE; c.beginPath(); c.moveTo(x1, y); c.lineTo(x2, y); c.stroke(); }
  function vline(c, x, y1, y2, w) { c.lineWidth = w || 0.7; c.strokeStyle = LINE; c.beginPath(); c.moveTo(x, y1); c.lineTo(x, y2); c.stroke(); }
  function box(c, x1, y1, x2, y2, w) { c.lineWidth = w || 1.4; c.strokeStyle = LINE; c.strokeRect(x1, y1, x2 - x1, y2 - y1); }
  function check(c, cx, cy, s, color, w) {
    c.strokeStyle = color; c.lineWidth = w || 1.8; c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(cx - s * 0.5, cy + s * 0.02); c.lineTo(cx - s * 0.12, cy + s * 0.4); c.lineTo(cx + s * 0.55, cy - s * 0.42); c.stroke();
  }
  function cross(c, cx, cy, s, color) {
    c.strokeStyle = color; c.lineWidth = 1.8; c.lineCap = 'round';
    c.beginPath(); c.moveTo(cx - s * 0.4, cy - s * 0.4); c.lineTo(cx + s * 0.4, cy + s * 0.4); c.moveTo(cx + s * 0.4, cy - s * 0.4); c.lineTo(cx - s * 0.4, cy + s * 0.4); c.stroke();
  }
  // ตัดข้อความเป็นบรรทัด (ภาษาไทยไม่มีเว้นวรรค จึงตัดทีละตัวอักษรเมื่อไม่พอดี)
  function wrap(c, str, maxW, maxLines) {
    var lines = [], cur = '';
    for (var i = 0; i < str.length; i++) {
      var t = cur + str[i];
      if (c.measureText(t).width > maxW && cur) {
        lines.push(cur); cur = str[i];
        if (lines.length === maxLines) break;
      } else cur = t;
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    else if (lines.length === maxLines && i < str.length) lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/, '…');
    return lines;
  }

  // วาดลายเซ็น (เส้น) ลงในกรอบ (x,y,w,h) คงสัดส่วน เส้นโค้งผ่านจุดกึ่งกลาง ให้ดูเป็นลายมือ
  function drawSignature(c, sig, x, y, w, h) {
    var p = Core.parseSignature(sig);
    if (!p) return false;
    var k = Math.min(w / p.w, h / p.h);
    var ox = x + (w - p.w * k) / 2, oy = y + (h - p.h * k) / 2;
    c.strokeStyle = PEN; c.lineWidth = Math.max(1.1, 2.4 * k); c.lineCap = 'round'; c.lineJoin = 'round';
    p.strokes.forEach(function (st) {
      c.beginPath();
      var pt = function (i) { return [ox + st[i][0] * k, oy + st[i][1] * k]; };
      var a = pt(0);
      if (st.length === 1) { c.moveTo(a[0], a[1]); c.lineTo(a[0] + 0.1, a[1]); c.stroke(); return; }
      c.moveTo(a[0], a[1]);
      for (var i = 1; i < st.length - 1; i++) {
        var q = pt(i), n = pt(i + 1);
        c.quadraticCurveTo(q[0], q[1], (q[0] + n[0]) / 2, (q[1] + n[1]) / 2);
      }
      var e = pt(st.length - 1);
      c.lineTo(e[0], e[1]);
      c.stroke();
    });
    return true;
  }

  // ---------- วาดทั้งฟอร์ม ----------
  function draw(c, d, hdr) {
    c.save();
    c.scale(SCALE, SCALE);
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);

    // หัวกระดาษ (ภาพจากแบบฟอร์มของโรงแรม)
    if (hdr) c.drawImage(hdr, X.l, 38, X.r - X.l, (X.r - X.l) * hdr.height / hdr.width);
    text(c, 'ตรวจเช็กรายการของใช้ภายในห้องพัก', W / 2, 137, { size: 17, weight: 700, align: 'center' });

    // บรรทัดวันที่
    var days = d.signers.filter(function (s) { return s.done; }).map(function (s) { return String(s.at).slice(0, 10); });
    var lastDay = days.length ? days[days.length - 1] : d.date;
    var spans = lastDay !== d.date;
    text(c, spans ? 'เริ่มตรวจ ' + thaiDate(d.date) : 'วันที่ตรวจ  ' + thaiDate(d.date), X.l + 2, spans ? 176 : 183, { size: spans ? 11.5 : 13, weight: 500 });
    if (spans) text(c, 'เซ็นล่าสุด ' + thaiDate(lastDay), X.l + 2, 192, { size: 10.5, color: '#555' });
    text(c, 'ห้อง ' + d.roomId + '  ·  ' + kindText(d), 300, 183, { size: 13, weight: 700 });
    text(c, statusText(d), X.r, 183, { size: 12, weight: 600, align: 'right', color: d.status === 'passed' ? GREEN : (d.status === 'cancelled' || d.status === 'fixing' ? RED : '#8a5a00') });

    // ---- หัวตาราง ----
    var top = T.top, hb = top + T.head, mid = top + T.head / 2;
    box(c, X.l, top, X.r, hb + T.row * T.n + 22, 1.6);
    hline(c, X.l, X.r, hb, 1.4);
    hline(c, X.c1 - 0 - 30, X.c3, mid, 1);
    [X.no, X.name].forEach(function (x) { vline(c, x, top, hb + T.row * T.n, 1.4); });
    [X.qty, X.c3].forEach(function (x) { vline(c, x, top, hb + T.row * T.n + 22, 1.4); });
    vline(c, X.c1, mid, hb + T.row * T.n + 22, 0.8); vline(c, X.c2, mid, hb + T.row * T.n + 22, 0.8);
    text(c, 'ลำดับ', (X.l + X.no) / 2, top + T.head / 2, { size: 11.5, weight: 700, align: 'center' });
    text(c, 'รายการของใช้ในห้องพัก', (X.no + X.name) / 2, top + T.head / 2, { size: 11.5, weight: 700, align: 'center' });
    text(c, 'จำนวน', (X.name + X.qty) / 2, top + T.head / 2, { size: 11.5, weight: 700, align: 'center' });
    text(c, 'ห้อง ' + d.roomId, (X.qty + X.c3) / 2, top + T.head / 4, { size: 11, weight: 700, align: 'center' });
    [X.qty, X.c1, X.c2].forEach(function (x, i) { text(c, String(i + 1), (x + [X.c1, X.c2, X.c3][i]) / 2, mid + T.head / 4, { size: 11.5, weight: 700, align: 'center' }); });
    text(c, 'หมายเหตุ / สิ่งที่พบ', (X.c3 + X.r) / 2, top + T.head / 2, { size: 11.5, weight: 700, align: 'center' });

    // ---- แถวรายการ ----
    var cols = [[X.qty, X.c1], [X.c1, X.c2], [X.c2, X.c3]];
    d.items.slice(0, T.n).forEach(function (it, i) {
      var y = hb + i * T.row, cy = y + T.row / 2;
      if (i) hline(c, X.l, X.r, y, 0.6);
      text(c, String(it.no), (X.l + X.no) / 2, cy, { size: 12, weight: 700, align: 'center' });
      font(c, 12);
      var nm = it.name;
      text(c, nm, X.no + 6, cy, { size: c.measureText(nm).width > X.name - X.no - 10 ? 10.5 : 12 });
      text(c, String(it.qty), (X.name + X.qty) / 2, cy, { size: 12, align: 'center' });
      it.marks.forEach(function (m, k) {
        var mx = (cols[k][0] + cols[k][1]) / 2;
        if (m === 'ok') check(c, mx, cy, 11, GREEN);
        else if (m === 'fail') cross(c, mx, cy, 11, RED);
      });
      if (it.remark) {
        font(c, 9.5);
        var lines = wrap(c, it.remark, X.r - X.c3 - 10, 2);
        lines.forEach(function (ln, j) {
          text(c, ln, X.c3 + 5, cy + (lines.length === 1 ? 0 : (j ? 5.5 : -5.5)), { size: 9.5, color: '#7a1f17' });
        });
      }
    });

    // ---- แถวรวม ----
    var sy = hb + T.row * T.n;
    hline(c, X.l, X.r, sy, 1.4);
    var sc = sy + 11;
    font(c, 10.5, 700);
    var pre = 'รวมรายการที่ครบถ้วน (', post = ') / ' + d.total + ' รายการ';
    var w1 = c.measureText(pre).width, w2 = c.measureText(post).width, tw = w1 + 12 + w2;
    var sx = (X.l + X.name) / 2 - tw / 2 + 4;
    text(c, pre, sx, sc, { size: 10.5, weight: 700 });
    check(c, sx + w1 + 6, sc, 8, GREEN, 1.5);
    text(c, post, sx + w1 + 12, sc, { size: 10.5, weight: 700 });
    d.totals.forEach(function (n, k) {
      var any = d.signers[k].done;
      text(c, any ? String(n) : '', (cols[k][0] + cols[k][1]) / 2, sc, { size: 11.5, weight: 700, align: 'center' });
    });

    // ---- ตารางผู้ตรวจสอบ / ลายเซ็น ----
    var gy = 975, gh = 22, rh = 50;
    var G = { a: X.l, b: X.qty, c: 527, e: 693, r: X.r };
    box(c, G.a, gy, G.r, gy + gh + rh * 3, 1.4);
    hline(c, G.a, G.r, gy + gh, 1.2);
    [G.b, G.c, G.e].forEach(function (x) { vline(c, x, gy, gy + gh + rh * 3, 1); });
    hline(c, G.a, G.r, gy + gh + rh, 0.8); hline(c, G.a, G.r, gy + gh + rh * 2, 0.8);
    text(c, 'ผู้ตรวจสอบ (ตามช่อง 1 / 2 / 3)', G.a + 6, gy + gh / 2, { size: 10.5, weight: 700 });
    text(c, 'ผล', (G.a + G.b) / 2 + (G.b - G.a) * 0.42, gy + gh / 2, { size: 10.5, weight: 700, align: 'center' });
    text(c, 'ชื่อ-นามสกุล / ลายมือชื่อผู้ตรวจสอบ', (G.b + G.c) / 2, gy + gh / 2, { size: 10.5, weight: 700, align: 'center' });
    text(c, 'ตำแหน่ง / แผนก', (G.c + G.e) / 2, gy + gh / 2, { size: 10.5, weight: 700, align: 'center' });
    text(c, 'วัน-เวลาที่ตรวจ', (G.e + G.r) / 2, gy + gh / 2, { size: 10.5, weight: 700, align: 'center' });
    var pos = ['แม่บ้านประจำชั้น', 'หัวหน้าแม่บ้าน', 'หัวหน้า / ฝ่ายต้อนรับ (QC)'];
    d.signers.forEach(function (s, k) {
      var y = gy + gh + rh * k, cy = y + rh / 2;
      text(c, 'คนที่ ' + (k + 1) + ' (ช่อง ' + (k + 1) + ')', G.a + 6, cy, { size: 11, weight: 700 });
      text(c, s.done ? (s.result === 'pass' ? 'ผ่าน' : 'พบปัญหา') : '-', G.a + (G.b - G.a) * 0.8, cy, { size: 10.5, weight: 600, align: 'center', color: s.result === 'fail' ? RED : (s.done ? GREEN : '#777') });
      if (s.done) {
        var drawn = s.signature ? drawSignature(c, s.signature, G.b + 8, y + 3, G.c - G.b - 16, rh - 17) : false;
        if (!drawn) text(c, 'ไม่มีลายเซ็น (บันทึกก่อนเปิดใช้ลายเซ็น)', (G.b + G.c) / 2, y + 17, { size: 9, color: '#999', align: 'center' });
        text(c, '(' + s.userName + ')', (G.b + G.c) / 2, y + rh - 8, { size: 9.5, align: 'center' });
        text(c, pos[k], (G.c + G.e) / 2, cy, { size: 10.5, align: 'center' });
        text(c, shortDate(s.at), (G.e + G.r) / 2, cy - 8, { size: 10, align: 'center' });
        text(c, hhmm(s.at) + ' น.', (G.e + G.r) / 2, cy + 8, { size: 11, weight: 600, align: 'center' });
      } else {
        text(c, 'ลงชื่อ ................................................', G.b + 8, cy, { size: 9.5, color: '#999' });
        text(c, pos[k], (G.c + G.e) / 2, cy, { size: 10, align: 'center', color: '#999' });
        text(c, '....../....../...... ..:.. น.', (G.e + G.r) / 2, cy, { size: 8.5, align: 'center', color: '#999' });
      }
    });

    if (d.status === 'cancelled') {
      c.save(); c.translate(W / 2, 640); c.rotate(-0.5);
      text(c, 'ยกเลิก', 0, 0, { size: 120, weight: 700, align: 'center', color: 'rgba(192,54,44,0.16)' });
      c.restore();
    }
    text(c, 'สร้างจากระบบตรวจห้องพัก · เลขที่ใบตรวจ ' + d.inspectionId, X.l, H - 18, { size: 8.5, color: '#888' });
    c.restore();
  }

  // → Promise<canvas>
  function render(d, opts) {
    opts = opts || {};
    return Promise.all([loadFonts(), loadImage(opts.header || 'form-header.png')]).then(function (r) {
      var cv = document.createElement('canvas');
      cv.width = PX; cv.height = Math.round(H * SCALE);
      draw(cv.getContext('2d'), d, r[1]);
      return cv;
    });
  }
  function download(d, opts) {
    return render(d, opts).then(function (cv) {
      return new Promise(function (res) {
        cv.toBlob(function (blob) {
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = fileName(d);
          document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); res(); }, 1500);
        }, 'image/png');
      });
    });
  }

  return { render: render, download: download, fileName: fileName, thaiDate: thaiDate };
})();
