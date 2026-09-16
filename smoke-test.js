/**
 * 冒烟测试：在 jsdom 中加载 index.html，模拟 APK 的桥接环境跑一遍关键交互。
 * 目的：确认改动没有引入运行时错误，且桥接调用参数正确。
 *
 * 重点覆盖两类曾经踩过的坑：
 *  1. 桥接方法缺失导致按钮点了没反应（静默失败）
 *  2. 卡片图 base64 整串传参会超出 IPC 上限被丢弃 → 必须验证分片能完整还原
 *
 * 运行：
 *   NODE_PATH=<workspace>/node_modules node smoke-test.js [--with-bridge|--no-bridge]
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const MODE = process.argv.includes('--no-bridge') ? 'no-bridge' : 'with-bridge';
const HTML = path.resolve(__dirname, process.env.HTML_FILE || 'index.html');
const ORIGIN = 'https://appassets.androidplatform.net/assets/index.html';

// 假的 PNG base64：刻意造得比 IPC 单片上限（64KB）大得多，逼出真实分片路径
const FAKE_PNG_B64 = 'A'.repeat(300000);
const FAKE_JPG_B64 = 'B'.repeat(5000);

const errors = [];
const log = [];
const note = (s) => { log.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  const m = String((e && e.message) || e);
  // jsdom 未实现的浏览器 API（如 scrollTo）不算被测代码的缺陷
  if (/Not implemented/i.test(m)) return;
  errors.push('jsdomError: ' + m);
});
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const bridgeCalls = [];

const dom = new JSDOM(fs.readFileSync(HTML, 'utf8'), {
  url: ORIGIN,
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    // 网页里的 alert/confirm 在 APK 中由原生代弹，这里记录调用
    window.alert = (m) => log.push('[alert] ' + String(m).split('\n')[0]);
    window.confirm = (m) => { log.push('[confirm] ' + String(m).split('\n')[0]); return true; };
    // jsdom 不保证提供 TextDecoder（导入 TXT 要用）
    if (!window.TextDecoder && typeof TextDecoder !== 'undefined') {
      window.TextDecoder = TextDecoder;
    }
    // 用假 canvas 顶替：jsdom 没有 canvas 实现，重点是验证绘制不抛错与分片传输正确
    const fakeCtx = {
      font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left',
      textBaseline: 'alphabetic', globalAlpha: 1,
      save() {}, restore() {}, scale() {}, fill() {}, stroke() {},
      fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
      moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, fillText() {}, drawImage() {},
      measureText(t) { return { width: String(t).length * 26 }; },
      createLinearGradient() { return { addColorStop() {} }; },
    };
    window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx; };
    window.HTMLCanvasElement.prototype.toDataURL = function (type) {
      return /jpeg/i.test(type || '')
        ? 'data:image/jpeg;base64,' + FAKE_JPG_B64
        : 'data:image/png;base64,' + FAKE_PNG_B64;
    };
    window.HTMLCanvasElement.prototype.toBlob = function (cb, type) {
      cb(new window.Blob(['x'], { type: type || 'image/png' }));
    };
    if (MODE === 'with-bridge') {
      window.AndroidBridge = {
        saveText: (name, text) => bridgeCalls.push({ fn: 'saveText', name, text }),
        shareText: (title, text) => bridgeCalls.push({ fn: 'shareText', title, text }),
        beginImage: (name, total) => bridgeCalls.push({ fn: 'beginImage', name, total }),
        pushImagePart: (idx, b64) => bridgeCalls.push({ fn: 'pushImagePart', idx, b64 }),
        saveImageDone: () => bridgeCalls.push({ fn: 'saveImageDone' }),
        shareImageDone: () => bridgeCalls.push({ fn: 'shareImageDone' }),
        toast: (m) => bridgeCalls.push({ fn: 'toast', text: String(m) }),
      };
    }
  },
});

const { window } = dom;
const { document } = window;

function check(label, cond, extra = '') {
  note((cond ? '  PASS  ' : '  FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
}
const $ = (id) => document.getElementById(id);
const cards = () => document.querySelectorAll('#homeGrid .card');

/** 往 <input type=file> 里塞一个文件并触发 change */
function setFile(input, name, content) {
  const file = new window.File([content], name, { type: 'text/plain' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change'));
}
const store = () => JSON.parse(window.localStorage.getItem('bookcards-v3') || '[]');

(async function main() {
  await sleep(150);
  note('=== 模式：' + MODE + ' ===');

  /* ---------- 1. 初始状态：不应再有默认示例数据 ---------- */
  check('首次使用为空（无默认摘录）', cards().length === 0, '实际 ' + cards().length);
  check('空态显示引导文案', /还没有读书卡/.test($('homeGrid').textContent));
  const stat0 = $('stats').querySelectorAll('.stat .num');
  check('统计初始为 0 / 0 / 0', [...stat0].every((n) => n.textContent === '0'),
    [...stat0].map((n) => n.textContent).join('/'));

  /* ---------- 2. 导航：底栏三个页签，书架降级为「我的」的子页面 ---------- */
  const tabViews = [...document.querySelectorAll('.tabbar button')].map((b) => b.dataset.view);
  check('底栏只剩 首页 / 记录 / 我的', tabViews.join(',') === 'home,add,profile', tabViews.join(','));
  check('底栏已无「我的书」', !document.querySelector('.tabbar button[data-view="books"]'));
  let navOk = true;
  for (const v of ['add', 'profile', 'home']) {
    document.querySelector(`.tabbar button[data-view="${v}"]`).click();
    if (!$(`${v}`).classList.contains('active')) { navOk = false; note('    切换失败: ' + v); }
  }
  check('三个页签切换均正常', navOk);
  check('「值得再读」页已删除', !document.querySelector('.tabbar button[data-view="fav"]') && !$('fav'));
  check('「再遇见」页已删除', !document.querySelector('.tabbar button[data-view="random"]') && !$('random'));
  check('「恢复示例数据」按钮已删除', !$('sample'));

  /* 「我的」页三个统计中，读书卡 / 读过的书 应变成可点入口 */
  window.show('profile');
  check('「读书卡」「读过的书」已变成可点击入口',
    $('stats').querySelectorAll('button.stat.link').length === 2,
    $('stats').querySelectorAll('button.stat.link').length + ' 个');
  $('stats').querySelectorAll('button.stat.link')[1].click();
  check('点「读过的书」进入书架页', $('books').classList.contains('active'));
  const activeTabs = [...document.querySelectorAll('.tabbar button.active')].map((b) => b.dataset.view);
  check('书架页底栏高亮仍停在「我的」',
    activeTabs.length === 1 && activeTabs[0] === 'profile', activeTabs.join(',') || '（无）');
  window.show('profile');
  $('stats').querySelectorAll('button.stat.link')[0].click();
  check('点「读书卡」打开完整摘录列表', $('home').classList.contains('active'));

  /* ---------- 2.5 记录页：保存按钮与品牌栏「读书卡」标题平行 ---------- */
  window.show('add');
  const addSec = $('add');
  const topbar = document.querySelector('.topbar');
  const savebar = document.querySelector('.savebar');
  const tbRow = document.querySelector('.topbar .tb-row');
  check('保存按钮已并入品牌栏（与「读书卡」标题同一水平线）',
    !!savebar && !!topbar && topbar.contains(savebar));
  check('保存按钮与标题同处 .tb-row，标题在左、按钮在右',
    !!tbRow && tbRow.contains($('save')) && tbRow.firstElementChild.classList.contains('brand'),
    tbRow ? [...tbRow.children].map((n) => n.className || n.tagName).join(' | ') : '（无 .tb-row）');
  check('保存按钮排在标题之后（视觉上靠右）',
    !!tbRow && tbRow.contains(savebar) &&
    [...tbRow.children].indexOf(savebar) > [...tbRow.children].indexOf(tbRow.firstElementChild));
  check('记录页已把 body 标记为 add（CSS 据此显示保存按钮）',
    document.body.dataset.view === 'add', 'data-view=' + (document.body.dataset.view || '(空)'));
  check('保存按钮不再粘在记录页内部（上一版浮动条已移除）', !addSec.contains(savebar));
  check('记录页表单区已无保存按钮（底部那个没回流）',
    addSec.querySelectorAll('.primary').length === 0,
    addSec.querySelectorAll('.primary').length + ' 个');
  check('「取消修改」也并入了品牌栏的按钮组', !!savebar && savebar.contains($('cancelEdit')));
  /* 旧方案靠 --toph 把浮动条钉在品牌栏下方；按钮进了品牌栏，这个偏移量必须清干净，
     否则残留的 resize 监听还在算一个没人用的值。 */
  check('不再残留 --toph 吸顶偏移',
    !document.documentElement.style.getPropertyValue('--toph').trim());
  window.show('home');
  check('离开记录页后保存按钮随之隐藏', document.body.dataset.view === 'home',
    'data-view=' + document.body.dataset.view);

  /* ---------- 3. 新增一条记录 ---------- */
  document.querySelector('.tabbar button[data-view="add"]').click();
  $('title').value = '百年孤独';
  $('author').value = '马尔克斯';
  $('chapter').value = '第一章';
  $('content').value = '过去都是假的，回忆是一条没有归途的路。';
  $('thought').value = '时间在这里是循环的。';
  $('tags').value = '孤独, 时间';
  $('save').click();
  check('新增后写入 localStorage', store().length === 1, '实际 ' + store().length);
  check('新增内容正确', store()[0] && store()[0].title === '百年孤独');
  check('表单已清空', $('title').value === '' && $('content').value === '');
  check('保存后回到首页', $('home').classList.contains('active'));
  check('首页渲染出 1 张卡', cards().length === 1);
  check('卡片上已无收藏（♥）按钮', !/♥|♡/.test($('homeGrid').innerHTML));
  check('统计显示 1 张 · 1 本', /^1 张 · 1 本$/.test($('homeCount').textContent), $('homeCount').textContent);

  /* ---------- 4. 搜索与书架 ---------- */
  $('search').value = 'zzz不存在';
  $('search').dispatchEvent(new window.Event('input'));
  check('搜索无结果时显示空态', /没有匹配/.test($('homeGrid').textContent));
  $('search').value = '';
  $('search').dispatchEvent(new window.Event('input'));
  check('清空搜索后恢复列表', cards().length === 1);
  check('「我的书」生成书架条目', document.querySelectorAll('#bookGrid .book').length === 1);

  /* ---------- 5. 分享：卡片图生成与分片传输 ---------- */
  const id = store()[0].id;
  window.openShare(id);
  check('分享弹层已打开', $('modal').classList.contains('show'));
  await sleep(120);
  check('卡片图已生成并预览', !!$('cardWrap').querySelector('img'),
    $('cardTip').textContent.slice(0, 40));

  bridgeCalls.length = 0;
  $('shareCardBtn').click();
  if (MODE === 'with-bridge') {
    const begin = bridgeCalls.filter((c) => c.fn === 'beginImage').pop();
    const parts = bridgeCalls.filter((c) => c.fn === 'pushImagePart');
    check('卡片图走 beginImage 声明分片', !!begin, begin && begin.name);
    check('分片数量与声明一致', !!begin && parts.length === begin.total,
      `声明 ${begin && begin.total} / 实收 ${parts.length}`);
    check('确实发生了分片（>1 片）', parts.length > 1, parts.length + ' 片');
    const joined = parts.sort((a, b) => a.idx - b.idx).map((p) => p.b64).join('');
    check('分片拼接后与原始 base64 逐字节一致', joined === FAKE_PNG_B64,
      `还原 ${joined.length} / 原始 ${FAKE_PNG_B64.length}`);
    check('分享结束调用 shareImageDone', bridgeCalls.some((c) => c.fn === 'shareImageDone'));
  } else {
    check('无桥接时回退到下载/系统分享而非静默失败',
      errors.length === 0 || log.some((l) => l.includes('保存为下载文件')));
  }

  bridgeCalls.length = 0;
  $('saveCardBtn').click();
  if (MODE === 'with-bridge') {
    check('保存到相册走 saveImageDone', bridgeCalls.some((c) => c.fn === 'saveImageDone'));
  }

  /* ---------- 6. 分享纯文字 ---------- */
  bridgeCalls.length = 0;
  $('shareTextBtn').click();
  if (MODE === 'with-bridge') {
    const c = bridgeCalls.find((x) => x.fn === 'shareText');
    check('分享文字走原生桥接', !!c);
    check('分享文案包含摘录与出处',
      !!c && c.text.includes('过去都是假的') && c.text.includes('百年孤独'));
  } else {
    check('无桥接时回退复制并提示', log.some((l) => l.includes('已复制到剪贴板')));
  }

  /* ---------- 7. 返回键钩子：弹层 → 操作面板 → 子页面 → 编辑态 → 首页 → 交给系统 ---------- */
  check('返回键先关分享弹窗', window.__appBack() === true && !$('modal').classList.contains('show'));
  window.openActions(store()[0].id);
  check('返回键能关操作面板', window.__appBack() === true && !$('actions').classList.contains('show'));
  window.show('books');
  check('返回键把书架退回「我的」', window.__appBack() === true && $('profile').classList.contains('active'));
  window.openEditor(store()[0].id);
  check('返回键能退出编辑态', window.__appBack() === true && $('home').classList.contains('active')
    && $('cancelEdit').style.display === 'none', $('addTitle').textContent);
  window.show('add');
  check('返回键从新建页回首页', window.__appBack() === true && $('home').classList.contains('active'));
  check('首页再按返回键交给系统退出', window.__appBack() === false);

  /* ---------- 8. 导出 ---------- */
  bridgeCalls.length = 0;
  $('exportJson').click();
  $('exportTxt').click();
  if (MODE === 'with-bridge') {
    const j = bridgeCalls.find((x) => x.fn === 'saveText' && x.name.endsWith('.json'));
    const t = bridgeCalls.find((x) => x.fn === 'saveText' && x.name.endsWith('.txt'));
    check('导出 JSON 走原生桥接', !!j, j && j.name);
    let parsed = null;
    try { parsed = JSON.parse(j.text); } catch (e) { /* 忽略 */ }
    check('导出的 JSON 可解析且条数正确', parsed && parsed.length === 1);
    check('导出 TXT 走原生桥接', !!t, t && t.name);
    check('TXT 含书名、章节与【想法】', !!t && t.text.includes('百年孤独') && t.text.includes('第一章') && t.text.includes('【想法】'));
  } else {
    check('无桥接时导出失败有明确提示而非静默',
      log.some((l) => l.includes('导出失败')) || errors.length === 0);
  }

  /* ---------- 9. 导入 JSON ---------- */
  const jsonIn = JSON.stringify([
    { title: '局外人', author: '加缪', chapter: '第一部', content: '今天，妈妈死了。', thought: '', tags: ['荒诞'], date: '2026-09-01' },
    { title: '百年孤独', author: '马尔克斯', chapter: '第一章', content: '过去都是假的，回忆是一条没有归途的路。', date: '2026-09-10' },
  ]);
  bridgeCalls.length = 0;
  setFile($('jsonFile'), 'backup.json', jsonIn);
  await sleep(80);
  check('导入 JSON 后总数为 2（重复项被跳过）', store().length === 2, '实际 ' + store().length);
  const imported = store().find((x) => x.title === '局外人');
  check('导入的字段完整', !!imported && imported.author === '加缪' && imported.chapter === '第一部'
    && imported.tags[0] === '荒诞' && imported.date === '2026-09-01',
    imported ? JSON.stringify({ a: imported.author, c: imported.chapter, t: imported.tags, d: imported.date }) : '无');
  check('导入完成后给出结果提示', log.some((l) => /导入完成：新增 1 条，跳过重复 1 条/.test(l)),
    log.filter((l) => l.includes('导入完成')).pop() || '（无）');

  /* ---------- 10. 导入 TXT（含块内空行、章节、【想法】【标签】） ---------- */
  const txtIn = [
    '《活着》｜余华',
    '第一章',
    '',
    '“人是为了活着本身而活着的。”',
    '',
    '【想法】答案不在远方。',
    '【标签】人生、生活',
    '2026-09-15',
    '',
    '---',
    '',
    '《月亮与六便士》｜毛姆',
    '',
    '“满地都是六便士，他却抬头看见了月亮。”',
  ].join('\n');
  setFile($('txtFile'), 'backup.txt', txtIn);
  await sleep(80);
  check('导入 TXT 后总数为 4', store().length === 4, '实际 ' + store().length);
  const huo = store().find((x) => x.title === '活着');
  check('TXT 书名与作者解析正确', !!huo && huo.author === '余华', huo && huo.author);
  check('TXT 章节未被并进正文', !!huo && huo.chapter === '第一章' && huo.content === '人是为了活着本身而活着的。',
    huo ? `章节=${huo.chapter} 内容=${huo.content}` : '无');
  check('TXT 【想法】解析正确', !!huo && huo.thought === '答案不在远方。', huo && huo.thought);
  check('TXT 【标签】解析正确', !!huo && huo.tags.join(',') === '人生,生活', huo && huo.tags.join(','));
  check('TXT 日期解析正确', !!huo && huo.date === '2026-09-15', huo && huo.date);
  const moon = store().find((x) => x.title === '月亮与六便士');
  check('分隔线切块正确（第二条未与上一条粘连）',
    !!moon && moon.content === '满地都是六便士，他却抬头看见了月亮。', moon && moon.content);
  setFile($('txtFile'), 'note.txt', '今天读到一句话，很有意思。\n它让我想起很多事。');
  await sleep(80);
  const free = store().find((x) => x.content.includes('它让我想起很多事'));
  check('首行无标记的散文也能整块导入且不丢内容', !!free, free ? `标题=${free.title}` : '未导入');

  /* ---------- 11. 修改已有的摘录 ---------- */
  window.show('home');
  const moreBtns = document.querySelectorAll('#homeGrid .card .cardtools .act-ic:first-child');
  const shareBtns = document.querySelectorAll('#homeGrid .card .cardtools .act-ic:last-child');
  check('每张卡都有「更多」与「分享」入口',
    moreBtns.length === cards().length && shareBtns.length === cards().length && cards().length > 0,
    `更多 ${moreBtns.length} / 分享 ${shareBtns.length} / 卡片 ${cards().length}`);

  const target = store().find((x) => x.title === '局外人');
  check('找到待修改的记录', !!target);
  const beforeCount = store().length;
  window.openActions(target.id);
  check('操作面板已打开', $('actions').classList.contains('show'));
  check('面板标题带出书名', $('actionsTitle').textContent.includes('局外人'), $('actionsTitle').textContent);

  $('editCardBtn').click();
  check('点「修改」进入记录页', $('add').classList.contains('active'));
  check('表单已预填原内容',
    $('title').value === '局外人' && $('author').value === '加缪' && $('chapter').value === '第一部'
    && $('content').value === '今天，妈妈死了。' && $('tags').value === '荒诞',
    [$('title').value, $('author').value, $('chapter').value, $('content').value, $('tags').value].join(' | '));
  check('标题与按钮切换为修改态',
    $('addTitle').textContent === '修改这张读书卡' && /保存修改/.test($('save').textContent),
    $('addTitle').textContent + ' / ' + $('save').textContent);
  check('出现「取消修改」入口', $('cancelEdit').style.display !== 'none');
  check('打开编辑器时操作面板已关闭', !$('actions').classList.contains('show'));

  $('content').value = '今天，妈妈死了。也许是昨天，我不知道。';
  $('thought').value = '开篇就把时间打散了。';
  $('save').click();
  check('修改是原地替换，总条数不变', store().length === beforeCount,
    `改前 ${beforeCount} / 改后 ${store().length}`);
  const edited = store().find((x) => x.id === target.id);
  check('修改内容已落库', !!edited && edited.content.includes('也许是昨天') && edited.thought === '开篇就把时间打散了。',
    edited && edited.content);
  check('原 id 与原始日期被保留', !!edited && edited.id === target.id && edited.date === target.date,
    edited && `${edited.id} / ${edited.date}`);
  check('保存后退出编辑态并回到首页',
    $('home').classList.contains('active') && $('cancelEdit').style.display === 'none'
    && $('addTitle').textContent === '记录一张读书卡');
  check('表单已清空，不会把上一条带进下一次新建', $('title').value === '' && $('content').value === '');

  window.openEditor(target.id);
  $('title').value = '不该被保存的书名';
  $('cancelEdit').click();
  const afterCancel = store().find((x) => x.id === target.id);
  check('「取消修改」未写入任何改动', !!afterCancel && afterCancel.title === '局外人',
    afterCancel && afterCancel.title);
  check('取消后回到首页', $('home').classList.contains('active'));

  /* ---------- 12. 删除与撤销 ---------- */
  // 注意：store() 每次都重新 parse，返回的是新对象，不能拿对象引用去 indexOf——那样两边都是
  // -1，"等于"会假通过。一律按 id 定位下标。
  const orderBefore = store().map((x) => x.id);
  const delTarget = store().find((x) => x.title === '月亮与六便士');
  const delId = delTarget.id;
  const delIdx = store().findIndex((x) => x.id === delId);
  check('待删记录下标有效', delIdx >= 0, String(delIdx));
  const cntBeforeDel = store().length;
  window.deleteCard(delId);
  check('删除前弹出确认', log.some((l) => l.includes('删除《月亮与六便士》')),
    (log.filter((l) => l.startsWith('[confirm]')).pop() || '（无）').slice(0, 46));
  check('删除后总条数 -1', store().length === cntBeforeDel - 1, `${cntBeforeDel} → ${store().length}`);
  check('被删记录已不在列表中', !store().some((x) => x.id === delId));
  check('出现撤销条', $('undoBar').classList.contains('show'), $('undoText').textContent);
  check('页面已重绘，卡片数同步', cards().length === store().length, `${cards().length} / ${store().length}`);

  $('undoBtn').click();
  const orderAfter = store().map((x) => x.id);
  check('撤销后记录回到原下标', orderAfter.indexOf(delId) === delIdx,
    `期望 ${delIdx} / 实际 ${orderAfter.indexOf(delId)}`);
  check('撤销后整体顺序与删除前完全一致', orderAfter.join(',') === orderBefore.join(','),
    `${orderBefore.length} 项`);
  check('撤销后总条数复原', store().length === cntBeforeDel, String(store().length));
  check('撤销后撤销条消失', !$('undoBar').classList.contains('show'));

  /* ---------- 13. 统计与收尾 ---------- */
  const nums = [...$('stats').querySelectorAll('.stat .num')].map((n) => n.textContent);
  check('统计三项均随数据更新', nums[0] === String(store().length) && Number(nums[1]) >= 4 && Number(nums[2]) > 0,
    nums.join(' / '));

  const cs = window.getComputedStyle(document.documentElement);
  check('安全区变量 --sat / --sab 已定义', cs.getPropertyValue('--sat').trim() !== '');
  check('Tesseract 未加载（jsdom 不拉 CDN，符合预期）', typeof window.Tesseract === 'undefined');

  note('');
  note('未捕获错误：' + (errors.length ? '\n  ' + errors.join('\n  ') : '无'));
  note(errors.length ? 'RESULT: FAIL' : 'RESULT: PASS');
  if (errors.length) process.exitCode = 1;
  dom.window.close();
})();
