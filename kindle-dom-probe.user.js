// ==UserScript==
// @name         Kindle Cloud Reader DOM Probe
// @namespace    mamiya.local.kcr-probe
// @version      1.0.0
// @description  Kindle Cloud Readerの描画要素と操作候補を調査（画像・本文は取得しない）
// @match        https://read.amazon.co.jp/*
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const HOST_ID = 'kcr-dom-probe-host';
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host{all:initial;position:fixed;right:12px;bottom:12px;
        z-index:2147483647;font:13px/1.5 system-ui,sans-serif;color:#fff}
      button{cursor:pointer;border:1px solid #727988;border-radius:7px;
        color:#fff;background:#334155;padding:8px 10px;font:inherit}
      button:hover{background:#475569}
      #panel{position:absolute;right:0;bottom:45px;width:min(460px,92vw);
        padding:12px;background:#101827;border:1px solid #64748b;
        border-radius:10px;box-shadow:0 5px 24px #0009}
      #panel[hidden]{display:none}
      #bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0}
      #status{color:#cbd5e1;font-size:12px;margin:6px 0}
      textarea{box-sizing:border-box;width:100%;height:min(45vh,360px);
        resize:vertical;background:#050b15;color:#d1fae5;border:1px solid #64748b;
        border-radius:6px;padding:8px;font:11px/1.4 monospace}
    </style>
    <button id="toggle" type="button">DOM調査</button>
    <section id="panel" hidden>
      <strong>Kindle Cloud Reader 構造調査</strong>
      <div id="bar">
        <button id="scan" type="button">現在ページを調査</button>
        <button id="copy" type="button">JSONコピー</button>
        <button id="close" type="button">閉じる</button>
      </div>
      <div id="status">本を開いてから「現在ページを調査」を押してください。</div>
      <textarea id="output" readonly spellcheck="false"
        aria-label="構造調査結果"></textarea>
    </section>`;
  (document.body || document.documentElement).appendChild(host);

  const $ = id => shadow.getElementById(id);
  const round = n => Math.round(Number(n) || 0);
  const clean = value => String(value || '').trim().slice(0, 80);
  const visible = (rect, view = window) => rect.width > 1 && rect.height > 1 &&
    rect.bottom > 0 && rect.right > 0 &&
    rect.top < view.innerHeight && rect.left < view.innerWidth;

  function nodePath(el) {
    const pieces = [];
    for (let node = el, i = 0; node && i < 5; i++) {
      const tag = node.tagName?.toLowerCase();
      if (!tag) break;
      const classes = [...(node.classList || [])].slice(0, 2)
        .map(c => '.' + clean(c).slice(0, 30)).join('');
      pieces.unshift(tag + classes);
      node = node.parentElement;
    }
    return pieces.join(' > ');
  }

  function sourceKind(img) {
    const url = img.currentSrc || img.getAttribute('src') || '';
    if (!url) return 'none';
    if (url.startsWith('data:')) return 'data:';
    if (url.startsWith('blob:')) return 'blob:';
    try { return new URL(url, img.baseURI).origin; }
    catch (_) { return 'unknown'; }
  }

  function inspectSurface(el, scope) {
    const rect = el.getBoundingClientRect();
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    const info = {
      kind: el.tagName.toLowerCase(), scope,
      path: nodePath(el),
      box: { x: round(rect.x), y: round(rect.y),
        width: round(rect.width), height: round(rect.height) },
      inViewport: visible(rect, el.ownerDocument.defaultView || window) &&
        style?.display !== 'none' &&
        style?.visibility !== 'hidden' && style?.opacity !== '0',
      intrinsic: el.tagName === 'CANVAS'
        ? { width: el.width, height: el.height }
        : { width: el.naturalWidth, height: el.naturalHeight },
    };
    if (el.tagName === 'IMG') {
      info.loaded = el.complete && el.naturalWidth > 0;
      info.srcOriginOrKind = sourceKind(el); // URL全体は出力しない
    }
    return info;
  }

  function inspectNavigation(el, scope) {
    const raw = el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      (el.matches('button,[role="button"]') ? el.textContent : '');
    const label = clean(raw);
    if (!label || String(raw).trim().length > 80 ||
      !/(次|前|ページ|めく|next|prev|page|forward|backward|^[<>←→›‹]+$)/i
        .test(label)) return null;
    const rect = el.getBoundingClientRect();
    return { scope, tag: el.tagName.toLowerCase(), label,
      path: nodePath(el),
      inViewport: visible(rect, el.ownerDocument.defaultView || window),
      box: {x:round(rect.x), y:round(rect.y),
        width:round(rect.width), height:round(rect.height)} };
  }

  function probe() {
    const MAX_NODES = 20000;
    const MAX_SURFACES = 500;
    const MAX_NAV = 100;
    let inspected = 0, shadowRoots = 0;
    let canvasCount = 0, imgCount = 0;
    const surfaces = [], navigation = [], frames = [];
    const docs = new WeakSet();

    function walk(root, scope, depth = 0) {
      if (!root || depth > 5 || inspected >= MAX_NODES) return;
      const doc = root.ownerDocument || root;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let el = root.nodeType === Node.ELEMENT_NODE
        ? root : walker.nextNode();
      while (el && inspected++ < MAX_NODES) {
        if (el !== host && !host.contains(el)) {
          if (el.tagName === 'CANVAS' || el.tagName === 'IMG') {
            if (el.tagName === 'CANVAS') canvasCount++;
            else imgCount++;
            if (surfaces.length < MAX_SURFACES) {
              surfaces.push(inspectSurface(el, scope));
            }
          }
          if (navigation.length < MAX_NAV &&
            el.matches?.('button,[role="button"],a[aria-label],a[title]')) {
            const nav = inspectNavigation(el, scope);
            if (nav) navigation.push(nav);
          }
          if (el.shadowRoot) {
            shadowRoots++;
            walk(el.shadowRoot, scope + ' / open-shadow', depth + 1);
          }
          if (el.tagName === 'IFRAME') {
            let child = null;
            try { child = el.contentDocument; } catch (_) {}
            frames.push({scope, accessible: !!child,
              box: {width:round(el.getBoundingClientRect().width),
                height:round(el.getBoundingClientRect().height)}});
            if (child?.documentElement && !docs.has(child)) {
              docs.add(child);
              walk(child.documentElement, scope + ' / iframe', depth + 1);
            }
          }
        }
        el = walker.nextNode();
      }
    }

    walk(document.documentElement, 'top');
    surfaces.sort((a, b) =>
      Number(b.inViewport) - Number(a.inViewport) ||
      b.box.width * b.box.height - a.box.width * a.box.height);

    return {
      probeVersion: '1.0.0', capturedAt: new Date().toISOString(),
      pageOrigin: location.origin, // 書籍タイトルや本文、ページURLは記録しない
      viewport: {width:innerWidth, height:innerHeight,
        devicePixelRatio:devicePixelRatio},
      capabilities: {
        directoryPicker: typeof showDirectoryPicker === 'function',
        secureContext: isSecureContext
      },
      counts: {scannedNodes:inspected, canvas:canvasCount, img:imgCount,
        openShadowRoots:shadowRoots, iframes:frames.length,
        limitedByNodeCap:inspected >= MAX_NODES,
        limitedBySurfaceCap:canvasCount + imgCount > MAX_SURFACES},
      surfaces: surfaces.slice(0, 100),
      pageControls: navigation.slice(0, 40),
      frames,
      note: 'Metadata only: no pixel reads, screenshots, book text or DRM access.'
    };
  }

  $('toggle').onclick = () => { $('panel').hidden = !$('panel').hidden; };
  $('close').onclick = () => { $('panel').hidden = true; };
  $('scan').onclick = () => {
    try {
      const result = probe();
      $('output').value = JSON.stringify(result, null, 2);
      $('status').textContent =
        `canvas ${result.counts.canvas}件 / img ${result.counts.img}件 / ` +
        `iframe ${result.counts.iframes}件。本文を1ページめくって再調査できます。`;
    } catch (e) {
      $('status').textContent = '調査失敗: ' + e.name + ' / ' + e.message;
    }
  };
  $('copy').onclick = async () => {
    if (!$('output').value) return;
    try {
      await navigator.clipboard.writeText($('output').value);
      $('status').textContent = '調査JSONをコピーしました。';
    } catch (_) {
      $('output').focus(); $('output').select();
      $('status').textContent = 'コピーを許可できませんでした。選択済みのJSONを手動コピーしてください。';
    }
  };
})();
