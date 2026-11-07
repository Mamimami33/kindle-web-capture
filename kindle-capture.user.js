// ==UserScript==
// @name         Kindle Web Page Capture
// @namespace    local.kindle-capture
// @version      1.0.0
// @description  Capture the currently displayed Kindle Web page image as PNG, one page or sequentially.
// @match        https://read.amazon.co.jp/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const MAX_PAGES = 1500;
  const MIN_INTERVAL_MS = 800;
  const CHANGE_TIMEOUT_MS = 30_000;
  const POLL_MS = 150;
  const PANEL_ID = 'kindle-capture-panel';
  if (document.getElementById(PANEL_ID)) return;

  const session = { running: false, stopping: false, saved: 0, page: 1, abort: null };

  const panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.setAttribute('aria-label', 'Kindle ページキャプチャ');
  panel.innerHTML = `
    <style>
      #${PANEL_ID}{position:fixed;right:14px;bottom:14px;z-index:2147483647;
        width:min(290px,calc(100vw - 28px));box-sizing:border-box;padding:14px;
        color:#f4f4f5;background:#1b1d24f5;border:1px solid #676b78;
        border-radius:12px;box-shadow:0 5px 22px #0008;
        font:13px/1.55 system-ui,-apple-system,sans-serif}
      #${PANEL_ID} *{box-sizing:border-box}
      #${PANEL_ID} h2{font-size:15px;margin:0 0 10px;font-weight:700}
      #${PANEL_ID} label{display:flex;align-items:center;gap:8px;margin-bottom:10px}
      #${PANEL_ID} input{width:95px;min-height:32px;padding:3px 7px;
        color:#fff;background:#303541;border:1px solid #858996;border-radius:6px}
      #${PANEL_ID} .kc-buttons{display:flex;flex-wrap:wrap;gap:6px}
      #${PANEL_ID} button{min-height:34px;cursor:pointer;padding:5px 9px;
        color:#fff;background:#334b75;border:1px solid #8290a7;border-radius:6px;
        font:inherit;font-weight:600}
      #${PANEL_ID} button.kc-stop{background:#70363c}
      #${PANEL_ID} button:disabled{opacity:.45;cursor:not-allowed}
      #${PANEL_ID} .kc-status{white-space:pre-wrap;overflow-wrap:anywhere;
        margin-top:10px;padding:8px;background:#0e1017;border-radius:6px;min-height:54px}
    </style>
    <h2>Kindle Web キャプチャ</h2>
    <label>開始ページ番号 <input class="kc-start" type="number" min="1" max="9999999" step="1" value="1"></label>
    <div class="kc-buttons">
      <button type="button" class="kc-test">1ページだけテスト</button>
      <button type="button" class="kc-all">全ページ開始</button>
      <button type="button" class="kc-stop" disabled>停止</button>
    </div>
    <div class="kc-status" role="status" aria-live="polite">保存済み: 0ページ\n状態: 待機中（本の先頭ページを表示してください）</div>
  `;
  document.body.appendChild(panel);

  const startInput = panel.querySelector('.kc-start');
  const testButton = panel.querySelector('.kc-test');
  const allButton = panel.querySelector('.kc-all');
  const stopButton = panel.querySelector('.kc-stop');
  const status = panel.querySelector('.kc-status');

  function report(message) {
    status.textContent = `保存済み: ${session.saved}ページ\n現在: page_${String(session.page).padStart(4, '0')}.png\n状態: ${message}`;
  }

  function updateButtons() {
    testButton.disabled = session.running;
    allButton.disabled = session.running;
    startInput.disabled = session.running;
    stopButton.disabled = !session.running || session.stopping;
  }

  function aborted(signal) {
    if (signal.aborted) throw new DOMException('停止要求', 'AbortError');
  }

  function delay(ms, signal) {
    aborted(signal);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('停止要求', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function visibleArea(img) {
    if (!img || !img.isConnected) return 0;
    const style = getComputedStyle(img);
    if (style.visibility === 'hidden' || style.display === 'none') return 0;
    const r = img.getBoundingClientRect();
    const w = Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left));
    const h = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
    return w * h;
  }

  function largestVisible(selector) {
    let chosen = null, area = 0;
    for (const img of document.querySelectorAll(selector)) {
      const score = visibleArea(img);
      if (score > area) { chosen = img; area = score; }
    }
    return chosen;
  }

  function activeImage() {
    return largestVisible('div.kg-full-page-img > img') || largestVisible('img');
  }

  function imageUrl(img) {
    return img?.getAttribute('src') || img?.currentSrc || img?.src || '';
  }

  function imageReady(img) {
    return !!(img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0 && imageUrl(img));
  }

  async function waitForInitialImage(signal) {
    const until = performance.now() + CHANGE_TIMEOUT_MS;
    while (performance.now() < until) {
      aborted(signal);
      const img = activeImage();
      if (imageReady(img)) return img;
      await delay(POLL_MS, signal);
    }
    throw new Error('本文画像が30秒以内に読み込まれませんでした');
  }

  function nextButton() {
    const selectors = [
      'div.kr-chevron-container-left button.chevron.round[aria-label="次のページ"]',
      'div.kr-chevron-container-left button[aria-label="次のページ"]',
      'button[aria-label="次のページ"]'
    ];
    for (const selector of selectors) {
      for (const button of document.querySelectorAll(selector)) {
        if (!button.isConnected || button.disabled ||
            button.getAttribute('aria-disabled') === 'true') continue;
        const style = getComputedStyle(button);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            button.getClientRects().length === 0) continue;
        return button;
      }
    }
    return null;
  }

  async function waitForChangedImage(previousUrl, signal) {
    const until = performance.now() + CHANGE_TIMEOUT_MS;
    let newSourceSeen = false;
    while (performance.now() < until) {
      aborted(signal);
      const img = activeImage();
      const url = imageUrl(img);
      if (url && url !== previousUrl) {
        newSourceSeen = true;
        if (imageReady(img)) return { img };
      }
      await delay(POLL_MS, signal);
    }
    return { timeout: true, newSourceSeen };
  }

  async function advance(previousUrl, signal) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      aborted(signal);
      const button = nextButton();
      if (!button) return { end: true, reason: '次ページボタンがありません／無効です' };
      report(`次ページへ移動中（${attempt}/2回目）`);
      button.click();
      const outcome = await waitForChangedImage(previousUrl, signal);
      if (outcome.img) return outcome;
      if (outcome.newSourceSeen) {
        throw new Error('画像srcは変わりましたが、30秒以内に読み込みが完了しませんでした');
      }
      if (!nextButton()) return { end: true, reason: '次ページボタンが無効になりました' };
    }
    throw new Error('次ページを2回押しても画像srcが変わりませんでした（各30秒待機）');
  }

  async function pngBlobForImage(img, signal) {
    aborted(signal);
    const url = imageUrl(img);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`画像取得がHTTP ${response.status}で失敗しました`);
    const blob = await response.blob();
    aborted(signal);
    if (!blob.size) throw new Error('画像Blobが空です');
    const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const isPng = signature.length === 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => signature[i] === b);
    if (isPng) return blob;
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
      aborted(signal);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2Dを作成できません');
      ctx.drawImage(bitmap, 0, 0);
      const png = await new Promise((resolve, reject) => canvas.toBlob(
        b => b ? resolve(b) : reject(new Error('PNGへの変換に失敗しました')), 'image/png'
      ));
      aborted(signal);
      return png;
    } finally {
      bitmap?.close();
    }
  }

  async function pngHash(blob, signal) {
    const bytes = await blob.arrayBuffer();
    aborted(signal);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    aborted(signal);
    return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  }

  async function writePng(dir, page, blob, signal) {
    aborted(signal);
    const filename = `page_${String(page).padStart(4, '0')}.png`;
    const handle = await dir.getFileHandle(filename, { create: true });
    aborted(signal);
    const writer = await handle.createWritable();
    let closed = false;
    try {
      aborted(signal);
      await writer.write(blob);
      aborted(signal);
      await writer.close();
      closed = true;
    } finally {
      if (!closed) {
        try { await writer.abort(); } catch (_) { /* preserve original error */ }
      }
    }
  }

  async function capture(dir, startPage, single, signal) {
    let previousHash = null;
    let image = await waitForInitialImage(signal);
    let lastCompleteAt = performance.now();
    for (let count = 0; count < MAX_PAGES; count++) {
      aborted(signal);
      session.page = startPage + count;
      report('画像の取得・PNG化中');
      const currentUrl = imageUrl(image);
      const png = await pngBlobForImage(image, signal);
      const hash = await pngHash(png, signal);
      if (imageUrl(image) !== currentUrl) {
        throw new Error('保存準備中にページ画像のsrcが切り替わりました');
      }
      if (hash === previousHash) {
        report('完了：直前ページと画像ハッシュが一致しました（重複画像は保存していません）');
        return;
      }
      aborted(signal);
      report('フォルダに保存中');
      await writePng(dir, session.page, png, signal);
      session.saved++;
      previousHash = hash;
      report(`保存しました（${png.size.toLocaleString()} バイト）`);
      if (single) { report('テスト完了：1ページ保存しました'); return; }
      if (session.saved >= MAX_PAGES) {
        report(`安全上限の${MAX_PAGES}ページに達したため停止しました`);
        return;
      }
      if (!nextButton()) { report('完了：最終ページ（次ページボタンがありません／無効です）'); return; }
      await delay(Math.max(0, MIN_INTERVAL_MS - (performance.now() - lastCompleteAt)), signal);
      aborted(signal);
      const next = await advance(currentUrl, signal);
      if (next.end) { report(`完了：${next.reason}`); return; }
      image = next.img;
      lastCompleteAt = performance.now();
      if (!imageReady(image)) throw new Error('次ページの画像の読み込み状態が不正です');
    }
  }

  function stop() {
    if (!session.running || session.stopping) return;
    session.stopping = true;
    session.abort?.abort();
    updateButtons();
    report('停止処理中…');
  }

  function start(single) {
    if (session.running) return;
    const page = Number(startInput.value);
    if (!Number.isSafeInteger(page) || page < 1 || page > 9999999) {
      report('エラー：開始ページ番号は1〜9999999の整数にしてください');
      return;
    }
    if (!window.showDirectoryPicker) {
      report('エラー：showDirectoryPicker非対応です。Chrome/Edgeの安全なコンテキストで実行してください');
      return;
    }
    let picker;
    try { picker = window.showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e) { report(`保存先の選択に失敗しました：${e.message}`); return; }
    session.running = true;
    session.stopping = false;
    session.saved = 0;
    session.page = page;
    session.abort = new AbortController();
    const signal = session.abort.signal;
    updateButtons();
    report('保存先フォルダを選択中');
    void (async () => {
      try {
        const dir = await picker;
        aborted(signal);
        report('本文画像を確認中');
        await capture(dir, page, single, signal);
      } catch (e) {
        if (signal.aborted || e.name === 'AbortError') {
          report(session.stopping ? '停止しました' : 'フォルダ選択をキャンセルしました');
        } else {
          report(`エラー（${session.page}ページ目）：${e.message || String(e)}`);
          console.error('[Kindle Capture]', e);
        }
      } finally {
        session.running = false;
        session.stopping = false;
        session.abort = null;
        updateButtons();
      }
    })();
  }

  testButton.addEventListener('click', () => start(true));
  allButton.addEventListener('click', () => start(false));
  stopButton.addEventListener('click', stop);
})();
