import { AppServer, AppSession } from '@mentra/sdk';
import * as tf from '@tensorflow/tfjs-node'; // Keep for potential future local ML
import * as dotenv from 'dotenv';
import express from 'express'; // For routes
import axios from 'axios'; // For Roboflow API

dotenv.config(); // Loads .env (MENTRA_API_KEY, ROBOFLOW_API_KEY)

class CardCounterApp extends AppServer {
  constructor(options: any) {
    super(options);

    // Express setup
    const app = this.getExpressApp();
    app.get('/health', (req, res) => res.status(200).send('OK - Card Counter is alive and running!'));
    app.post('/webhook', (req, res) => {
      console.log('Webhook received:', req.body);
      res.status(200).send('OK');
    });
  }

  protected async onSession(
    session: AppSession,
    sessionId: string,
    userId: string
  ): Promise<void> {
    console.log(`New session started: ${sessionId} for user ${userId}`);

    // Shoe state
    let runningCount = 0;
    let cardsSeen = 0;
    let highSeen = 0;
    const totalCards = 312;
    const totalHigh = 120;
    const decks = 6;

    let streamingInterval: NodeJS.Timeout | null = null;

    await session.audio.speak('Card counter ready. Say "scan cards" for single scan, or "start streaming" for live tracking.');

    session.events.onTranscription(async (data) => {
      const text = data.text.toLowerCase().trim();
      console.log(`User said: ${text}`);

      if (text.includes('scan cards')) {
        const result = await this.performScan(session, { runningCount, cardsSeen, highSeen, decks, totalHigh });
        if (result) {
          runningCount = result.runningCount;
          cardsSeen = result.cardsSeen;
          highSeen = result.highSeen;
        }
      } else if (text.includes('start streaming')) {
        if (streamingInterval) return await session.audio.speak('Streaming already active.');
        await session.audio.speak('Starting live streaming. Tracking cards in real-time.');
        streamingInterval = setInterval(async () => {
          const result = await this.performScan(session, { runningCount, cardsSeen, highSeen, decks, totalHigh });
          if (result) {
            runningCount = result.runningCount;
            cardsSeen = result.cardsSeen;
            highSeen = result.highSeen;
          }
        }, 3000); // Every 3s - adjust for flow (lower = faster, but more battery drain)
      } else if (text.includes('stop streaming')) {
        if (streamingInterval) {
          clearInterval(streamingInterval);
          streamingInterval = null;
          await session.audio.speak('Stopped streaming.');
        } else {
          await session.audio.speak('Not streaming.');
        }
      } else if (text.includes('new shoe')) {
        runningCount = 0;
        cardsSeen = 0;
        highSeen = 0;
        await session.audio.speak('New shoe started.');
      } else if (text.includes('status')) {
        const decksLeft = decks - (cardsSeen / 52);
        const trueCount = decksLeft > 0 ? Math.round(runningCount / decksLeft) : 0;
        const highLeft = totalHigh - highSeen;
        await session.audio.speak(`True count is ${trueCount}. High cards left: ${highLeft}.`);
      }
    });

    // Cleanup on session end
    this.addCleanupHandler(() => {
      if (streamingInterval) clearInterval(streamingInterval);
    });
  }

  // Perform a scan (single or stream frame)
  private async performScan(
    session: AppSession,
    state: { runningCount: number; cardsSeen: number; highSeen: number; decks: number; totalHigh: number }
  ): Promise<{ runningCount: number; cardsSeen: number; highSeen: number } | null> {
    try {
      // Capture frame
      const photo = await session.camera.requestPhoto();
      const imageBase64 = photo.photoData; // Already base64 from SDK

      // Detect cards
      const detectedCards = await this.detectCards(imageBase64);

      if (detectedCards.length === 0) {
        await session.audio.speak('No cards detected.');
        return null;
      }

      // Update counts
      for (const card of detectedCards) {
        const rank = card.class.charAt(0); // e.g., '2' from '2H' (adjust if model format differs)
        const value = this.getCardValue(rank);
        state.runningCount += value;
        state.cardsSeen++;
        if (['10', 'J', 'Q', 'K', 'A'].includes(rank)) {
          state.highSeen++;
        }
      }

      // Announce
      const decksLeft = state.decks - (state.cardsSeen / 52);
      const trueCount = decksLeft > 0 ? Math.round(state.runningCount / decksLeft) : 0;
      const highLeft = state.totalHigh - state.highSeen;
      await session.audio.speak(`Detected ${detectedCards.length} cards. True count: ${trueCount}. High cards left: ${highLeft}.`);

      return { runningCount: state.runningCount, cardsSeen: state.cardsSeen, highSeen: state.highSeen };
    } catch (error) {
      console.error('Scan error:', error);
      await session.audio.speak('Error detecting cards. Try again.');
      return null;
    }
  }

  // Detect cards via Roboflow API
  private async detectCards(imageBase64: string): Promise<{ class: string; confidence: number }[]> {
    const apiKey = process.env.ROBOFLOW_API_KEY;
    const modelId = 'playing-cards-yy60t/1'; // Your forked ID/version (update after forking)

    try {
      const response = await axios.post(
        `https://detect.roboflow.com/${modelId}?api_key=${apiKey}`,
        imageBase64,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      // Filter high-confidence detections
      return (response.data.predictions || []).filter((pred: any) => pred.confidence > 0.5);
    } catch (error) {
      console.error('Roboflow API error:', error);
      return [];
    }
  }

  // Hi-Lo counting values
  private getCardValue(rank: string): number {
    if (['2', '3', '4', '5', '6'].includes(rank)) return 1;
    if (['7', '8', '9'].includes(rank)) return 0;
    return -1;  // 10, J, Q, K, A
  }
}

// Server setup
const port = Number(process.env.PORT) || 7010;
const server = new CardCounterApp({
  packageName: 'com.yakov.cardcounter',
  apiKey: process.env.MENTRA_API_KEY!,
  port: port,
  host: '0.0.0.0'
});

// Start server
server.start()
  .then(() => {
    console.log(`Mentra AppServer started successfully on port ${port}`);
  })
  .catch((err) => {
    console.error('Mentra startup failed:', err.message || err);
    process.exit(1);
  });
