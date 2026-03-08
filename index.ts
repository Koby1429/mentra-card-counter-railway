import { AppServer, AppSession } from '@mentra/sdk';
import * as dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';

dotenv.config();

// Use the key you provided
const GEMINI_API_KEY = "AIzaSyDCfqu-6H_blk6czA7L_EEtmRz3VqKxjLg";

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
      if (state) {
          await this.performScan(session, state);
      }
      // Increased delay slightly to allow for Gemini processing time
      setTimeout(runStream, 4000); 
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
      // Small size is faster for uploading from the glasses
      const photo: any = await session.camera.requestPhoto({ size: 'small' });
      const rawData = photo.photoData || photo.data || photo.buffer || photo.base64 || photo.image;
      if (!rawData) return;

      let base64 = "";
      if (Buffer.isBuffer(rawData)) {
        base64 = rawData.toString('base64');
      } else if (typeof rawData === 'string') {
        base64 = rawData.replace(/^data:image\/\w+;base64,/, "");
      }

      // Use Gemini to detect the ranks
      const detectedRanks = await this.detectCardsWithGemini(base64);
      
      if (detectedRanks.length > 0) {
        detectedRanks.forEach(rank => {
          state.runningCount += this.getCardValue(rank);
          state.cardsSeen++;
          if (['10', 'J', 'Q', 'K', 'A'].includes(rank)) state.highSeen++;
        });

        const decksLeft = Math.max(0.5, state.decks - (state.cardsSeen / 52));
        const trueCount = Math.floor(state.runningCount / decksLeft);
        
        // Show update on the Glass HUD
        await session.display.displayText(`Count: ${trueCount} (Seen: ${state.cardsSeen})`);
        
        // Voice update for significant count changes
        if (trueCount !== 0) {
            await session.audio.speak(`${trueCount > 0 ? 'Plus' : ''} ${trueCount}`);
        }
      }
    } catch (err) {
      console.error('[SCAN_ERR]', err);
    }
  }

  private async detectCardsWithGemini(imageBase64: string): Promise<string[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    try {
      const response = await axios.post(url, {
        contents: [{
          parts: [
            { text: "List the rank of every visible playing card. Use ranks: 2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K, A. Return ONLY a JSON array of strings, e.g. [\"A\", \"10\", \"4\"]. If none, return []." },
            { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }
          ]
        }],
        generationConfig: { response_mime_type: "application/json", temperature: 0.1 }
      });

      const resultText = response.data.candidates[0].content.parts[0].text;
      return JSON.parse(resultText);
    } catch (e) {
      console.error("[GEMINI_ERR]", e);
      return [];
    }
  }

  private getCardValue(rank: string): number {
    const r = rank.toUpperCase();
    if (['2', '3', '4', '5', '6'].includes(r)) return 1;
    if (['7', '8', '9'].includes(r)) return 0;
    if (['10', 'J', 'Q', 'K', 'A'].includes(r)) return -1;
    return 0;
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
