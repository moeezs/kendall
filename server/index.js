import { Telegraf } from "telegraf";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { pipeline } from "@huggingface/transformers";
import BetterSqlite3 from "better-sqlite3";
import os from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "dotenv";

// Load .env from the server directory
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env") });

for (const key of [
  "GEMINI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_ID",
]) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    console.error(`   Copy server/.env.example to server/.env and fill it in.`);
    process.exit(1);
  }
}

// telegram user id
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10);

function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const appId = process.env.KENDALL_APP_ID;
  const home = os.homedir();
  switch (process.platform) {
    case "win32":
      return join(
        process.env.APPDATA || join(home, "AppData", "Roaming"),
        appId,
        "kendall.db",
      );
    case "linux":
      return join(home, ".local", "share", appId, "kendall.db");
    default: // macOS
      return join(home, "Library", "Application Support", appId, "kendall.db");
  }
}
const DB_PATH = resolveDbPath();

let db;
try {
  db = new BetterSqlite3(DB_PATH);
  db.pragma("journal_mode = WAL"); // safe concurrent access with the app
  db.pragma("foreign_keys = ON");
} catch (err) {
  console.error("❌ Could not open database:", err.message);
  console.error(
    `   Make sure the Kendall app has been launched at least once.`,
  );
  console.error(`   Expected DB at: ${DB_PATH}`);
  process.exit(1);
}

// Ensure the telegram chat row exists in the chats table
const TELEGRAM_CHAT_ID = "telegram-bot";
db.prepare(`INSERT OR IGNORE INTO chats (id, title) VALUES (?, ?)`).run(
  TELEGRAM_CHAT_ID,
  "Telegram Bot",
);

// embedding
let embedder = null;
async function getEmbedder() {
  if (!embedder) {
    console.log("Loading embedding model (first run may take a moment)...");
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    console.log("Embedding model ready.");
  }
  return embedder;
}

async function generateEmbedding(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

// cosine similarity
function cosineSimilarity(a, b) {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// rag search
async function searchContext(query, topK = 3) {
  const queryVec = await generateEmbedding(query);
  const files = db
    .prepare("SELECT * FROM files WHERE embedding IS NOT NULL")
    .all();

  return files
    .map((f) => {
      let emb = [];
      try {
        emb = JSON.parse(f.embedding);
      } catch {}
      return { ...f, score: cosineSimilarity(queryVec, emb) };
    })
    .filter((f) => f.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// db helpers
function saveMessage(role, content, sources = null) {
  db.prepare(
    `INSERT INTO messages (chat_id, role, content, sources) VALUES (?, ?, ?, ?)`,
  ).run(
    TELEGRAM_CHAT_ID,
    role,
    content,
    sources ? JSON.stringify(sources) : null,
  );
}

// Load the last N turns from the DB, in chronological order
function loadHistory(maxTurns = 20) {
  const rows = db
    .prepare(
      `SELECT role, content FROM (
         SELECT role, content, created_at FROM messages
         WHERE chat_id = ?
         ORDER BY created_at DESC
         LIMIT ?
       ) ORDER BY created_at ASC`,
    )
    .all(TELEGRAM_CHAT_ID, maxTurns * 2);

  return rows.map((r) => ({
    role: r.role === "ai" ? "model" : "user",
    parts: [{ text: r.content }],
  }));
}

// gemini and rag
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function askKendall(userText) {
  const allFiles = db
    .prepare("SELECT id FROM files WHERE embedding IS NOT NULL")
    .all();
  const contexts = await searchContext(userText);

  const contextBlock =
    contexts.length > 0
      ? contexts
          .map(
            (c) =>
              `[Source: ${c.filename}]\n${(c.content || "").substring(0, 1500)}`,
          )
          .join("\n\n---\n\n")
      : null;

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
    systemInstruction: `You are Kendall, a concise and friendly personal AI assistant with access to ${allFiles.length} indexed local files.

Rules:
- Be brief and conversational. You're on Telegram so keep it readable on a phone.
- Write in plain text only. No markdown, no asterisks, no headers.
- When asked about the user's data, use the file context to answer accurately.
- If the provided context is not relevant to the question, ignore it and answer naturally.
- ONLY reference files you actually used to form your answer.
- Always end your response with exactly: USED_SOURCES: <comma-separated filenames> or USED_SOURCES: NONE`,
  });

  const history = loadHistory(20);
  const chat = model.startChat({ history });

  const userMessage = contextBlock
    ? `Context from my files:\n${contextBlock}\n\nQuestion: ${userText}`
    : userText;

  const result = await chat.sendMessage(userMessage);
  let responseText = result.response.text();

  // Parse the USED_SOURCES line
  let usedSources = [];
  const sourcesMatch = responseText.match(/USED_SOURCES:\s*(.+)/i);
  if (sourcesMatch) {
    const raw = sourcesMatch[1].trim();
    if (raw.toUpperCase() !== "NONE") {
      usedSources = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    responseText = responseText.replace(/\n?USED_SOURCES:\s*.+/i, "").trim();
  }

  const contextFiles = contexts
    .filter((c) =>
      usedSources.some((s) => c.filename.includes(s) || s.includes(c.filename)),
    )
    .map((c) => c.path);

  return { answer: responseText, contextFiles };
}

// bot setup
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Block every request that is not from your Telegram user ID (silently ignored)
bot.use((ctx, next) => {
  if (ctx.from?.id !== ALLOWED_USER_ID) {
    console.warn(`[telegram] Blocked unauthorized user ID: ${ctx.from?.id}`);
    return;
  }
  return next();
});

bot.start((ctx) =>
  ctx.reply(
    "Hey, I'm Kendall. I have access to all your indexed files — just ask me anything.\n\nUse /reset to clear our conversation history.",
  ),
);

bot.command("reset", (ctx) => {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(TELEGRAM_CHAT_ID);
  ctx.reply("Conversation cleared.");
});

bot.on("text", async (ctx) => {
  const userText = ctx.message.text.trim();
  if (!userText) return;

  console.log(`[telegram] "${userText}"`);
  await ctx.sendChatAction("typing");

  try {
    // Save the user message to the DB before calling Gemini
    saveMessage("user", userText);

    const { answer, contextFiles } = await askKendall(userText);

    // Save the AI response (role "ai" matches what the app uses)
    saveMessage("ai", answer, contextFiles.length > 0 ? contextFiles : null);

    console.log(`[telegram] Reply: "${answer.substring(0, 80)}..."`);

    if (answer.length <= 4096) {
      await ctx.reply(answer);
    } else {
      for (const chunk of splitMessage(answer, 4000)) {
        await ctx.reply(chunk);
      }
    }
  } catch (err) {
    console.error("[telegram] Error:", err.message);
    await ctx.reply("I ran into an issue. Please try again.");
  }
});

// helpers
function splitMessage(text, maxLen) {
  const chunks = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let current = "";
  for (const sentence of sentences) {
    if ((current + " " + sentence).trim().length > maxLen) {
      if (current) chunks.push(current.trim());
      current = sentence;
    } else {
      current = (current + " " + sentence).trim();
    }
  }
  if (current) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text.substring(0, maxLen)];
}

// launch the bot
bot.launch().then(() => {
  console.log("\n✅ Kendall Telegram bot running (long polling)");
  console.log(`   DB: ${DB_PATH}`);
  console.log(`   Restricted to Telegram user ID: ${ALLOWED_USER_ID}`);
  console.log(`   Chats stored in DB under chat ID: "${TELEGRAM_CHAT_ID}"\n`);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
