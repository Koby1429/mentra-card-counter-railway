import { AppServer, AppSession } from '@mentra/sdk';
import * as dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';

dotenv.config();

// Types for better state management
interface SessionState {
  runningCount: number;
  cardsSeen: number;
  highSeen: number;
  decks: number;
  totalHigh: number;
}

const sessionStates = new Map<string, SessionState>();
const transcriptionHandlers = new Map<string, (data: any) => void>();

class CardCounterApp extends AppServer {
  constructor(options: any) {
    super(options);
    const app = this.getExpressApp();

    app.get('/health', (req, res) => res.status(200).send('System Online'));

    // Dashboard UI
    app.get('/webview', (req, res) => {
      res.status(200).send(`
        <html>
          <head>
            <title>Card Counter Pro</title>
            <style>
              body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #1a1a1a; color: #eee; text-align: center; padding: 20px; }
              .card { background: #333; border-radius: 10px; padding: 20px; margin: 20px auto; max-width: 400px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
              .stat-val { font-size: 2.5em; font-weight: bold; color: #4CAF50; }
              .label { color: #888; text-transform: uppercase; font-size: 0.8em; }
              button { padding: 12px 24px; margin: 8px; border-radius: 5px; border: none; font-weight: bold; cursor: pointer; transition: 0.3s; }
              .btn-start { background: #4CAF50; color: white; }
              .btn-stop { background: #f44336; color: white; }
              .btn-neutral { background: #555; color: white; }
              button:hover { opacity: 0.8; }
            </style>
          </head>
          <body>
            <h1>Blackjack Analytics</h1>
            <div class="card">
              <div class="label">True Count</div>
              <div id="trueCount" class="stat-val">0</div>
              <hr style="border: 0; border-top: 1px solid #444; margin: 15px 0;">
              <div style="display: flex; justify-content: space-around;">
                <div><div class="label">High Left</div><div id="highLeft">0</div></div>
                <div><div class="label">Cards Seen</div><div id="cardsSeen">0</div></div>
              </div>
            </div>
            <button class="btn-start" onclick="trigger('start streaming')">Start Feed</button>
            <button class="btn-stop" onclick="trigger('stop streaming')">Stop Feed</button>
            <button class="btn-neutral" onclick="trigger('new shoe')">Reset Shoe</button>
            <script>
              async function update() {
                try {
                  const r = await fetch('/stats');
                  const d = await r.json();
                  document.getElementById('trueCount').textContent = d.trueCount;
                  document.getElementById('highLeft').textContent = d.highLeft;
                  document.getElementById('cardsSeen').textContent = d.cardsSeen;
                } catch (e) { console.error(e); }
              }
              setInterval(update, 2000);
              async function trigger(cmd) {
                await fetch('/action', { 
                  method: 'POST', 
                  headers: { 'Content-Type': 'application/json' }, 
                  body: JSON.stringify({ command: cmd }) 
                });
              }
            </script>
          </body>
        </html>
      `);
    });

    app.get('/stats', (req, res) => {
      const state = Array.from(sessionStates.values())[0] || this.getDefaultState();
      const decksLeft = Math.max(0.5, state.decks - (state.cardsSeen / 52));
      const trueCount = Math.floor(state.runningCount / decksLeft);
      res.json({ trueCount, highLeft: state.totalHigh - state.highSeen, cardsSeen: state.cardsSeen });
    });

    app.post('/action', express.json(), (req, res) => {
      const handler = Array.from(transcriptionHandlers.values())[0];
      if (handler) handler({ text: req.body.command });
      res.sendStatus(200);
    });
  }

  private getDefaultState(): SessionState {
    return { runningCount: 0, cardsSeen: 0, highSeen: 0, decks: 6, totalHigh: 120 };
  }

