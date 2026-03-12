import { AppServer, AppSession } from '@mentra/sdk';
import * as dotenv from 'dotenv';
import express from 'express';
import sharp from 'sharp';

dotenv.config();

const activeSessions = new Map<string, AppSession>();
let isCapturing = false;
let isSearching = false;
let pendingPhoto: { base64: string; enhanced: string; sizeKB: number } | null = null;

class FaceAnalyzerApp extends AppServer {
  constructor(options: any) {
    super(options);

    const app = this.getExpressApp();
    app.use(express.json());

    // ── Health ──────────────────────────────────────────────────────────────
    app.get('/health', (_req, res) => res.status(200).send('OK - Face Search running!'));

    // ── Session status ──────────────────────────────────────────────────────
    app.get('/session-status', (_req, res) => {
      res.json({ connected: activeSessions.size > 0 });
    });

    // ── Webview ─────────────────────────────────────────────────────────────
    app.get('/webview', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Face Search</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, sans-serif;
      text-align: center;
      padding: 16px;
      background: #1a1a2e;
      color: #eee;
      min-height: 100vh;
    }
    h1 { color: #4CAF50; font-size: 22px; margin-bottom: 4px; }
    #connStatus { font-size: 13px; margin: 4px 0 8px; }
    #feedback  { font-size: 13px; color: #aaa; min-height: 18px; margin: 6px 0; }
    #feedback2 { font-size: 13px; color: #aaa; min-height: 18px; margin: 4px 0; }

    .btn {
      width: 100%; max-width: 340px; padding: 16px;
      margin: 6px auto; display: block;
      border: none; border-radius: 10px;
      cursor: pointer; font-size: 17px; font-weight: bold;
    }
    .btn:disabled { background: #555 !important; cursor: not-allowed; }
    #btnCapture   { background: #4CAF50; color: #fff; }
    #btnConfirm   { background: #1976D2; color: #fff; display: none; }
    #btnRetake    { background: #c0392b; color: #fff; display: none; }
    #btnNewSearch { background: #37474F; color: #fff; display: none; margin-top: 12px; }

    #previewSection {
      display: none; max-width: 360px;
      margin: 12px auto; text-align: left;
    }
    #previewImg {
      width: 100%; border-radius: 10px;
      border: 3px solid #4CAF50; display: block;
    }
    #qualityLabel { font-size: 12px; color: #aaa; margin: 10px 0 4px; }
    #qualityTrack { background: #333; border-radius: 6px; height: 10px; overflow: hidden; }
    #qualityFill  { height: 100%; border-radius: 6px; transition: width 0.4s, background 0.4s; width: 0%; }
    #qualityText  { font-size: 14px; font-weight: bold; margin: 6px 0; }

    #progressBar {
      width: 100%; max-width: 340px; margin: 6px auto;
      background: #333; border-radius: 6px;
      overflow: hidden; height: 10px; display: none;
    }
    #progressFill { height: 100%; background: #4CAF50; width: 0%; transition: width 0.4s; }

