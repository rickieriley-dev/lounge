// ============================================================
// roulette-server/index.js
// Greedy ProMax — Game Orchestrator + PayMongo Payment Server
// Runs on Railway.app
// ============================================================

const admin   = require('firebase-admin');
const http    = require('http');
const crypto  = require('crypto');
const cron    = require('node-cron');

// ── Firebase init ─────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db      = admin.database();
const gameRef = db.ref('globalGames/roulette');

// ── PayMongo config ───────────────────────────────────────────
const PAYMONGO_SECRET    = process.env.PAYMONGO_SECRET_KEY;     // sk_live_xxx or sk_test_xxx
const PAYMONGO_WEBHOOK   = process.env.PAYMONGO_WEBHOOK_SECRET; // from PayMongo dashboard
const SERVER_URL         = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.SERVER_URL; // fallback for local dev

// ── Coin packages (must match wallet_screen.dart) ─────────────
const COIN_PACKAGES = {
  'starter': { coins: 18000,    amountCents: 5700  },  // ₱57
  'basic':   { coins: 54450,    amountCents: 17100 },  // ₱171
  'popular': { coins: 90950,    amountCents: 28500 },  // ₱285
  'value':   { coins: 127450,   amountCents: 39900 },  // ₱399
  'plus':    { coins: 182250,   amountCents: 57000 },  // ₱570
  'premium': { coins: 328500,   amountCents: 102600 }, // ₱1,026
  'pro':     { coins: 913500,   amountCents: 285000 }, // ₱2,850
  'elite':   { coins: 1829250,  amountCents: 570000 }, // ₱5,700
};

// ── PayMongo API helper ───────────────────────────────────────
async function paymongoPost(path, body) {
  const encoded = Buffer.from(`${PAYMONGO_SECRET}:`).toString('base64');
  const res = await fetch(`https://api.paymongo.com/v1${path}`, {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${encoded}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json.errors ?? json));
  return json;
}

// ── Parse raw body ────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end',  () => {
      try { resolve({ raw: data, parsed: JSON.parse(data || '{}') }); }
      catch { resolve({ raw: data, parsed: {} }); }
    });
    req.on('error', reject);
  });
}

