import { AppServer, AppSession } from '@mentra/sdk';
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as dotenv from 'dotenv';
import express from 'express';

dotenv.config();

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
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

    // Dashboard UI remains the same...
    app.get('/webview', (req, res) => {
      res.status(200).send(`
        <html>
          <head><title>Card Counter Pro</title>
          <style>
            body { font-family: sans-serif; background: #1a1a1a; color: #eee; text-align: center; }
            .card { background: #333; border-radius: 10px; padding: 20px; margin: 20px auto; max-width: 400px; }
            .stat-val { font-size: 2.5em; color: #4CAF50; }
          </style></head>
          <body>
            <h1>Blackjack Analytics (Gemini AI)</h1>
            <div class="card">
              <div id="trueCount" class="stat-val">0</div>
              <p>True Count</p>
            </div>
            <button onclick="trigger('start streaming')">Start</button>
            <button onclick="trigger('stop streaming')">Stop</button>
            <script>
              setInterval(async () => {
                const r = await fetch('/stats');
                const d = await r.json();
                document.getElementById('trueCount').textContent = d.trueCount;
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
      res.json({ trueCount, cardsSeen: state.cardsSeen });
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
    console.log(`[SESSION] New Connection: ${sessionId}`);
    sessionStates.set(sessionId, this.getDefaultState());

    let sessionAlive = true;

    const runStream = async () => {
      const state = sessionStates.get(sessionId);
      if (!sessionAlive || !state || !state.isStreaming) return;

      const success = await this.performScan(session, state);
      if (!success) {
        sessionAlive = false;
        return; 
      }

      setTimeout(runStream, 4000); // 4s interval for Gemini processing
    };

    const onTrans = async (data: any) => {
      const text = data.text.toLowerCase();
      const state = sessionStates.get(sessionId);
      if (!state) return;

      if (text.includes('start streaming')) {
        if (!state.isStreaming) {
          state.isStreaming = true;
          await session.audio.speak('Gemini Engine Online.');
          runStream();
        }
      } else if (text.includes('stop streaming')) {
        state.isStreaming = false;
        await session.audio.speak('Engine Offline.');
      } else if (text.includes('new shoe')) {
        sessionStates.set(sessionId, this.getDefaultState());
        await session.audio.speak('Shoe reset.');
      }
    };

    session.events.onTranscription(onTrans);
    transcriptionHandlers.set(sessionId, onTrans);

    this.addCleanupHandler(() => {
      sessionAlive = false;
      sessionStates.delete(sessionId);
      transcriptionHandlers.delete(sessionId);
    });
  }

  private async performScan(session: AppSession, state: SessionState): Promise<boolean> {
    try {
      const photo: any = await session.camera.requestPhoto();
      const rawData = photo.photoData || photo.data || photo.buffer;
      if (!rawData) return true;

      const base64 = Buffer.isBuffer(rawData) ? rawData.toString('base64') : rawData;

      // Use Gemini to detect cards with zero-shot spatial reasoning
      const detected = await this.detectCardsWithGemini(base64);
      
      if (detected.length > 0) {
        detected.forEach(rank => {
          state.runningCount += this.getCardValue(rank);
          state.cardsSeen++;
        });

        const decksLeft = Math.max(0.5, state.decks - (state.cardsSeen / 52));
        const trueCount = Math.floor(state.runningCount / decksLeft);
        
        if (trueCount !== 0) {
          await session.audio.speak(`Count ${trueCount}`);
        }
      }
      return true;
    } catch (err: any) {
      if (err.message.includes("WebSocket") || err.message.includes("not established")) {
        return false; 
      }
      return true;
    }
  }

  private async detectCardsWithGemini(imageBase64: string): Promise<string[]> {
    try {
      const prompt = "Identify all blackjack playing card ranks visible. Return ONLY a comma-separated list of ranks (e.g., 2, K, A, 10). If none, return 'none'. Do not repeat the same physical card.";
      
      const result = await model.generateContent([
        prompt,
        { inlineData: { data: imageBase64, mimeType: "image/jpeg" } }
      ]);

      const responseText = result.response.text().trim();
      if (responseText.toLowerCase() === 'none') return [];

      // Clean up Gemini output
      return responseText.split(',')
        .map(s => s.trim().toUpperCase())
        .filter(s => /^(10|[2-9]|[JQKA])$/.test(s));

    } catch (e) {
      console.error("[GEMINI_ERR]", e);
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
}).start().then(() => console.log(`Gemini Card Counter Live on ${port}`));
