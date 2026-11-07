// ==UserScript==
// @name         Kindle Web Page Capture
// @namespace    local.kindle-capture
// @version      1.0.1
// @description  Kindle Webの本文画像をPNGとして保存する（Canvas優先・fetchフォールバック）
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
  const ORDER_MIN_GAP_MS = 0;
  const SAVE_MIN_GAP_MS = 300;
  const START_PAGE_NO_OFFSET = 0;
  const PROGRESS_TOTAL = MAX_PAGES;
  const FETCH_TIMEOUT_MS = 30000;
  const START_PAGE_DEFAULT = 1;

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
      '<div style="font-weight:700;margin-bottom:6px">Kindle Web Capture v1.0.1</div>' +
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

  function pickTargetImage() {
    const img = waitForTargetImage();
    return img;
  }

  async function waitForImageReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
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

  async function pngBlobForImage(prompt) {
    const current = await pickTargetImage();
    if (!current) {
      return null;
    }
    const src0 = current.src;
    const url = new URL(src0, location.href);
    const protocol = url.protocol;
    const isBlob = protocol === 'blob:';
    if (isBlob || !isBlob && !isSupportedImageUrl(url.pathname)) {
      // ✅ v1.0.1: blob は CSP の connect-src で fetch が弾かれるケースがあるため
      //   blob: の画像を <img> から取り出し、Canvas へ直接描画します。
      // 1) 第一手段: <img> からの Canvas 描画
      try {
        const blob = await pngBlobForCanvas(current);
        const currentAfter = pickImageElement();
        if (!currentAfter || currentAfter.src !== current.src) {
          throw new Error('PNG生成中に画像が切り替わりました');
        }
        return {
          blob,
          hash: fnv1aHash(new Uint8Array(await blob.arrayBuffer())),
          isBlob,
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
            isBlob,
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

  async function savePage(pageNo, bytes) {
    if (!dirHandle) {
      dirHandle = await window.showDirectoryPicker();
    }
    const fileName = `page_${String(pageNo).padStart(4, '0')}.png`;
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(bytes);
    await writable.close();
  }

  function findNextButton() {
    for (const sel of NEXT_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  function capturePage(pageNo) {
    const current = pickTargetImage();
    if (!current) {
      throw new Error(`画像が見つかりません（${pageNo}ページ目）`);
    }
    return pngBlobForImage(current);
  }

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
      setStatus(`エラー（${pageNo}ページ目）: 画像が見つかりません（${pageNo}ページ目）`, true);
      return { ok: false, error: new Error('画像が見つかりません') };
    }
    if (stopRequested) {
      return { ok: false, stopped: true };
    }
    const { blob, hash, isBlob, source } = result;
    if (ctx.lastHash === hash) {
      setStatus(`完了: ${pageNo - 1}ページ保存しました（重複画像で終了）`, false);
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

  async function waitForSrcChange(prevSrc, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (stopRequested) return { loaded: false, stopped: true };
      const img = pickImageElement();
      if (img && img.src !== prevSrc && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
        return { loaded: true, img };
      }
      await sleep(100);
    }
    return { loaded: false, timeout: true };
  }

  async function loadNextPage(prevSrc, clickAttempt = 1) {
    const btn = findNextButton();
    if (!btn || btn.disabled) {
      return { ok: false, reason: 'no-next' };
    }
    btn.click();
    const changed = await waitForSrcChange(prevSrc);
    if (changed.loaded) {
      return { ok: true };
    }
    if (changed.stopped) {
      return { ok: false, reason: 'stopped' };
    }
    if (clickAttempt < 3) {
      await sleep(500);
      const btn2 = findNextButton();
      if (btn2 && !btn2.disabled) {
        btn2.click();
        const changed2 = await waitForSrcChange(prevSrc);
        if (changed2.loaded) return { ok: true };
        if (changed2.stopped) return { ok: false, reason: 'stopped' };
      }
      return loadNextPage(prevSrc, clickAttempt + 1);
    }
    return { ok: false, reason: 'src-not-changed' };
  }

  async function runCapture(startNo, testOne) {
    if (activeSession) return;
    activeSession = true;
    stopRequested = false;
    const ctx = { lastHash: null };
    let pageNo = startNo;
    let saved = 0;
    const totalNote = testOne ? '' : '';
    try {
      for (;;) {
        if (stopRequested) {
          setStatus(`停止しました: ${saved}ページ保存しました`, false);
          break;
        }
        if (pageNo - startNo + 1 > MAX_PAGES) {
          setStatus(`上限（${MAX_PAGES}ページ）に達しました: ${saved}ページ保存しました`, false);
          break;
        }
        setStatus(`保存準備中… ${pageNo}ページ目（保存済み ${saved}ページ / 上限${PROGRESS_TOTAL}ページ）`, false);
        if (stopRequested) {
          setStatus(`停止しました: ${saved}ページ保存しました`, false);
          break;
        }
        const res = await captureOnePage(pageNo, ctx);
        if (res.stopped) {
          setStatus(`停止しました: ${saved}ページ保存しました`, false);
          break;
        }
        if (res.duplicate) {
          saved++;
          setStatus(`完了: ${saved}ページ保存しました（重複画像で終了）`, false);
          break;
        }
        if (!res.ok) {
          break;
        }
        saved++;
        if (testOne) {
          setStatus(`テスト完了: ${res.fileName} を保存しました（${res.source}）`, false);
          break;
        }
        setStatus(`保存済み ${saved}ページ / 上限${PROGRESS_TOTAL}ページ（次ページへ移動中…）`, false);
        await sleep(WAIT_BASE_MS);
        const currentImg = pickImageElement();
        if (!currentImg) {
          setStatus(`完了: ${saved}ページ保存しました（画像が見つからなくなりました）`, false);
          break;
        }
        const prevSrc = currentImg.src;
        const nextRes = await loadNextPage(prevSrc);
        if (nextRes.reason === 'no-next') {
          setStatus(`完了: ${saved}ページ保存しました（最終ページ）`, false);
          break;
        }
        if (nextRes.reason === 'stopped') {
          setStatus(`停止しました: ${saved}ページ保存しました`, false);
          break;
        }
        if (!nextRes.ok) {
          setStatus(`エラー（${pageNo}ページ目→次ページ）: ページ送りに失敗しました（画像が切り替わりませんでした）`, true);
          break;
        }
        pageNo = pageNo + 1;
        if (pageNo > MAX_PAGES) {
          setStatus(`上限（${MAX_PAGES}ページ）に達しました: ${saved}ページ保存しました`, false);
          break;
        }
        await sleep(ORDER_MIN_GAP_MS);
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
