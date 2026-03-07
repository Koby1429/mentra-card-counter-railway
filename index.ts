import { AppServer, AppSession } from '@mentra/sdk';
import * as tf from '@tensorflow/tfjs-node'; // For future ML card detection
import * as dotenv from 'dotenv';
import express from 'express'; // For custom routes
import axios from 'axios'; // For Roboflow API

dotenv.config(); // Loads .env variables like MENTRA_API_KEY and ROBOFLOW_API_KEY

// Global store for session states
const sessionStates = new Map<string, { runningCount: number; cardsSeen: number; highSeen: number; decks: number; totalHigh: number }>();

// Transcription handlers (global for actions)
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

    // Dashboard webview
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

    // Stats API (assumes one session for demo; add sessionId param for multi)
    app.get('/stats', (req, res) => {
      const state = Array.from(sessionStates.values())[0] || { runningCount: 0, cardsSeen: 0, highSeen: 0, decks: 6, totalHigh: 120 };
      const decksLeft = state.decks - (state.cardsSeen / 52);
      const trueCount = decksLeft > 0 ? Math.round(state.runningCount / decksLeft) : 0;
      const highLeft = state.totalHigh - state.highSeen;
      res.json({ trueCount, highLeft, cardsSeen: state.cardsSeen });
    });

    // Action API
    app.post('/action', express.json(), (req, res) => {
      const { command } = req.body;
      console.log(`Action triggered: ${command}`);
      // Simulate transcription for first active session
      const handler = Array.from(transcriptionHandlers.values())[0];
      if (handler) handler({ text: command });
      res.status(200).send('OK');
    });
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`Session start: ${sessionId}`);
    sessionStates.set(sessionId, { runningCount: 0, cardsSeen: 0, highSeen: 0, decks: 6, totalHigh: 120 });

    let streamingInterval: NodeJS.Timeout | null = null;

    await session.audio.speak('Ready. Say "scan cards" or "start streaming".');

    const onTrans = async (data: any) => {
      const text = data.text.toLowerCase().trim();
      console.log(`Transcription: ${text}`);

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
      }
    };

    session.events.onTranscription(onTrans);
    transcriptionHandlers.set(sessionId, onTrans);

    this.addCleanupHandler(() => {
      if (streamingInterval) clearInterval(streamingInterval);
      sessionStates.delete(sessionId);
      transcriptionHandlers.delete(sessionId);
    });
  }

  private async performScan(session: AppSession, state: any): Promise<void> {
    try {
      console.log('Scan start');
      // Simulate longer timeout (60s)
      const photoPromise = session.camera.requestPhoto();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Photo timeout')), 60000));
      const photo = await Promise.race([photoPromise, timeoutPromise]);
      console.log('Photo received, mimeType:', photo.mimeType, 'data type:', photo.photoData.constructor.name);

      // Convert ArrayBuffer to base64
      const imageBuffer = Buffer.from(photo.photoData);
      const imageBase64 = imageBuffer.toString('base64');
      console.log('Base64 length:', imageBase64.length);

      const detectedCards = await this.detectCards(imageBase64);
      console.log(`Detected: ${detectedCards.length}`);

      let announcement = '';
      if (detectedCards.length === 0) {
        const decksLeft = state.decks - (state.cardsSeen /
