import { AppServer, AppSession } from '@mentra/sdk';
import * as tf from '@tensorflow/tfjs-node'; // For future ML card detection
import * as dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';

dotenv.config(); // Loads .env variables

const sessionStates = new Map<string, { runningCount: number; cardsSeen: number; highSeen: number; decks: number; totalHigh: number }>();
const transcriptionHandlers = new Map<string, (data: any) => void>();

class CardCounterApp extends AppServer {
  constructor(options: any) {
    super(options);

    const app = this.getExpressApp();

    app.get('/health', (req, res) => res.status(200).send('OK - Card Counter running!'));

    app.post('/webhook', (req, res) => {
      console.log('Webhook:', req.body);
      res.status(200).send('OK');
    });

    app.get('/webview', (req, res) => {
      res.status(200).send(`
        <html>
          <head><title>Card Counter Dashboard</title>
          <style>body { font-family: Arial; text-align: center; padding: 20px; }
          .stats { margin: 20px; font-size: 18px; }
          button { padding: 10px 20px; margin: 10px; background: #4CAF50; color: white; border: none; cursor: pointer; }
          button:hover { background: #45a049; }</style></head>
          <body><h1>Card Counter Dashboard</h1>
          <p>Use voice or buttons. Stats update every 5s.</p>
          <div class="stats">
            <p>True Count: <span id="trueCount">Loading...</span></p>
            <p>High Left: <span id="highLeft">Loading...</span></p>
            <p>Cards Seen: <span id="cardsSeen">Loading...</span></p>
          </div>
          <button onclick="trigger('scan cards')">Scan</button>
          <button onclick="trigger('start streaming')">Start Stream</button>
          <button onclick="trigger('stop streaming')">Stop Stream</button>
          <button onclick="trigger('new shoe')">New Shoe</button>
          <button onclick="trigger('status')">Status</button>
          <script>
            async function update() {
              try { const r = await fetch('/stats'); const d = await r.json();
                document.getElementById('trueCount').textContent = d.trueCount;
                document.getElementById('highLeft').textContent = d.highLeft;
                document.getElementById('cardsSeen').textContent = d.cardsSeen;
              } catch (e) { console.error(e); }
            } setInterval(update, 5000); update();
            async function trigger(cmd) {
              try { await fetch('/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: cmd }) });
                alert('Sent: ' + cmd); update(); } catch (e) { alert('Error'); }
            }
          </script></body></html>
      `);
    });

    app.get('/stats', (req, res) => {
      const state = Array.from(sessionStates.values())[0] || { runningCount: 0, cardsSeen: 0, highSeen: 0, decks: 6, totalHigh: 120 };
      const decksLeft = state.decks - (state.cardsSeen / 52);
      const trueCount = decksLeft > 0 ? Math.round(state.runningCount / decksLeft) : 0;
      const highLeft = state.totalHigh - state.highSeen;
      res.json({ trueCount, highLeft, cardsSeen: state.cardsSeen });
    });

    app.post('/action', express.json(), (req, res) => {
      const { command } = req.body;
      console.log(`Action triggered: ${command}`);
      const handler = Array.from(transcriptionHandlers.values())[0];
      if (handler) handler({ text: command });
      res.status(200).send('OK');
    });
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[SESSION] Start: ${sessionId}`);
    sessionStates.set(sessionId, { runningCount: 0, cardsSeen: 0, highSeen: 0, decks: 6, totalHigh: 120 });

    let streamingInterval: NodeJS.Timeout | null = null;

    await session.audio.speak('Ready. Say "scan cards" or "start streaming".');

    const onTrans = async (data: any) => {
      const text = data.text.toLowerCase().trim();
      console.log(`[TRANS] Received: ${text} (full data: ${JSON.stringify(data)})`);

      if (text.includes('scan cards')) await this.performScan(session, sessionStates.get(sessionId)!);
      else if (text.includes('start streaming')) {
        if (streamingInterval) return await session.audio.speak('Active.');
        await session.audio.speak('Streaming started.');
        streamingInterval = setInterval(() => this.performScan(session, sessionStates.get(sessionId)!), 3000);
      } else if (text.includes('stop streaming')) {
        if (streamingInterval) {
          clearInterval(streamingInterval);
          streamingInterval = null;
          await session.audio.speak('Stopped.');
        }
      } else if (text.includes('new shoe')) {
        const state = sessionStates.get(sessionId)!;
        state.runningCount = state.cardsSeen = state.highSeen = 0;
        await session.audio.speak('New shoe.');
      } else if (text.includes('status')) {
        const state = sessionStates.get(sessionId)!;
        const decksLeft = state.decks - (state.cardsSeen / 52);
        const trueCount = decksLeft > 0 ? Math.round(state.runningCount / decksLeft) : 0;
        const highLeft = state.totalHigh - state.highSeen;
        await session.audio.speak(`True: ${trueCount}. High: ${highLeft}.`);
      } else {
        console.log(`[TRANS] Unrecognized command: ${text}`);
      }
    };

    session.events.onTranscription(onTrans);
    transcriptionHandlers.set(sessionId, onTrans);

    this.addCleanupHandler(() => {
      if (streamingInterval) clearInterval(streamingInterval);
      sessionStates.delete(sessionId);
      transcriptionHandlers.delete(sessionId);
      console.log(`[SESSION] Cleanup: ${sessionId}`);
    });
  }

  private async performScan(session: AppSession, state: any): Promise<void> {
    try {
      console.log('[SCAN] Starting scan...');
      const photoPromise = session.camera.requestPhoto();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Photo timeout')), 60000));
      const photo = await Promise.race([photoPromise, timeoutPromise]);

      console.log('[SCAN] Full photo object:', photo);
      if (photo && typeof photo === "object") {
        console.log('[SCAN] All photo keys:', Object.keys(photo));
        for (const key in photo) {
          if (Object.prototype.hasOwnProperty.call(photo, key)) {
            console.log(`[SCAN] Key: ${key} typeof:`, typeof photo[key]);
          }
        }
      }

      const candidateKeys = ['photoData', 'data', 'buffer', 'bytes'];
      let rawData: any = null;
      for (const k of candidateKeys) {
        if (photo[k]) {
          rawData = photo[k];
          console.log(`[SCAN] Using photo.${k} as image data. typeof:`, typeof rawData, 'length:', rawData?.length || rawData?.byteLength);
          break;
        }
      }

      let imageBase64: string | null = null;

      if (rawData) {
        if (Buffer.isBuffer(rawData) || rawData instanceof Uint8Array || rawData instanceof ArrayBuffer) {
          const imageBuffer = Buffer.from(rawData);
          imageBase64 = imageBuffer.toString('base64');
          console.log(`[SCAN] Encoded base64 from photo, length: ${imageBase64.length}`);
        } else if (typeof rawData === "string") {
          imageBase64 = rawData.replace(/^data:image\/jpeg;base64,/, "");
          console.log('[SCAN] Raw image data is a string, using as base64 (first 50 chars):', imageBase64.slice(0,50));
        } else {
          throw new Error("Camera photo binary data is in an unrecognized format!");
        }
      } else if (photo.base64) {
        console.log("[SCAN] Found base64 property on photo, using as is.");
        imageBase64 = photo.base64.replace(/^data:image\/jpeg;base64,/, "");
      }

      if (!imageBase64) {
        throw new Error("Camera photo has no usable binary/image data!");
      }

      // --- Logging for debug purposes ---
      console.log('[SCAN] About to call detectCards...');
      console.log('[SCAN] Length of base64 image:', imageBase64.length);

      const detectedCards = await this.detectCards(imageBase64);
      console.log(`[SCAN] Detected cards: ${detectedCards ? detectedCards.length : 0}`);

      let announcement = '';
      if (!detectedCards || detectedCards.length === 0) {
        const decksLeft = state.decks - (state.cardsSeen / 52);
        const trueCount = decksLeft > 0 ? Math.round(state.runningCount / decksLeft) : 0;
        announcement = `No cards. True: ${trueCount}.`;
      } else {
        for (const card of detectedCards) {
          const rank = card.class.slice(0, -1);
          const value = this.getCardValue(rank);
          state.runningCount += value;
          state.cardsSeen++;
          if (['10', 'J', 'Q', 'K', 'A'].includes(rank)) state.highSeen++;
        }
        const decksLeft = state.decks - (state.cardsSeen / 52);
        const trueCount = decksLeft > 0 ? Math.round(state.runningCount / decksLeft) : 0;
        const highLeft = state.totalHigh - state.highSeen;
        announcement = `Detected ${detectedCards.length}. Running: ${state.runningCount}. True: ${trueCount}. High: ${highLeft}.`;
      }
      await session.audio.speak(announcement);
      console.log('[SCAN] Announcement:', announcement);

    } catch (error: any) {
      if (error && error.response && error.response.data) {
        console.error('[SCAN] Error (Roboflow API response):', JSON.stringify(error.response.data));
      } else {
        console.error('[SCAN] Error:', error.stack || error.message || error);
      }
      await session.audio.speak('Scan error. Retry.');
    }
  }

  // --- ROBUST AND DIAGNOSTIC CARD DETECTION ---
  private async detectCards(imageBase64: string): Promise<any[]> {
    const apiKey = process.env.ROBOFLOW_API_KEY;
    const modelId = 'yakovs-workspace-vkezy/playing-cards-ow27d-sefl4/1';
    const endpoint = `https://detect.roboflow.com/${modelId}`;

    // Diagnostic logging:
    console.log('[RF] Endpoint:', endpoint);
    console.log('[RF] API key loaded:', typeof apiKey === 'string' && apiKey.length > 10);
    console.log('[RF] Image base64 length:', imageBase64.length);

    try {
      const response = await axios.post(
        endpoint,
        { image: `data:image/jpeg;base64,${imageBase64}` },
        { params: { api_key: apiKey } }
      );
      console.log('[RF] API response:', response.data);
      return response.data.predictions?.filter((p: any) => p.confidence > 0.5) || [];
    } catch (error: any) {
      if (error.response) {
        // Improved error reporting:
        console.error('[RF] Fail status:', error.response.status);
        console.error('[RF] Fail status text:', error.response.statusText);
        console.error('[RF] Fail headers:', error.response.headers);
        console.error('[RF] Fail data:', error.response.data);
      } else {
        console.error('[RF] Fail:', error.stack || error.message || error);
      }
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

server.start().then(() => console.log(`On port ${port}`)).catch(err => { console.error(err); process.exit(1); });
