import { AppServer, AppSession } from '@mentra/sdk';
import * as dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';

dotenv.config();

interface SessionState {
  runningCount: number;
  cardsSeen: number;
  highSeen: number;
  decks: number;
  totalHigh: number;
}

const sessionStates = new Map<string, SessionState>();
const transcriptionHandlers = new Map<string, (data: any) => void>();

class CardCounterApp extends AppServer {
  constructor(options: any) {
    super(options);
    const app = this.getExpressApp();

    // Health Check
    app.get('/health', (req, res) => res.status(200).send('OK'));

    // Dashboard UI
    app.get('/webview', (req, res) => {
      res.status(200).send(`
        <html>
          <head>
            <title>Card Counter Pro</title>
            <style>
              body { font-family: sans-serif; background: #121212; color: #eee; text-align: center; padding: 20px; }
              .card { background: #1e1e1e; border-radius: 12px; padding: 25px; margin: 20px auto; max-width: 350px; border: 1px solid #333; }
              .stat-val { font-size: 3em; font-weight: bold; color: #4CAF50; margin: 10px 0; }
              .label { color: #888; text-transform: uppercase; letter-spacing: 1px; font-size: 0.75em; }
              .grid { display: flex; justify-content: space-between; margin-top: 20px; }
              button { padding: 15px; width: 80%; margin: 10px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; }
              .btn-start { background: #4CAF50; color: white; }
              .btn-reset { background: #555; color: white; }
            </style>
          </head>
          <body>
            <h2>Table Analytics</h2>
            <div class="card">
              <div class="label">True Count</div>
              <div id="trueCount" class="stat-val">0</div>
              <div class="grid">
                <div><div class="label">Seen</div><div id="cardsSeen">0</div></div>
                <div><div class="label">High Left</div><div id="highLeft">0</div></div>
              </div>
            </div>
            <button class="btn-start" onclick="trigger('start streaming')">Start Analytics</button>
            <button class="btn-reset" onclick="trigger('new shoe')">Reset Shoe</button>
            <script>
              async function update() {
                try {
                  const r = await fetch('/stats');
                  const d = await r.json();
                  document.getElementById('trueCount').textContent = d.trueCount;
                  document.getElementById('cardsSeen').textContent = d.cardsSeen;
                  document.getElementById('highLeft').textContent = d.highLeft;
                } catch (e) {}
              }
              setInterval(update, 1000);
              async function trigger(cmd) {
                await fetch('/action', { 
                  method: 'POST', 
                  headers: { 'Content-Type': 'application/json' }, 
                  body: JSON.stringify({ command: cmd }) 
                });
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
      res.json({ trueCount, highLeft: state.totalHigh - state.highSeen, cardsSeen: state.cardsSeen });
    });

    app.post('/action', express.json(), (req, res) => {
      const handler = Array.from(transcriptionHandlers.values())[0];
      if (handler) handler({ text: req.body.command });
      res.sendStatus(200);
    });
  }

  private getDefaultState(): SessionState {
    return { runningCount: 0, cardsSeen: 0, highSeen: 0, decks: 6, totalHigh: 1
