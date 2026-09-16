// 聚焦验证：「恢复示例数据」在首次使用（localStorage 为空）时是否真能还原
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const file = process.argv[2];
const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
  url: 'https://appassets.androidplatform.net/assets/index.html',
  runScripts: 'dangerously',
  virtualConsole: new VirtualConsole(),
  beforeParse(w) { w.alert = () => {}; w.confirm = () => true; },
});
const { window } = dom;
const { document } = window;

setTimeout(() => {
  document.querySelector('nav button[data-view="add"]').click();
  document.getElementById('title').value = '测试书';
  document.getElementById('content').value = '测试内容';
  document.getElementById('save').click();
  const afterAdd = JSON.parse(window.localStorage.getItem('bookcards-v3') || '[]').length;

  document.getElementById('sample').click();
  const afterRestore = JSON.parse(window.localStorage.getItem('bookcards-v3') || '[]').length;

  const verdict = afterRestore === 3 ? '正确' : '★ BUG：应回到 3 条';
  console.log(path.basename(file) + ': 新增后 ' + afterAdd + ' 条 -> 点「恢复示例数据」后 ' + afterRestore + ' 条  ' + verdict);
  dom.window.close();
}, 300);
