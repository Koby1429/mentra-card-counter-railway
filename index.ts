import { AppServer, AppSession } from '@mentra/sdk';
import * as dotenv from 'dotenv';
import express from 'express';

dotenv.config();

// ─── Session State ────────────────────────────────────────────────────────────

interface SessionState {
  runningCount: number;
  cardsSeen: number;
  highSeen: number;
  decks: number;
  totalHigh: number;
}

interface DetectedCard {
  rank: string;
  suit: string;
}

const sessionStates = new Map<string, SessionState>();
const transcriptionHandlers = new Map<string, (data: any) => void>();
const activeSessions = new Map<string, AppSession>();
let pendingCommand: string | null = null;
let globalStreamingInterval: NodeJS.Timeout | null = null;
let isGlobalScanning = false;

// ─── App ──────────────────────────────────────────────────────────────────────

class CardCounterApp extends AppServer {
  constructor(options: any) {
    super(options);

    const app = this.getExpressApp();
    app.use(express.json());

    // Health check
    app.get('/health', (_req, res) => res.status(200).send('OK - Card Counter running!'));

    // Webhook receiver
    app.post('/webhook', (req, res) => {
      console.log('Webhook received:', req.body);
      res.status(200).send('OK');
    });

    // Dashboard webview
    app.get('/webview', (_req, res) => {
      res.status(200).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Card Counter</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: Arial, sans-serif; text-align: center; padding: 16px; background: #1a1a2e; color: #eee; }
              h1 { color: #4CAF50; font-size: 24px; margin-bottom: 4px; }
              .stats { margin: 12px auto; max-width: 320px; }
              .stat { background: #16213e; border-radius: 10px; padding: 10px 14px; margin: 6px 0; display: flex; justify-content: space-between; align-items: center; }
              .label { color: #aaa; font-size: 14px; }
              .value { font-size: 26px; font-weight: bold; color: #4CAF50; }
              .value.negative { color: #e53935; }
              #connStatus { font-size: 13px; margin: 8px 0; }
              #feedback { min-height: 20px; font-size: 13px; color: #aaa; margin: 6px 0; }
              .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; max-width: 320px; margin: 10px auto; }
              button { padding: 14px 10px; background: #4CAF50; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: bold; width: 100%; }
              button:active { opacity: 0.8; }
              button.blue { background: #1565C0; }
              button.red { background: #e53935; }
              button.orange { background: #e65100; }
              button:disabled { background: #555; cursor: not-allowed; }
            </style>
          </head>
          <body>
            <h1>🃏 Card Counter</h1>
            <p id="connStatus">Checking...</p>
            <div class="stats">
              <div class="stat"><span class="label">True Count</span><span class="value" id="trueCount">—</span></div>
              <div class="stat"><span class="label">Running Count</span><span class="value" id="runningCount">—</span></div>
              <div class="stat"><span class="label">High Cards Left</span><span class="value" id="highLeft">—</span></div>
              <div class="stat"><span class="label">Cards Seen</span><span class="value" id="cardsSeen">—</span></div>
            </div>
            <p id="feedback">Ready</p>
            <div class="grid">
              <button id="btnScan" onclick="doScan()">📷 Scan</button>
              <button id="btnStream" class="blue" onclick="toggleStream()">▶ Start Stream</button>
              <button class="orange" onclick="doAction('status')">📊 Status</button>
              <button class="red" onclick="doNewShoe()">🔄 New Shoe</button>
            </div>
            <script>
              let streaming = false;

              async function update() {
                try {
                  const r = await fetch('/stats');
                  const d = await r.json();
                  document.getElementById('trueCount').textContent = d.trueCount ?? '—';
                  document.getElementById('runningCount').textContent = d.runningCount ?? '—';
                  document.getElementById('highLeft').textContent = d.highLeft ?? '—';
                  document.getElementById('cardsSeen').textContent = d.cardsSeen ?? '—';
                  const tc = document.getElementById('trueCount');
                  tc.className = 'value' + (d.trueCount > 0 ? '' : d.trueCount < 0 ? ' negative' : '');
                } catch (e) {}
              }

              async function checkConn() {
                try {
                  const r = await fetch('/session-status');
                  const d = await r.json();
                  const el = document.getElementById('connStatus');
                  el.textContent = d.connected ? '🟢 Glasses Connected' : '🔴 Glasses Disconnected';
                  el.style.color = d.connected ? '#4CAF50' : '#e53935';
                } catch(e) {}
              }

              async function post(endpoint, body) {
                const r = await fetch(endpoint, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body)
                });
                return r.json();
              }

              async function doScan() {
                const btn = document.getElementById('btnScan');
                btn.disabled = true;
                btn.textContent = '⏳ Scanning...';
                setFeedback('Capturing image...');
                try {
                  const d = await post('/action/scan', {});
                  setFeedback(d.message || 'Scan complete');
                  setTimeout(update, 300);
                } catch(e) { setFeedback('Error: ' + e.message); }
                btn.disabled = false;
                btn.textContent = '📷 Scan';
              }

              async function toggleStream() {
                const btn = document.getElementById('btnStream');
                if (!streaming) {
                  streaming = true;
                  btn.textContent = '⏹ Stop Stream';
                  btn.className = 'red';
                  setFeedback('Streaming started...');
                  await post('/action/stream/start', {});
                } else {
                  streaming = false;
                  btn.textContent = '▶ Start Stream';
                  btn.className = 'blue';
                  setFeedback('Streaming stopped');
                  await post('/action/stream/stop', {});
                }
              }

              async function doNewShoe() {
                if (!confirm('Reset count for new shoe?')) return;
                await post('/action/new-shoe', {});
                setFeedback('New shoe — count reset');
                setTimeout(update, 300);
              }

              async function doAction(cmd) {
                await post('/action', { command: cmd });
              }

              function setFeedback(msg) {
                document.getElementById('feedback').textContent = msg;
              }

              setInterval(update, 3000);
              setInterval(checkConn, 3000);
              update();
              checkConn();
            </script>
          </body>
        </html>
      `);
    });

    // Stats endpoint
    app.get('/stats', (_req, res) => {
      const state: SessionState = Array.from(sessionStates.values())[0] ?? {
        runningCount: 0,
        cardsSeen: 0,
        highSeen: 0,
        decks: 6,
        totalHigh: 120
      };
      const decksLeft = Math.max(state.decks - state.cardsSeen / 52, 0.5);
      const trueCount = Math.round(state.runningCount / decksLeft);
      const highLeft = state.totalHigh - state.highSeen;
      res.json({ trueCount, highLeft, cardsSeen: state.cardsSeen, runningCount: state.runningCount });
    });

    // Session status — lets webview know if glasses are connected
    app.get('/session-status', (_req, res) => {
      res.json({ connected: transcriptionHandlers.size > 0 });
    });

    // Dedicated REST endpoints for webview buttons (no voice needed)
    const getSession = () => Array.from(activeSessions.values())[0] ?? null;
    const getState = () => Array.from(sessionStates.values())[0] ?? null;

    app.post('/action/scan', async (_req, res) => {
      const session = getSession();
      const state = getState();
      if (!session || !state) return res.status(503).json({ message: 'Glasses not connected' });
      if (isGlobalScanning) return res.status(429).json({ message: 'Scan already in progress' });
      console.log('[ACTION] Scan triggered from webview');
      // Run async, respond immediately so webview doesnt time out
      this.performScan(session, state).catch(e => console.error('[ACTION] Scan error:', e));
      res.json({ message: 'Scan started' });
    });

    app.post('/action/stream/start', (_req, res) => {
      const session = getSession();
      const state = getState();
      if (!session || !state) return res.status(503).json({ message: 'Glasses not connected' });
      if (globalStreamingInterval) return res.json({ message: 'Already streaming' });
      console.log('[ACTION] Stream start triggered from webview');
      globalStreamingInterval = setInterval(async () => {
        if (!isGlobalScanning) await this.performScan(session, state).catch(() => {});
      }, 4000);
      res.json({ message: 'Streaming started' });
    });

    app.post('/action/stream/stop', (_req, res) => {
      if (globalStreamingInterval) {
        clearInterval(globalStreamingInterval);
        globalStreamingInterval = null;
      }
      console.log('[ACTION] Stream stop triggered from webview');
      res.json({ message: 'Streaming stopped' });
    });

    app.post('/action/new-shoe', (_req, res) => {
      const state = getState();
      if (state) {
        state.runningCount = 0;
        state.cardsSeen = 0;
        state.highSeen = 0;
      }
      if (globalStreamingInterval) {
        clearInterval(globalStreamingInterval);
        globalStreamingInterval = null;
      }
      console.log('[ACTION] New shoe reset');
      res.json({ message: 'Count reset' });
    });

    // Legacy action endpoint (kept for compatibility)
    app.post('/action', (req, res) => {
      const { command } = req.body;
      console.log(`[ACTION] Legacy command: ${command}`);
      res.json({ status: 'ok' });
    });
  }

  // ─── Session Lifecycle ──────────────────────────────────────────────────────

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[SESSION] Started: ${sessionId} (user: ${userId})`);

    activeSessions.set(sessionId, session);
    sessionStates.set(sessionId, {
      runningCount: 0,
      cardsSeen: 0,
      highSeen: 0,
      decks: 6,
      totalHigh: 120  // 6 decks × 20 high cards (10, J, Q, K, A × 4 suits × 6 decks)
    });

    let streamingInterval: NodeJS.Timeout | null = null;
    let isScanning = false;


    // ─── Transcription Handler ──────────────────────────────────────────────
    // IMPORTANT: Handler registered BEFORE speak() so SDK sends correct subscriptions

    // Mute window: ignore transcription for N ms after we speak (prevents TTS echo)
    let mutedUntil = 0;
    const MUTE_DURATION_MS = 4000;
    const speakAndMute = async (msg: string) => {
      mutedUntil = Date.now() + MUTE_DURATION_MS;
      await session.audio.speak(msg);
    };

    const onTrans = async (data: any) => {
      // Only act on final transcription results, not partials
      if (data?.isFinal === false) return;

      const text: string = (data?.text ?? '').toLowerCase().trim();
      if (!text) return;

      // Ignore if we're in the mute window (glasses echoing our own TTS)
      if (Date.now() < mutedUntil) {
        console.log(`[TRANS] Muted (TTS echo): "${text}"`);
        return;
      }

      console.log(`[TRANS] "${text}"`);

      const state = sessionStates.get(sessionId);
      if (!state) return;

      if (text.includes('scan cards')) {
        await this.performScan(session, state);
        mutedUntil = Date.now() + 8000; // scan TTS can be long

      } else if (text.includes('start streaming')) {
        if (streamingInterval) {
          await speakAndMute('Already streaming.');
          return;
        }
        await speakAndMute('Streaming started.');
        streamingInterval = setInterval(async () => {
          if (!isScanning) { await this.performScan(session, state); mutedUntil = Date.now() + 8000; }
        }, 3000);

      } else if (text.includes('stop streaming')) {
        if (streamingInterval) {
          clearInterval(streamingInterval);
          streamingInterval = null;
          await speakAndMute('Streaming stopped.');
        } else {
          await speakAndMute('Not currently streaming.');
        }

      } else if (text.includes('new shoe')) {
        state.runningCount = 0;
        state.cardsSeen = 0;
        state.highSeen = 0;
        await speakAndMute('New shoe started. Count reset.');

      } else if (text.includes('status')) {
        const decksLeft = Math.max(state.decks - state.cardsSeen / 52, 0.5);
        const trueCount = Math.round(state.runningCount / decksLeft);
        const highLeft = state.totalHigh - state.highSeen;
        await speakAndMute(
          `Running count ${state.runningCount}. True count ${trueCount}. High cards left: ${highLeft}. Cards seen: ${state.cardsSeen}.`
        );

      } else {
        console.log(`[TRANS] Unrecognized: "${text}"`);
      }
    };


    // CRITICAL FIX: Register BEFORE speak so SDK sends transcription subscription
    session.events.onTranscription(onTrans);
    transcriptionHandlers.set(sessionId, onTrans);
    console.log(`[SESSION] Handler registered for ${sessionId}`);

    // Wait for session to stabilize (switching_clouds causes rapid reconnects)
    // We wait longer to let Mentra settle on one cloud region
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Only speak if this session is still the active one
    const currentState = sessionStates.get(sessionId);
    if (!currentState) {
      console.log(`[SESSION] ${sessionId} was replaced before stabilization, skipping speak`);
      return;
    }

    mutedUntil = Date.now() + MUTE_DURATION_MS;
    await session.audio.speak('Card counter ready. Say scan cards or start streaming.');


    // Fire any command that was queued before the session was ready
    if (pendingCommand) {
      const cmd = pendingCommand;
      pendingCommand = null;
      console.log(`[SESSION] Executing queued command: "${cmd}"`);
      setTimeout(() => onTrans({ text: cmd }), 500);
    }

    // ─── Cleanup ────────────────────────────────────────────────────────────

    const cleanup = () => {
      if (streamingInterval) {
        clearInterval(streamingInterval);
        streamingInterval = null;
      }
      sessionStates.delete(sessionId);
      transcriptionHandlers.delete(sessionId);
      activeSessions.delete(sessionId);
      console.log(`[SESSION] Cleaned up: ${sessionId}`);
    };

    if (typeof (session as any).onEnd === 'function') {
      (session as any).onEnd(cleanup);
    } else {
      this.addCleanupHandler(cleanup);
    }
  }

  // ─── Scan Logic ─────────────────────────────────────────────────────────────

  private async performScan(session: AppSession, state: SessionState): Promise<void> {
    if (isGlobalScanning) { console.log('[SCAN] Already scanning, skipping'); return; }
    isGlobalScanning = true;
    console.log('[SCAN] Starting...');
    try {
      await this._performScanInner(session, state);
    } finally {
      isGlobalScanning = false;
    }
  }

  private async _performScanInner(session: AppSession, state: SessionState): Promise<void> {

    // Extract base64 from a frame object (handles multiple SDK data shapes)
    const extractBase64 = (frame: any): string | null => {
      if (!frame) return null;
      console.log('[SCAN] Frame type:', typeof frame, '| keys:', 
        typeof frame === 'object' ? Object.keys(frame).join(', ') : 'n/a');

      // Raw Buffer / Uint8Array / ArrayBuffer
      if (Buffer.isBuffer(frame) || frame instanceof Uint8Array || frame instanceof ArrayBuffer) {
        return Buffer.from(frame).toString('base64');
      }
      // Plain base64 string
      if (typeof frame === 'string') {
        return frame.startsWith('data:') ? frame.split(',')[1] : frame;
      }
      // Object with a data field
      const candidateKeys = ['jpegData', 'data', 'buffer', 'bytes', 'base64', 'photoData', 'image'];
      for (const k of candidateKeys) {
        const val = frame[k];
        if (!val) continue;
        if (Buffer.isBuffer(val) || val instanceof Uint8Array || val instanceof ArrayBuffer) {
          console.log(`[SCAN] Got buffer from frame.${k}`);
          return Buffer.from(val).toString('base64');
        }
        if (typeof val === 'string') {
          console.log(`[SCAN] Got string from frame.${k}`);
          return val.startsWith('data:') ? val.split(',')[1] : val;
        }
      }
      return null;
    };

    let imageBase64: string | null = null;

    try {
      // Log every method on camera so we know exactly what's available
      const cam = session.camera as any;
      const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(cam));
      const own = Object.keys(cam);
      console.log('[SCAN] camera proto methods:', proto.join(', '));
      console.log('[SCAN] camera own keys:', own.join(', '));

      // Try each possible API in order
      if (typeof cam.onFrame === 'function') {
        console.log('[SCAN] Using onFrame API');
        imageBase64 = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('onFrame timeout 15s')), 15000);
          const unsub = cam.onFrame((frame: any) => {
            clearTimeout(timeout);
            try { unsub?.(); } catch (_) {}
            try { cam.stopVideoStream?.(); } catch (_) {}
            const b64 = extractBase64(frame);
            b64 ? resolve(b64) : reject(new Error('extractBase64 returned null'));
          });
          try { cam.startVideoStream?.({ fps: 1 }); } catch (_) {}
        });

      } else if (typeof cam.requestPhoto === 'function') {
        console.log('[SCAN] Using requestPhoto API');
        const photo = await Promise.race([
          cam.requestPhoto(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('requestPhoto timeout 15s')), 15000))
        ]);
        imageBase64 = extractBase64(photo);

      } else {
        console.error('[SCAN] No known camera method found on:', proto.join(', '));
        await session.audio.speak('Camera not supported. Please update the app.');
        return;
      }

    } catch (err: any) {
      console.error('[SCAN] Camera capture failed:', err.message);
      await session.audio.speak('Camera error. Please retry.');
      return;
    }

    if (!imageBase64) {
      await session.audio.speak('No image data received. Please retry.');
      return;
    }

    console.log('[SCAN] Got frame, base64 length:', imageBase64.length);

    // Detect cards via Claude Vision
    let detectedCards: DetectedCard[] = [];
    try {
      detectedCards = await this.detectCards(imageBase64);
      console.log(`[SCAN] Cards detected: ${detectedCards.length}`);
    } catch (err: any) {
      console.error('[SCAN] detectCards threw:', err.message);
      await session.audio.speak('Detection error. Please retry.');
      return;
    }

    // Update state and announce
    if (detectedCards.length === 0) {
      const decksLeft = Math.max(state.decks - state.cardsSeen / 52, 0.5);
      const trueCount = Math.round(state.runningCount / decksLeft);
      await session.audio.speak(`No cards detected. True count: ${trueCount}.`);
    } else {
      for (const card of detectedCards) {
        state.runningCount += this.getCardValue(card.rank);
        state.cardsSeen++;
        if (['10', 'J', 'Q', 'K', 'A'].includes(card.rank)) state.highSeen++;
      }
      const newDecksLeft = Math.max(state.decks - state.cardsSeen / 52, 0.5);
      const trueCount = Math.round(state.runningCount / newDecksLeft);
      const highLeft = state.totalHigh - state.highSeen;
      await session.audio.speak(
        `Detected ${detectedCards.length} card${detectedCards.length > 1 ? 's' : ''}. Running: ${state.runningCount}. True: ${trueCount}. High left: ${highLeft}.`
      );
    }
  }

  // ─── Claude Vision Card Detection ──────────────────────────────────────────

  private async detectCards(imageBase64: string): Promise<DetectedCard[]> {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      console.error('[CLAUDE] ANTHROPIC_API_KEY not set in .env');
      return [];
    }

    console.log('[CLAUDE] Sending image to Claude Vision, base64 length:', imageBase64.length);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: imageBase64
                }
              },
              {
                type: 'text',
                text: `Look at this image and identify every playing card visible.
For each card return its rank and suit.
Rank must be one of: A, 2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K
Suit must be one of: spades, hearts, diamonds, clubs

Respond ONLY with valid JSON — no explanation, no markdown, no extra text.
Format: {"cards": [{"rank": "A", "suit": "spades"}, {"rank": "10", "suit": "hearts"}]}
If no playing cards are visible respond: {"cards": []}`
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[CLAUDE] API error:', response.status, errText);
      throw new Error(`Claude API returned ${response.status}: ${errText}`);
    }

    const data = await response.json();
    console.log('[CLAUDE] Raw response:', JSON.stringify(data));

    // Extract text from response
    const text = (data.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');

    console.log('[CLAUDE] Extracted text:', text);

    // Strip any accidental markdown fences and parse JSON
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    const cards: DetectedCard[] = (parsed.cards ?? []).filter(
      (c: any) => typeof c.rank === 'string' && typeof c.suit === 'string'
    );

    console.log('[CLAUDE] Parsed cards:', JSON.stringify(cards));
    return cards;
  }

  // ─── Hi-Lo Card Value ───────────────────────────────────────────────────────

  private getCardValue(rank: string): number {
    if (['2', '3', '4', '5', '6'].includes(rank)) return 1;   // low  → count up
    if (['7', '8', '9'].includes(rank)) return 0;              // neutral
    return -1;                                                  // 10, J, Q, K, A → count down
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT) || 8080;

const server = new CardCounterApp({
  packageName: 'com.yakov.cardcounter',
  apiKey: process.env.MENTRA_API_KEY!,
  port,
  host: '0.0.0.0',
  // Tell the SDK we need transcription before session starts
  // so it sends the correct subscriptions at CONNECTION_ACK time
  requiredPermissions: ['microphone'],
  subscriptions: ['transcription'],
});

server.start()
  .then(() => console.log(`✅ Card Counter running on port ${port}`))
  .catch(err => {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  });
