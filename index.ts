import { AppServer, AppSession } from '@mentra/sdk';
import * as dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';

dotenv.config();

// ─── Session State ────────────────────────────────────────────────────────────

interface SessionState {
  runningCount: number;
  cardsSeen: number;
  highSeen: number;
  decks: number;
  totalHigh: number;
}

const sessionStates = new Map<string, SessionState>();
const transcriptionHandlers = new Map<string, (data: any) => void>();

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

              async function trigger(cmd) {
                try {
                  await fetch('/action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: cmd })
                  });
                  setTimeout(update, 500); // refresh stats after action
                } catch (e) { alert('Error sending command: ' + cmd); }
              }
            </script>
          </body>
        </html>
      `);
    });

    // Stats endpoint — FIX: returns zeroed state if no session yet
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
      } else {
        console.warn('[ACTION] No active session handler found');
      }
      res.status(200).send('OK');
    });
  }

  // ─── Session Lifecycle ──────────────────────────────────────────────────────

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[SESSION] Started: ${sessionId} (user: ${userId})`);

    // Initialize state for this session
    sessionStates.set(sessionId, {
      runningCount: 0,
      cardsSeen: 0,
      highSeen: 0,
      decks: 6,
      totalHigh: 120  // 6 decks × 20 high cards (10, J, Q, K, A per suit)
    });

    let streamingInterval: NodeJS.Timeout | null = null;
    let isScanning = false; // FIX: prevent overlapping scans during streaming

    await session.audio.speak('Card counter ready. Say scan cards or start streaming.');

    // ─── Transcription Handler ──────────────────────────────────────────────

    const onTrans = async (data: any) => {
      const text: string = (data?.text ?? '').toLowerCase().trim();
      if (!text) return;
      console.log(`[TRANS] "${text}"`);

      const state = sessionStates.get(sessionId);
      if (!state) return;

      if (text.includes('scan cards')) {
        await this.performScan(session, state);

      } else if (text.includes('start streaming')) {
        if (streamingInterval) {
          await session.audio.speak('Already streaming.');
          return;
        }
        await session.audio.speak('Streaming started.');
        streamingInterval = setInterval(async () => {
          if (!isScanning) await this.performScan(session, state);
        }, 3000);

      } else if (text.includes('stop streaming')) {
        if (streamingInterval) {
          clearInterval(streamingInterval);
          streamingInterval = null;
          await session.audio.speak('Streaming stopped.');
        } else {
          await session.audio.speak('Not currently streaming.');
        }

      } else if (text.includes('new shoe')) {
        state.runningCount = 0;
        state.cardsSeen = 0;
        state.highSeen = 0;
        await session.audio.speak('New shoe started. Count reset.');

      } else if (text.includes('status')) {
        const decksLeft = Math.max(state.decks - state.cardsSeen / 52, 0.5);
        const trueCount = Math.round(state.runningCount / decksLeft);
        const highLeft = state.totalHigh - state.highSeen;
        await session.audio.speak(
          `Running count ${state.runningCount}. True count ${trueCount}. High cards left: ${highLeft}. Cards seen: ${state.cardsSeen}.`
        );

      } else {
        console.log(`[TRANS] Unrecognized: "${text}"`);
      }
    };

    session.events.onTranscription(onTrans);
    transcriptionHandlers.set(sessionId, onTrans);

    // ─── Cleanup ────────────────────────────────────────────────────────────

    // FIX: cleanup is scoped correctly to this session
    const cleanup = () => {
      if (streamingInterval) {
        clearInterval(streamingInterval);
        streamingInterval = null;
      }
      sessionStates.delete(sessionId);
      transcriptionHandlers.delete(sessionId);
      console.log(`[SESSION] Cleaned up: ${sessionId}`);
    };

    // Listen for session end if SDK supports it; fallback to process exit
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
      // FIX: null-safe photo capture with timeout
      const photoPromise = session.camera.requestPhoto();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Photo capture timed out after 60s')), 60000)
      );
      photo = await Promise.race([photoPromise, timeoutPromise]);
    } catch (err: any) {
      console.error('[SCAN] Photo capture failed:', err.message);
      await session.audio.speak('Camera error. Please retry.');
      return;
    }

    // FIX: null check before accessing keys
    if (!photo || typeof photo !== 'object') {
      console.error('[SCAN] Photo is null or not an object:', photo);
      await session.audio.speak('No photo received. Please retry.');
      return;
    }

    console.log('[SCAN] Photo keys:', Object.keys(photo));

    // Extract base64 image data from whichever key the SDK uses
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

    // Send to Base44 for card detection
    let detectedCards: any[] = [];
    try {
      detectedCards = await this.detectCards(imageBase64);
      console.log(`[SCAN] Cards detected: ${detectedCards.length}`);
    } catch (err: any) {
      console.error('[SCAN] detectCards threw:', err.message);
      await session.audio.speak('Detection error. Please retry.');
      return;
    }

    // Update state and announce result
    const decksLeft = Math.max(state.decks - state.cardsSeen / 52, 0.5);

    if (detectedCards.length === 0) {
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

  // ─── Base44 Integration ─────────────────────────────────────────────────────

  private async detectCards(imageBase64: string): Promise<any[]> {
    const webhookUrl = process.env.BASE44_WEBHOOK_URL;
    const webhookSecret = process.env.GLASS_WEBHOOK_SECRET;

    if (!webhookUrl || !webhookSecret) {
      console.error('[BASE44] BASE44_WEBHOOK_URL or GLASS_WEBHOOK_SECRET not set in .env');
      return [];
    }

    console.log('[BASE44] Calling endpoint:', webhookUrl);
    console.log('[BASE44] Image size (base64 chars):', imageBase64.length);

    const response = await axios.post(
      webhookUrl,
      { imageBase64: `data:image/jpeg;base64,${imageBase64}` },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': webhookSecret
        },
        timeout: 60000
      }
    );

    console.log('[BASE44] Response status:', response.status);
    console.log('[BASE44] Response data:', JSON.stringify(response.data));

    // FIX: safe access with fallback, filter by confidence threshold
    const cards = response.data?.cards ?? [];
    return cards.filter((c: any) => typeof c.confidence === 'number' && c.confidence > 0.6);
  }

  // ─── Hi-Lo Card Value ───────────────────────────────────────────────────────

  private getCardValue(rank: string): number {
    if (['2', '3', '4', '5', '6'].includes(rank)) return 1;   // low cards
    if (['7', '8', '9'].includes(rank)) return 0;              // neutral
    return -1;                                                  // 10, J, Q, K, A
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT) || 8080;

const server = new CardCounterApp({
  packageName: 'com.yakov.cardcounter',
  apiKey: process.env.MENTRA_API_KEY!,
  port,
  host: '0.0.0.0'
});

server.start()
  .then(() => console.log(`✅ Card Counter running on port ${port}`))
  .catch(err => {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  });
