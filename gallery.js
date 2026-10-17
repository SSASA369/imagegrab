/* ============================================================
 * gallery.js —— 画廊页逻辑（图提取 ImageGrab）
 * 职责：
 *   1. 从 storage.session 读取提取结果并渲染网格；
 *   2. 全选 / 反选 / 计数 / 勾选状态管理；
 *   3. 发起批量下载，展示进度条与完成反馈；
 *   4. 支持 ?demo=1 演示模式（无提取数据时预览界面）。
 * ============================================================ */
(function () {
  'use strict';

  const STORE_KEY = 'imagegrab:lastResult';
  const state = {
    pageUrl: '',
    pageTitle: '',
    images: [],      // [{url, width, height}]
    selected: new Set(), // 选中下标
    broken: new Set(),   // 加载失败下标
    downloading: false
  };

  const $ = (id) => document.getElementById(id);
  const grid = $('ig-grid');

  /* ---------- 入口 ---------- */
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    // 向 service worker 登记上线（用于回推下载进度）
    try { chrome.runtime.sendMessage({ type: 'GALLERY_READY' }); } catch (e) {}

    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1') {
      loadDemo();
      return;
    }

    let result = null;
    try {
      const data = await chrome.storage.session.get(STORE_KEY);
      result = data[STORE_KEY];
    } catch (e) {
      console.error('[ImageGrab] 读取存储失败：', e);
    }

    if (!result || !result.images || result.images.length === 0) {
      showEmpty();
      return;
    }

    state.pageUrl = result.pageUrl || '';
    state.pageTitle = result.pageTitle || '';
    state.images = result.images;
    render();

    // 监听下载进度 / 完成反馈
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'IG_START') {
        setProgress(0, `共 ${msg.total} 张，准备下载…`);
      }
      if (msg.type === 'IG_ITEM') onItem(msg);
      if (msg.type === 'IG_DONE') onDone(msg);
    });
  }

  /* ---------- 渲染 ---------- */
  function render() {
    $('ig-source').textContent = state.pageTitle
      ? `${state.pageTitle} — ${state.pageUrl}`
      : state.pageUrl;

    grid.innerHTML = '';
    state.images.forEach((img, i) => {
      const card = document.createElement('label');
      card.className = 'ig-card';
      card.innerHTML = `
        <input type="checkbox" data-index="${i}" ${state.selected.has(i) ? 'checked' : ''} />
        <div class="ig-thumb"><img alt="商品图 ${i + 1}" /></div>
        <div class="ig-meta">
          <span class="ig-idx">#${String(i + 1).padStart(3, '0')}</span>
          <span class="ig-size">${img.width} × ${img.height}</span>
        </div>`;

      const elImg = card.querySelector('img');
      elImg.src = img.url;
      elImg.onload = () => {
        // 以真实渲染尺寸为准（某些 CDN 会返回与原声明不同的图）
        const sizeEl = card.querySelector('.ig-size');
        if (sizeEl && elImg.naturalWidth) {
          sizeEl.textContent = `${elImg.naturalWidth} × ${elImg.naturalHeight}`;
        }
      };
      elImg.onerror = () => {
        // 缩略图加载失败：标灰并禁止勾选
        state.broken.add(i);
        card.classList.add('broken');
        const box = card.querySelector('input[type="checkbox"]');
        box.disabled = true;
        box.checked = false;
        state.selected.delete(i);
        card.querySelector('.ig-thumb').textContent = '图片加载失败';
        refreshToolbar();
      };

      grid.appendChild(card);
    });

    grid.addEventListener('change', onGridChange);
    $('ig-checkall').addEventListener('change', onCheckAll);
    $('ig-invert').addEventListener('click', onInvert);
    $('ig-download').addEventListener('click', onDownload);
    refreshToolbar();
  }

  /* ---------- 选择逻辑 ---------- */
  function onGridChange(e) {
    const box = e.target.closest('input[type="checkbox"][data-index]');
    if (!box) return;
    const i = Number(box.dataset.index);
    box.checked ? state.selected.add(i) : state.selected.delete(i);
    box.closest('.ig-card').classList.toggle('checked', box.checked);
    refreshToolbar();
  }

  function onCheckAll(e) {
    const on = e.target.checked;
    state.selected.clear();
    if (on) {
      state.images.forEach((_, i) => { if (!state.broken.has(i)) state.selected.add(i); });
    }
    syncBoxes();
    refreshToolbar();
  }

  function onInvert() {
    state.images.forEach((_, i) => {
      if (state.broken.has(i)) return;
      state.selected.has(i) ? state.selected.delete(i) : state.selected.add(i);
    });
    syncBoxes();
    refreshToolbar();
  }

  function syncBoxes() {
    grid.querySelectorAll('input[data-index]').forEach((box) => {
      const i = Number(box.dataset.index);
      box.checked = state.selected.has(i);
      box.closest('.ig-card').classList.toggle('checked', box.checked);
    });
    const allValid = state.images.length - state.broken.size;
    $('ig-checkall').checked = state.selected.size === allValid && allValid > 0;
  }

  function refreshToolbar() {
    const total = state.images.length - state.broken.size;
    $('ig-count').textContent = `已选 ${state.selected.size} / ${total} 张`;
    $('ig-download').disabled = state.selected.size === 0 || state.downloading;
  }

  /* ---------- 下载 ---------- */
  function onDownload() {
    if (state.downloading || state.selected.size === 0) return;
    state.downloading = true;
    receivedCount = 0;
    refreshToolbar();

    // 文件名规则：商品图_序号.png，序号按选中顺序补零三位
    const items = [...state.selected]
      .sort((a, b) => a - b)
      .map((idx, n) => ({
        url: state.images[idx].url,
        filename: `商品图_${String(n + 1).padStart(3, '0')}.png`
      }));

    $('ig-banner').hidden = true;
    setProgress(0, `共 ${items.length} 张，准备下载…`);
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_BATCH', items });
  }

  /* SW 每转码完一张就回传一条 IG_ITEM：进入保存队列，逐张落盘并刷新进度。
     队列间隔 280ms：无用户手势的连续程序化下载会被浏览器突发拦截，
     拉开间隔后（实测）可稳定全部落盘且文件名正确。 */
  const saveQueue = [];
  let saveDraining = false;

  function enqueueSave(dataUrl, filename) {
    saveQueue.push({ dataUrl, filename });
    drainSaveQueue();
  }

  async function drainSaveQueue() {
    if (saveDraining) return;
    saveDraining = true;
    while (saveQueue.length) {
      const item = saveQueue.shift();
      saveDataUrl(item.dataUrl, item.filename);
      await new Promise((r) => setTimeout(r, 280));
    }
    saveDraining = false;
  }

  let receivedCount = 0;
  function onItem(msg) {
    receivedCount += 1;
    if (msg.ok && msg.dataUrl) {
      enqueueSave(msg.dataUrl, msg.filename);
    }
    const pct = msg.total ? Math.round((receivedCount / msg.total) * 100) : 0;
    const note = msg.fallback ? '（原格式）' : '';
    setProgress(pct, `正在下载 ${receivedCount}/${msg.total} 张…${note}`);
  }

  /* dataURL → 本地文件（锚点 download 属性可保证中文编号文件名在各浏览器一致） */
  function saveDataUrl(dataUrl, filename) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename || '商品图.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function onDone(msg) {
    state.downloading = false;
    refreshToolbar();
    setProgress(100, '下载完成');
    const banner = $('ig-banner');
    banner.hidden = false;
    banner.classList.toggle('has-fail', msg.failed > 0);
    banner.textContent = msg.failed > 0
      ? `下载完成：成功 ${msg.completed} 张，失败 ${msg.failed} 张（失败项多为原站限制，可在页面中右键另存）。`
      : `下载完成：成功 ${msg.completed} 张，已保存到浏览器默认下载目录。`;
  }

  function setProgress(pct, text) {
    $('ig-progress').hidden = false;
    $('ig-progress-fill').style.width = pct + '%';
    $('ig-progress-text').textContent = text;
  }

  /* ---------- 空状态 / 演示模式 ---------- */
  function showEmpty() {
    $('ig-empty').hidden = false;
    $('ig-progress').hidden = true;
    $('ig-demo').addEventListener('click', () => {
      location.search = '?demo=1';
    });
  }

  function loadDemo() {
    // 生成 8 张纯 SVG 示意图，便于无提取数据时预览完整界面
    const colors = ['#6366f1', '#8b5cf6', '#a78bfa', '#7c3aed', '#4f46e5', '#9333ea', '#6d28d9', '#5b21b6'];
    const sizes = [800, 800, 750, 800, 800, 750, 800, 800];
    state.images = colors.map((c, i) => ({
      url: svgDemoImage(c, `图 ${i + 1}`),
      width: sizes[i],
      height: sizes[i]
    }));
    state.pageTitle = '演示数据 · 图提取界面预览';
    state.pageUrl = 'imagegrab://demo';
    render();
    $('ig-source').textContent = '演示数据 · 界面预览（非真实提取结果）';
  }

  function svgDemoImage(color, label) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">` +
      `<rect width="800" height="800" fill="${color}"/>` +
      `<circle cx="400" cy="330" r="120" fill="rgba(255,255,255,0.25)"/>` +
      `<rect x="250" y="500" width="300" height="40" rx="20" fill="rgba(255,255,255,0.35)"/>` +
      `<text x="400" y="345" font-size="64" fill="#fff" text-anchor="middle" font-family="sans-serif">${label}</text>` +
      `</svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
})();
