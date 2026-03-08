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

    app.post('/webhook', express.json(), (req, res) => {
      console.log('Webhook received:', req.body);
      res.status(200).send('OK');
    });

    app.get('/webview', (req, res) => {
      res.status(200).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Card Counter Dashboard</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body { font-family: Arial; text-align: center; padding: 20px; background: #111; color: white; }
              h1 { color: #4CAF50; }
              .stats { margin: 20px auto; font-size: 20px; max-width: 300px; }
              .stat { background: #222; border-radius: 10px; padding: 12px; margin: 8px 0; }
              .label { font-size: 12px; color: #888; }
              .value { font-size: 36px; font-weight: bold; color: #4CAF50; }
              button { padding: 12px 24px; margin: 8px; background: #4CAF50; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 16px; width: 90%; max-width: 300px; display: block; margin: 8px auto; }
              button:hover { background: #45a049; }
              .danger { background: #e53935; }
              .danger:hover { background: #c62828; }
              #status { color: #888; font-size: 12px; margin-top: 12px; }
            </style>
          </head>
          <body>
            <h1>♠ Card Counter</h1>
            <div class="stats">
              <div class="stat"><div class="label">TRUE COUNT</div><div class="value" id="trueCount">-</div></div>
              <div class="stat"><div class="label">RUNNING COUNT</div><div class="value" id="runningCount">-</div></div>
              <div class="stat"><div class="label">HIGH CARDS LEFT</div><div class="value" id="highLeft">-</div></div>
              <div class="stat"><div class="label">CARDS SEEN</div><div class="value" id="cardsSeen">-</div></div>
            </div>
            <button onclick="trigger('scan cards')">📸 Scan Cards</button>
            <button onclick="trigger('start streaming')">▶ Start Streaming</button>
            <button onclick="trigger('stop streaming')">⏹ Stop Streaming</button>
            <button onclick="trigger('status')">📊 Status</button>
            <button class="danger" onclick="trigger('new shoe')">🔄 New Shoe</button>
            <div id="status">Loading...</div>
            <script>
              async function update() {
                try {
                  const r = await fetch('/stats');
                  const d = await r.json();
                  document.getElementById('trueCount').textContent = (d.trueCount >= 0 ? '+' : '') + d.trueCount;
                  document.getElementById('runningCount').textContent = (d.runningCount >= 0 ? '+' : '') + d.runningCount;
                  document.getElementById('highLeft').textContent = d.highLeft;
                  document.getElementById('cardsSeen').textContent = d.cardsSeen;
                  document.getElementById('status').textContent = 'Updated: ' + new Date().toLocaleTimeString();
                } catch(e) {
                  document.getElementById('status').textContent = 'Connection error';
                }
              }
              setInterval(update, 3000);
              update();
              async function trigger(cmd) {
                try {
                  await fetch('/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: cmd }) });
                  document.getElementById('status').textContent = 'Sent: ' + cmd;
                  setTimeout(update, 1000);
                } catch(e) {
                  document.getElementById('status').textContent = 'Error sending command';
                }
              }
            </script>
          </body>
        </html>
      `);
    });

    app.get('/stats', (req, res) => {
      const state = Array.from(sessionStates.values())[0] || { runningCount: 0, cardsSeen: 0, highSeen: 0, decks: 6, totalHigh: 120 };
      const decksLeft = Math.max(state.decks - (state.cardsSeen / 52), 0.1);
      const trueCount = Math.round(state.runningCount / decksLeft);
      const highLeft = state.totalHigh - state.highSeen;
      res.json({ trueCount, runningCount: state.runningCount, highLeft, cardsSeen: state.cardsSeen });
    });

    app.post('/action', express.json(), (req, res) => {
      const { command } = req.body;
      console.log(`[ACTION] Triggered: ${command}`);
      const handler = Array.from(transcriptionHandlers.values())[0];
      if (handler) handler({ text: command });
      res.status(200).send('OK');
    });
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[SESSION] Start: ${sessionId}`);
    sessionStates.set(sessionId, { runningCount: 0, cardsSeen: 0, highSeen: 0, decks: 6, totalHigh: 120 });

    let streamingInterval: NodeJS.Timeout | null = null;

    await session.audio.speak('Ready. Say scan cards or start streaming.');

    const onTrans = async (data: any) => {
      const text = data.text.toLowerCase().trim();
      console.log(`[TRANS] "${text}"`);

      if (text.includes('scan cards')) {
        await this.performScan(session, sessionStates.get(sessionId)!);
      } else if (text.includes('start streaming')) {
        if (streamingInterval) { await session.audio.speak('Already streaming.'); return; }
        await session.audio.speak('Streaming started.');
        streamingInterval = setInterval(() => this.performScan(session, sessionStates.get(sessionId)!), 3000);
      } else if (text.includes('stop streaming')) {
        if (streamingInterval) {
          clearInterval(streamingInterval);
          streamingInterval = null;
          await session.audio.speak('Streaming stopped.');
        }
      } else if (text.includes('new shoe')) {
        const state = sessionStates.get(sessionId)!;
        state.runningCount = state.cardsSeen = state.highSeen = 0;
        await session.audio.speak('New shoe started.');
      } else if (text.includes('status')) {
        const state = sessionStates.get(sessionId)!;
        const decksLeft = Math.max(state.decks - (state.cardsSeen / 52), 0.1);
        const trueCount = Math.round(state.runningCount / decksLeft);
        const highLeft = state.totalHigh - state.highSeen;
        await session.audio.speak(`True count ${trueCount}. High cards left ${highLeft}.`);
      }
    };

    session.events.onTranscription(onTrans);
    transcriptionHandlers.set(sessionId, onTrans);

    this.addCleanupHandler(() => {
      if (streamingInterval) clearInterval(streamingInterval);
      sessionStates.delete(sessionId);
      transcriptionHandlers.delete(sessionId);
      console.log(`[SESSION] Cleanup: ${sessionId}`);
    });
  }

  private async performScan(session: AppSession, state: any): Promise<void> {
    try {
      console.log('[SCAN] Requesting photo...');
      const photo = await Promise.race([
        session.camera.requestPhoto(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Photo timeout after 60s')), 60000))
      ]) as any;

      console.log('[SCAN] Photo keys:', Object.keys(photo));

      // Extract image data from whichever key the SDK uses
      let imageBase64: string | null = null;

      for (const k of ['photoData', 'data', 'buffer', 'bytes', 'base64', 'image']) {
        if (photo[k]) {
          const raw = photo[k];
          if (Buffer.isBuffer(raw) || raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
            imageBase64 = Buffer.from(raw).toString('base64');
          } else if (typeof raw === 'string') {
            imageBase64 = raw.replace(/^data:image\/\w+;base64,/, '');
          }
          console.log(`[SCAN] Image from key "${k}", base64 length: ${imageBase64?.length}`);
          break;
        }
      }

      if (!imageBase64) {
        throw new Error(`No image data found. Photo keys were: ${Object.keys(photo).join(', ')}`);
      }

      const cards = await this.detectCards(imageBase64);
      console.log(`[SCAN] Detected ${cards.length} cards:`, cards);

      if (cards.length === 0) {
        const decksLeft = Math.max(state.decks - (state.cardsSeen / 52), 0.1);
        const trueCount = Math.round(state.runningCount / decksLeft);
        await session.audio.speak(`No cards detected. True count ${trueCount}.`);
      } else {
        for (const card of cards) {
          state.runningCount += this.getCardValue(card.rank);
          state.cardsSeen++;
          if (['10', 'J', 'Q', 'K', 'A'].includes(card.rank)) state.highSeen++;
        }
        const decksLeft = Math.max(state.decks - (state.cardsSeen / 52), 0.1);
        const trueCount = Math.round(state.runningCount / decksLeft);
        const highLeft = state.totalHigh - state.highSeen;
        await session.audio.speak(`${cards.length} cards. Running ${state.runningCount}. True ${trueCount}. High left ${highLeft}.`);
      }

    } catch (error: any) {
      console.error('[SCAN] Error:', error.message);
      await session.audio.speak('Scan error. Please retry.');
    }
  }

  private async detectCards(imageBase64: string): Promise<any[]> {
    try {
      console.log('[DETECT] Sending to Base44...');
      const response = await axios.post(
        BASE44_WEBHOOK_URL,
        { imageBase64: `data:image/jpeg;base64,${imageBase64}` },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-webhook-secret': GLASS_WEBHOOK_SECRET
          },
          timeout: 30000
        }
      );
      console.log('[DETECT] Base44 response:', response.data);
      return response.data?.cards || [];
    } catch (error: any) {
      console.error('[DETECT] Base44 error:', error.message);
      return [];
    }
  
