/* ============================================================
 * content.js —— 「图提取 ImageGrab」内容脚本
 * 职责：
 *   1. 在电商详情页右下角注入「获取图片」悬浮按钮；
 *   2. 点击后触发懒加载滚动，扫描页面全部商品图片；
 *   3. 过滤小图/占位图，去重补全 URL，交给 background 打开画廊页。
 * 兼容平台：淘宝 / 天猫 / 京东 / 拼多多商家版。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 0. 防止重复注入（SPA 软跳转不会重新执行，但保险起见） ---------- */
  if (window.__imagegrabInjected) return;
  window.__imagegrabInjected = true;

  /* 图片过滤阈值：宽或高小于该值视为图标/占位图 */
  const MIN_SIZE = 100;
  /* 单次提取的最大图片数，防止详情页超长导致内存暴涨 */
  const MAX_IMAGES = 300;

  const HOST_ID = 'imagegrab-fab';
  const BTN_HTML = `
    <button type="button" class="ig-btn" aria-label="提取本页商品图片">
      <span class="ig-spinner" aria-hidden="true"></span>
      <span class="ig-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="3"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
      </span>
      <span class="ig-text">获取图片</span>
    </button>`;

  /* ---------- 1. 注入悬浮按钮 ---------- */
  function injectButton() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.innerHTML = BTN_HTML;
    (document.body || document.documentElement).appendChild(host);
    host.querySelector('.ig-btn').addEventListener('click', onExtractClick);
  }

  /* 页面 body 可能很晚才出现，双保险 */
  if (document.body) {
    injectButton();
  } else {
    document.addEventListener('DOMContentLoaded', injectButton);
  }

  /* ---------- 2. 懒加载触发：匀速滚完整个页面再滚回顶部 ---------- */
  async function triggerLazyLoad() {
    const step = Math.max(window.innerHeight * 0.8, 400);
    const total = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    let y = 0;
    while (y < total && y < 20000) {
      window.scrollTo(0, y);
      await sleep(120); // 等待 data-src 等懒加载属性生效
      y += step;
    }
    window.scrollTo(0, 0);
    await sleep(150);
  }

  /* ---------- 3. URL 收集：img / srcset / data-* / 背景图 ---------- */

  /** 判断一个字符串是不是疑似图片地址（用于扫描 data-* 属性，兼容各平台懒加载命名差异） */
  function looksLikeImageUrl(value) {
    if (!value || typeof value !== 'string') return false;
    const v = value.trim();
    if (/^https?:\/\//i.test(v) || v.startsWith('//')) {
      return /\.(jpe?g|png|webp|gif|bmp|avif)(\?|#|$)/i.test(v) || /alicdn|jdcloud|360buyimg|pddpic|yangkeduo/i.test(v);
    }
    return false;
  }

  /** 把协议相对路径 / 相对路径统一补全为绝对地址，并做基础过滤 */
  function toAbsolute(raw) {
    if (!raw) return null;
    let v = String(raw).trim();
    if (!v || v.startsWith('blob:') || v.startsWith('about:')) return null;
    if (v.startsWith('data:image/svg')) return null; // SVG 占位图不要
    try {
      const abs = new URL(v, location.href).href;
      return /^https?:|^data:image\//i.test(abs) ? abs : null;
    } catch (e) {
      return null;
    }
  }

  /** 解析 srcset 字符串："url 1x, url2 2x" / "url 400w, url2 800w" */
  function pushSrcset(urls, srcset) {
    if (!srcset) return;
    srcset.split(',').forEach((pair) => {
      const url = pair.trim().split(/\s+/)[0];
      const abs = toAbsolute(url);
      if (abs) urls.add(abs);
    });
  }

  /** 扫描整页，返回去重后的绝对 URL 集合 */
  function collectImageUrls() {
    const urls = new Set();

    document.querySelectorAll('img').forEach((img) => {
      pushSrcset(urls, img.currentSrc || img.src);
      pushSrcset(urls, img.srcset || img.getAttribute('srcset'));
      // 兼容各平台懒加载属性：data-src / data-lazy-src / data-original / data-lazyload 等
      for (const attr of img.attributes) {
        if (attr.name.startsWith('data-') && looksLikeImageUrl(attr.value)) {
          const abs = toAbsolute(attr.value);
          if (abs) urls.add(abs);
        }
      }
    });

    // 背景图（京东部分楼层用 background-image 展示商品图）
    document.querySelectorAll('*').forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') return;
      const re = /url\(["']?([^"')]+)["']?\)/g;
      let m;
      while ((m = re.exec(bg))) {
        const abs = toAbsolute(m[1]);
        if (abs) urls.add(abs);
      }
    });

    return [...urls];
  }

  /* ---------- 4. 尺寸过滤：加载图片读取真实宽高，剔除小图 ---------- */
  function probeImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => {
        img.src = ''; // 触发 onerror 收尾，避免悬挂
        resolve(null);
      }, 8000);
      img.onload = () => {
        clearTimeout(timer);
        resolve({ url, width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve(null); // 加载失败的图直接丢弃
      };
      img.src = url;
    });
  }

  async function filterImages(urls) {
    // 并发探测，但限制并发数，避免一次性几百个请求把页面卡死
    const results = [];
    const POOL = 12;
    let cursor = 0;
    async function worker() {
      while (cursor < urls.length && results.length < MAX_IMAGES) {
        const url = urls[cursor++];
        const info = await probeImage(url);
        // 只保留宽和高都 >= 阈值的图（自然过滤 1x1 像素图、图标、logo）
        if (info && info.width >= MIN_SIZE && info.height >= MIN_SIZE) {
          results.push(info);
        }
      }
    }
    await Promise.all(Array.from({ length: POOL }, worker));
    return results;
  }

  /* ---------- 5. 点击流程：滚动 → 收集 → 过滤 → 发给扩展 ---------- */
  async function onExtractClick() {
    const btn = document.querySelector('#' + HOST_ID + ' .ig-btn');
    const text = btn && btn.querySelector('.ig-text');
    if (btn.classList.contains('ig-loading')) return;

    btn.classList.add('ig-loading');
    if (text) text.textContent = '提取中…';

    try {
      await triggerLazyLoad();
      const urls = collectImageUrls();
      const images = await filterImages(urls);

      chrome.runtime.sendMessage({
        type: 'IMAGES_EXTRACTED',
        payload: {
          pageUrl: location.href,
          pageTitle: document.title,
          images: images
        }
      });
    } catch (err) {
      console.error('[ImageGrab] 提取失败：', err);
    } finally {
      btn.classList.remove('ig-loading');
      if (text) text.textContent = '获取图片';
    }
  }
})();
