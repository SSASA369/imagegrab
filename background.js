/* ============================================================
 * background.js —— Service Worker（MV3）
 * 职责：
 *   1. 接收 content.js 提取到的图片列表，写入 storage.session；
 *   2. 打开 gallery.html 画廊页集中展示；
 *   3. 执行批量下载：跨域图片 fetch → 转 PNG → chrome.downloads，
 *      全程向画廊页推送进度，完成后反馈结果。
 * ============================================================ */

const STORE_KEY = 'imagegrab:lastResult';
const GALLERY_URL = 'gallery.html';

/* ---------- 消息路由 ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'IMAGES_EXTRACTED': {
      // 保存结果（service worker 随时可能被回收，storage.session 可在本次浏览会话内持久）
      chrome.storage.session
        .set({ [STORE_KEY]: msg.payload })
        .then(() => chrome.tabs.create({ url: chrome.runtime.getURL(GALLERY_URL) }));
      return false;
    }

    case 'GALLERY_READY': {
      // 画廊页上线登记（sender.tab.id 可用于精准回推消息）
      sendResponse({ ok: true, tabId: sender.tab ? sender.tab.id : null });
      return false;
    }

    case 'DOWNLOAD_BATCH': {
      // 画廊页请求批量下载
      handleBatchDownload(msg.items || [], sender.tab ? sender.tab.id : null);
      return false;
    }

    default:
      return false;
  }
});

/* 向画廊页推送消息（标签页可能已被用户关闭，失败静默忽略） */
function notifyGallery(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

/* ---------- 核心：批量下载 ---------- */
async function handleBatchDownload(items, tabId) {
  const total = items.length;
  let completed = 0;
  let failed = 0;

  notifyGallery(tabId, { type: 'IG_START', total });

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      // 跨域 fetch + 转 PNG 在 SW 中完成（依赖 host_permissions 绕过 CORS）
      const dataUrl = await toPngDataUrl(item.url);
      /* 转码成功后把 dataURL 回传画廊页，由页面用 <a download> 落盘：
         实测 Edge 会忽略 chrome.downloads.download 的 filename 选项（统一存成
         download.png 并互相覆盖），而锚点 download 属性可保证「商品图_序号.png」
         命名正确；Chrome 中两种方式均正常。 */
      notifyGallery(tabId, {
        type: 'IG_ITEM',
        seq: i + 1,
        total,
        dataUrl,
        filename: item.filename,
        ok: true
      });
      completed += 1;
    } catch (err) {
      console.warn('[ImageGrab] PNG 转换失败，降级按原格式下载：', item.url, err);
      try {
        // 降级策略：用 chrome.downloads 直接保存原图（保留原扩展名）
        await chrome.downloads.download({
          url: item.url,
          filename: item.filename.replace(/\.png$/, guessExt(item.url)),
          saveAs: false
        });
        notifyGallery(tabId, { type: 'IG_ITEM', seq: i + 1, total, ok: true, fallback: true });
        completed += 1;
      } catch (err2) {
        notifyGallery(tabId, { type: 'IG_ITEM', seq: i + 1, total, ok: false });
        failed += 1;
      }
    }
  }

  notifyGallery(tabId, { type: 'IG_DONE', completed, failed, total });
}

/* ---------- 工具：跨域图片 → PNG dataURL ---------- */
async function toPngDataUrl(url) {
  // 声明了 host_permissions 后，扩展内 fetch 电商域名不受 CORS 限制
  const resp = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob);
  // Service Worker 中没有 DOM canvas，使用 OffscreenCanvas
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(pngBlob);
}

/* blob → dataURL（Service Worker 中没有 FileReader，用 arrayBuffer + btoa 实现） */
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000; // 分块 String.fromCharCode，避免爆栈
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:image/png;base64,' + btoa(binary);
}

/* 从 URL 猜测扩展名（降级下载时保持原格式） */
function guessExt(url) {
  const m = /\.(jpe?g|png|webp|gif|bmp|avif)(\?|#|$)/i.exec(url);
  const ext = m ? m[1].toLowerCase() : 'jpg';
  return ext === 'jpeg' ? '.jpg' : '.' + ext;
}
