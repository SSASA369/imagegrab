/* ============================================================
 * run-test.mjs —— 图提取 ImageGrab 端到端自动化测试
 * 流程：
 *   1. 给 manifest 临时追加 localhost 权限（测完恢复）
 *   2. Edge(headless) 加载扩展，截 chrome://extensions 页
 *   3. 打开模拟商品页 → 校验「获取图片」按钮注入 → 截图
 *   4. 点击按钮 → 等待画廊页 → 校验提取数量 → 截图
 *   5. 全选 → 下载到临时目录 → 校验 PNG 文件名与数量
 * 运行：node run-test.mjs
 * ============================================================ */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = ROOT;
const MOCK_PORT = 8123;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/product-mock.html`;
const SHOTS = path.join(ROOT, 'test', 'shots');
const DL = path.join(ROOT, 'test', 'downloads');
const PROFILE = path.join(ROOT, 'test', '.profile');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true });

/* ---------- 简易静态服务器：托管 fixtures ---------- */
const MIME = { '.html': 'text/html', '.png': 'image/png', '.css': 'text/css', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'test', 'fixtures', urlPath === '/' ? 'product-mock.html' : urlPath);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(MOCK_PORT, '127.0.0.1', r));

/* ---------- manifest 临时打补丁（localhost） ---------- */
const manifestPath = path.join(EXT, 'manifest.json');
const originalManifest = fs.readFileSync(manifestPath, 'utf8');
const patched = JSON.parse(originalManifest);
const LOCAL = '*://127.0.0.1/*';
patched.host_permissions.push(LOCAL);
patched.content_scripts[0].matches.push(LOCAL);
fs.writeFileSync(manifestPath, JSON.stringify(patched, null, 2));

const report = { ok: true, steps: [] };
const step = (name, ok, detail = '') => {
  report.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) report.ok = false;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  /* ---------- 1. 启动 Edge 并加载扩展 ---------- */
  browser = await puppeteer.launch({
    executablePath: EDGE,
    userDataDir: PROFILE,
    headless: false, // 有头模式：headless 的 Edge 会忽略 downloads 的 filename 选项
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msHubApps',
      '--window-size=1440,900',
      '--window-position=-3000,-3000' // 窗口移到屏幕外，避免干扰桌面
    ]
  });

  /* ---------- 2. chrome://extensions 页截图 ---------- */
  const extPage = await browser.newPage();
  await extPage.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
  await sleep(1200); // WebUI 懒渲染，等待卡片出现
  // chrome://extensions 大量使用 Shadow DOM，需递归穿透取文本
  const extName = await extPage.evaluate(() => {
    const walk = (el) => {
      let t = el.textContent || '';
      el.querySelectorAll('*').forEach((c) => { if (c.shadowRoot) t += walk(c.shadowRoot); });
      return t;
    };
    return walk(document.body).includes('图提取');
  });
  step('扩展已加载（chrome://extensions 可检索到）', extName);
  await extPage.screenshot({ path: path.join(SHOTS, '01_extensions_page.png'), fullPage: true });
  await extPage.close();

  /* ---------- 3. 打开模拟商品页 ---------- */
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(MOCK_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#imagegrab-fab .ig-btn', { timeout: 15000 });
  step('「获取图片」按钮已注入', true);

  const btnText = await page.$eval('#imagegrab-fab .ig-text', (el) => el.textContent.trim());
  step('按钮文案正确', btnText === '获取图片', `实际：${btnText}`);
  await page.screenshot({ path: path.join(SHOTS, '02_mock_page_with_button.png') });

  /* ---------- 4. 点击按钮，等待画廊页 ---------- */
  const galleryPromise = new Promise((resolve) => {
    browser.on('targetcreated', async (target) => {
      const url = target.url();
      if (url.includes('gallery.html')) resolve(target);
    });
    setTimeout(() => resolve(null), 20000);
  });
  await page.click('#imagegrab-fab .ig-btn');
  const galleryTarget = await galleryPromise;
  step('点击后新标签页打开画廊', Boolean(galleryTarget));

  await sleep(1500);
  const pages = await browser.pages();
  const gallery = pages.find((p) => p.url().includes('gallery.html'));
  if (gallery) {
    gallery.on('console', (m) => console.log('[gallery-console]', m.text()));
    await gallery.waitForSelector('.ig-card', { timeout: 10000 });
    const cardCount = await gallery.$$eval('.ig-card', (els) => els.length);
    // 期望：red(去重后1) blue green orange gold pink purple = 7 张有效图
    step('提取图片数量正确', cardCount === 7, `提取到 ${cardCount} 张（期望 7）`);
    const countText = await gallery.$eval('#ig-count', (el) => el.textContent);
    step('计数器显示正确', countText.includes(`0 / ${cardCount}`), countText);
    await gallery.screenshot({ path: path.join(SHOTS, '03_gallery_grid.png'), fullPage: false });

    /* ---------- 5. 全选 + 下载 ---------- */
    await gallery.click('#ig-checkall');
    await sleep(300);
    const countText2 = await gallery.$eval('#ig-count', (el) => el.textContent);
    step('全选后计数更新', countText2.includes(`${cardCount} / ${cardCount}`), countText2);
    await gallery.screenshot({ path: path.join(SHOTS, '04_gallery_selected.png') });

    // 指定下载目录
    const client = await gallery.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

    await gallery.click('#ig-download');

    // 等待完成反馈横幅（下载真正落盘后 SW 会推送 IG_DONE）
    await gallery.waitForFunction(() => {
      const b = document.getElementById('ig-banner');
      return b && !b.hidden;
    }, { timeout: 45000 });
    const bannerText = await gallery.$eval('#ig-banner', (el) => el.textContent);
    step('下载完成反馈横幅显示', /成功\s*7/.test(bannerText), bannerText);

    // 保存队列仍在逐张落盘，轮询等待（每张间隔 280ms）
    let files = [];
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      files = fs.existsSync(DL) ? fs.readdirSync(DL).filter((f) => !f.endsWith('.crdownload')) : [];
      if (files.length >= cardCount) break;
    }
    const pngs = files.filter((f) => /^商品图_\d{3}\.png$/.test(f));
    step('PNG 文件名编号正确', pngs.length === cardCount, `匹配 ${pngs.length}/${cardCount} 个：${files.join(', ')}`);
    // 校验 PNG 魔数（89504E47）
    if (pngs.length) {
      const fd = fs.openSync(path.join(DL, pngs[0]), 'r');
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      step('下载文件为合法 PNG', head.toString('hex') === '89504e47', pngs[0]);
    }
    await gallery.screenshot({ path: path.join(SHOTS, '05_gallery_download_done.png') });
  }
} catch (err) {
  step('端到端流程无异常', false, err.message);
  console.error(err);
} finally {
  /* 恢复 manifest 并清理 */
  fs.writeFileSync(manifestPath, originalManifest);
  server.close();
  if (browser) await browser.close();
}

console.log('\n=== 测试结论：' + (report.ok ? '全部通过' : '存在失败项') + ' ===');
process.exit(report.ok ? 0 : 1);
