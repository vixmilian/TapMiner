// Tapminer — combined bot + API + Mini App hosting (webhook mode)
// One single service does everything: serves tapminer.html, runs the bot,
// and stores player state — so you only need ONE deploy, not three.
//
// Required environment variables (set these in your host's dashboard, never in code):
//   BOT_TOKEN     — from @BotFather
// Optional:
//   WEB_APP_URL   — only needed if you host tapminer.html somewhere else.
//                    Leave unset and this server serves it for you at /tapminer.html
//   CHANNEL_USERNAME — public channel to verify, e.g. @tapminer_news (defaults to that)
//   GROUP_CHAT_ID    — numeric chat id of the private group mission.
//   FIREBASE_DB_URL  — a free Firebase Realtime Database URL. Set this so player
//                      progress survives redeploys — Render's free tier wipes local
//                      files (db.json) every time you push a change.
// Render sets these automatically, you don't need to add them:
//   RENDER_EXTERNAL_URL — this service's own public URL
//   PORT

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
const WEB_APP_URL = process.env.WEB_APP_URL || (PUBLIC_URL ? `${PUBLIC_URL}/tapminer.html` : null);
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');
const WEBHOOK_PATH = '/telegraf-webhook';
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@tapminer_news';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '-1002645219026';
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');

if (!BOT_TOKEN) { console.error('Missing BOT_TOKEN environment variable.'); process.exit(1); }
if (!WEB_APP_URL) { console.error('Could not determine the Mini App URL.'); process.exit(1); }
if (!FIREBASE_DB_URL) {
  console.warn('FIREBASE_DB_URL not set — player progress is saved to a local file and WILL be lost on the next redeploy.');
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    `Welcome to Tapminer, ${ctx.from.first_name}! 🪙\n\nTap to earn coins, complete missions, and rise through the ranks — Coal, Copper, Iron, Silver, Gold and beyond.`,
    Markup.inlineKeyboard([ Markup.button.webApp('🪙 Open Tapminer', WEB_APP_URL) ])
  );
});
bot.help((ctx) => ctx.reply('Tap /start to open the Tapminer Mini App and start mining.'));
bot.command('chatid', (ctx) => ctx.reply(`This chat's id is: ${ctx.chat.id}`));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(bot.webhookCallback(WEBHOOK_PATH));

// --- Persistent storage layer ---
function readLocalDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (err) { return {}; } }
function writeLocalDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

async function getPlayer(id) {
  if (FIREBASE_DB_URL) {
    try {
      const res = await fetch(`${FIREBASE_DB_URL}/players/${id}.json`);
      return await res.json();
    } catch (err) {
      console.error('Firebase read error:', err.message);
      return null;
    }
  }
  const db = readLocalDB();
  return db[id] || null;
}