    .results { max-width: 360px; margin: 12px auto; text-align: left; }
    .result-card { background: #16213e; border-radius: 10px; padding: 14px; margin: 10px 0; overflow: hidden; }
    .result-title { color: #4CAF50; font-weight: bold; font-size: 15px; margin-bottom: 8px; }
    .row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #2a2a4a; font-size: 13px; }
    .row:last-child { border-bottom: none; }
    .lbl { color: #aaa; min-width: 50px; }
    .val { color: #eee; font-weight: bold; text-align: right; word-break: break-all; }
    .val a { color: #4CAF50; text-decoration: none; }
    .score-bar { height: 6px; border-radius: 3px; background: #4CAF50; margin: 4px 0 8px; }
    .thumb { width: 64px; height: 64px; object-fit: cover; border-radius: 6px; float: right; margin-left: 10px; }
    .no-results { color: #aaa; font-size: 14px; padding: 20px; text-align: center; }
  </style>
</head>
<body>
  <h1>&#128269; Face Search</h1>
  <p id="connStatus">Checking...</p>
  <p id="feedback">Point glasses at a face, then press Capture</p>

  <button id="btnCapture" class="btn" onclick="doCapture()">&#128247; Capture Photo</button>

  <div id="previewSection">
    <img id="previewImg" src="" alt="Captured photo" />
    <div id="qualityLabel">Image Quality</div>
    <div id="qualityTrack"><div id="qualityFill"></div></div>
    <div id="qualityText"></div>
  </div>

  <button id="btnConfirm"   class="btn" onclick="doConfirm()">&#9989; Looks Good &#8212; Search!</button>
  <button id="btnRetake"    class="btn" onclick="doRetake()">&#128260; Retake Photo</button>

  <div id="progressBar"><div id="progressFill"></div></div>
  <p id="feedback2"></p>

  <div class="results" id="results"></div>
  <button id="btnNewSearch" class="btn" onclick="resetUI()">&#128247; New Search</button>

  <script>
    function el(id) { return document.getElementById(id); }
    function setFb(msg)  { el('feedback').textContent  = msg; }
    function setFb2(msg) { el('feedback2').textContent = msg; }

    function showProgress(on) {
      el('progressBar').style.display = on ? 'block' : 'none';
      if (!on) el('progressFill').style.width = '0%';
    }
    function setProgress(pct) { el('progressFill').style.width = pct + '%'; }

    function showPreview(base64, sizeKB, quality) {
      el('previewImg').src = 'data:image/jpeg;base64,' + base64;
      el('previewSection').style.display = 'block';

      var pct  = Math.min(100, Math.max(0, quality));
      var fill = el('qualityFill');
      fill.style.width      = pct + '%';
      fill.style.background = pct >= 70 ? '#4CAF50' : pct >= 40 ? '#FFA500' : '#e53935';

      var label = pct >= 70 ? 'Good quality'
                : pct >= 40 ? 'Acceptable - may work'
                : 'Low quality - consider retaking';
      el('qualityText').textContent = label + ' (' + sizeKB + ' KB)';
      el('qualityText').style.color = pct >= 70 ? '#4CAF50' : pct >= 40 ? '#FFA500' : '#e53935';

      el('btnCapture').style.display  = 'none';
      el('btnConfirm').style.display  = 'block';
      el('btnRetake').style.display   = 'block';
      el('btnNewSearch').style.display = 'none';
    }

    function hidePreview() {
      el('previewSection').style.display = 'none';
      el('btnConfirm').style.display = 'none';
      el('btnRetake').style.display  = 'none';
      el('btnCapture').style.display = 'block';
    }

    function resetUI() {
      hidePreview();
      el('results').innerHTML = '';
      el('btnNewSearch').style.display = 'none';
      setFb('Point glasses at a face, then press Capture');
      setFb2('');
      showProgress(false);
    }

    async function checkConn() {
      try {
        var d = await fetch('/session-status').then(function(r) { return r.json(); });
        var s = el('connStatus');
        s.textContent = d.connected ? 'Glasses Connected' : 'Glasses Disconnected';
        s.style.color = d.connected ? '#4CAF50' : '#e53935';
      } catch(e) {}
    }

    async function doCapture() {
      var btn = el('btnCapture');
      btn.disabled = true;
      btn.textContent = 'Capturing...';
      setFb('Taking photo from glasses...');
      setFb2('');
      el('results').innerHTML = '';
      el('btnNewSearch').style.display = 'none';
      hidePreview();
      showProgress(true);
      setProgress(15);

      try {
        var resp = await fetch('/action/capture', { method: 'POST' });
        var d    = await resp.json();
        showProgress(false);
        if (d.error) {
          setFb('Error: ' + d.error);
        } else {
          showPreview(d.base64, d.sizeKB, d.quality);
          setFb('Photo ready - confirm or retake');
        }
      } catch(e) {
        showProgress(false);
        setFb('Capture failed - try again');
      }

      btn.disabled = false;
      btn.textContent = 'Capture Photo';
    }

    async function doRetake() {
      try { await fetch('/action/discard', { method: 'POST' }); } catch(e) {}
      hidePreview();
      setFb('Point glasses at a face, then press Capture');
      setFb2('');
    }

    async function doConfirm() {
      var btnC = el('btnConfirm');
      var btnR = el('btnRetake');
      btnC.disabled = true;
      btnR.disabled = true;
      btnC.textContent = 'Searching...';
      setFb2('Searching the web by face... (~30s)');
      showProgress(true);
      setProgress(10);
      el('results').innerHTML = '';

      var ticker = setInterval(function() {
        var cur = parseFloat(el('progressFill').style.width) || 10;
        if (cur < 85) setProgress(cur + 2);
      }, 1500);

      try {
        var resp = await fetch('/action/confirm', { method: 'POST' });
        var d    = await resp.json();

        clearInterval(ticker);
        setProgress(100);
        setTimeout(function() { showProgress(false); }, 600);

        if (d.error) {
          setFb2('Error: ' + d.error);
          btnC.disabled = false;
          btnR.disabled = false;
          btnC.textContent = 'Looks Good - Search!';
          return;
        }

        hidePreview();
        setFb('');

        if (!d.results || d.results.length === 0) {
          setFb2('No matching faces found on the web.');
          el('results').innerHTML = '<p class="no-results">No matches found.</p>';
        } else {
          setFb2(d.results.length + ' match' + (d.results.length > 1 ? 'es' : '') + ' found!');
          renderResults(d.results);
        }
        el('btnNewSearch').style.display = 'block';

      } catch(e) {
        clearInterval(ticker);
        showProgress(false);
        setFb2('Search failed - try again');
        btnC.disabled = false;
        btnR.disabled = false;
        btnC.textContent = 'Looks Good - Search!';
      }
    }

    function renderResults(results) {
      var c = el('results');
      c.innerHTML = '';
      results.forEach(function(r, i) {
        var thumb = r.base64
          ? '<img class="thumb" src="data:image/jpeg;base64,' + r.base64 + '" alt="match" />'
          : '';
        var score = Math.round(r.score);
        c.innerHTML +=
          '<div class="result-card">' +
            thumb +
            '<div class="result-title">Match #' + (i + 1) + '</div>' +
            '<div class="row"><span class="lbl">Score</span><span class="val">' + score + ' / 100</span></div>' +
            '<div class="score-bar" style="width:' + Math.min(score, 100) + '%"></div>' +
            '<div class="row"><span class="lbl">URL</span><span class="val">' +
              '<a href="' + r.url + '" target="_blank" rel="noopener">View page</a>' +
            '</span></div>' +
          '</div>';
      });
    }

    setInterval(checkConn, 3000);
    checkConn();
  </script>
</body>
</html>\`);
    });

    // ── CAPTURE ─────────────────────────────────────────────────────────────
    app.post('/action/capture', async (_req, res) => {
      const session = Array.from(activeSessions.values())[0];
      if (!session)    return res.status(503).json({ error: 'Glasses not connected' });
      if (isCapturing) return res.status(429).json({ error: 'Capture already in progress' });

      isCapturing = true;
      console.log('[CAPTURE] Requesting photo...');

      try {
        const photo = await Promise.race([
          (session.camera as any).requestPhoto(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Photo timeout after 15s')), 15000)
          ),
        ]);

        const rawBase64 = this.extractBase64(photo);
        if (!rawBase64) {
          isCapturing = false;
          return res.status(500).json({ error: 'Could not read photo data from glasses' });
        }

        const rawBuffer = Buffer.from(rawBase64, 'base64');
        console.log(\`[CAPTURE] Raw size: \${Math.round(rawBuffer.length / 1024)} KB\`);

        const enhancedBuffer = await sharp(rawBuffer)
          .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: false })
          .sharpen({ sigma: 1.5 })
          .normalise()
          .jpeg({ quality: 92 })
          .toBuffer();

        const enhancedBase64 = enhancedBuffer.toString('base64');
        const enhancedKB     = Math.round(enhancedBuffer.length / 1024);
        const quality        = Math.min(100, Math.round((enhancedKB / 80) * 100));

        pendingPhoto = { base64: rawBase64, enhanced: enhancedBase64, sizeKB: enhancedKB };

        console.log(\`[CAPTURE] Enhanced: \${enhancedKB} KB, quality: \${quality}\`);
        await this.safeSpeak(session, 'Photo captured. Check the app and confirm or retake.');

        isCapturing = false;
        return res.json({ base64: enhancedBase64, sizeKB: enhancedKB, quality });

      } catch (err: any) {
        console.error('[CAPTURE] Error:', err.message);
        isCapturing = false;
        return res.status(500).json({ error: err.message });
      }
    });

    // ── DISCARD ─────────────────────────────────────────────────────────────
    app.post('/action/discard', (_req, res) => {
      pendingPhoto = null;
      console.log('[DISCARD] Pending photo cleared');
      return res.json({ ok: true });
    });

    // ── CONFIRM ─────────────────────────────────────────────────────────────
    app.post('/action/confirm', async (_req, res) => {
      if (!pendingPhoto) return res.status(400).json({ error: 'No photo pending - capture one first' });
      if (isSearching)   return res.status(429).json({ error: 'Search already in progress' });

      isSearching = true;
      const photoToSearch = pendingPhoto;
      pendingPhoto = null;
      const session = Array.from(activeSessions.values())[0];

      console.log('[CONFIRM] Searching FaceCheck.ID...');

      try {
        const results = await this.searchFace(photoToSearch.enhanced);
        console.log(\`[CONFIRM] \${results.length} match(es) found\`);

        if (session) {
          const msg = results.length === 0
            ? 'No matching faces found on the web.'
            : \`Found \${results.length} match\${results.length > 1 ? 'es' : ''}. Check the app for details.\`;
          await this.safeSpeak(session, msg);
        }

        isSearching = false;
        return res.json({ results });

      } catch (err: any) {
        console.error('[CONFIRM] Error:', err.message);
        isSearching = false;
        if (session) await this.safeSpeak(session, 'Search failed. Please try again.').catch(() => {});
        return res.status(500).json({ error: err.message });
      }
    });
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  protected async onSession(
    session: AppSession,
    sessionId: string,
    _userId: string
  ): Promise<void> {
    console.log(\`[SESSION] Started: \${sessionId}\`);
    activeSessions.set(sessionId, session);

    await new Promise(r => setTimeout(r, 2000));
    if (!activeSessions.has(sessionId)) return;

    await this.safeSpeak(session, 'Face search ready. Press capture in the app.');

    const cleanup = () => {
      activeSessions.delete(sessionId);
      console.log(\`[SESSION] Ended: \${sessionId}\`);
    };

    if (typeof (session as any).onEnd === 'function') {
      (session as any).onEnd(cleanup);
    } else {
      this.addCleanupHandler(cleanup);
    }
  }

  // ── FaceCheck.ID API ──────────────────────────────────────────────────────

  private async searchFace(imageBase64: string): Promise<any[]> {
    const apiToken = process.env.FACECHECK_API_TOKEN;
    if (!apiToken) throw new Error('FACECHECK_API_TOKEN not set');

    const site    = 'https://facecheck.id';
    const headers: Record<string, string> = {
      accept: 'application/json',
      Authorization: apiToken,
    };

    const buffer   = Buffer.from(imageBase64, 'base64');
    const blob     = new Blob([buffer], { type: 'image/jpeg' });
    const formData = new FormData();
    formData.append('images', blob, 'photo.jpg');
    formData.append('id_search', '');

    const uploadResp = await fetch(\`\${site}/api/upload_pic\`, {
      method: 'POST',
      headers,
      body: formData,
    });

    const uploadData = await uploadResp.json() as any;
    if (uploadData.error) {
      throw new Error(\`FaceCheck upload error: \${uploadData.error} (\${uploadData.code})\`);
    }

    const id_search = uploadData.id_search;
    console.log('[FACECHECK] Uploaded, id_search:', id_search);

    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(r => setTimeout(r, 2000));

      const searchResp = await fetch(\`\${site}/api/search\`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_search, with_progress: true, status_only: false, demo: false }),
      });

      const searchData = await searchResp.json() as any;
      if (searchData.error) throw new Error(\`FaceCheck search error: \${searchData.error}\`);

      console.log(\`[FACECHECK] Progress: \${searchData.progress ?? 0}%\`);

      if (searchData.output?.items) {
        return searchData.output.items.map((item: any) => ({
          score: item.score,
          url:   item.url,
          base64: item.base64 ?? null,
        }));
      }
    }

    throw new Error('FaceCheck search timed out after 60 seconds');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private extractBase64(photo: any): string | null {
    if (!photo) return null;
    if (Buffer.isBuffer(photo) || photo instanceof Uint8Array) {
      return Buffer.from(photo).toString('base64');
    }
    if (typeof photo === 'string') {
      return photo.startsWith('data:') ? photo.split(',')[1] : photo;
    }
    for (const key of ['buffer', 'jpegData', 'data', 'bytes', 'base64', 'photoData', 'image']) {
      const val = photo[key];
      if (!val) continue;
      if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
        return Buffer.from(val).toString('base64');
      }
      if (typeof val === 'string') {
        return val.startsWith('data:') ? val.split(',')[1] : val;
      }
    }
    return null;
  }

  private async safeSpeak(session: AppSession, msg: string): Promise<void> {
    try {
      await Promise.race([
        session.audio.speak(msg),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('speak timeout')), 5000)
        ),
      ]);
    } catch (e: any) {
      console.warn('[SPEAK] Failed:', e.message);
    }
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

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
  .then(() => console.log(\`Face Search running on port \${port}\`))
  .catch(err => { console.error('Failed to start:', err); process.exit(1); });
