import { AppServer, AppSession } from '@mentra/sdk';
import * as tf from '@tensorflow/tfjs-node'; // For future ML card detection
import * as dotenv from 'dotenv';
import express from 'express'; // For custom routes
import axios from 'axios'; // For Roboflow API

dotenv.config(); // Loads .env variables like MENTRA_API_KEY and ROBOFLOW_API_KEY

class CardCounterApp extends AppServer {
  constructor(options: any) {
    super(options);

    // Get Express app instance
    const app = this.getExpressApp();

    // Health check route for Railway
    app.get('/health', (req, res) => {
      res.status(200).send('OK - Card Counter is alive and running!');
    });

    // Webhook route (in case Mentra pings it)
    app.post('/webhook', (req, res) => {
      console.log('Webhook received:', req.body);
      res.status(200).send('OK');
    });

    // Placeholder route for /webview to fix 404 error in Mentra console/simulator
    app.get('/webview', (req, res) => {
      res.status(200).send(`
        <html>
          <body>
            <h1>Card Counter App</h1>
            <p>This is the webview for the Card Counter MiniApp.</p>
            <p>Status: Running. Use voice commands on your Mentra glasses to interact.</p>
          </body>
        </html>
      `);
    });
  }

  protected async onSession(
    session: AppSession,
    sessionId: string,
    userId: string
  ): Promise<void> {
    console.log(`New session started: ${sessionId} for user ${userId}`);

    // Initialize shoe state (6 decks)
    let runningCount = 0;
    let cardsSeen = 0;
    let highSeen = 0;
    const totalCards = 312;      // 6 × 52
    const totalHigh = 120;       // 10/J/Q/K/A across 6 decks
    const decks = 6;

    let streamingInterval: NodeJS.Timeout | null = null;

    // Welcome message (private TTS in user's ear)
    await session.audio.speak('Card counter ready. Say "scan cards" for single scan, or "start streaming" for live tracking.');

    // Listen for voice commands via transcription events
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
        if (streamingInterval) {
          await session.audio.speak('Streaming already active.');
          return;
        }
        await session.audio.speak('Starting live streaming. Tracking cards in real-time.');
        streamingInterval = setInterval(async () => {
          const result = await this.performScan(session, { runningCount, cardsSeen, highSeen, decks, totalHigh });
          if (result) {
            runningCount = result.runningCount;
            cardsSeen = result.cardsSeen;
            highSeen = result.highSeen;
          }
        }, 3000); // Every 3 seconds - adjust for flow/battery
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
        await session.audio.speak(
          `True count is ${trueCount}. High cards left: ${highLeft}.`
        );
      }
    });

    // Optional: Add more event handlers later, e.g., button presses
    // session.events.onButtonPress((data) => { ... });

    // Cleanup streaming on session end
    this.addCleanupHandler(() => {
      if (streamingInterval) clearInterval(streamingInterval);
    });
  }

  // Perform a single scan/detection (used for both single and streaming)
  private async performScan(
    session: AppSession,
    state: { runningCount: number; cardsSeen: number; highSeen: number; decks: number; totalHigh: number }
  ): Promise<{ runningCount: number; cardsSeen: number; highSeen: number } | null> {
    try {
      // Request photo from glasses camera
      const photo = await session.camera.requestPhoto();
      const imageBase64 = photo.photoData; // Assuming photoData is base64

      // Detect cards using Roboflow
      const detectedCards = await this.detectCards(imageBase64);

      if (detectedCards.length === 0) {
        await session.audio.speak('No cards detected.');
        return null;
      }

      // Update Hi-Lo running count
      for (const card of detectedCards) {
        const label = card.class; // e.g., '10H', '2S', 'JH'
        const rank = label.slice(0, -1); // '10', '2', 'J' (removes suit)
        const value = this.getCardValue(rank);
        state.runningCount += value;
        state.cardsSeen++;
        if (['10', 'J', 'Q', 'K', 'A'].includes(rank)) {
          state.highSeen++;
        }
      }

      // Calculate true count and high cards left
      const decksLeft = state.decks - (state.cardsSeen / 52);
      const trueCount = decksLeft > 0 ? Math.round(state.runningCount / decksLeft) : 0;
      const highLeft = state.totalHigh - state.highSeen;

      // Announce results privately
      await session.audio.speak(
        `Detected ${detectedCards.length} cards. True count is ${trueCount}. High cards left: ${highLeft}.`
      );

      return { runningCount: state.runningCount, cardsSeen: state.cardsSeen, highSeen: state.highSeen };
    } catch (error) {
      console.error('Scan error:', error);
      await session.audio.speak('Error detecting cards. Try again.');
      return null;
    }
  }

  // Detect cards using Roboflow Serverless Inference API (V2)
  private async detectCards(imageBase64: string): Promise<{ class: string; confidence: number }[]> {
    const apiKey = process.env.ROBOFLOW_API_KEY;
    const modelId = 'playing-cards-ow27d-sefl4/1'; // Updated to the provided ID

    try {
      const url = `https://serverless.roboflow.com/${modelId}`;
      const data = {
        image: `data:image/jpeg;base64,${imageBase64}`, // Add data URI prefix; change 'jpeg' if needed
        image_type: 'base64',
      };

      const response = await axios.post(url, data, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      console.log('Roboflow predictions:', response.data.predictions);
      return response.data.predictions.filter((pred: any) => pred.confidence > 0.5);
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

// Create the Mentra app with dynamic port and host
const port = Number(process.env.PORT) || 8080; // Update to match logs
const server = new CardCounterApp({
  packageName: 'com.yakov.cardcounter',
  apiKey: process.env.MENTRA_API_KEY!,
  port: port,
  host: '0.0.0.0' // Bind to all interfaces for cloud access
});

// Start server (no backup listen to avoid conflict)
server.start()
  .then(() => {
    console.log(`Mentra AppServer started successfully on port ${port}`);
  })
  .catch((err) => {
    console.error('Mentra startup failed:', err.message || err);
    process.exit(1);
  });
