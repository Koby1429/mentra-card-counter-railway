import { AppServer, AppSession } from '@mentra/sdk';
// FIX: Use the correct, existing package name
import { GoogleGenerativeAI } from "@google/generative-ai"; 
import * as dotenv from 'dotenv';
import express from 'express';

dotenv.config();

// FIX: Correct Initialization for the @google/generative-ai SDK
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

interface SessionState {
  runningCount: number;
  cardsSeen: number;
  highSeen: number;
  decks: number;
  totalHigh: number;
  isStreaming: boolean;
}

const sessionStates = new Map<string, SessionState>();
const transcriptionHandlers = new Map<string, (data: any) => void>();

class CardCounterApp extends AppServer {
  constructor(options: any) {
    super(options);
    const app = this.getExpressApp();

    app.get('/health', (req, res) => res.status(200).send('System Online'));

    app.get('/webview', (req, res) => {
      res.status(200).send(`
        <html>
          <head>
            <title>Gemini Card Counter</title>
            <style>
              body { font-family: sans-serif; background: #1a1a1a; color: #eee; text-align: center; }
              .card { background: #333; border-radius: 10px; padding: 20px; margin: 20px auto; max-width: 400px; }
              .stat-val { font-size: 2.5em; color: #4CAF50; }
              button { padding: 12px 20px; margin: 5px; cursor: pointer; font-weight: bold; border-radius: 5px; border: none; }
              .start { background: #4CAF50; color: white; }
              .stop { background: #f44336; color: white; }
            </style>
          </head>
          <body>
            <h1>Blackjack Analytics (Gemini)</h1>
            <div class="card">
              <div class="label">True Count</div>
              <div id="trueCount" class="stat-val">0</div>
              <div id="cardsSeen">Cards Seen: 0</div>
            </div>
            <button class="start" onclick="trigger('start streaming')">Start Feed</button>
            <button class="stop" onclick="trigger('stop streaming')">Stop Feed</button>
            <script>
              setInterval(async () => {
                const r = await fetch('/stats');
                const d = await r.json();
                document.getElementById('trueCount').textContent = d.trueCount;
                document.getElementById('cardsSeen').textContent = "Cards Seen: " + d.cardsSeen;
              }, 2000);
              async function trigger(cmd) {
                await fetch('/action', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ command: cmd }) });
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
      res.json({ trueCount, cardsSeen: state.cardsSeen, highLeft: state.totalHigh - state.highSeen });
    });

    app.post('/action', express.json(), (req, res) => {
      const handler = Array.from(transcriptionHandlers.values())[0];
      if (handler) handler({ text: req.body.command });
      res.sendStatus(200);
    });
  }

  private getDefaultState(): SessionState {
    return { runningCount: 0, cardsSeen: 0, highSeen: 0, decks: 6, totalHigh: 120, isStreaming: false };
  }

  protected async onSession(session: AppSession, sessionId: string): Promise<void> {
    sessionStates.set(sessionId, this.getDefaultState());

    const runStream = async () => {
      const state = sessionStates.get(sessionId);
      if (!state || !state.isStreaming) return;

      const ok = await this.performScan(session, state);
      if (!ok) return; // WebSocket closed

      setTimeout(runStream, 4000); 
    };

    const onTrans = async (data: any) => {
      const text = data.text.toLowerCase();
      const state = sessionStates.get(sessionId)!;
      if (text.includes('start streaming')) {
        state.isStreaming = true;
        await session.audio.speak('Gemini analyzing.');
        runStream();
      } else if (text.includes('stop streaming')) {
        state.isStreaming = false;
        await session.audio.speak('Stopped.');
      }
    };

    session.events.onTranscription(onTrans);
    transcriptionHandlers.set(sessionId, onTrans);
  }

  private async performScan(session: AppSession, state: SessionState): Promise<boolean> {
    try {
      const photo: any = await session.camera.requestPhoto();
      const buffer = photo.buffer || photo.photoData || photo.data;
      if (!buffer) return true;

      // Ensure we have a Base64 string from the Buffer
      const base64Data = Buffer.isBuffer(buffer) ? buffer.toString('base64') : buffer;

      const prompt = "Act as a card counter. List the ranks of all unique playing cards visible. Format: rank, rank. If none, say 'none'.";
      
      const result = await model.generateContent([
        prompt,
        { inlineData: { data: base64Data, mimeType: "image/jpeg" } }
      ]);

      const text = result.response.text().toUpperCase();
      if (text.includes('NONE')) return true;

      const ranks = text.split(',').map(r => r.trim());
      ranks.forEach(rank => {
        if (/^(10|[2-9]|[JQKA])$/.test(rank)) {
          state.runningCount += this.getCardValue(rank);
          state.cardsSeen++;
          if (['10', 'J', 'Q', 'K', 'A'].includes(rank)) state.highSeen++;
        }
      });

      const trueCount = Math.floor(state.runningCount / (Math.max(0.5, state.decks - (state.cardsSeen / 52))));
      if (Math.abs(trueCount) >= 1) await session.audio.speak(`Count ${trueCount}`);

      return true;
    } catch (err: any) {
      return !err.message.includes("closed");
    }
  }

  private getCardValue(rank: string): number {
    if (['2', '3', '4', '5', '6'].includes(rank)) return 1;
    if (['7', '8', '9'].includes(rank)) return 0;
    return -1;
  }
}

new CardCounterApp({
  packageName: 'com.yakov.cardcounter',
  apiKey: process.env.MENTRA_API_KEY!,
  port: Number(process.env.PORT) || 8080
}).start();