// ── HTTP server ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost`);
  const method = req.method;

  // ── CORS headers ────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const reply = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // ── Health check ─────────────────────────────────────────────
  if (method === 'GET' && url.pathname === '/health') {
    return reply(200, { status: 'ok', server: 'lounge-railway' });
  }

  // ── POST /reset-leaderboard/:period ──────────────────────────
  // Manually trigger a leaderboard reset (protected by RESET_SECRET)
  // Usage: POST /reset-leaderboard/daily  (or weekly / monthly)
  //        Header: x-reset-secret: <your RESET_SECRET env var>
  const resetMatch = url.pathname.match(/^\/reset-leaderboard\/(daily|weekly|monthly)$/);
  if (method === 'POST' && resetMatch) {
    if (req.headers['x-reset-secret'] !== process.env.RESET_SECRET) {
      return reply(401, { error: 'Unauthorized' });
    }
    const period = resetMatch[1];
    reply(200, { message: `${period} leaderboard reset triggered` });
    resetLeaderboard(period).catch(console.error);
    return;
  }

  // ── POST /create-payment ─────────────────────────────────────
  // Body: { uid, packageKey, paymentMethod, email }
  // paymentMethod: 'gcash' | 'paymaya' | 'card'
  // Returns: { checkoutUrl } — open this in WebView
  if (method === 'POST' && url.pathname === '/create-payment') {
    try {
      const { parsed } = await parseBody(req);
      const { uid, packageKey, paymentMethod, email } = parsed;

      if (!uid || !packageKey || !paymentMethod) {
        return reply(400, { error: 'Missing uid, packageKey, or paymentMethod' });
      }

      const pkg = COIN_PACKAGES[packageKey.toLowerCase()];
      if (!pkg) return reply(400, { error: 'Invalid package' });

      // Verify uid exists in Firebase
      const userSnap = await db.ref(`users/${uid}/profile/displayName`).once('value');
      if (!userSnap.exists()) return reply(403, { error: 'User not found' });

      // Create PayMongo payment link
      const linkRes = await paymongoPost('/links', {
        data: {
          attributes: {
            amount:      pkg.amountCents,
            currency:    'PHP',
            description: `Lounge ${packageKey} package — ${pkg.coins.toLocaleString()} coins`,
            remarks:     `uid=${uid};pkg=${packageKey}`, // ← parsed by webhook
          },
        },
      });

      const checkoutUrl = linkRes.data.attributes.checkout_url;
      const referenceNo = linkRes.data.attributes.reference_number;

      // Store pending payment in Firebase for reference
      await db.ref(`pending_payments/${referenceNo}`).set({
        uid,
        packageKey,
        coins:     pkg.coins,
        amount:    pkg.amountCents,
        createdAt: Date.now(),
        status:    'pending',
      });

      console.log(`[payment] Created link for uid=${uid} pkg=${packageKey} ref=${referenceNo}`);
      return reply(200, { checkoutUrl, referenceNo });

    } catch (err) {
      console.error('[payment] create-payment error:', err.message);
      return reply(500, { error: err.message });
    }
  }

  // ── POST /webhook ─────────────────────────────────────────────
  // Called by PayMongo when payment is completed
  if (method === 'POST' && url.pathname === '/webhook') {
    try {
      const { raw, parsed } = await parseBody(req);

      // ── Verify PayMongo webhook signature ──────────────────
      const sigHeader = req.headers['paymongo-signature'];
      if (PAYMONGO_WEBHOOK && sigHeader) {
        const parts    = sigHeader.split(',').reduce((acc, p) => {
          const [k, v] = p.split('='); acc[k] = v; return acc;
        }, {});
        const timestamp = parts['t'];
        const testSig   = parts['te'] ?? parts['li'];
        const toSign    = `${timestamp}.${raw}`;
        const expected  = crypto
          .createHmac('sha256', PAYMONGO_WEBHOOK)
          .update(toSign)
          .digest('hex');
        if (expected !== testSig) {
          console.warn('[webhook] Invalid signature — rejecting');
          return reply(401, { error: 'Invalid signature' });
        }
      }

      const eventType = parsed?.data?.attributes?.type;
      console.log(`[webhook] Event: ${eventType}`);

      // ── Handle payment paid event ──────────────────────────
      if (eventType === 'link.payment.paid') {
        const attrs    = parsed.data.attributes.data.attributes;
        const remarks  = attrs.remarks ?? '';          // uid=xxx;pkg=yyy
        const refNo    = attrs.reference_number ?? '';

        // Parse uid + packageKey from remarks
        const uidMatch = remarks.match(/uid=([^;]+)/);
        const pkgMatch = remarks.match(/pkg=([^;]+)/);

        if (!uidMatch || !pkgMatch) {
          console.error('[webhook] Could not parse uid/pkg from remarks:', remarks);
          return reply(200, { received: true }); // 200 so PayMongo doesn't retry
        }

        const uid        = uidMatch[1];
        const packageKey = pkgMatch[1];
        const pkg        = COIN_PACKAGES[packageKey];

        if (!pkg) {
          console.error('[webhook] Unknown package:', packageKey);
          return reply(200, { received: true });
        }

        // Idempotency — check if already credited
        const pendingSnap = await db.ref(`pending_payments/${refNo}`).once('value');
        const pending     = pendingSnap.val();
        if (pending?.status === 'credited') {
          console.log(`[webhook] Already credited ref=${refNo} — skipping`);
          return reply(200, { received: true });
        }

        // ── Credit coins atomically ────────────────────────
        await db.ref(`users/${uid}/wallet/coins`)
          .transaction(current => (current || 0) + pkg.coins);

        // ── Log transaction ────────────────────────────────
        const now = Date.now();
        await db.ref(`user_transactions/${uid}`).push({
          type:      'topUp',
          amount:    pkg.coins,
          currency:  'coins',
          label:     `Top-up — ${packageKey} (${pkg.coins.toLocaleString()} coins)`,
          createdAt: now,
        });

        // ── Mark as credited ───────────────────────────────
        await db.ref(`pending_payments/${refNo}`).update({
          status:    'credited',
          creditedAt: now,
        });

        console.log(`[webhook] ✅ Credited ${pkg.coins} coins → uid=${uid} ref=${refNo}`);
      }

      return reply(200, { received: true });

    } catch (err) {
      console.error('[webhook] error:', err.message);
      return reply(500, { error: err.message });
    }
  }

  reply(404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

// ============================================================
// ROULETTE GAME LOOP (unchanged below)
// ============================================================

const BET_MS    = 20_000;
const SPIN_MS   =  7_800;
const RESULT_MS =  4_000;

const SLOTS = [
  { label: 'x25', multiplier: 25 },
  { label: 'x45', multiplier: 45 },
  { label: 'x5a', multiplier:  5 },
  { label: 'x5b', multiplier:  5 },
  { label: 'x5c', multiplier:  5 },
  { label: 'x5d', multiplier:  5 },
  { label: 'x10', multiplier: 10 },
  { label: 'x15', multiplier: 15 },
];

function pickWinner() {
  const r = Math.floor(Math.random() * 100);
  if (r < 85) return [2, 3, 4, 5][Math.floor(Math.random() * 4)];
  if (r < 92) return 6;
  if (r < 97) return 7;
  if (r < 99) return 0;
  return 1;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function processPayout(winIdx) {
  const slot = SLOTS[winIdx];
  console.log(`[payout] Processing for slot ${winIdx} (${slot.label} x${slot.multiplier})`);

  const [betsSnap, bettersSnap] = await Promise.all([
    gameRef.child('bets').once('value'),
    gameRef.child('betters').once('value'),
  ]);

  const bets    = betsSnap.val()    || {};
  const betters = bettersSnap.val() || {};
  const winners = [];

  const payoutPromises = Object.entries(bets).map(async ([uid, uBets]) => {
    if (!uBets || typeof uBets !== 'object') return;
    const betAmt = parseInt(uBets[slot.label] ?? '0', 10) || 0;
    if (betAmt <= 0) return;
    const coinsWon = betAmt * slot.multiplier;
    const profile  = betters[uid] || {};
    await db.ref(`users/${uid}/wallet/coins`)
      .transaction(current => (current || 0) + coinsWon);
    await db.ref(`user_transactions/${uid}`).push({
      type: 'rouletteWin', amount: coinsWon, currency: 'coins',
      label: `Roulette win — ${slot.label}`, createdAt: Date.now(),
    });
    console.log(`[payout] +${coinsWon} coins → ${uid}`);
    winners.push({ uid, name: profile.name || uid.slice(0,6), avatar: profile.avatar || '', coinsWon });
  });

  await Promise.all(payoutPromises);
  winners.sort((a, b) => b.coinsWon - a.coinsWon);
  return winners;
}

async function runRound() {
  while (true) {
    try {
      const roundStart = Date.now();
      const winIdx     = pickWinner();
      console.log(`\n[round] ▶ Starting — winner slot ${winIdx} (${SLOTS[winIdx].label})`);
      const betTimer = sleep(BET_MS);
      await gameRef.update({
        roundStartTime: roundStart, winSlotIdx: -1, paidOut: false,
        bets: {}, betters: {}, winners: [], phase: 'betting', countdown: 20,
      });
      console.log('[round] ⏳ Betting phase...');
      await betTimer;
      console.log(`[round] 🎰 Spinning... winner = slot ${winIdx}`);
      await gameRef.update({ phase: 'spinning', winSlotIdx: winIdx });
      await sleep(SPIN_MS);
      const winners = await processPayout(winIdx);
      const histSnap = await gameRef.child('history').once('value');
      const oldHist  = Array.isArray(histSnap.val()) ? histSnap.val() : [];
      const newHist  = [winIdx, ...oldHist].slice(0, 6);
      console.log(`[round] 🏆 Result — ${winners.length} winner(s)`);
      await gameRef.update({ phase: 'result', paidOut: true, winners, history: newHist });
      await sleep(RESULT_MS);
      console.log('[round] ✅ Round complete');
    } catch (err) {
      console.error('[round] ❌ Error:', err.message);
      await sleep(5_000);
    }
  }
}

console.log('🎰 Lounge Game Server + PayMongo starting...');
runRound();

// ============================================================
// LEADERBOARD RESET (daily / weekly / monthly)
// All schedules in UTC targeting 12:00 AM Manila (UTC+8)
// ============================================================

const LEADERBOARD_TYPES = ['wealth', 'charm', 'room'];

async function resetLeaderboard(period) {
  const now    = new Date();
  // Date key in Manila time
  const manila = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const dateKey = manila.toISOString().slice(0, 10); // "2025-03-24"

  console.log(`\n[leaderboard] ⏰ Starting ${period.toUpperCase()} reset (${dateKey})...`);

  for (const type of LEADERBOARD_TYPES) {
    const livePath    = `leaderboard/${type}/${period}`;
    const archivePath = `leaderboard_archive/${period}/${dateKey}/${type}`;
    try {
      const snap = await db.ref(livePath).get();
      if (snap.exists()) {
        await db.ref(archivePath).set(snap.val());
        console.log(`[leaderboard]   ✓ Archived  → ${archivePath}`);
      }
      await db.ref(livePath).remove();
      console.log(`[leaderboard]   ✓ Cleared   ${livePath}`);
    } catch (err) {
      console.error(`[leaderboard]   ✗ FAILED    ${livePath}:`, err.message);
    }
  }

  console.log(`[leaderboard] ✅ ${period.toUpperCase()} reset done.\n`);
}

// Daily  — every day at 16:00 UTC = 12:00 AM Manila
// --- CRON SCHEDULES (8:00 AM Manila = 00:00 UTC) ---

// Daily — Every day at 00:00 UTC
cron.schedule('0 0 * * *', () => {
  resetLeaderboard('daily').catch(console.error);
}, { timezone: 'UTC' });

// Weekly — Every Monday at 00:00 UTC
cron.schedule('0 0 * * 1', () => {
  resetLeaderboard('weekly').catch(console.error);
}, { timezone: 'UTC' });

// Monthly — 1st day of every month at 00:00 UTC
cron.schedule('0 0 1 * *', () => {
  resetLeaderboard('monthly').catch(console.error);
}, { timezone: 'UTC' });

console.log('📅 Leaderboard reset schedules active (daily/weekly/monthly @ 12:00 AM Manila)');