  protected async onSession(session: AppSession, sessionId: string): Promise<void> {
    console.log(`[SESSION] New Connection: ${sessionId}`);
    sessionStates.set(sessionId, this.getDefaultState());

    let isStreaming = false;

    const runStream = async () => {
      if (!isStreaming) return;
      const state = sessionStates.get(sessionId);
      if (state) await this.performScan(session, state);
      setTimeout(runStream, 3500); // Recursive timeout prevents overlapping
    };

    const onTrans = async (data: any) => {
      const text = data.text.toLowerCase();
      const state = sessionStates.get(sessionId)!;

      if (text.includes('scan')) {
        await this.performScan(session, state);
      } else if (text.includes('start streaming')) {
        if (!isStreaming) {
          isStreaming = true;
          await session.audio.speak('Streaming active.');
          runStream();
        }
      } else if (text.includes('stop streaming')) {
        isStreaming = false;
        await session.audio.speak('Stopped.');
      } else if (text.includes('new shoe')) {
        sessionStates.set(sessionId, this.getDefaultState());
        await session.audio.speak('Shoe reset.');
      }
    };

    session.events.onTranscription(onTrans);
    transcriptionHandlers.set(sessionId, onTrans);

    this.addCleanupHandler(() => {
      isStreaming = false;
      sessionStates.delete(sessionId);
      transcriptionHandlers.delete(sessionId);
    });
  }

  private async performScan(session: AppSession, state: SessionState): Promise<void> {
    try {
      const photo: any = await session.camera.requestPhoto();
      const rawData = photo.photoData || photo.data || photo.buffer;
      
      if (!rawData) return;
      const base64 = Buffer.isBuffer(rawData) ? rawData.toString('base64') : rawData;

      const detected = await this.detectCards(base64);
      
      if (detected.length > 0) {
        detected.forEach(rank => {
          state.runningCount += this.getCardValue(rank);
          state.cardsSeen++;
          if (['10', 'J', 'Q', 'K', 'A'].includes(rank)) state.highSeen++;
        });

        const decksLeft = Math.max(0.5, state.decks - (state.cardsSeen / 52));
        const trueCount = Math.floor(state.runningCount / decksLeft);
        
        // Only speak if there is a significant count change
        if (Math.abs(trueCount) >= 1) {
          await session.audio.speak(`True ${trueCount}`);
        }
      }
    } catch (err) {
      console.error('[SCAN_ERR]', err);
    }
  }

  private async detectCards(imageBase64: string): Promise<string[]> {
    const apiKey = process.env.GOOGLE_API_KEY;
    try {
      const resp = await axios.post(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
        requests: [{
          image: { content: imageBase64 },
          features: [{ type: "TEXT_DETECTION" }]
        }]
      });

      const annotations = resp.data.responses[0].textAnnotations || [];
      if (annotations.length === 0) return [];

      // Logic to prevent double-counting: 
      // 1. Extract text and bounding boxes
      // 2. Filter for card ranks
      // 3. Ensure we don't count the same rank in the same physical area (top/bottom of card)
      const foundRanks: { rank: string, y: number, x: number }[] = [];
      const rankPattern = /^(10|[2-9]|[JQKA])$/i;

      annotations.slice(1).forEach((anno: any) => {
        const text = anno.description.toUpperCase();
        if (rankPattern.test(text)) {
          const vert = anno.boundingPoly.vertices[0];
          foundRanks.push({ rank: text, x: vert.x || 0, y: vert.y || 0 });
        }
      });

      // Filter duplicates by proximity (cards are usually > 50px apart)
      const uniqueResults: string[] = [];
      foundRanks.forEach((card, i) => {
        const isDuplicate = foundRanks.some((other, j) => {
          if (i === j) return false;
          const dist = Math.sqrt(Math.pow(card.x - other.x, 2) + Math.pow(card.y - other.y, 2));
          return dist < 60 && card.rank === other.rank; // Adjust distance based on camera resolution
        });
        if (!isDuplicate || i < foundRanks.findIndex(c => c.rank === card.rank)) {
           // We only push once for each physical cluster
           if (!uniqueResults.includes(`${card.rank}-${Math.round(card.x/80)}-${Math.round(card.y/80)}`)) {
              uniqueResults.push(`${card.rank}-${Math.round(card.x/80)}-${Math.round(card.y/80)}`);
           }
        }
      });

      return uniqueResults.map(s => s.split('-')[0]);
    } catch (e) {
      return [];
    }
  }

  private getCardValue(rank: string): number {
    if (['2', '3', '4', '5', '6'].includes(rank)) return 1;
    if (['7', '8', '9'].includes(rank)) return 0;
    return -1;
  }
}

const port = Number(process.env.PORT) || 8080;
new CardCounterApp({
  packageName: 'com.yakov.cardcounter',
  apiKey: process.env.MENTRA_API_KEY!,
  port,
  host: '0.0.0.0'
}).start().then(() => console.log(`Server Live on ${port}`));
