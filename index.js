// ============================================================
// roulette-server/index.js
// Greedy ProMax — Game Orchestrator
// Runs on Railway.app (free tier)
//
// Responsibilities:
//   1. Start new rounds automatically (forever loop)
//   2. Pick winner server-side (tamper-proof)
//   3. Process payouts securely (only server credits coins)
//
// Firebase path: globalGames/roulette
// ============================================================

const admin = require('firebase-admin');

// ── Firebase init ─────────────────────────────────────────────
// Set FIREBASE_SERVICE_ACCOUNT env var in Railway dashboard
// (paste the entire JSON content of your service account key)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  // e.g. https://your-project-default-rtdb.firebaseio.com
});

const db      = admin.database();
const gameRef = db.ref('globalGames/roulette');

// ── Round timing (ms) ─────────────────────────────────────────
const BET_MS    = 20_000;  // 20s betting
const SPIN_MS   =  7_800;  // 7.8s spinning (matches client animation)
const RESULT_MS =  4_000;  // 4s result display
const ROUND_MS  = BET_MS + SPIN_MS + RESULT_MS; // 31_800ms total

// ── Slot definitions (must match Flutter _slots array) ────────
const SLOTS = [
  { label: 'x25', multiplier: 25 },  // index 0 — 🍗
  { label: 'x45', multiplier: 45 },  // index 1 — 🥩
  { label: 'x5a', multiplier:  5 },  // index 2 — 🥕
  { label: 'x5b', multiplier:  5 },  // index 3 — 🍎
  { label: 'x5c', multiplier:  5 },  // index 4 — 🥭
  { label: 'x5d', multiplier:  5 },  // index 5 — 🍓
  { label: 'x10', multiplier: 10 },  // index 6 — 🍢
  { label: 'x15', multiplier: 15 },  // index 7 — 🐟
];

// ── Winner picker — server-side, tamper-proof ─────────────────
// x5 = 85%, x10 = 7%, x15 = 5%, x25 = 2%, x45 = 1%
function pickWinner() {
  const r = Math.floor(Math.random() * 100);
  if (r < 85) return [2, 3, 4, 5][Math.floor(Math.random() * 4)]; // x5
  if (r < 92) return 6;  // x10
  if (r < 97) return 7;  // x15
  if (r < 99) return 0;  // x25
  return 1;               // x45
}

// ── Sleep helper ──────────────────────────────────────────────
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Payout ───────────────────────────────────────────────────
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

    // ── Credit coins — server-side atomic increment ──────────
    await db.ref(`users/${uid}/wallet/coins`)
      .transaction(current => (current || 0) + coinsWon);

    // ── Log transaction ───────────────────────────────────────
    await db.ref(`user_transactions/${uid}`).push({
      type:      'rouletteWin',
      amount:    coinsWon,
      currency:  'coins',
      label:     `Roulette win — ${slot.label}`,
      createdAt: Date.now(),
    });

    console.log(`[payout] +${coinsWon} coins → ${uid} (${profile.name || uid.slice(0,6)})`);

    winners.push({
      uid,
      name:      profile.name     || uid.slice(0, 6),
      avatar:    profile.avatar   || '',
      coinsWon,
    });
  });

  await Promise.all(payoutPromises);

  // Sort by coinsWon desc
  winners.sort((a, b) => b.coinsWon - a.coinsWon);
  return winners;
}

// ── Main round loop ───────────────────────────────────────────
async function runRound() {
  while (true) {
    try {
      const roundStart = Date.now();
      const winIdx     = pickWinner();

      console.log(`\n[round] ▶ Starting new round — winner will be slot ${winIdx} (${SLOTS[winIdx].label})`);

      // ── Write round start to Firebase ──────────────────────
      // NOTE: winSlotIdx is intentionally NOT written here during betting phase
      // to prevent clients from reading the winner before the spin.
      // It is revealed only when the spinning phase starts.
      await gameRef.update({
        roundStartTime: roundStart,
        winSlotIdx:     -1,        // hidden during betting
        paidOut:        false,
        bets:           {},
        betters:        {},
        winners:        [],
        phase:          'betting',
        countdown:      20,
      });

      // ── Betting phase (20s) ─────────────────────────────────
      console.log('[round] ⏳ Betting phase (20s)...');
      await sleep(BET_MS);

      // ── Spinning phase (7.8s) — reveal winner now ───────────
      console.log(`[round] 🎰 Spinning... winner = slot ${winIdx} (${SLOTS[winIdx].label})`);
      await gameRef.update({ phase: 'spinning', winSlotIdx: winIdx });
      await sleep(SPIN_MS);

      // ── Process payout ──────────────────────────────────────
      const winners = await processPayout(winIdx);

      // ── Update history ──────────────────────────────────────
      const histSnap = await gameRef.child('history').once('value');
      const oldHist  = Array.isArray(histSnap.val()) ? histSnap.val() : [];
      const newHist  = [winIdx, ...oldHist].slice(0, 6);

      // ── Result phase (4s) ───────────────────────────────────
      console.log(`[round] 🏆 Result phase — ${winners.length} winner(s)`);
      await gameRef.update({
        phase:   'result',
        paidOut: true,
        winners,
        history: newHist,
      });

      await sleep(RESULT_MS);

      console.log('[round] ✅ Round complete');

    } catch (err) {
      console.error('[round] ❌ Error:', err.message);
      // Wait 5s before retrying to avoid hammering Firebase on errors
      await sleep(5_000);
    }
  }
}

// ── Startup ───────────────────────────────────────────────────
console.log('🎰 Greedy ProMax Game Server starting...');
console.log(`   Round duration: ${ROUND_MS / 1000}s (${BET_MS/1000}s bet + ${SPIN_MS/1000}s spin + ${RESULT_MS/1000}s result)`);
runRound();
