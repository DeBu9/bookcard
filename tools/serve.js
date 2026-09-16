// 本地静态服务器，用于在电脑上预览网页版。
//   node tools/serve.js  →  http://localhost:8080
//
// 为什么需要它：直接双击 index.html 走的是 file:// 协议，OCR 用到的
// Tesseract.js 需要从 CDN 拉 worker 与语言包，file:// 下常被浏览器拦截。
// 用 http://localhost 打开就没有这个问题，也贴近手机里的真实运行环境。
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(ROOT, path.normalize(rel));
    // 防目录穿越：只允许读取项目目录内的文件
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found: ' + rel);
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  })
  .listen(PORT, () => {
    console.log('读书卡网页版： http://localhost:' + PORT);
    console.log('（Ctrl+C 停止）');
  });
