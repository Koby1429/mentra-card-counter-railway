import { AppServer, AppSession } from '@mentra/sdk';
import * as dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';

dotenv.config();

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

    // Health Check
    app.get('/health', (req, res) => res.status(200).send('OK'));

    // Dashboard UI
    app.get('/webview', (req, res) => {
      res.status(200).send(`
        <html>
          <head>
            <title>Card Counter Pro</title>
            <style>
              body { font-family: sans-serif; background: #121212; color: #eee; text-align: center; padding: 20px; }
              .card { background: #1e1e1e; border-radius: 12px; padding: 25px; margin: 20px auto; max-width: 350px; border: 1px solid #333; }
              .stat-val { font-size: 3em; font-weight: bold; color: #4CAF50; margin: 10px 0; }
              .label { color: #888; text-transform: uppercase; letter-spacing: 1px; font-size: 0.75em; }
              .grid { display: flex; justify-content: space-between; margin-top: 20px; }
              button { padding: 15px; width: 80%; margin: 10px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; }
              .btn-start { background: #4CAF50; color: white; }
              .btn-reset { background: #555; color: white; }
            </style>
          </head>
          <body>
            <h2>Table Analytics</h2>
            <div class="card">
              <div class="label">True Count</div>
              <div id="trueCount" class="stat-val">0</div>
              <div class="grid">
                <div><div class="label">Seen</div><div id="cardsSeen">0</div></div>
                <div><div class="label">High Left</div><div id="highLeft">0</div></div>
              </div>
            </div>
            <button class="btn-start" onclick="trigger('start streaming')">Start Analytics</button>
            <button class="btn-reset" onclick="trigger('new shoe')">Reset Shoe</button>
            <script>
              async function update() {
                try {
                  const r = await fetch('/stats');
                  const d = await r.json();
                  document.getElementById('trueCount').textContent = d.trueCount;
                  document.getElementById('cardsSeen').textContent = d.cardsSeen;
                  document.getElementById('highLeft').textContent = d.highLeft;
                } catch (e) {}
              }
              setInterval(update, 1000);
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
    console.log(`[SESSION] Connected: ${sessionId}`);
    sessionStates.set(sessionId, this.getDefaultState());

    let isStreaming = false;

    const runStream = async () => {
      if (!isStreaming) return;
      const state = sessionStates.get(sessionId);
      if (state) await this.performScan(session, state);
      setTimeout(runStream, 3500); 
    };

    const onTrans = async (data: any) => {
      const text = data.text.toLowerCase();
      const state = sessionStates.get(sessionId);
      if (!state) return;

      if (text.includes('start streaming') || text.includes('start analytics')) {
        if (!isStreaming) {
          isStreaming = true;
          await session.audio.speak('Counting active.');
          runStream();
        }
      } else if (text.includes('stop')) {
        isStreaming = false;
        await session.audio.speak('Stopping.');
      } else if (text.includes('new shoe') || text.includes('reset')) {
        sessionStates.set(sessionId, this.getDefaultState());
        await session.audio.speak('New shoe started.');
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
      const rawData = photo.photoData || photo.data || photo.buffer || photo.base64 || photo.image;
      if (!rawData) return;

      let base64 = "";
      if (Buffer.isBuffer(rawData)) {
        base64 = rawData.toString('base64');
      } else if (typeof rawData === 'string') {
        base64 = rawData.replace(/^data:image\/\w+;base64,/, "");
      }

      const detected = await this.detectCards(base64);
      
      if (detected.length > 0) {
        let countChanged = false;
        detected.forEach(rank => {
          state.runningCount += this.getCardValue(rank);
          state.cardsSeen++;
          if (['10', 'J', 'Q', 'K', 'A'].includes(rank)) state.highSeen++;
          countChanged = true;
        });

        if (countChanged) {
          const decksLeft = Math.max(0.5, state.decks - (state.cardsSeen / 52));
          const trueCount = Math.floor(state.runningCount / decksLeft);
          if (trueCount !== 0) {
            await session.audio.speak(`${trueCount > 0 ? 'Plus' : ''} ${trueCount}`);
          }
        }
      }
    } catch (err) {
      console.error('[SCAN_ERR]', err);
    }
  }

  private async detectCards(imageBase64: string): Promise<string[]> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return [];

    try {
      const resp = await axios.post(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
        requests: [{
          image: { content: imageBase64 },
          features: [{ type: "TEXT_DETECTION" }]
        }]
      });

      const annotations = resp.data.responses[0].textAnnotations || [];
      if (annotations.length <= 1) return [];

      const foundRanks: { rank: string, x: number, y: number }[] = [];
      const rankPattern = /^(10|[2-9]|[JQKA])$/i;

      annotations.slice(1).forEach((anno: any) => {
        const text = anno.description.toUpperCase();
        if (rankPattern.test(text)) {
          const v = anno.boundingPoly.vertices[0];
          foundRanks.push({ rank: text, x: v.x || 0, y: v.y || 0 });
        }
      });

      const uniqueResults: string[] = [];
      const processed = new Set<number>();

      for (let i = 0; i < foundRanks.length; i++) {
        if (processed.has(i)) continue;
        uniqueResults.push(foundRanks[i].rank);
        processed.add(i);
        for (let j = i + 1; j < foundRanks.length; j++) {
          const dist = Math.sqrt(Math.pow(foundRanks[i].x - foundRanks[j].x, 2) + Math.pow(foundRanks[i].y - foundRanks[j].y, 2));
          if (dist < 70 && foundRanks[i].rank === foundRanks[j].rank) processed.add(j);
        }
      }
      return uniqueResults;
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
const server = new CardCounterApp({
  packageName: 'com.yakov.cardcounter',
  apiKey: process.env.MENTRA_API_KEY!,
  port,
  host: '0.0.0.0'
});

server.start().then(() => console.log(`Card Counter Engine Live on Port ${port}`));
