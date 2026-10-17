# 图提取 ImageGrab · 电商图片下载插件

一个 Chrome Manifest V3 扩展：在**淘宝 / 天猫 / 京东 / 拼多多商家版**的商品详情页右下角注入「获取图片」悬浮按钮，一键提取页面内全部商品图片，在新标签页中集中预览、自由勾选，批量下载为 **PNG** 格式。

## 功能特性

- **一键提取**：自动触发懒加载滚动，扫描 `<img>`、`srcset`、`data-src` / `data-lazy-src` / `data-original` / `data-lazyload` 等懒加载属性、CSS `background-image`
- **智能过滤**：自动剔除图标、logo、占位图、1×1 像素图与小于 100×100 的图片；URL 自动补全绝对地址并去重
- **集中预览**：新标签页网格展示缩略图 + 真实尺寸
- **自由勾选**：全选 / 反选 / 已选计数
- **统一 PNG**：跨域图片在 Service Worker 中 `fetch + OffscreenCanvas` 转码
- **批量下载**：文件名自动编号 `商品图_001.png`，全程进度条提示，完成后给出结果反馈

## 文件结构

```
imagegrab/
├── manifest.json      # MV3 配置：权限、域名匹配、service worker、content script
├── content.js         # 注入按钮 + 图片提取
├── content.css        # 悬浮按钮样式（高优先级，防页面样式污染）
├── background.js      # Service Worker：消息转发、批量下载、PNG 转码、进度回推
├── gallery.html       # 画廊页骨架
├── gallery.css        # 画廊页样式
├── gallery.js         # 画廊页逻辑（渲染/勾选/下载/演示模式）
├── icons/             # 扩展图标 16/48/128
├── docs/              # 官方静态官网（GitHub Pages 发布源）
│   ├── index.html
│   ├── css/style.css
│   └── js/main.js
└── test/              # 自动化测试（puppeteer-core + Edge）
    ├── fixtures/product-mock.html   # 模拟电商详情页
    └── run-test.mjs                 # 端到端测试脚本
```

## 安装步骤

1. 下载本仓库并解压到本地文件夹（或 `git clone`）
2. 打开 Chrome / Edge，地址栏输入 `chrome://extensions` 回车
3. 打开右上角「**开发者模式**」开关
4. 点击「**加载已解压的扩展程序**」，选择本文件夹（`imagegrab/`）
5. 打开任意支持平台的商品详情页，右下角出现「获取图片」按钮即安装成功

## 使用方法

1. 在淘宝 / 天猫 / 京东 / 拼多多商家版的**商品详情页**等待页面加载完成
2. 点击右下角紫色悬浮按钮「**获取图片**」（插件会自动向下滚动触发懒加载）
3. 新标签页打开**图提取画廊**：网格展示全部提取到的商品图
4. 勾选需要的图片（支持全选 / 反选），点击「**下载选中**」
5. 观察顶部进度条，完成后按提示到浏览器默认下载目录查看 `商品图_001.png` 系列文件

## 技术要点

- **Manifest V3**：`activeTab / scripting / downloads / storage` 权限；`host_permissions` 覆盖五个电商平台域名
- **跨域转 PNG**：扩展页与 Service Worker 内 `fetch` 已授权域名不受 CORS 限制，`createImageBitmap` + `OffscreenCanvas` 完成转码；转换失败自动降级按原格式下载
- **平台兼容**：懒加载属性差异（`data-src` / `data-original` / `data-lazyload`）通过「遍历全部 `data-*` 属性 + 图片 URL 特征识别」统一兼容
- **防样式污染**：按钮全部样式 `!important` 且作用域限定在 `#imagegrab-fab` 内

## 测试

```bash
cd test
npm install
node run-test.mjs
```

自动化流程：加载扩展到 Edge（headless）→ 打开模拟商品页 → 点击「获取图片」→ 画廊渲染 → 全选下载 → 校验落盘的 PNG 文件名与数量。

## 官网

`docs/` 文件夹为插件官方静态网站（纯 HTML/CSS/JS，无外部依赖），通过 GitHub Pages 发布：

- 发布地址：`https://<你的用户名>.github.io/imagegrab/`
- 或本地点击 `docs/index.html` 直接预览
