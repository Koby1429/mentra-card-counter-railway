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
let pendingCommand: string | null = null; // queues commands that arrive before session is ready

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
            <title>Card Counter Dashboard</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #1a1a2e; color: #eee; }
              h1 { color: #4CAF50; }
              .stats { margin: 20px auto; font-size: 20px; max-width: 300px; }
              .stat { background: #16213e; border-radius: 8px; padding: 12px; margin: 8px 0; }
              .label { color: #aaa; font-size: 14px; }
              .value { font-size: 28px; font-weight: bold; color: #4CAF50; }
              .buttons { margin-top: 20px; }
              button { padding: 10px 20px; margin: 6px; background: #4CAF50; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 15px; }
              button:hover { background: #45a049; }
              button.danger { background: #e53935; }
              button.danger:hover { background: #c62828; }
              #connStatus { font-size: 14px; margin: 8px 0; }
            </style>
          </head>
          <body>
            <h1>🃏 Card Counter</h1>
            <p>Stats refresh every 5 seconds</p>
            <div class="stats">
              <div class="stat"><div class="label">True Count</div><div class="value" id="trueCount">—</div></div>
              <div class="stat"><div class="label">High Cards Left</div><div class="value" id="highLeft">—</div></div>
              <div class="stat"><div class="label">Cards Seen</div><div class="value" id="cardsSeen">—</div></div>
            </div>
            <p id="connStatus">Checking connection...</p>
            <div class="buttons">
              <button onclick="trigger('scan cards')">📷 Scan</button>
              <button onclick="trigger('start streaming')">▶ Start Stream</button>
              <button onclick="trigger('stop streaming')">⏹ Stop Stream</button>
              <button onclick="trigger('status')">📊 Status</button>
              <button class="danger" onclick="trigger('new shoe')">🔄 New Shoe</button>
            </div>
            <script>
              async function update() {
                try {
                  const r = await fetch('/stats');
                  const d = await r.json();
                  document.getElementById('trueCount').textContent = d.trueCount;
                  document.getElementById('highLeft').textContent = d.highLeft;
                  document.getElementById('cardsSeen').textContent = d.cardsSeen;
                } catch (e) { console.error('Stats fetch error:', e); }
              }
              setInterval(update, 5000);
              update();

              async function checkConnection() {
                try {
                  const r = await fetch('/session-status');
                  const d = await r.json();
                  const el = document.getElementById('connStatus');
                  el.textContent = d.connected ? '🟢 Glasses Connected' : '🔴 Glasses Not Connected';
                  el.style.color = d.connected ? '#4CAF50' : '#e53935';
                } catch(e) {}
              }
              setInterval(checkConnection, 3000);
              checkConnection();

              async function trigger(cmd) {
                try {
                  const r = await fetch('/action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: cmd })
                  });
                  const d = await r.json();
                  if (r.status === 202) {
                    document.getElementById('connStatus').textContent = '⏳ Queued — waiting for glasses to connect...';
                  }
                  setTimeout(update, 500);
                } catch (e) { alert('Error sending command: ' + cmd); }
              }
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
      res.json({ trueCount, highLeft, cardsSeen: state.cardsSeen });
    });

    // Session status — lets webview know if glasses are connected
    app.get('/session-status', (_req, res) => {
      res.json({ connected: transcriptionHandlers.size > 0 });
    });

    // Action trigger from webview buttons
    app.post('/action', (req, res) => {
      const { command } = req.body;
      if (!command || typeof command !== 'string') {
        return res.status(400).send('Missing command');
      }
      console.log(`[ACTION] Triggered: ${command}`);
      const handler = Array.from(transcriptionHandlers.values())[0];
      if (handler) {
        handler({ text: command });
        res.status(200).json({ status: 'ok' });
      } else {
        pendingCommand = command;
        console.warn(`[ACTION] No session yet, queued: "${command}"`);
        res.status(202).json({ status: 'queued', message: 'Glasses not connected yet. Will run when connected.' });
      }
    });
  }

  // ─── Session Lifecycle ──────────────────────────────────────────────────────

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[SESSION] Started: ${sessionId} (user: ${userId})`);

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
    console.log('[SCAN] Requesting photo...');
    let photo: any;

    try {
      // Use event listener pattern — requestPhoto() promise never resolves on this SDK version.
      // Instead: register a one-shot onPhotoTaken listener, then trigger the capture.
      photo = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Photo capture timed out after 20s'));
        }, 20000);

        // One-shot listener: fires on next photo taken
        const unsub = session.camera.onPhotoTaken((p: any) => {
          clearTimeout(timeout);
          unsub?.(); // unsubscribe after first photo
          resolve(p);
        });

        // Trigger the capture
        session.camera.requestPhoto().catch(() => {}); // ignore promise, we use the event
      });
    } catch (err: any) {
      console.error('[SCAN] Photo capture failed:', err.message);
      await session.audio.speak('Camera error. Please retry.');
      return;
    }

    if (!photo || typeof photo !== 'object') {
      console.error('[SCAN] Photo is null or not an object:', photo);
      await session.audio.speak('No photo received. Please retry.');
      return;
    }

    console.log('[SCAN] Photo keys:', Object.keys(photo));

    // Extract base64 from whichever key the SDK provides
    let imageBase64: string | null = null;
    const candidateKeys = ['photoData', 'data', 'buffer', 'bytes', 'base64'];

    for (const k of candidateKeys) {
      const val = photo[k];
      if (!val) continue;

      if (Buffer.isBuffer(val) || val instanceof Uint8Array || val instanceof ArrayBuffer) {
        imageBase64 = Buffer.from(val).toString('base64');
        console.log(`[SCAN] Encoded base64 from photo.${k}, length: ${imageBase64.length}`);
        break;
      } else if (typeof val === 'string') {
        imageBase64 = val.replace(/^data:image\/\w+;base64,/, '');
        console.log(`[SCAN] Using string from photo.${k}, length: ${imageBase64.length}`);
        break;
      }
    }

    if (!imageBase64) {
      console.error('[SCAN] Could not extract image data. Available keys:', Object.keys(photo));
      await session.audio.speak('Could not read photo data. Please retry.');
      return;
    }

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
