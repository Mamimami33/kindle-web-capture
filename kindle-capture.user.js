// ==UserScript==
// @name         Kindle Web Page Capture
// @namespace    local.kindle-capture
// @version      1.0.2
// @description  Kindle Webの本文画像をPNGとして保存する（Canvas優先・ページ送り複合方式）
// @author       local
// @match        https://read.amazon.co.jp/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const MAX_PAGES = 1500;
  const WAIT_BASE_MS = 800;
  const PROGRESS_TOTAL = MAX_PAGES;
  const START_PAGE_DEFAULT = 1;
  const ADVANCE_TOTAL_TIMEOUT_MS = 60000;
  const ADVANCE_STRATEGY_TIMEOUT_MS = 12000;

  const NEXT_SELECTORS = [
    'div.kr-chevron-container-left button.chevron.round',
    '.kr-chevron-container-left button.chevron',
    '[aria-label="次のページ"]',
    '[aria-label="Next page"]',
  ];

  function fnv1aHash(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function sameErrorMessage(err) {
    if (!err) return 'unknown error';
    if (err && err.message) return err.message;
    return String(err);
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'kindle-capture-panel';
    panel.style.cssText = [
      'position: fixed',
      'right: 16px',
      'bottom: 16px',
      'z-index: 2147483647',
      'background: rgba(255,255,255,0.97)',
      'border: 1px solid #999',
      'border-radius: 8px',
      'padding: 10px',
      'width: 260px',
      'font: 12px/1.5 system-ui, sans-serif',
      'color: #111',
      'box-shadow: 0 4px 16px rgba(0,0,0,0.25)',
    ].join(';');
    panel.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">Kindle Web Capture v1.0.2</div>' +
      '<div>開始番号: <input id="kc-start-page" type="number" min="1" value="1" style="width:64px"></div>' +
      '<div id="kc-status" style="margin:6px 0;min-height:36px">待機中</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '<button id="kc-test-one" type="button">1ページだけテスト</button>' +
      '<button id="kc-start-all" type="button">全ページ開始</button>' +
      '<button id="kc-stop" type="button">停止</button>' +
      '</div>';
    document.body.appendChild(panel);
    return panel;
  }

  const panel = createPanel();
  const statusEl = panel.querySelector('#kc-status');
  const startInput = panel.querySelector('#kc-start-page');
  const testBtn = panel.querySelector('#kc-test-one');
  const startBtn = panel.querySelector('#kc-start-all');
  const stopBtn = panel.querySelector('#kc-stop');

  let stopRequested = false;
  let activeSession = false;

  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.style.color = isError ? '#b00020' : '#111';
  }

  function pickImageElement() {
    const primary = document.querySelector('div.kg-full-page-img > img');
    if (primary) return primary;
    const imgs = Array.from(document.querySelectorAll('img'))
      .filter(img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
    if (imgs.length === 0) return null;
    imgs.sort((a, b) => {
      const areaA = a.naturalWidth * a.naturalHeight;
      const areaB = b.naturalWidth * b.naturalHeight;
      if (areaB !== areaA) return areaB - areaA;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    return imgs[0];
  }

  async function waitForTargetImage() {
    const deadline = Date.now() + 10000;
    for (;;) {
      const img = pickImageElement();
      if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
        return img;
      }
      if (Date.now() > deadline) return null;
      await sleep(100);
    }
  }

  function isSupportedImageUrl(src) {
    return /\.(png|jpe?g|webp|gif)(\?|$)/i.test(src);
  }

  async function pngBlobForCanvas(img) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const cx = canvas.getContext('2d');
    if (!cx) {
      throw new Error('2d context が取得できませんでした');
    }
    cx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(b => {
        if (b) resolve(b);
        else reject(new Error('toBlob() が null を返しました'));
      }, 'image/png');
    });
    return blob;
  }

  async function pngBlobForImageFetch(img, src) {
    const res = await fetch(src, { mode: 'cors', credentials: 'same-origin' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const blob = await res.blob();
    if (!blob || blob.size === 0) {
      throw new Error('空のBlobが返されました');
    }
    if (blob.type === 'image/png') return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const cx = canvas.getContext('2d');
    if (!cx) {
      throw new Error('2d context が取得できませんでした');
    }
    cx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
    const png = await new Promise((resolve, reject) => {
      canvas.toBlob(b => {
        if (b) resolve(b);
        else reject(new Error('toBlob() が null を返しました'));
      }, 'image/png');
    });
    return png;
  }

  async function pngBlobForImage() {
    const current = await waitForTargetImage();
    if (!current) {
      return null;
    }
    const url = new URL(current.src, location.href);
    const isBlob = url.protocol === 'blob:';
    if (isBlob || !isSupportedImageUrl(url.pathname)) {
      // blob: は CSP の connect-src で fetch が弾かれるため、表示中の <img> を Canvas へ直接描画する。
      try {
        const blob = await pngBlobForCanvas(current);
        const currentAfter = pickImageElement();
        if (!currentAfter || currentAfter.src !== current.src) {
          throw new Error('PNG生成中に画像が切り替わりました');
        }
        return {
          blob,
          hash: fnv1aHash(new Uint8Array(await blob.arrayBuffer())),
          source: 'canvas',
        };
      } catch (drawErr) {
        let fetchErr = null;
        try {
          const blob = await pngBlobForImageFetch(current, current.src);
          const currentAfter = pickImageElement();
          if (!currentAfter || currentAfter.src !== current.src) {
            throw new Error('PNG生成中に画像が切り替わりました');
          }
          return {
            blob,
            hash: fnv1aHash(new Uint8Array(await blob.arrayBuffer())),
            source: 'fallback fetch',
          };
        } catch (fetchError) {
          fetchErr = fetchError;
        }
        throw new Error(
          `画像の取得に失敗しました。Canvas描画: ${sameErrorMessage(drawErr)} / fetch: ${sameErrorMessage(fetchErr)}`
        );
      }
    }
    return null;
  }

  function pad(n, len) {
    return String(n).padStart(len, '0');
  }

  let dirHandle = null;

  async function captureOnePage(pageNo, ctx) {
    if (stopRequested) {
      return { ok: false, stopped: true };
    }
    let result;
    try {
      result = await pngBlobForImage();
    } catch (err) {
      const msg = sameErrorMessage(err);
      setStatus(`エラー（${pageNo}ページ目）: ${msg}（source: canvas→fetch）`, true);
      return { ok: false, error: err };
    }
    if (stopRequested) {
      return { ok: false, stopped: true };
    }
    if (!result) {
      setStatus(`エラー（${pageNo}ページ目）: 画像が見つかりません`, true);
      return { ok: false, error: new Error('画像が見つかりません') };
    }
    const { blob, hash, source } = result;
    if (ctx.lastHash === hash) {
      setStatus(`完了: ${ctx.saved}ページ保存しました（重複画像で終了）`, false);
      return { ok: false, duplicate: true };
    }
    if (stopRequested) {
      return { ok: false, stopped: true };
    }
    try {
      dirHandle = dirHandle || await window.showDirectoryPicker();
      const fileName = `page_${pad(pageNo, 4)}.png`;
      const fh = await dirHandle.getFileHandle(fileName, { create: true });
      const writable = await fh.createWritable();
      await writable.write(blob);
      await writable.close();
      ctx.lastHash = hash;
      return { ok: true, pageNo, fileName, source };
    } catch (err) {
      const msg = sameErrorMessage(err);
      if (err && err.name === 'AbortError') {
        setStatus(`フォルダ選択がキャンセルされました（${pageNo}ページ目）`, true);
      } else {
        setStatus(`保存エラー（${pageNo}ページ目）: ${msg}`, true);
      }
      return { ok: false, error: err };
    }
  }

  // ---- ページ送り（v1.0.2: 複合方式・上限時間つき・経過表示つき） ----

  function findNextButton() {
    for (const sel of NEXT_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  const fpCanvas = document.createElement('canvas');
  fpCanvas.width = 24;
  fpCanvas.height = 24;

  function sampleFingerprint(img) {
    try {
      if (!img || !img.complete || img.naturalWidth === 0) return null;
      const cx = fpCanvas.getContext('2d', { willReadFrequently: true });
      if (!cx) return null;
      cx.drawImage(img, 0, 0, 24, 24);
      const data = cx.getImageData(0, 0, 24, 24).data;
      return fnv1aHash(data);
    } catch (e) {
      return null;
    }
  }

  function currentPageState() {
    const img = pickImageElement();
    if (!img) return null;
    return { src: img.src, fp: sampleFingerprint(img) };
  }

  function fireMouse(el, type, x, y) {
    if (!el) return;
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, button: 0,
    }));
  }

  function hoverLeftEdge() {
    const x = 24;
    const y = Math.floor(window.innerHeight / 2);
    const el = document.elementFromPoint(x, y) || document.body;
    fireMouse(el, 'mouseover', x, y);
    fireMouse(el, 'mousemove', x, y);
    const container = document.querySelector('.kr-chevron-container-left');
    if (container) {
      const r = container.getBoundingClientRect();
      const cx = Math.floor(r.left + r.width / 2);
      const cy = Math.floor(r.top + r.height / 2);
      fireMouse(container, 'mouseover', cx, cy);
      fireMouse(container, 'mousemove', cx, cy);
    }
  }

  function clickLeftZone() {
    const x = Math.max(16, Math.floor(window.innerWidth * 0.05));
    const y = Math.floor(window.innerHeight / 2);
    const el = document.elementFromPoint(x, y) || document.body;
    fireMouse(el, 'mousedown', x, y);
    fireMouse(el, 'mouseup', x, y);
    fireMouse(el, 'click', x, y);
  }

  function sendArrowLeft() {
    const opts = {
      key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, which: 37,
      bubbles: true, cancelable: true,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (document.body) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', opts));
      document.body.dispatchEvent(new KeyboardEvent('keyup', opts));
    }
  }

  async function waitForPageChange(prev, timeoutMs, pageNo, label, advanceStart) {
    const start = Date.now();
    let lastStatusSec = -1;
    for (;;) {
      if (stopRequested) return { changed: false, stopped: true };
      const now = Date.now();
      const elapsedTotal = Math.floor((now - advanceStart) / 1000);
      if (elapsedTotal !== lastStatusSec) {
        lastStatusSec = elapsedTotal;
        setStatus(`ページ送り中… ${pageNo}ページ目の次へ（${label}、経過${elapsedTotal}秒）`, false);
      }
      const cur = currentPageState();
      if (cur) {
        const srcChanged = cur.src !== prev.src;
        const fpChanged = prev.fp && cur.fp && cur.fp !== prev.fp;
        if (srcChanged || fpChanged) {
          return { changed: true };
        }
      }
      if (now - start >= timeoutMs) return { changed: false };
      await sleep(250);
    }
  }

  async function loadNextPage(prev, pageNo) {
    const advanceStart = Date.now();
    const history = [];
    const remaining = () => ADVANCE_TOTAL_TIMEOUT_MS - (Date.now() - advanceStart);

    const strategies = [
      {
        name: 'ボタン',
        run: async () => {
          hoverLeftEdge();
          await sleep(600);
          const btn = findNextButton();
          if (!btn) return 'skip';
          if (btn.disabled) return 'disabled';
          btn.click();
          return 'acted';
        },
      },
      {
        name: '左端クリック',
        run: async () => { clickLeftZone(); return 'acted'; },
      },
      {
        name: '←キー',
        run: async () => { sendArrowLeft(); return 'acted'; },
      },
    ];

    for (const st of strategies) {
      if (stopRequested) return { ok: false, reason: 'stopped', history };
      if (remaining() <= 0) break;
      let acted;
      try {
        acted = await st.run();
      } catch (e) {
        history.push(`${st.name}: 例外`);
        continue;
      }
      if (acted === 'skip') { history.push(`${st.name}: なし`); continue; }
      if (acted === 'disabled') { history.push(`${st.name}: 無効`); continue; }
      const waitMs = Math.min(ADVANCE_STRATEGY_TIMEOUT_MS, remaining());
      const res = await waitForPageChange(prev, waitMs, pageNo, st.name, advanceStart);
      if (res.stopped) return { ok: false, reason: 'stopped', history };
      if (res.changed) {
        history.push(`${st.name}: 成功`);
        return { ok: true, via: st.name, history };
      }
      history.push(`${st.name}: 変化なし`);
    }
    return { ok: false, reason: 'no-change', history };
  }

  async function runCapture(startNo, testOne) {
    if (activeSession) return;
    activeSession = true;
    stopRequested = false;
    const ctx = { lastHash: null, saved: 0 };
    let pageNo = startNo;
    try {
      for (;;) {
        if (stopRequested) {
          setStatus(`停止しました: ${ctx.saved}ページ保存しました`, false);
          break;
        }
        if (pageNo - startNo + 1 > MAX_PAGES) {
          setStatus(`上限（${MAX_PAGES}ページ）に達しました: ${ctx.saved}ページ保存しました`, false);
          break;
        }
        setStatus(`保存中… ${pageNo}ページ目（保存済み ${ctx.saved}ページ / 上限${PROGRESS_TOTAL}ページ）`, false);
        const res = await captureOnePage(pageNo, ctx);
        if (res.stopped) {
          setStatus(`停止しました: ${ctx.saved}ページ保存しました`, false);
          break;
        }
        if (res.duplicate) {
          break;
        }
        if (!res.ok) {
          break;
        }
        ctx.saved++;
        if (testOne) {
          setStatus(`テスト完了: ${res.fileName} を保存しました（${res.source}）`, false);
          break;
        }
        setStatus(`保存済み ${ctx.saved}ページ / 上限${PROGRESS_TOTAL}ページ（次ページへ移動中…）`, false);
        await sleep(WAIT_BASE_MS);
        const prev = currentPageState();
        if (!prev) {
          setStatus(`完了: ${ctx.saved}ページ保存しました（画像が見つからなくなりました）`, false);
          break;
        }
        const nextRes = await loadNextPage(prev, pageNo);
        if (nextRes.reason === 'stopped') {
          setStatus(`停止しました: ${ctx.saved}ページ保存しました`, false);
          break;
        }
        if (!nextRes.ok) {
          setStatus(
            `ページ送りができませんでした（${nextRes.history.join(' / ')}）。最終ページの可能性もあります: ${ctx.saved}ページ保存済み`,
            true
          );
          break;
        }
        pageNo = pageNo + 1;
        await sleep(300);
      }
    } catch (err) {
      const msg = sameErrorMessage(err);
      setStatus(`エラー: ${msg}`, true);
    } finally {
      activeSession = false;
    }
  }

  testBtn.addEventListener('click', async () => {
    if (activeSession) return;
    const no = Number(startInput.value) || START_PAGE_DEFAULT;
    dirHandle = null;
    await runCapture(no, true);
  });

  startBtn.addEventListener('click', async () => {
    if (activeSession) return;
    const no = Number(startInput.value) || START_PAGE_DEFAULT;
    dirHandle = null;
    await runCapture(no, false);
  });

  stopBtn.addEventListener('click', () => {
    stopRequested = true;
    setStatus('停止要求を受け付けました…', false);
  });
})();
