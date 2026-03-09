import { AppServer, AppSession } from '@mentra/sdk';
import * as dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const activeSessions = new Map<string, AppSession>();
let isScanning = false;

class FaceAnalyzerApp extends AppServer {
  constructor(options: any) {
    super(options);

    const app = this.getExpressApp();
    app.use(express.json());

    app.get('/health', (_req, res) => res.status(200).send('OK - Face Analyzer running!'));

    // ─── Webview ─────────────────────────────────────────────────────────────
    app.get('/webview', (_req, res) => {
      res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <title>Face Analyzer</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; text-align: center; padding: 16px; background: #1a1a2e; color: #eee; }
    h1 { color: #4CAF50; font-size: 24px; margin-bottom: 6px; }
    #connStatus { font-size: 13px; margin: 6px 0 10px; }
    #feedback { min-height: 18px; font-size: 13px; color: #aaa; margin: 8px 0; }
    #btnScan { width: 100%; max-width: 320px; padding: 18px; margin: 10px auto; display: block;
      background: #4CAF50; color: white; border: none; border-radius: 10px;
      cursor: pointer; font-size: 18px; font-weight: bold; }
    #btnScan:disabled { background: #555; cursor: not-allowed; }
    .results { max-width: 360px; margin: 14px auto; text-align: left; }
    .face-card { background: #16213e; border-radius: 10px; padding: 14px; margin: 10px 0; }
    .face-title { color: #4CAF50; font-weight: bold; font-size: 15px; margin-bottom: 8px; }
    .row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #2a2a4a; font-size: 14px; }
    .row:last-child { border-bottom: none; }
    .lbl { color: #aaa; }
    .val { color: #eee; font-weight: bold; }
  </style>
</head>
<body>
  <h1>😊 Face Analyzer</h1>
  <p id="connStatus">Checking...</p>
  <p id="feedback">Press Scan to analyze</p>
  <button id="btnScan" onclick="doScan()">📷 Scan Face</button>
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

    async function doScan() {
      const btn = document.getElementById('btnScan');
      const fb = document.getElementById('feedback');
      btn.disabled = true;
      btn.textContent = '⏳ Scanning...';
      fb.textContent = 'Capturing photo...';
      document.getElementById('results').innerHTML = '';

      try {
        const d = await fetch('/action/scan', { method: 'POST' }).then(r => r.json());
        if (d.error) {
          fb.textContent = 'Error: ' + d.error;
        } else if (!d.faces || d.faces.length === 0) {
          fb.textContent = 'No faces detected';
        } else {
          fb.textContent = d.faces.length + ' face' + (d.faces.length > 1 ? 's' : '') + ' detected';
          renderFaces(d.faces);
        }
      } catch(e) {
        fb.textContent = 'Request failed — try again';
      }

      btn.disabled = false;
      btn.textContent = '📷 Scan Face';
    }

    function renderFaces(faces) {
      const c = document.getElementById('results');
      c.innerHTML = '';
      faces.forEach((f, i) => {
        c.innerHTML += '<div class="face-card">' +
          '<div class="face-title">Face ' + (i+1) + '</div>' +
          row('Age', f.age) + row('Gender', f.gender) + row('Emotion', f.emotion) +
          row('Smile', f.smile + '%') + row('Attractiveness', f.beauty) +
          '</div>';
      });
    }

    function row(l, v) {
      return '<div class="row"><span class="lbl">' + l + '</span><span class="val">' + (v ?? '—') + '</span></div>';
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

    // ─── Scan Endpoint ────────────────────────────────────────────────────────
    app.post('/action/scan', async (_req, res) => {
      const session = Array.from(activeSessions.values())[0];
      if (!session) return res.status(503).json({ error: 'Glasses not connected' });
      if (isScanning) return res.status(429).json({ error: 'Scan already in progress' });

      isScanning = true;
      console.log('[SCAN] Starting...');

      try {
        const photo = await Promise.race([
          (session.camera as any).requestPhoto(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Photo timeout 15s')), 15000))
        ]);

        const imageBase64 = this.extractBase64(photo);
        if (!imageBase64) {
          isScanning = false;
          return res.status(500).json({ error: 'Could not read photo data' });
        }

        console.log('[SCAN] Photo captured, length:', imageBase64.length);

        const faces = await this.analyzeFaces(imageBase64);
        console.log(`[SCAN] ${faces.length} face(s) detected`);

        // Speak summary through glasses
        if (faces.length === 0) {
          await this.safeSpeak(session, 'No faces detected.');
        } else {
          const lines = faces.map((f: any, i: number) =>
            `Face ${i + 1}: ${f.gender}, age ${f.age}, ${f.emotion}.`
          ).join(' ');
          await this.safeSpeak(session, lines);
        }

        isScanning = false;
        return res.json({ faces });

      } catch (err: any) {
        console.error('[SCAN] Error:', err.message);
        isScanning = false;
        await this.safeSpeak(session, 'Scan failed. Please retry.').catch(() => {});
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

    await this.safeSpeak(session, 'Face analyzer ready. Press scan in the app.');

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

  // ─── Face++ API ─────────────────────────────────────────────────────────────

  private async analyzeFaces(imageBase64: string): Promise<any[]> {
    const apiKey = process.env.FACEPP_API_KEY;
    const apiSecret = process.env.FACEPP_API_SECRET;
    if (!apiKey || !apiSecret) throw new Error('FACEPP_API_KEY / FACEPP_API_SECRET not set');

    console.log('[FACEPP] Calling Face++ API...');

    const form = new FormData();
    form.append('api_key', apiKey);
    form.append('api_secret', apiSecret);
    form.append('image_base64', imageBase64);
    form.append('return_attributes', 'age,gender,emotion,beauty,smile');

    const response = await fetch('https://api-us.faceplusplus.com/facepp/v3/detect', {
      method: 'POST',
      body: form
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Face++ ${response.status}: ${err}`);
    }

    const data = await response.json();
    console.log('[FACEPP] Faces found:', data.faces?.length ?? 0);
    if (!data.faces?.length) return [];

    return data.faces.map((face: any) => {
      const a = face.attributes;
      const topEmotion = a.emotion
        ? (Object.entries(a.emotion) as [string, number][])
            .reduce((best, cur) => cur[1] > best[1] ? cur : best, ['neutral', 0])[0]
            .replace('_', ' ')
        : 'unknown';

      const beauty = a.beauty
        ? Math.round((a.beauty.female_score + a.beauty.male_score) / 2)
        : null;

      return {
        age: a.age?.value ?? '?',
        gender: a.gender?.value ?? '?',
        emotion: topEmotion,
        smile: Math.round(a.smile?.value ?? 0),
        beauty: beauty !== null ? beauty + '/100' : '?',
      };
    });
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
  packageName: 'com.yakov.faceanalyzer',
  apiKey: process.env.MENTRA_API_KEY!,
  port,
  host: '0.0.0.0',
  requiredPermissions: ['camera'],
});

server.start()
  .then(() => console.log(`✅ Face Analyzer running on port ${port}`))
  .catch(err => { console.error('❌ Failed to start:', err); process.exit(1); });
