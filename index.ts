import { AppServer, AppSession } from '@mentra/sdk';
import * as dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';

dotenv.config();

const BASE44_WEBHOOK_URL = process.env.BASE44_WEBHOOK_URL!;
const GLASS_WEBHOOK_SECRET = process.env.GLASS_WEBHOOK_SECRET!;

const sessionStates = new Map<string, { runningCount: number; cardsSeen: number; highSeen: number; decks: number; totalHigh: number }>();
const transcriptionHandlers = new Map<string, (data: any) => void>();

class CardCounterApp extends AppServer {
  constructor(options: any) {
    super(options);

    const app = this.getExpressApp();

    app.get('/health', (req, res) => res.status(200).send('OK - Card Counter running!'));

    app.get('/stats', (req, res) => {
      const state = Array.from(sessionStates.values())[0] || { runningCount: 0, cardsSeen: 0, highSeen: 0, decks: 6, totalHigh: 120 };
      const decksLeft = state.decks - (state.cardsSeen / 52);
      const trueCount = decksLeft > 0 ? Math.round(state.runningCount / decksLeft) : 0;
      const highLeft = state.totalHigh - state.highSeen;
      res.json({ trueCount, highLeft, cardsSeen: state.cardsSeen, runningCount: state.runningCount });
    });

    app.post('/action', express.json(), (req, res) => {
      const { command } = req.body;
      const handler = Array.from(transcriptionHandlers.values())[0];
      if (handler) handler({ text: command });
      res.status(200).send('OK');
    });

    app.get('/webview', (req, res) => {
      res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Card Counter</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #111; color: white; padding: 24px; text-align: center; }
    h2 { font-size: 22px; margin-bottom: 24px; color: #aaa; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
    .card { background: #1f1f1f; border-radius: 12px; padding: 20px 10px; }
    .label { font-size: 12px; color: #666; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
    .value { font-size: 48px; font-weight: bold; }
    .tc { color: #22c55e; }
    .rc { color: #3b82f6; }
    .hl { color: #f59e0b; }
    .cs { color: #a78bfa; }
    .btn { background: #22c55e; color: black; border: none; border-radius: 10px; padding: 14px 28px; font-size: 16px; font-weight: bold; cursor: pointer; width: 100%; margin-top: 8px; }
    .btn-red { background: #ef4444; color: white; margin-top: 10px; }
    .status { font-size: 12px; color: #555; margin-top: 16px; }
  </style>
</head>
<body>
  <h2>♠ Card Counter</h2>
  <div class="grid">
    <div class="card">
      <div class="label">True Count</div>
      <div class="value tc" id="tc">-</div>
    </div>
    <div class="card">
      <div class="label">Running Count</div>
      <div class="value rc" id="rc">-</div>
    </div>
    <div class="card">
      <div class="label">High Cards Left</div>
      <div class="value hl" id="hl">-</div>
    </div>
    <div class="card">
      <div class="label">Cards Seen</div>
      <div class="value cs" id="cs">-</div>
    </div>
  </div>

  <button class="btn" onclick="sendCommand('scan cards')">📸 Scan Cards</button>
  <button class="btn" style="background:#3b82f6;color:white;margin-top:10px" onclick="sendCommand('start streaming')">▶ Start Streaming</button>
  <button class="btn" style="background:#6b7280;color:white;margin-top:10px" onclick="sendCommand('stop streaming')">⏹ Stop Streaming</button>
  <button class="btn btn-red" onclick="sendCommand('new shoe')">🔄 New Shoe</button>

  <div class="status" id="status">Updating...</div>

  <script>
    async function refresh() {
      try {
        const r = await fetch('/stats');
        const d = await r.json();
        document.getElementById('tc').textContent = d.trueCount >= 0 ? '+' + d.trueCount : d.trueCount;
        document.getElementById('rc').textContent = d.runningCount >= 0 ? '+' + d.runningCount : d.runningCount;
        document.getElementById('hl').textContent = d.highLeft;
        document.getElementById('cs').textContent = d.cardsSeen;
        document.getElementById('status').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
      } catch(e) {
        document.getElementById('status').textContent = 'Connection error';
      }
    }

    async function sendCommand(cmd) {
      await fetch('/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd })
      });
      document.getElementById('status').textContent = 'Sent: ' + cmd;
      setTimeout(refresh, 1000);
    }

    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`);
    });
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[SESSION] Start: ${sessionId}`);
    sessionStates.set(sessionId, { runningCount: 0, cardsSeen: 0, highSeen: 0, decks: 6, totalHigh: 120 });

    let streamingInterval: NodeJS.Timeout | null = null;

    await session.audio.speak('Ready. Say "scan cards" or "start streaming".');

    const onTrans = async (data: any) => {
      const text = data.text.toLowerCase().trim();
      const state = sessionStates.get(sessionId)!;

      if (text.includes('scan cards')) {
        await this.performScan(session, state);
      } else if (text.includes('start streaming')) {
        if (streamingInterval) return await session.audio.speak('Already streaming.');
        await session.audio.speak('Streaming started.');
        streamingInterval = setInterval(() => this.performScan(session, state), 3000);
      } else if (text.includes('stop streaming')) {
        if (streamingInterval) {
          clearInterval(streamingInterval);
          streamingInterval = null;
          await session.audio.speak('Stopped.');
        }
      } else if (text.includes('new shoe')) {
        state.runningCount = state.cardsSeen = state.highSeen = 0;
        await session.audio.speak('New shoe started.');
      } else if (text.includes('status')) {
        const decksLeft = state.decks - (state.cardsSeen / 52);
        const trueCount = decksLeft > 0 ? Math.round(state.runningCount / decksLeft) : 0;
        const highLeft = state.totalHigh - state.highSeen;
        await session.audio.speak(`True count: ${trueCount}. High cards left: ${highLeft}.`);
      }
    };

    session.events.onTranscription(onTrans);
    transcriptionHandlers.set(sessionId, onTrans);

    this.addCleanupHandler(() => {
      if (streamingInterval) clearInterval(streamingInterval);
      sessionStates.delete(sessionId);
      transcriptionHandlers.delete(sessionId);
    });
  }

  private async performScan(session: AppSession, state: any): Promise<void> {
    try {
      console.log('[SCAN] Capturing photo...');
      const photoPromise = session.camera.requestPhoto();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Photo timeout')), 60000));
      const photo = await Promise.race([photoPromise, timeoutPromise]) as any;

      let imageBase64: string | null = null;
      for (const k of ['photoData', 'data', 'buffer', 'bytes']) {
        if (photo[k]) {
          const raw = photo[k];
          if (Buffer.isBuffer(raw) || raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
            imageBase64 = Buffer.from(raw).toString('base64');
          } else if (typeof raw === 'string') {
            imageBase64 = raw.replace(/^data:image\/jpeg;base64,/, '');
          }
          break;
        }
      }
      if (!imageBase64 && photo.base64) {
        imageBase64 = photo.base64.replace(/^data:image\/jpeg;base64,/, '');
      }
      if (!imageBase64) throw new Error('No usable image data from camera');

      const webhookRes = await axios.post(
        BASE44_WEBHOOK_URL,
        { imageBase64: `data:image/jpeg;base64,${imageBase64}` },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-webhook-secret': GLASS_WEBHOOK_SECRET
          }
        }
      );

      const cards = webhookRes.data?.cards || [];
      console.log(`[SCAN] Base44 detected ${cards.length} cards`);

      if (cards.length === 0) {
        await session.audio.speak('No cards detected.');
      } else {
        for (const card of cards) {
          const value = this.getCardValue(card.rank);
          state.runningCount += value;
          state.cardsSeen++;
          if (['10', 'J', 'Q', 'K', 'A'].includes(card.rank)) state.highSeen++;
        }
        const decksLeft = state.decks - (state.cardsSeen / 52);
        const trueCount = decksLeft > 0 ? Math.round(state.runningCount / decksLeft) : 0;
        const highLeft = state.totalHigh - state.highSeen;
        await session.audio.speak(`${cards.length} cards. True count: ${trueCount}. High left: ${highLeft}.`);
      }

    } catch (error: any) {
      console.error('[SCAN] Error:', error.message);
      await session.audio.speak('Scan error. Please retry.');
    }
  }

  private getCardValue(rank: string): number {
    if (['2', '3', '4', '5', '6'].includes(rank)) return 1;
    if (['7', '8', '9'].includes(rank)) return 0;
    return -1;
  }
}

const port = Number(process.env.PORT) || 8080;
const server = new CardCounterApp({
  packageName: 'com.yakov.cardcounter',
  apiKey: process.env.MENTRA_API_KEY!,
  port,
  host: '0.0.0.0'
});
