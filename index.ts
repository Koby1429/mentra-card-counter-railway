import { AppServer, AppSession } from '@mentra/sdk';
import * as dotenv from 'dotenv';
import express from 'express';
import sharp from 'sharp';

dotenv.config();

const activeSessions = new Map<string, AppSession>();
let isCapturing = false;
let isSearching = false;

// Pending photo waiting for user confirmation
let pendingPhoto: { base64: string; enhanced: string; sizeKB: number } | null = null;

class FaceAnalyzerApp extends AppServer {
  constructor(options: any) {
    super(options);

    const app = this.getExpressApp();
    app.use(express.json());

    app.get('/health', (_req, res) => res.status(200).send('OK - Face Search running!'));

    // ─── Webview ─────────────────────────────────────────────────────────────
    app.get('/webview', (_req, res) => {
      res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <title>Face Search</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; text-align: center; padding: 16px; background: #1a1a2e; color: #eee; }
    h1 { color: #4CAF50; font-size: 22px; margin-bottom: 6px; }
    #connStatus { font-size: 13px; margin: 6px 0 10px; }
    #feedback { min-height: 18px; font-size: 13px; color: #aaa; margin: 8px 0; }

    #progressBar { width: 100%; max-width: 320px; margin: 6px auto; display: none;
      background: #333; border-radius: 6px; overflow: hidden; height: 10px; }
    #progressFill { height: 100%; background: #4CAF50; width: 0%; transition: width 0.3s; }

    .btn { width: 100%; max-width: 320px; padding: 16px; margin: 6px auto; display: block;
      border: none; border-radius: 10px; cursor: pointer; font-size: 17px; font-weight: bold; }
    .btn:disabled { background: #555 !important; cursor: not-allowed; }
    #btnCapture { background: #4CAF50; color: white; }
    #btnConfirm { background: #1976D2; color: white; display: none; }
    #btnRetake  { background: #c0392b; color: white; display: none; }

    #previewSection { display: none; max-width: 360px; margin: 14px auto; }
    #previewImg { width: 100%; border-radius: 10px; border: 3px solid #4CAF50; }
    #qualityLabel { font-size: 13px; color: #aaa; margin: 10px 0 4px; }
    #qualityTrack { background: #333; border-radius: 6px; height: 10px; overflow: hidden; }
    #qualityFill { height: 100%; border-radius: 6px; transition: width 0.4s, background 0.4s; }
    #qualityText { font-size: 14px; font-weight: bold; margin-top: 6px; }

    .results { max-width: 360px; margin: 14px auto; text-align: left; }
    .result-card { background: #16213e; border-radius: 10px; padding: 14px; margin: 10px 0; overflow: hidden; }
    .result-title { color: #4CAF50; font-weight: bold; font-size: 15px; margin-bottom: 8px; }
    .row { display: flex; justify-content: space-between; padding: 5px 0;
      border-bottom: 1px solid #2a2a4a; font-size: 13px; }
    .row:last-child { border-bottom: none; }
    .lbl { color: #aaa; min-width: 50px; }
    .val { color: #eee; font-weight: bold; text-align: right; word-break: break-all; }
    .val a { color: #4CAF50; text-decoration: none; }
    .score-bar { height: 6px; border-radius: 3px; background: #4CAF50; margin: 4px 0 8px; }
    .thumb { width: 64px; height: 64px; object-fit: cover; border-radius: 6px; float: right; margin-left: 10px; }
    .no-results { color: #aaa; font-size: 14px; padding: 20px; }
  </style>
</head>
<body>
  <h1>🔍 Face Search</h1>
  <p id="connStatus">Checking...</p>
  <p id="feedback">Point glasses at a face, then press Capture</p>

  <button id="btnCapture" class="btn" onclick="doCapture()">📷 Capture Photo</button>

  <div id="previewSection">
    <img id="previewImg" src="" alt="Captured photo" />
    <div id="qualityLabel">Image Quality</div>
    <div id="qualityTrack"><div id="qualityFill"></div></div>
    <div id="qualityText"></div>
  </div>

  <button id="btnConfirm" class="btn" onclick="doConfirm()">✅ Looks Good — Search!</button>
  <button id="btnRetake"  class="btn" onclick="doRetake()">🔄 Retake Photo</button>

  <div id="progressBar"><div id="progressFill"></div></div>
  <p id="feedback2" style="font-size:13px;color:#aaa;margin:6px 0;min-height:18px;"></p>
  <div class="results" id="results"></div>

  <script>
    async function checkConn() {
      try {
        const d = await fetch('/session-status').then(r => r.json());
        const el = document.getElementById('connStatus');
        el.textContent = d.connected ? '🟢 Glasses Connected' : '🔴 Glasses Disconnected';
        el.style.color = d.connected ? '#4CAF50' : '#e53935';
      } catch(e) {}
    }

    async function doCapture() {
      const btn = document.getElementById('btnCapture');
      const fb  = document.getElementById('feedback');
      btn.disabled = true;
      btn.textContent = '⏳ Capturing...';
      fb.textContent = 'Taking photo from glasses...';
      document.getElementById('results').innerHTML = '';
      document.getElementById('feedback2').textContent = '';
      hidePreview();

      try {
        const resp = await fetch('/action/capture', { method: 'POST' });
        const d = await resp.json();
        if (d.error) {
          fb.textContent = 'Error: ' + d.error;
        } else {
          showPreview(d.base64, d.sizeKB, d.quality);
          fb.textContent = 'Photo captured! Check quality, then confirm or retake.';
        }
      } catch(e) {
        fb.textContent = 'Capture failed — try again';
      }

      btn.disabled = false;
      btn.textContent = '📷 Capture Photo';
    }

    function showPreview(base64, sizeKB, quality) {
      document.getElementById('previewImg').src = 'data:image/jpeg;base64,' + base64;
      document.getElementById('previewSection').style.display = 'block';

      const pct = Math.min(100, Math.max(0, quality));
      const fill = document.getElementById('qualityFill');
      fill.style.width = pct + '%';
      fill.style.background = pct >= 70 ? '#4CAF50' : pct >= 40 ? '#FFA500' : '#e53935';

      const label = pct >= 70 ? '✅ Good quality'
                  : pct >= 40 ? '⚠️ Acceptable'
                  : '❌ Low quality — consider retaking';
      document.getElementById('qualityText').textContent = label + ' (' + sizeKB + ' KB)';
      document.getElementById('qualityText').style.color = pct >= 70 ? '#4CAF50' : pct >= 40 ? '#FFA500' : '#e53935';

      document.getElementById('btnConfirm').style.display = 'block';
      document.getElementById('btnRetake').style.display  = 'block';
      document.getElementById('btnCapture').style.display = 'none';
    }

    function hidePreview() {
      document.getElementById('previewSection').style.display = 'none';
      document.getElementById('btnConfirm').style.display = 'none';
      document.getElementById('btnRetake').style.display  = 'none';
      document.getElementById('btnCapture').style.display = 'block';
    }

    async function doRetake() {
      await fetch('/action/discard', { method: 'POST' });
      hidePreview();
      document.getElementById('feedback').textContent = 'Point glasses at a face, then press Capture';
    }

    async function doConfirm() {
      const fb2 = document.getElementById('feedback2');
      const bar  = document.getElementById('progressBar');
      const fill = document.getElementById('progressFill');
      const confirmBtn = document.getElementById('btnConfirm');
      const retakeBtn  = document.getElementById('btnRetake');

      confirmBtn.disabled = true;
      retakeBtn.disabled  = true;
      confirmBtn.textContent = '⏳ Searching...';
      fb2.textContent = 'Searching the web by face... (may take ~30s)';
      bar.style.display = 'block';
      fill.style.width = '10%';
      document.getElementById('results').innerHTML = '';

      try {
        let prog = 10;
        const ticker = setInterval(() => {
          if (prog < 85) { prog += 3; fill.style.width = prog + '%'; }
        }, 1500);

        const resp = await fetch('/action/confirm', { method: 'POST' });
        const d = await resp.json();

        clearInterval(ticker);
        fill.style.width = '100%';
        setTimeout(() => { bar.style.display = 'none'; fill.style.width = '0%'; }, 600);

        if (d.error) {
          fb2.textContent = 'Error: ' + d.error;
        } else if (!d.results || d.results.length === 0) {
          fb2.textContent = 'No matches found on the web.';
          document.getElementById('results').innerHTML = '<p class="no-results">No matching faces found.</p>';
        } else {
          fb2.textContent = d.results.length + ' match' + (d.results.length > 1 ? 'es' : '') + ' found!';
          renderResults(d.results);
        }
      } catch(e) {
        fb2.textContent = 'Search failed — try again';
        bar.style.display = 'none';
      }

      hidePreview();
      document.getElementById('feedback').textContent = 'Point glasses at a face, then press Capture';
      confirmBtn.disabled = false;
      retakeBtn.disabled  = false;
      confirmBtn.textContent = '✅ Looks Good — Search!';
    }

    function renderResults(results) {
      const c = document.getElementById('results');
      c.innerHTML = '';
      results.forEach((r, i) => {
        const thumb = r.base64
          ? '<img class="thumb" src="data:image/jpeg;base64,' + r.base64 + '" />'
          : '';
        c.innerHTML +=
          '<div class="result-card">' +
            thumb +
            '<div class="result-title">Match #' + (i + 1) + '</div>' +
            '<div class="row"><span class="lbl">Score</span><span class="val">' + r.score + ' / 100</span></div>' +
            '<div class="score-bar" style="width:' + r.score + '%"></div>' +
            '<div class="row"><span class="lbl">URL</span><span class="val"><a href="' + r.url + '" target="_blank">View page ↗</a></span></div>' +
          '</div>';
      });
    }

    setInterval(checkConn, 3000);
    checkConn();
  </script>
</body>
</html>`);
    });

    // ─── Session Status ───────────────────────────────────────────────────────
    app.get('/session-status', (_req, res) => {
      res.json({ connected: activeSessions.size > 0 });
    });

    // ─── CAPTURE: take photo, return preview + quality score ─────────────────
    app.post('/action/capture', async (_req, res) => {
      const session = Array.from(activeSessions.values())[0];
      if (!session) return res.status(503).json({ error: 'Glasses not connected' });
      if (isCapturing) return res.status(429).json({ error: 'Capture already in progress' });

      isCapturing = true;
      console.log('[CAPTURE] Taking photo...');

      try {
        const photo = await Promise.race([
          (session.camera as any).requestPhoto(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Photo timeout 15s')), 15000))
        ]);

        const rawBase64 = this.extractBase64(photo);
        if (!rawBase64) {
          isCapturing = false;
          return res.status(500).json({ error: 'Could not read photo data' });
        }

        const rawBuffer = Buffer.from(rawBase64, 'base64');
        console.log(`[CAPTURE] Raw photo: ${Math.round(rawBuffer.length / 1024)} KB`);

        const enhancedBuffer = await sharp(rawBuffer)
          .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: false })
          .sharpen({ sigma: 1.5 })
          .normalise()
          .jpeg({ quality: 92 })
          .toBuffer();

        const enhancedBase64 = enhancedBuffer.toString('base64');
        const enhancedKB = Math.round(enhancedBuffer.length / 1024);

        // Quality heuristic: larger enhanced file = more detail captured
        const quality = Math.min(100, Math.round((enhancedKB / 80) * 100));

        pendingPhoto = { base64: rawBase64, enhanced: enhancedBase64, sizeKB: enhancedKB };

        await this.safeSpeak(session, 'Photo captured. Check the app and confirm or retake.');

        isCapturing = false;
        return res.json({ base64: enhancedBase64, sizeKB: enhancedKB, quality });

      } catch (err: any) {
        console.error('[CAPTURE] Error:', err.message);
        isCapturing = false;
        return res.status(500).json({ error: err.message });
      }
    });

    // ─── DISCARD: clear pending photo ────────────────────────────────────────
    app.post('/action/discard', (_req, res) => {
      pendingPhoto = null;
      console.log('[DISCARD] Pending photo cleared');
      res.json({ ok: true });
    });

    // ─── CONFIRM: search FaceCheck.ID with the pending photo ─────────────────
    app.post('/action/confirm', async (_req, res) => {
      if (!pendingPhoto) return res.status(400).json({ error: 'No photo pending — capture one first' });
      if (isSearching) return res.status(429).json({ error: 'Search already in progress' });

      isSearching = true;
      const photoToSearch = pendingPhoto;
      pendingPhoto = null;
      console.log('[CONFIRM] Searching FaceCheck.ID...');

      const session = Array.from(activeSessions.values())[0];

      try {
        const results = await this.searchFace(photoToSearch.enhanced);
        console.log(`[CONFIRM] ${results.length} match(es) found`);

        if (session) {
          if (results.length === 0) {
            await this.safeSpeak(session, 'No matching faces found on the web.');
          } else {
            await this.safeSpeak(session, `Found ${results.length} match${results.length > 1 ? 'es' : ''}. Check the app for details.`);
          }
        }

        isSearching = false;
        return res.json({ results });

      } catch (err: any) {
        console.error('[CONFIRM] Error:', err.message);
        isSearching = false;
        if (session) await this.safeSpeak(session, 'Search failed. Please retry.').catch(() => {});
        return res.status(500).json({ error: err.message });
      }
    });
  }

  // ─── Session Lifecycle ──────────────────────────────────────────────────────

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[SESSION] Started: ${sessionId}`);
    activeSessions.set(sessionId, session);

    await new Promise(r => setTimeout(r, 2000));
    if (!activeSessions.has(sessionId)) return;

    await this.safeSpeak(session, 'Face search ready. Press capture in the app.');

    const cleanup = () => {
      activeSessions.delete(sessionId);
      console.log(`[SESSION] Ended: ${sessionId}`);
    };

    if (typeof (session as any).onEnd === 'function') {
      (session as any).onEnd(cleanup);
    } else {
      this.addCleanupHandler(cleanup);
    }
  }

  // ─── FaceCheck.ID API ────────────────────────────────────────────────────────

  private async searchFace(imageBase64: string): Promise<any[]> {
    const apiToken = process.env.FACECHECK_API_TOKEN;
    if (!apiToken) throw new Error('FACECHECK_API_TOKEN not set');

    const site = 'https://facecheck.id';
    const headers: Record<string, string> = {
      'accept': 'application/json',
      'Authorization': apiToken,
    };

    const buffer = Buffer.from(imageBase64, 'base64');
    const blob = new Blob([buffer], { type: 'image/jpeg' });
    const formData = new FormData();
    formData.append('images', blob, 'photo.jpg');
    formData.append('id_search', '');

    const uploadResp = await fetch(`${site}/api/upload_pic`, {
      method: 'POST',
      headers,
      body: formData,
    });

    const uploadData = await uploadResp.json();
    if (uploadData.error) throw new Error(`FaceCheck upload error: ${uploadData.error} (${uploadData.code})`);

    const id_search = uploadData.id_search;
    console.log('[FACECHECK] Uploaded, id_search:', id_search);

    const demo = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(r => setTimeout(r, 2000));

      const searchResp = await fetch(`${site}/api/search`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_search, with_progress: true, status_only: false, demo }),
      });

      const searchData = await searchResp.json();
      if (searchData.error) throw new Error(`FaceCheck search error: ${searchData.error}`);

      console.log(`[FACECHECK] Progress: ${searchData.progress ?? 0}%`);

      if (searchData.output?.items) {
        return searchData.output.items.map((item: any) => ({
          score: item.score,
          url: item.url,
          base64: item.base64 ?? null,
        }));
      }
    }

    throw new Error('FaceCheck search timed out after 60 seconds');
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private extractBase64(photo: any): string | null {
    if (!photo) return null;
    if (Buffer.isBuffer(photo) || photo instanceof Uint8Array) return Buffer.from(photo).toString('base64');
    if (typeof photo === 'string') return photo.startsWith('data:') ? photo.split(',')[1] : photo;
    for (const k of ['buffer', 'jpegData', 'data', 'bytes', 'base64', 'photoData', 'image']) {
      const val = photo[k];
      if (!val) continue;
      if (Buffer.isBuffer(val) || val instanceof Uint8Array) return Buffer.from(val).toString('base64');
      if (typeof val === 'string') return val.startsWith('data:') ? val.split(',')[1] : val;
    }
    return null;
  }

  private async safeSpeak(session: AppSession, msg: string): Promise<void> {
    try {
      await Promise.race([
        session.audio.speak(msg),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ]);
    } catch (e: any) {
      console.warn('[SPEAK] Failed:', e.message);
    }
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT) || 8080;

const server = new FaceAnalyzerApp({
  packageName: 'com.yakov.picture.detector',
  apiKey: process.env.MENTRA_API_KEY!,
  port,
  host: '0.0.0.0',
  requiredPermissions: ['camera'],
  webviewURL: 'https://mentra-picture-detector-production.up.railway.app/webview',
});

server.start()
  .then(() => console.log(`Face Search running on port ${port}`))
  .catch(err => { console.error('Failed to start:', err); process.exit(1); });
