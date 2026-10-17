/* ============================================================
 * main.js —— 图提取官网交互脚本
 * 1. 导航栏滚动阴影
 * 2. 移动端汉堡菜单开合
 * 3. IntersectionObserver 滚动入场动画
 * 4. 滚动监听导航高亮（scrollspy）
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 1. 导航栏滚动阴影 ---------- */
  var navbar = document.getElementById('navbar');
  function onScrollBar() {
    navbar.classList.toggle('scrolled', window.scrollY > 8);
  }
  window.addEventListener('scroll', onScrollBar, { passive: true });
  onScrollBar();

  /* ---------- 2. 移动端汉堡菜单 ---------- */
  var toggle = document.getElementById('nav-toggle');
  var links = document.getElementById('nav-links');

  toggle.addEventListener('click', function () {
    var open = links.classList.toggle('open');
    toggle.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '收起菜单' : '展开菜单');
  });

  // 点击菜单项后自动收起（移动端）
  links.addEventListener('click', function (e) {
    if (e.target.closest('a') && links.classList.contains('open')) {
      links.classList.remove('open');
      toggle.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });

  /* ---------- 3. 滚动入场动画 ---------- */
  var revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target); // 只播一次
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    // 老浏览器兜底：直接显示
    revealEls.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- 4. 滚动监听导航高亮 ---------- */
  var spyLinks = document.querySelectorAll('[data-spy]');
  var sections = [];
  spyLinks.forEach(function (a) {
    var sec = document.getElementById(a.getAttribute('data-spy'));
    if (sec) sections.push({ link: a, sec: sec });
  });

  function onScrollSpy() {
    // 以视口 1/3 处为判定线，取最后一个越过判定线的区块
    var line = window.scrollY + window.innerHeight / 3;
    var current = null;
    sections.forEach(function (item) {
      if (item.sec.offsetTop <= line) current = item;
    });
    sections.forEach(function (item) {
      item.link.classList.toggle('active', item === current);
    });
  }
  window.addEventListener('scroll', onScrollSpy, { passive: true });
  window.addEventListener('resize', onScrollSpy);
  onScrollSpy();
})();