async function setPlayer(id, data) {
  if (FIREBASE_DB_URL) {
    try {
      await fetch(`${FIREBASE_DB_URL}/players/${id}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch (err) {
      console.error('Firebase write error:', err.message);
    }
    return;
  }
  const db = readLocalDB();
  db[id] = data;
  writeLocalDB(db);
}

async function getAllPlayers() {
  if (FIREBASE_DB_URL) {
    try {
      const res = await fetch(`${FIREBASE_DB_URL}/players.json`);
      const data = await res.json();
      return data || {};
    } catch (err) {
      console.error('Firebase read error:', err.message);
      return {};
    }
  }
  return readLocalDB();
}

function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return null;
  const userJson = params.get('user');
  if (!userJson) return null;
  try { return JSON.parse(userJson); } catch (err) { return null; }
}

function requireTelegramUser(req, res, next) {
  const user = verifyInitData(req.header('X-Telegram-Init-Data'));
  if (!user) return res.status(401).json({ error: 'Invalid or missing Telegram auth' });
  req.tgUser = user;
  next();
}

app.get('/api/state', requireTelegramUser, async (req, res) => {
  try {
    const player = await getPlayer(req.tgUser.id);
    res.json(player || null);
  } catch (err) {
    res.status(500).json({ error: 'Could not load state' });
  }
});
app.post('/api/state', requireTelegramUser, async (req, res) => {
  try {
    await setPlayer(req.tgUser.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not save state' });
  }
});

app.get('/api/check-membership', requireTelegramUser, async (req, res) => {
  const target = req.query.target;
  let chatId = null;
  if (target === 'channel') chatId = CHANNEL_USERNAME;
  else if (target === 'group') chatId = GROUP_CHAT_ID;
  if (!chatId) return res.status(400).json({ error: 'This mission is not configured for verification yet', isMember: false });

  try {
    const member = await bot.telegram.getChatMember(chatId, req.tgUser.id);
    const isMember = ['member', 'administrator', 'creator'].includes(member.status);
    res.json({ isMember });
  } catch (err) {
    console.error('getChatMember failed:', err.message);
    res.status(200).json({ isMember: false, error: 'Could not verify — make sure the bot is added to that chat as an admin' });
  }
});

app.get('/health', (req, res) => res.send('Tapminer bot + API is running'));

const PROMO_START = new Date('2026-07-16T00:00:00Z');
const PROMO_REWARD = 500;
const REQUIRED_DAILY_QUEST_IDS = ['tap50', 'earn2000', 'boost', 'visitshop'];
const PROMO_CODES = [
  'EGF90UXC61', 'FRF13KJO23', 'BUL79KZC46', 'BNJ43PJA73', 'OHD75EWZ37',
  'DPC90IYB38', 'LUZ49PSJ23', 'NKM41CEZ97', 'GAY21DMO41', 'NSR73YWG45',
  'QWQ50HDR23', 'UPJ42EJL98', 'HLC67QYG14', 'FCL97KGH63', 'VFR98NHD07',
  'JTE86RIE74', 'OGA80LYR60', 'JAY92IAJ68', 'XYO12ROK71', 'PKQ36SWI68',
  'WRA37SOA27', 'UII96UCV78', 'OIN58OFF82', 'VWJ94OAJ30', 'GRL13XQU53',
  'EKV65XFG55', 'CQL43QUK33', 'YUV62PEO62', 'LZV14QTF12', 'DBS01EPN21',
  'HPY67VMJ09', 'BPD05YEO53', 'CFT67RKR36', 'QTP66BLF56', 'VLQ14UJK03',
  'JOP22GWX92', 'SEN37TOJ21', 'ZXJ42TIV49', 'VDR72UGT97', 'KYZ31DQZ96',
  'XRP68CNN86', 'RLQ09ERN60', 'VQC77CZJ82', 'UDU71QDM33', 'UPA23CHS69',
  'ECY29TZM16', 'DVR12QKF20', 'REU29AWD29', 'DIX79MHG05', 'NMO13RJC64',
  'ZQJ34MXH92', 'PTX20ZGM28', 'QSO63XOO30', 'ZTN61ZEF23', 'MTV08CRP89',
  'DWT82APO97', 'BAN50VTL39', 'CHD01OCI11', 'AHK55QOT63', 'OIR50CCE11',
  'UWD61AWU73', 'DPH01OEB35', 'PMB83DLT73', 'GKP91FGV15', 'MBV81VHP41',
  'DGN34XML16', 'LVC17XBU64', 'LEO64LQO27', 'PDJ64WVS07', 'WIU91SVG18',
  'QUI01KEC43', 'THT00UID81', 'OWX97FZG62', 'EVB91JWM45', 'ZSE95QNX89',
  'PSZ93JJG15', 'WQH01PRQ15', 'QCO96NBD68', 'RMB65ZKU09', 'OES37ONX13',
  'INV55VYH69', 'ELT42BRQ99', 'OES37PXS10', 'KXW71ZVH96', 'UYQ48ZIY75',
  'MHV69PZO22', 'ZKE13HJX01', 'QBY09YBW15', 'KSH29JGI98', 'JHN49ERB94',
];

// Day boundary aligned to 7:00 AM Tashkent time (UTC+5) = 02:00 UTC,
// so server-side daily checks (promo code gating) match the client's reset time.
const RESET_HOUR_UTC = 2;
function todayDateKey() {
  const shifted = new Date(Date.now() - RESET_HOUR_UTC * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${shifted.getUTCMonth() + 1}-${shifted.getUTCDate()}`;
}
function daysSincePromoStart() {
  const now = new Date(Date.now() - RESET_HOUR_UTC * 60 * 60 * 1000);
  const start = new Date(PROMO_START.getTime() - RESET_HOUR_UTC * 60 * 60 * 1000);
  const utcNow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const utcStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  return Math.floor((utcNow - utcStart) / 86400000);
}

app.post('/api/redeem-promo', requireTelegramUser, async (req, res) => {
  const code = ((req.body && req.body.code) || '').trim().toUpperCase();
  const dayIndex = daysSincePromoStart();

  if (dayIndex < 0 || dayIndex >= PROMO_CODES.length) {
    return res.json({ ok: false, message: 'No promo code is active today.' });
  }
  if (code !== PROMO_CODES[dayIndex]) {
    return res.json({ ok: false, message: 'Invalid promo code.' });
  }

  const player = await getPlayer(req.tgUser.id);
  if (!player) {
    return res.json({ ok: false, message: 'Play a bit first so your progress is saved, then try again.' });
  }

  const today = todayDateKey();
  const questsDone = player.questDate === today &&
    REQUIRED_DAILY_QUEST_IDS.every((id) => player.questClaims && player.questClaims[id]);
  if (!questsDone) {
    return res.json({ ok: false, message: 'Please complete today\'s daily quests first, then redeem the code.' });
  }

  player.promoRedeemedDates = player.promoRedeemedDates || [];
  if (player.promoRedeemedDates.includes(today)) {
    return res.json({ ok: false, message: 'You already redeemed today\'s code.' });
  }

  player.promoRedeemedDates.push(today);
  player.coins = (player.coins || 0) + PROMO_REWARD;
  player.totalEarned = (player.totalEarned || 0) + PROMO_REWARD;
  await setPlayer(req.tgUser.id, player);
  res.json({ ok: true, reward: PROMO_REWARD });
});

app.get('/api/leaderboard', requireTelegramUser, async (req, res) => {
  const db = await getAllPlayers();
  const entries = Object.entries(db).map(([id, s]) => ({
    id: 'tg' + id,
    nickname: (s && s.nickname) || 'Miner',
    avatar: (s && s.avatar) || '⛏️',
    totalEarned: (s && s.totalEarned) || 0,
  }));
  entries.sort((a, b) => b.totalEarned - a.totalEarned);
  res.json(entries.slice(0, 60));
});

app.get('/api/referral-stats', requireTelegramUser, async (req, res) => {
  const db = await getAllPlayers();
  const myId = 'tg' + req.tgUser.id;
  let count = 0;
  Object.values(db).forEach((s) => { if (s && s.referredBy === myId) count += 1; });
  res.json({ count, bonus: count * 200 });
});

app.listen(PORT, async () => {
  console.log(`Tapminer server listening on port ${PORT}`);
  if (PUBLIC_URL) {
    try {
      await bot.telegram.setWebhook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
      console.log('Webhook set to', `${PUBLIC_URL}${WEBHOOK_PATH}`);
    } catch (err) {
      console.error('Failed to set webhook:', err.message);
    }
  } else {
    console.warn('PUBLIC_URL/RENDER_EXTERNAL_URL not set yet.');
  }
});
