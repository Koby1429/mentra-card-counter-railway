import { AppServer, AppSession } from '@mentra/sdk';
import * as tf from '@tensorflow/tfjs-node'; // For future ML card detection
import * as dotenv from 'dotenv';
import http from 'http';

dotenv.config(); // Loads .env variables like MENTRA_API_KEY (local only)

class CardCounterApp extends AppServer {
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

    // Welcome message (private TTS in user's ear)
    await session.audio.speak('Card counter ready. Say "scan cards" to detect.');

    // Listen for voice commands via transcription events
    session.events.onTranscription(async (data) => {
      const text = data.text.toLowerCase().trim();
      console.log(`User said: ${text}`);

      if (text.includes('scan cards')) {
        try {
          // Request photo from glasses camera
          const photo = await session.camera.requestPhoto();
          const imageBuffer = Buffer.from(photo.photoData);

          // Detect cards (placeholder for now)
          const detectedCards = await this.detectCards(imageBuffer);

          // Update Hi-Lo running count
          for (const card of detectedCards) {
            const value = this.getCardValue(card.rank);
            runningCount += value;
            cardsSeen++;
            if (['10', 'J', 'Q', 'K', 'A'].includes(card.rank)) {
              highSeen++;
            }
          }

          // Calculate true count and high cards left
          const decksLeft = decks - (cardsSeen / 52);
          const trueCount = decksLeft > 0 ? Math.round(runningCount / decksLeft) : 0;
          const highLeft = totalHigh - highSeen;

          // Announce results privately
          await session.audio.speak(
            `True count is ${trueCount}. High cards left: ${highLeft}.`
          );
        } catch (error) {
          console.error('Scan error:', error);
          await session.audio.speak('Error detecting cards. Try again.');
        }
      } else if (text.includes('new shoe')) {
        // Reset counters
        runningCount = 0;
        cardsSeen = 0;
        highSeen = 0;
        await session.audio.speak('New shoe started.');
      } else if (text.includes('status')) {
        // Quick status check
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
  }

  // Placeholder for card detection (replace with real TF.js model later)
  private async detectCards(imageBuffer: Buffer): Promise<{ rank: string; suit: string }[]> {
    // For now, return empty → no cards detected (testing stub)
    console.log('Placeholder: No cards detected from image.');
    return [];
  }

  // Hi-Lo counting values
  private getCardValue(rank: string): number {
    if (['2', '3', '4', '5', '6'].includes(rank)) return 1;
    if (['7', '8', '9'].includes(rank)) return 0;
    return -1;  // 10, J, Q, K, A
  }
}

// Create the app instance
const server = new CardCounterApp({
  packageName: 'com.yakov.cardcounter',          // Confirmed match from store
  apiKey: process.env.MENTRA_API_KEY!,           // Fresh key from console
  // NO port here — let Mentra use default 7010 for WebSocket
});

// Health check for Railway (HTTP on $PORT)
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK - Card Counter is alive');
}).listen(Number(process.env.PORT) || 3000, () => {
  console.log(`Health check server listening on port ${process.env.PORT || 3000}`);
});

// Start Mentra SDK server with error handling
try {
  server.start();
  console.log('Mentra AppServer started successfully on default port 7010');
} catch (err) {
  console.error('Mentra AppServer startup failed:', err.message || err);
  process.exit(1);
}
