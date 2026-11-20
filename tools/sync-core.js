// คัดลอก docs/core.js → apps-script/Core.gs (ตรรกะชุดเดียวกันทั้งหน้าเว็บและ backend)
// รัน: node tools/sync-core.js   (ทุกครั้งที่แก้ docs/core.js)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'docs', 'core.js'), 'utf8');
const header = '// ไฟล์นี้คัดลอกมาจาก docs/core.js โดย tools/sync-core.js — อย่าแก้ที่นี่ ให้แก้ที่ docs/core.js แล้วรันสคริปต์ใหม่\n';
fs.writeFileSync(path.join(root, 'apps-script', 'Core.gs'), header + src);
console.log('synced → apps-script/Core.gs');
