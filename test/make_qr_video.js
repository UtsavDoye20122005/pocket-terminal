// Test helper: turns a pairing link into a fake camera feed (.y4m) for Chromium's
// --use-file-for-fake-video-capture, so the in-app QR scanner can be tested end to end.
//   node test/make_qr_video.js "<link>" out.y4m
const fs = require('fs');
const path = require('path');
const base = path.join(__dirname, '..', 'agent', 'node_modules', 'qrcode-terminal', 'vendor', 'QRCode');
const QRCode = require(base), L = require(path.join(base, 'QRErrorCorrectLevel')).L;

const [text, out] = process.argv.slice(2);
const q = new QRCode(-1, L); q.addData(text); q.make();
const n = q.getModuleCount(), W = 640, H = 480, scale = Math.floor(440 / (n + 8));
const size = (n + 8) * scale, ox = (W - size) >> 1, oy = (H - size) >> 1;
const Y = Buffer.alloc(W * H, 235); // light background
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
  if (!q.isDark(r, c)) continue;
  for (let y = 0; y < scale; y++) Y.fill(16, (oy + (r + 4) * scale + y) * W + ox + (c + 4) * scale, (oy + (r + 4) * scale + y) * W + ox + (c + 5) * scale);
}
const UV = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
const frame = Buffer.concat([Buffer.from('FRAME\n'), Y, UV]);
fs.writeFileSync(out, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...Array(10).fill(frame)]));
console.log(`wrote ${out}: ${n}x${n} modules`);
