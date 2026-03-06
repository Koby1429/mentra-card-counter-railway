import { AppServer, AppSession } from '@mentra/sdk';
import * as tf from '@tensorflow/tfjs-node'; // For future local ML if needed
import * as dotenv from 'dotenv';
import express from 'express';
import { InferenceClient } from '@roboflow/inference-sdk'; // NEW: For serverless Roboflow

dotenv.config();

class CardCounterApp extends AppServer {
  constructor(options: any) {
    super(options);

    const app = this.getExpressApp();
    app.get('/health', (req, res) => res.status(200).send('OK - Card Counter is alive!'));
    app.post('/webhook', (req, res) => {
      console.log('Webhook:', req.body);
      res.status(200).send('OK');
    });
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`Session started: ${sessionId} for ${userId}`);

    let runningCount = 0;
    let cardsSeen = 0;
    let highSeen = 0;
    const totalCards = 312; // 6 decks
    const totalHigh = 120; // High cards in 6 decks
    const decks = 6;

    await session.audio.speak('Card counter ready. Say "scan cards" to detect.');

    session.events.onTranscription(async (data) => {
      const text = data.text.toLowerCase().trim();
      console.log(`User said: ${text}`);

      if (text.includes('scan cards')) {
        try {
          const photo = await session.camera.requestPhoto();
          const imageBuffer = Buffer.from(photo.photoData);

          const detectedCards = await this.detectCards(imageBuffer);

          // Deduplicate by unique rank+suit (simple; add bbox IoU later if overlaps common)
          const uniqueCards = [...new Map(detectedCards.map(card => [`${card.rank}${card.suit}`, card])).values()];

          for (const card of uniqueCards) {
            const value = this.getCardValue(card.rank);
            runningCount += value;
            cardsSeen++;
            if (['10', 'J', 'Q', 'K', 'A'].includes(card.rank)) highSeen++;
          }

          const decksLeft = decks - (cardsSeen / 52);
          const trueCount = decksLeft > 0 ? Math.round(runningCount / decksLeft) : 0;
          const highLeft = totalHigh - highSeen;

          await session.audio.speak(`True count is ${trueCount}. High cards left: ${highLeft}.`);
        } catch (error) {
          console.error('Scan error:', error);
          await session.audio.speak('Error detecting cards. Try again.');
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
  }

  private async detectCards(imageBuffer: Buffer): Promise<{ rank: string; suit: string }[]> {
    const apiKey = process.env.ROBOFLOW_API_KEY;
    if (!apiKey) throw new Error('ROBOFLOW_API_KEY missing');

    const modelId = 'yakov-cards/1'; // Your model ID; add workspace if needed (e.g., 'yakov/yakov-cards/1')

    try {
      const client = new InferenceClient({
        apiKey,
        apiUrl: 'https://infer.roboflow.com', // Serverless v2 endpoint
      });

      const response: any = await client.infer({ // TS: Added 'any' for response type; refine if needed
        modelId,
        image: imageBuffer.toString('base64'),
        confidence: 0.5, // Built-in threshold
      });

      console.log('Detections:', JSON.stringify(response, null, 2)); // Debug

      if (!response.predictions) return [];

      return response.predictions
        .filter((pred: any) => pred.confidence > 0.5 && pred.class.includes(' of '))
        .map((pred: any) => {
          const className = pred.class; // e.g., "10 of hearts"
          const parts = className.split(' of ');
          let rank = parts[0].trim();
          rank = rank.replace('Ace', 'A').replace('Jack', 'J').replace('Queen', 'Q').replace('King', 'K');
          const suit = parts[1].trim()[0].toUpperCase(); // H, C, D, S
          return { rank, suit };
        });
    } catch (error) {
      console.error('Detection error:', error);
      return [];
    }
  }

  private getCardValue(rank: string): number {
    if (['2', '3', '4', '5', '6'].includes(rank)) return 1;
    if (['7', '8', '9'].includes(rank)) return 0;
    return -1; // 10, J, Q, K, A
  }
}

// Create the Mentra app with dynamic port and host
const port = Number(process.env.PORT) || 7010; // Matches SDK default from logs
const server = new CardCounterApp({
  packageName: 'com.yakov.cardcounter',
  apiKey: process.env.MENTRA_API_KEY!,
  port: port,
  host: '0.0.0.0' // Critical: Allows external access in cloud
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
