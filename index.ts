import { AppServer, AppSession } from '@mentra/sdk';
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as dotenv from 'dotenv';
import express from 'express';

dotenv.config();

// --- 1. Explicit Gemini Initialization ---
// This matches your Railway 'Variables' tab exactly.
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// We use 'Flash' because it's optimized for high-speed vision tasks.
const visionModel = genAI.getGenerativeModel({ 
  model: "gemini-1.5-flash",
  generationConfig: {
    temperature: 0.1, // Keeps the AI from "hallucinating" extra cards
    topP: 0.1,
  }
});

interface SessionState {
  runningCount: number;
  cardsSeen: number;
  decks: number;
  isStreaming: boolean;
}

const sessionStates = new Map<string, SessionState>();

class GeminiCardCounter extends AppServer {
  constructor(options: any) {
    super(options);
    const app = this.getExpressApp();

    // Stats API for the Webview
    app.get('/stats', (req, res) => {
      const state = Array.from(sessionStates.values())[0] || this.getDefaultState();
      const decksLeft = Math.max(0.5, state.decks - (state.cardsSeen / 52));
      const trueCount = Math.floor(state.runningCount / decksLeft);
      res.json({ trueCount, cardsSeen: state.cardsSeen });
    });

    // Voice/Button Command Handler
    app.post('/action', express.json(), (req, res) => {
      const session = Array.from(sessionStates.keys())[0]; 
      // In a real app, you'd route this to the specific sessionId
      this.handleCommand(req.body.command, session);
      res.sendStatus(200);
    });
  }

  private getDefaultState(): SessionState {
    return { runningCount: 0, cardsSeen: 0, decks: 6, isStreaming: false };
  }

  protected async onSession(session: AppSession, sessionId: string): Promise<void> {
    console.log(`[DEPLOY] Gemini Engine Active on Session: ${sessionId}`);
    sessionStates.set(sessionId, this.getDefaultState());

    this.addCleanupHandler(() => sessionStates.delete(sessionId));
  }

  private async handleCommand(cmd: string, sessionId: string) {
    const state = sessionStates.get(sessionId);
    if (!state) return;

    if (cmd.includes('start')) {
      state.isStreaming = true;
      this.runVisionLoop(sessionId);
    } else if (cmd.includes('stop')) {
      state.isStreaming = false;
    }
  }

  private async runVisionLoop(sessionId: string) {
    const state = sessionStates.get(sessionId);
    if (!state || !state.isStreaming) return;

    try {
      // 1. Capture frame from Mentra
      const session = (this as any).sessions?.get(sessionId); // Internal SDK access
      if (!session) return;

      const photo: any = await session.camera.requestPhoto();
      const base64 = photo.buffer.toString('base64');

      // 2. Multimodal Vision Request
      const prompt = "List the ranks of all unique playing cards visible. Format: rank, rank. If none, say 'none'.";
      const result = await visionModel.generateContent([
        prompt,
        { inlineData: { data: base64, mimeType: "image/jpeg" } }
      ]);

      const text = result.response.text().toUpperCase();
      
      // 3. Update Count Logic
      if (!text.includes('NONE')) {
        const ranks = text.split(',').map(r => r.trim());
        ranks.forEach(rank => {
          if (/^(10|[2-9]|[JQKA])$/.test(rank)) {
            state.runningCount += this.calculateValue(rank);
            state.cardsSeen++;
          }
        });
        
        // Voice Feedback
        await session.audio.speak(`Updated. Total cards: ${state.cardsSeen}`);
      }
    } catch (e) {
      console.error("Gemini Loop Error:", e);
    }

    // Repeat every 4 seconds
    setTimeout(() => this.runVisionLoop(sessionId), 4000);
  }

  private calculateValue(rank: string): number {
    if (['2', '3', '4', '5', '6'].includes(rank)) return 1;
    if (['10', 'J', 'Q', 'K', 'A'].includes(rank)) return -1;
    return 0;
  }
}

// Start Server
new GeminiCardCounter({
  packageName: 'com.yakov.cardcounter',
  apiKey: process.env.MENTRA_API_KEY!,
  port: Number(process.env.PORT) || 8080
}).start();
