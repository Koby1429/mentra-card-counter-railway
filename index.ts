import { AppServer, AppSession } from '@mentra/sdk';
import { GoogleGenAI } from "@google/genai"; // The new 2026 standard SDK
import * as dotenv from 'dotenv';
import express from 'express';

dotenv.config();

// Initialize the New 2026 SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
// Using 2.5 Flash for the fastest vision processing available in 2026
const modelName = 'gemini-2.5-flash';

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

    // Stats for your Webview
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
    return { runningCount: 0, cardsSeen: 0, highSeen: 0, decks: 6, totalHigh: 120, isStreaming: false };
  }

  protected async onSession(session: AppSession, sessionId: string): Promise<void> {
    sessionStates.set(sessionId, this.getDefaultState());

    const runStream = async () => {
      const state = sessionStates.get(sessionId);
      if (!state || !state.isStreaming) return;

      const success = await this.performScan(session, state);
      if (!success) return; 

      setTimeout(runStream, 3500); 
    };

    const onTrans = async (data: any) => {
      const text = data.text.toLowerCase();
      const state = sessionStates.get(sessionId)!;

      if (text.includes('start streaming')) {
        if (!state.isStreaming) {
          state.isStreaming = true;
          await session.audio.speak('Gemini Vision engaged.');
          runStream();
        }
      } else if (text.includes('stop streaming')) {
        state.isStreaming = false;
        await session.audio.speak('Stopping scan.');
      } else if (text.includes('new shoe')) {
        sessionStates.set(sessionId, this.getDefaultState());
        await session.audio.speak('New shoe started.');
      }
    };

    session.events.onTranscription(onTrans);
    transcriptionHandlers.set(sessionId, onTrans);
  }

  private async performScan(session: AppSession, state: SessionState): Promise<boolean> {
    try {
      const photo = await session.camera.requestPhoto({ size: 'medium' });
      
      // Mentra 2026 Fix: requestPhoto returns photo.buffer as an ArrayBuffer
      // We must use Buffer.from to convert it for the Gemini base64 requirement
      const base64Data = Buffer.from(photo.buffer).toString('base64');

      const prompt = "Identify the ranks of all unique playing cards. Return a comma-separated list like: 2, 10, K, A. If no cards, say 'none'.";
      
      // New 2026 SDK Syntax
      const result = await ai.models.generateContent({
        model: modelName,
        contents: [
          { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
          { text: prompt }
        ],
        config: { temperature: 0.1 }
      });

      const responseText = result.text.toUpperCase();
      if (responseText.includes('NONE')) return true;

      const ranks = responseText.split(',').map(s => s.trim());
      ranks.forEach(rank => {
        if (/^(10|[2-9]|[JQKA])$/.test(rank)) {
          state.runningCount += this.getCardValue(rank);
          state.cardsSeen++;
          if (['10', 'J', 'Q', 'K', 'A'].includes(rank)) state.highSeen++;
        }
      });

      const decksLeft = Math.max(0.5, state.decks - (state.cardsSeen / 52));
      const trueCount = Math.floor(state.runningCount / decksLeft);
      if (Math.abs(trueCount) >= 1) {
        await session.audio.speak(`Count ${trueCount}`);
      }

      return true;
    } catch (err: any) {
      console.error("[GEMINI_2026_ERR]", err);
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
