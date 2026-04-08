import { Telegraf } from "telegraf";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { pipeline } from "@huggingface/transformers";
import BetterSqlite3 from "better-sqlite3";
import os from "os";
import http from "http";
import fs from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";
import { config } from "dotenv";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

// Load .env from the server directory
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env") });

for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID"]) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    console.error(`   Copy server/.env.example to server/.env and fill it in.`);
    process.exit(1);
  }
}

// telegram user id
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10);
if (!Number.isFinite(ALLOWED_USER_ID)) {
  console.error(
    "❌ Invalid TELEGRAM_ALLOWED_USER_ID: expected a numeric Telegram user ID.",
  );
  console.error(
    "   Check server/.env and ensure TELEGRAM_ALLOWED_USER_ID is set to your numeric Telegram user ID.",
  );
  process.exit(1);
}

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

// ── Settings table ──
db.prepare(
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`,
).run();

// Default settings — per-feature provider + model selection
const DEFAULT_SETTINGS = {
  provider: "gemini", // global fallback: "gemini" or "ollama"
  gemini_api_key: process.env.GEMINI_API_KEY || "",
  ollama_url: "http://localhost:11434",
  // Per-feature provider override (defaults to global provider)
  bot_provider: "",
  chat_provider: "",
  work_provider: "",
  autosort_provider: "",
  // Per-feature models
  bot_gemini_model: "gemini-2.5-flash-lite",
  bot_ollama_model: "llama3.1",
  chat_gemini_model: "gemini-2.5-flash-lite",
  chat_ollama_model: "llama3.1",
  work_gemini_model: "gemini-2.5-flash-lite",
  work_ollama_model: "llama3.1",
  autosort_gemini_model: "gemini-2.5-flash-lite",
  autosort_ollama_model: "llama3.1",
};

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : DEFAULT_SETTINGS[key] || null;
}

function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    key,
    value,
  );
}

function getAllSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const stored = {};
  for (const row of rows) stored[row.key] = row.value;
  return { ...DEFAULT_SETTINGS, ...stored };
}

// Initialize defaults if not set
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  const existing = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key);
  if (!existing) setSetting(key, value);
}

// ── LLM Abstraction Layer ──
// Unified interface for Gemini and Ollama

// Resolve which model to use for a given feature
function resolveModel(feature = "bot") {
  const settings = getAllSettings();
  // Per-feature provider override, falling back to global provider
  const provider =
    settings[`${feature}_provider`] || settings.provider || "gemini";
  if (provider === "ollama") {
    return settings[`${feature}_ollama_model`] || "llama3.1";
  }
  return settings[`${feature}_gemini_model`] || "gemini-2.5-flash-lite";
}

function resolveProvider(feature = "bot") {
  const settings = getAllSettings();
  return settings[`${feature}_provider`] || settings.provider || "gemini";
}

async function callOllamaChat(messages, options = {}) {
  const settings = getAllSettings();
  const url = `${settings.ollama_url}/api/chat`;

  const body = {
    model: options.model || "llama3.1",
    messages,
    stream: false,
  };

  if (options.tools) {
    body.tools = options.tools;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama error (${res.status}): ${errText}`);
  }

  return await res.json();
}

async function callOllamaGenerate(prompt, systemPrompt, options = {}) {
  const settings = getAllSettings();
  const url = `${settings.ollama_url}/api/generate`;

  const body = {
    model: options.model || "llama3.1",
    prompt,
    system: systemPrompt || undefined,
    stream: false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.response;
}

// Convert Gemini tool format to Ollama tool format
function geminiToolsToOllamaTools(geminiTools) {
  const ollamaTools = [];
  for (const toolGroup of geminiTools) {
    for (const decl of toolGroup.functionDeclarations) {
      const properties = {};
      const required = decl.parameters?.required || [];

      if (decl.parameters?.properties) {
        for (const [propName, propDef] of Object.entries(
          decl.parameters.properties,
        )) {
          properties[propName] = {
            type: propDef.type?.toLowerCase() || "string",
            description: propDef.description || "",
          };
        }
      }

      ollamaTools.push({
        type: "function",
        function: {
          name: decl.name,
          description: decl.description,
          parameters: {
            type: "object",
            properties,
            required,
          },
        },
      });
    }
  }
  return ollamaTools;
}

// Unified LLM call that works with both providers
// feature: "bot" | "chat" | "work" | "autosort" — determines which model to use
async function llmChat(
  systemPrompt,
  conversationHistory,
  userMessage,
  options = {},
) {
  const settings = getAllSettings();
  const feature = options.feature || "bot";
  const provider = resolveProvider(feature);
  const model = resolveModel(feature);

  if (provider === "ollama") {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    for (const msg of conversationHistory) {
      messages.push({
        role: msg.role === "model" ? "assistant" : msg.role,
        content: msg.parts?.[0]?.text || msg.content || "",
      });
    }
    messages.push({ role: "user", content: userMessage });

    const ollamaOpts = { model };
    if (options.tools) {
      ollamaOpts.tools = geminiToolsToOllamaTools(options.tools);
    }

    const result = await callOllamaChat(messages, ollamaOpts);

    // Check for tool calls
    if (result.message?.tool_calls && result.message.tool_calls.length > 0) {
      const toolCall = result.message.tool_calls[0];
      return {
        text: result.message.content || "",
        functionCall: {
          name: toolCall.function.name,
          args: toolCall.function.arguments || {},
        },
        _ollamaMessages: [...messages, result.message],
      };
    }

    return {
      text: result.message?.content || "",
      functionCall: null,
      _ollamaMessages: [...messages, result.message],
    };
  }

  // Gemini provider
  const apiKey = settings.gemini_api_key;
  if (!apiKey)
    throw new Error("Gemini API key not configured. Go to Settings to set it.");

  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({
    model: model,
    systemInstruction: systemPrompt,
    ...(options.tools ? { tools: options.tools } : {}),
  });

  const chat = genModel.startChat({ history: conversationHistory });
  const result = await chat.sendMessage(userMessage);
  const response = result.response;

  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const functionCallPart = parts.find((p) => p.functionCall);

  return {
    text: response.text() || "",
    functionCall: functionCallPart ? functionCallPart.functionCall : null,
    _geminiChat: chat,
  };
}

// Continue a conversation after a function call result
async function llmContinue(
  prevResult,
  functionName,
  functionResponse,
  options = {},
) {
  const settings = getAllSettings();
  const feature = options.feature || "bot";
  const provider = resolveProvider(feature);
  const model = resolveModel(feature);

  if (provider === "ollama") {
    const messages = prevResult._ollamaMessages || [];
    messages.push({
      role: "tool",
      content: JSON.stringify(functionResponse),
    });

    const ollamaOpts = { model };
    if (options.tools) {
      ollamaOpts.tools = geminiToolsToOllamaTools(options.tools);
    }

    const result = await callOllamaChat(messages, ollamaOpts);

    if (result.message?.tool_calls && result.message.tool_calls.length > 0) {
      const toolCall = result.message.tool_calls[0];
      return {
        text: result.message.content || "",
        functionCall: {
          name: toolCall.function.name,
          args: toolCall.function.arguments || {},
        },
        _ollamaMessages: [...messages, result.message],
      };
    }

    return {
      text: result.message?.content || "",
      functionCall: null,
      _ollamaMessages: [...messages, result.message],
    };
  }

  // Gemini
  const chat = prevResult._geminiChat;
  if (!chat) throw new Error("No Gemini chat session to continue");

  const result = await chat.sendMessage([
    { functionResponse: { name: functionName, response: functionResponse } },
  ]);
  const response = result.response;

  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const functionCallPart = parts.find((p) => p.functionCall);

  return {
    text: response.text() || "",
    functionCall: functionCallPart ? functionCallPart.functionCall : null,
    _geminiChat: chat,
  };
}

// Simple generation (no chat, no tools) — for document generation phases
// feature: "bot" | "chat" | "work" | "autosort"
async function llmGenerate(systemPrompt, prompt, feature = "bot") {
  const settings = getAllSettings();
  const provider = resolveProvider(feature);
  const model = resolveModel(feature);

  if (provider === "ollama") {
    return await callOllamaGenerate(prompt, systemPrompt, { model });
  }

  const apiKey = settings.gemini_api_key;
  if (!apiKey) throw new Error("Gemini API key not configured.");

  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({
    model: model,
    systemInstruction: systemPrompt,
  });

  const result = await genModel.generateContent(prompt);
  return result.response.text();
}

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

  // First, fetch only the minimal data needed for scoring (id + embedding)
  const fileEmbeddings = db
    .prepare("SELECT id, embedding FROM files WHERE embedding IS NOT NULL")
    .all();

  const scored = fileEmbeddings
    .map((f) => {
      let emb = [];
      try {
        emb = JSON.parse(f.embedding);
      } catch {}
      return { id: f.id, score: cosineSimilarity(queryVec, emb) };
    })
    .filter((f) => f.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (scored.length === 0) {
    return [];
  }

  // Fetch full rows only for the top-K matching ids
  const ids = scored.map((f) => f.id);
  const placeholders = ids.map(() => "?").join(", ");
  const fullRows = db
    .prepare(`SELECT * FROM files WHERE id IN (${placeholders})`)
    .all(...ids);

  // Index full rows by id for quick lookup
  const rowsById = new Map(fullRows.map((row) => [row.id, row]));

  // Return full rows in score order, augmented with their score
  return scored.map((s) => {
    const row = rowsById.get(s.id) || {};
    return { ...row, score: s.score };
  });
}

// db helpers — chat message functions moved to session management below

// gemini and rag — now uses LLM abstraction

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

  const systemPrompt = `You are Kendall, a concise and friendly personal AI assistant with access to ${allFiles.length} indexed local files.

Rules:
- Be brief and conversational. You're on Telegram so keep it readable on a phone.
- Write in plain text only. No markdown, no asterisks, no headers.
- When asked about the user's data, use the file context to answer accurately.
- If the provided context is not relevant to the question, ignore it and answer naturally.
- ONLY reference files you actually used to form your answer.
- Always end your response with exactly: USED_SOURCES: <comma-separated filenames> or USED_SOURCES: NONE`;

  const history = loadCurrentHistory(20);

  const userMessage = contextBlock
    ? `Context from my files:\n${contextBlock}\n\nQuestion: ${userText}`
    : userText;

  const result = await llmChat(systemPrompt, history, userMessage);
  let responseText = result.text;

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

// ── Session state (single-user bot) ──
let activeProjectId = null;
let lastGeneratedDocument = null;
let lastDocumentTitle = null;
let currentChatId = TELEGRAM_CHAT_ID; // tracks the active conversation

// ── Conversation management ──
function createTelegramChat(title) {
  const id = `telegram-${Date.now()}`;
  db.prepare("INSERT OR IGNORE INTO chats (id, title) VALUES (?, ?)").run(
    id,
    title || `Telegram ${new Date().toLocaleDateString()}`,
  );
  return id;
}

function getTelegramChats() {
  return db
    .prepare(
      "SELECT id, title, created_at FROM chats WHERE id LIKE 'telegram%' ORDER BY created_at DESC",
    )
    .all();
}

function saveMsgToCurrent(role, content, sources = null) {
  db.prepare(
    "INSERT INTO messages (chat_id, role, content, sources) VALUES (?, ?, ?, ?)",
  ).run(currentChatId, role, content, sources ? JSON.stringify(sources) : null);
}

function loadCurrentHistory(maxTurns = 20) {
  const rows = db
    .prepare(
      `SELECT role, content FROM (
       SELECT role, content, created_at FROM messages
       WHERE chat_id = ?
       ORDER BY created_at DESC
       LIMIT ?
     ) ORDER BY created_at ASC`,
    )
    .all(currentChatId, maxTurns * 2);

  return rows.map((r) => ({
    role: r.role === "ai" ? "model" : "user",
    parts: [{ text: r.content }],
  }));
}

// Save document to project directory so it's visible in the app
function saveDocumentToProjectDir(
  projectName,
  title,
  content,
  extension = "txt",
) {
  try {
    const projectDir = join(PROJECTS_DIR, projectName);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }
    const safeName = title.replace(/[^a-zA-Z0-9 ]/g, "_");
    const filePath = join(projectDir, `${safeName}.${extension}`);
    fs.writeFileSync(filePath, content, "utf-8");
    console.log(`[telegram] Saved document to ${filePath}`);
    return filePath;
  } catch (err) {
    console.error(
      "[telegram] Failed to save document to project dir:",
      err.message,
    );
    return null;
  }
}

// ── Projects directory ──
const PROJECTS_DIR = join(os.homedir(), "Desktop", "kendall", "Projects");

function ensureProjectsDir() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  }
}

// ── Bot's own folder (memory, generated files, exports) ──
const BOT_DIR = join(os.homedir(), "Desktop", "kendall", "Kendall");
const BOT_FILES_DIR = join(BOT_DIR, "Files");
const BOT_MEMORY_DIR = join(BOT_DIR, "Memory");

function ensureBotDirs() {
  for (const dir of [BOT_DIR, BOT_FILES_DIR, BOT_MEMORY_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
ensureBotDirs();

// Save a file to the bot's own folder
function saveBotFile(filename, content, subfolder = "Files") {
  ensureBotDirs();
  const dir = subfolder === "Memory" ? BOT_MEMORY_DIR : BOT_FILES_DIR;
  const safeName = filename.replace(/[^a-zA-Z0-9._\- ]/g, "_");
  const filePath = join(dir, safeName);
  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(filePath, content);
  } else {
    fs.writeFileSync(filePath, content, "utf-8");
  }
  return filePath;
}

// Read bot memory
function loadBotMemory() {
  ensureBotDirs();
  const memoryFile = join(BOT_MEMORY_DIR, "context.md");
  if (fs.existsSync(memoryFile)) {
    return fs.readFileSync(memoryFile, "utf-8");
  }
  return "";
}

// Append to bot memory
function appendBotMemory(note) {
  ensureBotDirs();
  const memoryFile = join(BOT_MEMORY_DIR, "context.md");
  const timestamp = new Date().toLocaleString();
  const entry = `\n[${timestamp}] ${note}\n`;
  fs.appendFileSync(memoryFile, entry, "utf-8");
}

// ── Telegram file receiving ──
// Download a file from Telegram, returns { buffer, filePath }
async function downloadTelegramFile(ctx, fileId) {
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(fileLink.href);
  if (!res.ok) throw new Error(`Failed to download file: ${res.statusText}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Extract text from a file buffer based on extension
async function extractTextFromBuffer(buffer, filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();

  if (ext === "pdf") {
    const data = await pdfParse(buffer);
    return data.text || "";
  }

  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  // Text-based files: txt, md, csv, json, js, ts, py, html, css, xml, yaml, yml, log, etc.
  const textExts = [
    "txt",
    "md",
    "csv",
    "json",
    "js",
    "ts",
    "jsx",
    "tsx",
    "py",
    "html",
    "css",
    "xml",
    "yaml",
    "yml",
    "log",
    "sh",
    "bat",
    "ini",
    "cfg",
    "toml",
    "env",
    "sql",
    "r",
    "rb",
    "go",
    "java",
    "c",
    "cpp",
    "h",
    "hpp",
    "rs",
    "swift",
    "kt",
    "scala",
    "lua",
    "pl",
    "tex",
    "rtf",
  ];
  if (textExts.includes(ext)) {
    return buffer.toString("utf-8");
  }

  return null; // unsupported
}

// Index a file into the database (same schema the Tauri app uses)
async function indexFileIntoDb(filename, content, sourcePath) {
  // Check if already exists
  const existing = db
    .prepare("SELECT id FROM files WHERE path = ?")
    .get(sourcePath);
  if (existing) {
    // Update content + re-embed
    const embedding = await generateEmbedding(content.substring(0, 8000));
    db.prepare("UPDATE files SET content = ?, embedding = ? WHERE id = ?").run(
      content,
      JSON.stringify(embedding),
      existing.id,
    );
    return { id: existing.id, updated: true };
  }

  // Insert new
  const embedding = await generateEmbedding(content.substring(0, 8000));
  const result = db
    .prepare(
      "INSERT INTO files (path, filename, content, embedding) VALUES (?, ?, ?, ?)",
    )
    .run(sourcePath, filename, content, JSON.stringify(embedding));
  return { id: result.lastInsertRowid, updated: false };
}

// ── Project DB helpers ──
function getProjectsList() {
  return db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all();
}

function getProjectByName(name) {
  return db
    .prepare("SELECT * FROM projects WHERE name = ? COLLATE NOCASE")
    .get(name);
}

function getProjectById(id) {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

function createProjectInDb(id, name) {
  db.prepare(
    "INSERT INTO projects (id, name, description) VALUES (?, ?, '')",
  ).run(id, name);
  // Create project directory
  ensureProjectsDir();
  const projectDir = join(PROJECTS_DIR, name);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }
}

function deleteProjectFromDb(id) {
  const project = getProjectById(id);
  db.prepare("DELETE FROM project_files WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  // Remove project directory
  if (project) {
    const projectDir = join(PROJECTS_DIR, project.name);
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }
}

function getProjectFilesList(projectId) {
  return db
    .prepare(
      `SELECT f.id, f.path, f.filename, length(f.content) as content_length
     FROM project_files pf
     JOIN files f ON pf.file_id = f.id
     WHERE pf.project_id = ?`,
    )
    .all(projectId);
}

function getProjectFileContentsList(projectId) {
  return db
    .prepare(
      `SELECT f.id, f.path, f.filename, f.content
     FROM project_files pf
     JOIN files f ON pf.file_id = f.id
     WHERE pf.project_id = ?`,
    )
    .all(projectId);
}

function addProjectFileLink(projectId, fileId) {
  db.prepare(
    "INSERT OR IGNORE INTO project_files (project_id, file_id) VALUES (?, ?)",
  ).run(projectId, fileId);
}

function removeProjectFileLink(projectId, fileId) {
  db.prepare(
    "DELETE FROM project_files WHERE project_id = ? AND file_id = ?",
  ).run(projectId, fileId);
}

function searchFilesByName(query) {
  const q = `%${query}%`;
  return db
    .prepare(
      "SELECT id, path, filename FROM files WHERE embedding IS NOT NULL AND (filename LIKE ? OR path LIKE ?) LIMIT 10",
    )
    .all(q, q);
}

// Semantic file search — finds files by description/meaning using embeddings
async function findFiles(query, topK = 5) {
  // Semantic search via embeddings
  const semantic = (await searchContext(query, topK)).map((r) => ({
    id: r.id,
    path: r.path,
    filename: r.filename,
    score: r.score,
  }));

  // Also try exact filename match as fallback
  const exact = searchFilesByName(query);

  // Merge and deduplicate (semantic results first)
  const seen = new Set();
  const combined = [];
  for (const f of [...semantic, ...exact]) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      combined.push(f);
    }
  }
  return combined.slice(0, topK);
}

// ── Agentic Document Generation (server-side, mirrors rag.ts) ──
async function generateDocumentServer(
  prompt,
  projectName,
  fileContents,
  onStep,
) {
  // Phase 1: Research
  onStep(
    "researching",
    "Analyzing project files and searching for relevant context...",
  );

  const fileOverview = fileContents
    .map((f) => `- ${f.filename} (${f.content.length} chars)`)
    .join("\n");
  const projectContext = fileContents
    .map((f) => `[${f.filename}]\n${f.content.substring(0, 4000)}`)
    .join("\n\n---\n\n");

  const ragResults = await searchContext(prompt, 5);
  const extraFiles = ragResults
    .filter(
      (r) =>
        r.score > 0.25 && !fileContents.some((f) => f.filename === r.filename),
    )
    .slice(0, 3);

  const extraContext = extraFiles
    .map((f) => `[${f.filename}]\n${(f.content || "").substring(0, 2000)}`)
    .join("\n\n---\n\n");

  onStep(
    "researching",
    `Found ${fileContents.length} project file${fileContents.length !== 1 ? "s" : ""}${extraFiles.length > 0 ? ` + ${extraFiles.length} related file${extraFiles.length !== 1 ? "s" : ""}` : ""}.`,
  );

  const fullContext =
    projectContext + (extraContext ? "\n\n---\n\n" + extraContext : "");

  // Phase 2: Planning
  onStep("planning", "Creating document outline...");

  let outline;
  try {
    const planSystemPrompt = `You are a document architect. Given a request and source material, create a structured outline for the document.

Reply with ONLY a valid JSON object — no markdown, no code fences, no explanation:
{"title": "Document Title", "sections": [{"heading": "Section Heading", "brief": "2-3 sentence description of what this section should cover"}]}

Create between 3 and 8 sections depending on the complexity.`;

    let planText = await llmGenerate(
      planSystemPrompt,
      `Project: ${projectName}\nUser's request: ${prompt}\n\nAvailable source files:\n${fileOverview || "(no project files linked)"}\n\nCreate a document outline.`,
    );
    planText = planText.trim();
    if (planText.startsWith("```")) {
      planText = planText
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "")
        .trim();
    }
    outline = JSON.parse(planText);
    if (
      !outline.title ||
      !Array.isArray(outline.sections) ||
      outline.sections.length === 0
    ) {
      throw new Error("Invalid outline");
    }
  } catch {
    outline = {
      title: projectName,
      sections: [
        {
          heading: "Overview",
          brief: "High-level overview addressing the request.",
        },
        { heading: "Details", brief: `Detailed response to: ${prompt}` },
        { heading: "Conclusion", brief: "Summary and closing remarks." },
      ],
    };
  }

  onStep(
    "planning",
    `Outline: "${outline.title}" — ${outline.sections.length} sections:\n${outline.sections.map((s, i) => `${i + 1}. ${s.heading}`).join("\n")}`,
  );

  // Phase 3: Writing
  const writerSystemPrompt = `You are a professional document writer. Write the requested section of a document.

Rules:
- Write in clear, professional prose.
- Do NOT use markdown formatting (no #, **, *, etc.). Use plain text only.
- Write substantively — each section should be 2-6 detailed paragraphs.
- Use specific information from the provided source files when relevant.
- Output ONLY the section body text. Do NOT repeat the section heading.`;

  const writtenSections = [];

  for (let i = 0; i < outline.sections.length; i++) {
    const section = outline.sections[i];
    onStep(
      "writing",
      `Writing section ${i + 1}/${outline.sections.length}: "${section.heading}"...`,
    );

    const previousSummary =
      writtenSections.length > 0
        ? `\n\nPreviously written:\n${writtenSections.map((text, j) => `--- ${outline.sections[j].heading} ---\n${text.substring(0, 800)}`).join("\n\n")}`
        : "";

    try {
      const sectionText = await llmGenerate(
        writerSystemPrompt,
        `Document title: "${outline.title}"\n\nSection: "${section.heading}"\nBrief: ${section.brief}\n\nSource material:\n${fullContext.substring(0, 10000)}${previousSummary}\n\nWrite this section now.`,
      );
      writtenSections.push(sectionText.trim());
    } catch (err) {
      writtenSections.push(
        `[This section could not be generated: ${err.message}]`,
      );
    }
  }

  // Phase 4: Assemble
  let draft = outline.title + "\n\n";
  for (let i = 0; i < outline.sections.length; i++) {
    draft +=
      outline.sections[i].heading + "\n\n" + writtenSections[i] + "\n\n\n";
  }

  // Phase 5: Refine
  onStep("refining", "Reviewing and polishing the complete document...");

  try {
    const refineText = await llmGenerate(
      `You are a document editor. Polish and refine the given document draft.

Rules:
- Fix inconsistencies, awkward phrasing, and factual errors.
- Improve transitions and flow between sections.
- Do NOT use markdown formatting. Plain text only, with section headings on their own lines.
- Keep the exact same structure. Do NOT add or remove sections.
- Output the complete refined document.`,
      `Review and polish this document draft. Preserve the structure exactly.\n\n${draft}`,
    );
    draft = refineText.trim();
  } catch {
    // Use unrefined draft
  }

  onStep("done", "Document generation complete.");
  return { title: outline.title, content: draft };
}

async function reviseDocumentServer(
  existingDoc,
  instructions,
  projectName,
  fileContents,
) {
  const projectContext = fileContents
    .map((f) => `[${f.filename}]\n${f.content.substring(0, 3000)}`)
    .join("\n\n---\n\n");

  const result = await llmGenerate(
    `You are a precise document revision specialist. Make ONLY the changes requested. Preserve everything else.

Rules:
- Do NOT use markdown formatting. Plain text only, with section headings on their own lines.
- Output the complete revised document (not just the changed parts).`,
    `Project: ${projectName}\n\nRevision instructions: ${instructions}\n${fileContents.length > 0 ? `\nSource files:\n${projectContext.substring(0, 6000)}\n\n` : ""}Current document:\n---\n${existingDoc}\n---\n\nApply the revisions. Return the complete revised document.`,
  );

  return result.trim();
}

// ── PDF/DOCX generation ──
function generatePDFBuffer(title, content) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text(title, { align: "left" });
    doc.moveDown(1);
    doc.fontSize(11).text(content, { align: "left", lineGap: 4 });

    doc.end();
  });
}

async function generateDOCXBuffer(title, content) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
          ...content.split("\n").map(
            (line) =>
              new Paragraph({
                children: [new TextRun({ text: line, size: 22 })],
              }),
          ),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

// ── Function calling tool definitions ──
const workTools = [
  {
    functionDeclarations: [
      {
        name: "list_projects",
        description:
          "List all user projects. Call when the user asks about their projects, what projects exist, or wants to see project list.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "create_project",
        description:
          "Create a new project. Call when the user wants to start a new project, create a project, or begin working on something new.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: {
              type: "STRING",
              description: "The name for the new project",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "delete_project",
        description:
          "Delete an existing project. Call when the user wants to remove or delete a project.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: {
              type: "STRING",
              description: "The name of the project to delete",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "select_project",
        description:
          "Select/switch to a project to work on. Call when the user wants to switch to, open, or work on a specific project.",
        parameters: {
          type: "OBJECT",
          properties: {
            name: {
              type: "STRING",
              description: "The name of the project to select",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "list_project_files",
        description:
          "List files linked to the active project. Call when the user asks what files are in the project, or wants to see linked files.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "link_file",
        description:
          "Search for and link a file to the active project using semantic search. Can find files by description, topic, or filename. Call when the user wants to add, attach, or link a file to the project.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description:
                "Search query — can be a filename, description, or topic (e.g. 'the marketing report' or 'budget spreadsheet')",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "unlink_file",
        description:
          "Remove a file from the active project. Call when the user wants to remove, unlink, or detach a file from the project.",
        parameters: {
          type: "OBJECT",
          properties: {
            filename: {
              type: "STRING",
              description: "Name or partial name of the file to unlink",
            },
          },
          required: ["filename"],
        },
      },
      {
        name: "generate_document",
        description:
          "Generate a full document using the project's linked files as context. Call when the user wants to create, write, draft, or generate a document, report, proposal, or any written content.",
        parameters: {
          type: "OBJECT",
          properties: {
            prompt: {
              type: "STRING",
              description: "Description of what document to generate",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "revise_document",
        description:
          "Revise/edit the last generated document. Call when the user wants to change, update, edit, fix, or revise the current document.",
        parameters: {
          type: "OBJECT",
          properties: {
            instructions: {
              type: "STRING",
              description: "What to change in the document",
            },
          },
          required: ["instructions"],
        },
      },
      {
        name: "export_pdf",
        description:
          "Export and send the current document as a PDF file. Call when the user wants a PDF, wants to download the document, or asks for the file.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "export_docx",
        description:
          "Export and send the current document as a DOCX (Word) file. Call when the user wants a Word doc or DOCX.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "start_new_chat",
        description:
          "Start a new conversation. Call when the user wants a fresh start, new conversation, or to clear context.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "show_active_status",
        description:
          "Show current active project status and session info. Call when the user asks what they're working on, what's active, or wants a status update.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "save_note",
        description:
          "Save a note or reminder to Kendall's persistent memory. Call when the user asks to remember something, save a note, or wants you to keep track of information.",
        parameters: {
          type: "OBJECT",
          properties: {
            note: {
              type: "STRING",
              description: "The note or information to remember",
            },
          },
          required: ["note"],
        },
      },
      {
        name: "write_file",
        description:
          "Write content to a file and save it to Kendall's files folder (~/Desktop/kendall/Kendall/Files/). Use this when the user wants you to create, write, draft, or save any file — essays, notes, code, text, etc. This does NOT require an active project.",
        parameters: {
          type: "OBJECT",
          properties: {
            filename: {
              type: "STRING",
              description:
                "The filename to save as (e.g. 'essay.txt', 'report.md')",
            },
            content: {
              type: "STRING",
              description: "The full content to write to the file",
            },
          },
          required: ["filename", "content"],
        },
      },
      {
        name: "quick_generate",
        description:
          "Generate written content (essay, report, summary, email, etc.) directly and save it as a file. Use this when the user asks you to write/generate something but there is no active project. This generates the content using AI, saves the file, and sends it. For project-based document generation, use generate_document instead.",
        parameters: {
          type: "OBJECT",
          properties: {
            prompt: {
              type: "STRING",
              description: "What to write/generate",
            },
            filename: {
              type: "STRING",
              description: "Filename to save as (e.g. 'dune_essay.txt')",
            },
            format: {
              type: "STRING",
              description:
                "Output format: 'txt', 'pdf', or 'docx'. Defaults to 'txt'.",
            },
          },
          required: ["prompt", "filename"],
        },
      },
    ],
  },
];

// Execute a function call and return the result
async function executeFunction(name, args, ctx) {
  switch (name) {
    case "list_projects": {
      const projects = getProjectsList();
      if (projects.length === 0) return { result: "No projects exist yet." };
      const active = activeProjectId;
      const list = projects
        .map((p) => `${p.name}${p.id === active ? " (active)" : ""}`)
        .join(", ");
      return { result: `Projects: ${list}` };
    }

    case "create_project": {
      const pName = args.name?.trim();
      if (!pName) return { error: "No project name provided." };
      if (getProjectByName(pName))
        return { error: `Project "${pName}" already exists.` };
      const id = randomUUID();
      createProjectInDb(id, pName);
      activeProjectId = id;
      lastGeneratedDocument = null;
      lastDocumentTitle = null;
      return {
        result: `Project "${pName}" created and set as active. Directory created at ~/Desktop/kendall/Projects/${pName}/`,
      };
    }

    case "delete_project": {
      const project = getProjectByName(args.name?.trim());
      if (!project) return { error: `No project found named "${args.name}".` };
      deleteProjectFromDb(project.id);
      if (activeProjectId === project.id) {
        activeProjectId = null;
        lastGeneratedDocument = null;
        lastDocumentTitle = null;
      }
      return { result: `Project "${project.name}" and its directory deleted.` };
    }

    case "select_project": {
      const project = getProjectByName(args.name?.trim());
      if (!project)
        return {
          error: `No project found named "${args.name}". Available: ${
            getProjectsList()
              .map((p) => p.name)
              .join(", ") || "none"
          }`,
        };
      activeProjectId = project.id;
      lastGeneratedDocument = null;
      lastDocumentTitle = null;
      const files = getProjectFilesList(project.id);
      return {
        result: `Switched to project "${project.name}". ${files.length} file(s) linked.`,
      };
    }

    case "list_project_files": {
      if (!activeProjectId)
        return {
          error: "No active project. Need to select or create one first.",
        };
      const project = getProjectById(activeProjectId);
      const files = getProjectFilesList(activeProjectId);
      if (files.length === 0)
        return { result: `No files linked to "${project?.name}".` };
      return {
        result: `Files in "${project?.name}": ${files.map((f) => f.filename).join(", ")}`,
      };
    }

    case "link_file": {
      if (!activeProjectId)
        return {
          error: "No active project. Need to select or create one first.",
        };
      const matches = await findFiles(args.query?.trim());
      if (matches.length === 0)
        return { error: `No indexed files match "${args.query}".` };
      let linked = 0;
      const linkedNames = [];
      for (const file of matches) {
        const existing = getProjectFilesList(activeProjectId).some(
          (f) => f.id === file.id,
        );
        if (!existing) {
          addProjectFileLink(activeProjectId, file.id);
          linked++;
          linkedNames.push(file.filename);
        }
      }
      if (linked === 0)
        return {
          result: `Found ${matches.length} file(s) but all already linked.`,
        };
      return { result: `Linked ${linked} file(s): ${linkedNames.join(", ")}` };
    }

    case "unlink_file": {
      if (!activeProjectId) return { error: "No active project." };
      const files = getProjectFilesList(activeProjectId);
      const match = files.find((f) =>
        f.filename.toLowerCase().includes(args.filename?.toLowerCase()),
      );
      if (!match)
        return { error: `No linked file matches "${args.filename}".` };
      removeProjectFileLink(activeProjectId, match.id);
      return { result: `Unlinked "${match.filename}".` };
    }

    case "generate_document": {
      if (!activeProjectId)
        return {
          error: "No active project. Need to select or create one first.",
        };
      const project = getProjectById(activeProjectId);
      if (!project) return { error: "Active project not found." };

      const fileContents = getProjectFileContentsList(activeProjectId);
      const formatted = fileContents.map((f) => ({
        filename: f.filename,
        content: f.content || "",
      }));

      const statusMsg = await ctx.reply("Starting document generation...");
      let lastPhase = "";

      async function onStep(phase, message) {
        if (phase !== lastPhase) {
          lastPhase = phase;
          const icons = {
            researching: "🔍",
            planning: "📝",
            writing: "✍️",
            refining: "✨",
            done: "✅",
          };
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              undefined,
              `${icons[phase] || "⏳"} ${message}`,
            );
          } catch {}
        }
      }

      await ctx.sendChatAction("typing");
      const { title, content } = await generateDocumentServer(
        args.prompt,
        project.name,
        formatted,
        onStep,
      );
      lastGeneratedDocument = content;
      lastDocumentTitle = title;
      saveDocumentToProjectDir(project.name, title, content, "txt");

      // Send the document directly
      if (content.length <= 4000) {
        await ctx.reply(content);
      } else {
        for (const chunk of splitMessage(content, 4000)) {
          await ctx.reply(chunk);
        }
      }
      return {
        result: `Document "${title}" generated and saved to project directory. User can ask for PDF/DOCX export or revisions.`,
      };
    }

    case "revise_document": {
      if (!activeProjectId) return { error: "No active project." };
      if (!lastGeneratedDocument)
        return { error: "No document to revise. Need to generate one first." };
      const project = getProjectById(activeProjectId);
      const fileContents = getProjectFileContentsList(activeProjectId);
      const formatted = fileContents.map((f) => ({
        filename: f.filename,
        content: f.content || "",
      }));

      await ctx.reply("Revising document...");
      await ctx.sendChatAction("typing");
      const revised = await reviseDocumentServer(
        lastGeneratedDocument,
        args.instructions,
        project?.name || "Document",
        formatted,
      );
      lastGeneratedDocument = revised;
      saveDocumentToProjectDir(
        project?.name || "Document",
        lastDocumentTitle || "Document",
        revised,
        "txt",
      );

      if (revised.length <= 4000) {
        await ctx.reply(revised);
      } else {
        for (const chunk of splitMessage(revised, 4000)) {
          await ctx.reply(chunk);
        }
      }
      return { result: "Document revised and saved." };
    }

    case "export_pdf": {
      if (!lastGeneratedDocument)
        return { error: "No document to export. Need to generate one first." };
      const title = lastDocumentTitle || "Document";
      const pdfBuffer = await generatePDFBuffer(title, lastGeneratedDocument);
      const safeName = title.replace(/[^a-zA-Z0-9]/g, "_") + ".pdf";

      if (activeProjectId) {
        const project = getProjectById(activeProjectId);
        if (project) {
          const projectDir = join(PROJECTS_DIR, project.name);
          if (!fs.existsSync(projectDir))
            fs.mkdirSync(projectDir, { recursive: true });
          fs.writeFileSync(join(projectDir, safeName), pdfBuffer);
        }
      }

      await ctx.replyWithDocument({ source: pdfBuffer, filename: safeName });
      return {
        result: `PDF "${safeName}" sent and saved to project directory.`,
      };
    }

    case "export_docx": {
      if (!lastGeneratedDocument)
        return { error: "No document to export. Need to generate one first." };
      const title = lastDocumentTitle || "Document";
      const docxBuffer = await generateDOCXBuffer(title, lastGeneratedDocument);
      const safeName = title.replace(/[^a-zA-Z0-9]/g, "_") + ".docx";

      if (activeProjectId) {
        const project = getProjectById(activeProjectId);
        if (project) {
          const projectDir = join(PROJECTS_DIR, project.name);
          if (!fs.existsSync(projectDir))
            fs.mkdirSync(projectDir, { recursive: true });
          fs.writeFileSync(join(projectDir, safeName), docxBuffer);
        }
      }

      await ctx.replyWithDocument({ source: docxBuffer, filename: safeName });
      return {
        result: `DOCX "${safeName}" sent and saved to project directory.`,
      };
    }

    case "start_new_chat": {
      const chatId = createTelegramChat(
        `Telegram ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
      );
      currentChatId = chatId;
      return { result: "Started a new conversation. Old chats are saved." };
    }

    case "show_active_status": {
      const project = activeProjectId ? getProjectById(activeProjectId) : null;
      const files = project ? getProjectFilesList(project.id) : [];
      const parts = [];
      parts.push(
        project ? `Active project: ${project.name}` : "No active project",
      );
      if (project) parts.push(`Linked files: ${files.length}`);
      parts.push(
        lastGeneratedDocument
          ? `Document ready: "${lastDocumentTitle}"`
          : "No document generated",
      );
      return { result: parts.join(". ") };
    }

    case "save_note": {
      const note = args.note?.trim();
      if (!note) return { error: "No note provided." };
      appendBotMemory(note);
      return {
        result: `Saved to memory: "${note.substring(0, 80)}${note.length > 80 ? "..." : ""}"`,
      };
    }

    case "write_file": {
      const filename = args.filename?.trim();
      const content = args.content;
      if (!filename || !content)
        return { error: "Need both filename and content." };
      const filePath = saveBotFile(filename, content);

      // Also send the file in Telegram
      try {
        await ctx.replyWithDocument({
          source: Buffer.from(content, "utf-8"),
          filename: filename,
        });
      } catch (err) {
        console.error("[telegram] Failed to send file:", err.message);
      }

      return {
        result: `File "${filename}" saved to ~/Desktop/kendall/Kendall/Files/ and sent.`,
      };
    }

    case "quick_generate": {
      const prompt = args.prompt?.trim();
      const filename = args.filename?.trim() || "document.txt";
      const format = (args.format || "txt").toLowerCase();
      if (!prompt) return { error: "No prompt provided." };

      await ctx.sendChatAction("typing");
      const statusMsg = await ctx.reply("Generating your document...");

      // Generate the content
      const content = await llmGenerate(
        `You are a professional writer. Write the requested content with depth and quality. Use plain text only — no markdown, no asterisks, no headers with #. Write section headings on their own lines. Be comprehensive and thorough.`,
        prompt,
        "bot",
      );

      const cleanContent = content.trim();
      lastGeneratedDocument = cleanContent;
      lastDocumentTitle = filename.replace(/\.[^.]+$/, "");

      // Save to bot's files folder
      saveBotFile(filename.replace(/\.[^.]+$/, ".txt"), cleanContent);

      // Send based on format
      try {
        if (format === "pdf") {
          const pdfBuffer = await generatePDFBuffer(
            lastDocumentTitle,
            cleanContent,
          );
          const pdfName = filename.replace(/\.[^.]+$/, ".pdf");
          saveBotFile(pdfName, pdfBuffer);
          await ctx.replyWithDocument({ source: pdfBuffer, filename: pdfName });
        } else if (format === "docx") {
          const docxBuffer = await generateDOCXBuffer(
            lastDocumentTitle,
            cleanContent,
          );
          const docxName = filename.replace(/\.[^.]+$/, ".docx");
          saveBotFile(docxName, docxBuffer);
          await ctx.replyWithDocument({
            source: docxBuffer,
            filename: docxName,
          });
        } else {
          // Send as text file
          await ctx.replyWithDocument({
            source: Buffer.from(cleanContent, "utf-8"),
            filename: filename,
          });
        }
      } catch (err) {
        console.error("[telegram] Send file error:", err.message);
        // Fallback: send as text message
        if (cleanContent.length <= 4000) {
          await ctx.reply(cleanContent);
        } else {
          for (const chunk of splitMessage(cleanContent, 4000)) {
            await ctx.reply(chunk);
          }
        }
      }

      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          undefined,
          "Document generated and sent.",
        );
      } catch {}

      return {
        result: `Document "${lastDocumentTitle}" generated and sent as ${format.toUpperCase()}. Saved to ~/Desktop/kendall/Kendall/Files/. User can request revisions or re-export.`,
      };
    }

    default:
      return { error: `Unknown function: ${name}` };
  }
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
    `Hey, I'm Kendall — your autonomous AI assistant. Just tell me what you need in plain language and I'll handle everything.

I can manage projects, find and link files, generate documents, export PDFs, and more — all from a single message. No commands to memorize.

Try something like: "Create a project called Research and draft a summary from my files"`,
  ),
);

bot.command("reset", (ctx) => {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(currentChatId);
  activeProjectId = null;
  lastGeneratedDocument = null;
  lastDocumentTitle = null;
  ctx.reply("Conversation and session cleared.");
});

// ── /help ──
bot.command("help", (ctx) => {
  ctx.reply(
    `Kendall commands:

Chat:
/newchat — start a new conversation
/history — list past conversations
/loadchat <number> — switch to an old conversation
/reset — clear current conversation

Work:
/projects — list projects
/newproject <name> — create a project
/deleteproject <name> — delete a project
/project <name> — select active project
/files — list linked files
/link <query> — link a file to project
/unlink <filename> — unlink a file
/generate <prompt> — generate a document
/revise <instructions> — revise last document
/pdf — send document as PDF
/docx — send document as DOCX`,
  );
});

// ── /newchat ──
bot.command("newchat", (ctx) => {
  const chatId = createTelegramChat(
    `Telegram ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
  );
  currentChatId = chatId;
  ctx.reply(
    "Started a new conversation. Your old chats are saved — use /history to browse.",
  );
});

// ── /history ──
bot.command("history", (ctx) => {
  const chats = getTelegramChats();
  if (chats.length === 0) return ctx.reply("No conversation history yet.");

  const list = chats
    .map((c, i) => {
      const marker = c.id === currentChatId ? " (active)" : "";
      return `${i + 1}. ${c.title}${marker}`;
    })
    .join("\n");
  ctx.reply(`Conversations:\n\n${list}\n\nUse /loadchat <number> to switch.`);
});

// ── /loadchat <number> ──
bot.command("loadchat", (ctx) => {
  const arg = ctx.message.text.replace(/^\/loadchat\s*/i, "").trim();
  const num = parseInt(arg, 10);
  if (!num || num < 1)
    return ctx.reply("Usage: /loadchat <number> (from /history list)");

  const chats = getTelegramChats();
  if (num > chats.length)
    return ctx.reply(`Only ${chats.length} conversation(s) found.`);

  const chat = chats[num - 1];
  currentChatId = chat.id;

  // Load last few messages as preview
  const recent = db
    .prepare(
      "SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 4",
    )
    .all(chat.id)
    .reverse();

  let preview = "";
  if (recent.length > 0) {
    preview =
      "\n\nRecent messages:\n" +
      recent
        .map(
          (m) =>
            `${m.role === "user" ? "You" : "Kendall"}: ${m.content.substring(0, 100)}${m.content.length > 100 ? "..." : ""}`,
        )
        .join("\n");
  }

  ctx.reply(`Switched to: ${chat.title}${preview}`);
});

// ── /projects ──
bot.command("projects", (ctx) => {
  const projects = getProjectsList();
  if (projects.length === 0) {
    return ctx.reply("No projects yet. Create one with /newproject <name>");
  }
  const active = activeProjectId;
  const list = projects
    .map((p) => {
      const marker = p.id === active ? " (active)" : "";
      return `- ${p.name}${marker}`;
    })
    .join("\n");
  ctx.reply(`Projects:\n\n${list}`);
});

// ── /newproject <name> ──
bot.command("newproject", (ctx) => {
  const name = ctx.message.text.replace(/^\/newproject\s*/i, "").trim();
  if (!name) return ctx.reply("Usage: /newproject <name>");
  if (getProjectByName(name))
    return ctx.reply(`Project "${name}" already exists.`);

  const id = randomUUID();
  createProjectInDb(id, name);
  activeProjectId = id;
  lastGeneratedDocument = null;
  lastDocumentTitle = null;
  ctx.reply(
    `Project "${name}" created and selected.\nDirectory: ~/Desktop/kendall/Projects/${name}/`,
  );
});

// ── /deleteproject <name> ──
bot.command("deleteproject", (ctx) => {
  const name = ctx.message.text.replace(/^\/deleteproject\s*/i, "").trim();
  if (!name) return ctx.reply("Usage: /deleteproject <name>");
  const project = getProjectByName(name);
  if (!project) return ctx.reply(`No project found named "${name}".`);

  deleteProjectFromDb(project.id);
  if (activeProjectId === project.id) {
    activeProjectId = null;
    lastGeneratedDocument = null;
    lastDocumentTitle = null;
  }
  ctx.reply(`Project "${name}" and its directory deleted.`);
});

// ── /project <name> ──
bot.command("project", (ctx) => {
  const name = ctx.message.text.replace(/^\/project\s*/i, "").trim();
  if (!name) {
    if (!activeProjectId)
      return ctx.reply("No active project. Use /project <name> to select one.");
    const p = getProjectById(activeProjectId);
    if (!p)
      return ctx.reply(
        "Active project not found. Use /project <name> to select one.",
      );
    const files = getProjectFilesList(p.id);
    return ctx.reply(
      `Active project: ${p.name}\nLinked files: ${files.length}\n${lastGeneratedDocument ? "Document ready (use /pdf or /docx to export)" : "No document generated yet"}`,
    );
  }

  const project = getProjectByName(name);
  if (!project)
    return ctx.reply(
      `No project found named "${name}". Use /projects to list all.`,
    );

  activeProjectId = project.id;
  lastGeneratedDocument = null;
  lastDocumentTitle = null;
  const files = getProjectFilesList(project.id);
  ctx.reply(
    `Switched to project "${project.name}".\nLinked files: ${files.length}`,
  );
});

// ── /files ──
bot.command("files", (ctx) => {
  if (!activeProjectId)
    return ctx.reply("No active project. Use /project <name> first.");
  const project = getProjectById(activeProjectId);
  if (!project) return ctx.reply("Active project not found.");

  const files = getProjectFilesList(activeProjectId);
  if (files.length === 0)
    return ctx.reply(
      `No files linked to "${project.name}". Use /link <query> to add files.`,
    );

  const list = files.map((f) => `- ${f.filename}`).join("\n");
  ctx.reply(`Files in "${project.name}":\n\n${list}`);
});

// ── /link <query> ──
bot.command("link", async (ctx) => {
  if (!activeProjectId)
    return ctx.reply("No active project. Use /project <name> first.");
  const query = ctx.message.text.replace(/^\/link\s*/i, "").trim();
  if (!query) return ctx.reply("Usage: /link <filename or description>");

  const matches = await findFiles(query);
  if (matches.length === 0)
    return ctx.reply("No indexed files match that query.");

  let linked = 0;
  const linkedNames = [];
  for (const file of matches) {
    const existing = getProjectFilesList(activeProjectId).some(
      (f) => f.id === file.id,
    );
    if (!existing) {
      addProjectFileLink(activeProjectId, file.id);
      linked++;
      linkedNames.push(file.filename);
    }
  }

  if (linked === 0) {
    ctx.reply(`Found ${matches.length} file(s), but all are already linked.`);
  } else {
    ctx.reply(
      `Linked ${linked} file(s):\n${linkedNames.map((n) => `- ${n}`).join("\n")}`,
    );
  }
});

// ── /unlink <filename> ──
bot.command("unlink", (ctx) => {
  if (!activeProjectId)
    return ctx.reply("No active project. Use /project <name> first.");
  const query = ctx.message.text.replace(/^\/unlink\s*/i, "").trim();
  if (!query) return ctx.reply("Usage: /unlink <filename>");

  const files = getProjectFilesList(activeProjectId);
  const match = files.find((f) =>
    f.filename.toLowerCase().includes(query.toLowerCase()),
  );
  if (!match)
    return ctx.reply(
      `No linked file matches "${query}". Use /files to see linked files.`,
    );

  removeProjectFileLink(activeProjectId, match.id);
  ctx.reply(`Unlinked "${match.filename}".`);
});

// ── /generate <prompt> ──
bot.command("generate", async (ctx) => {
  if (!activeProjectId)
    return ctx.reply("No active project. Use /project <name> first.");
  const prompt = ctx.message.text.replace(/^\/generate\s*/i, "").trim();
  if (!prompt)
    return ctx.reply("Usage: /generate <describe the document you want>");

  const project = getProjectById(activeProjectId);
  if (!project) return ctx.reply("Active project not found.");

  const fileContents = getProjectFileContentsList(activeProjectId);
  const formatted = fileContents.map((f) => ({
    filename: f.filename,
    content: f.content || "",
  }));

  // Send initial status message that we'll edit
  const statusMsg = await ctx.reply("Starting document generation...");
  let lastPhase = "";

  async function onStep(phase, message) {
    if (phase !== lastPhase) {
      lastPhase = phase;
      const icons = {
        researching: "🔍",
        planning: "📝",
        writing: "✍️",
        refining: "✨",
        done: "✅",
      };
      const icon = icons[phase] || "⏳";
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          undefined,
          `${icon} ${message}`,
        );
      } catch {
        // Edit may fail if message didn't change, that's OK
      }
    }
  }

  try {
    await ctx.sendChatAction("typing");
    const { title, content } = await generateDocumentServer(
      prompt,
      project.name,
      formatted,
      onStep,
    );
    lastGeneratedDocument = content;
    lastDocumentTitle = title;

    // Save to project directory so it's visible in the desktop app
    saveDocumentToProjectDir(project.name, title, content, "txt");

    // Send the document content
    if (content.length <= 4000) {
      await ctx.reply(content);
    } else {
      for (const chunk of splitMessage(content, 4000)) {
        await ctx.reply(chunk);
      }
    }
    await ctx.reply(
      "Document ready. Use /pdf or /docx to export, or /revise to make changes.",
    );
  } catch (err) {
    console.error("[telegram] Generate error:", err.message);
    await ctx.reply("Failed to generate document. Please try again.");
  }
});

// ── /revise <instructions> ──
bot.command("revise", async (ctx) => {
  if (!activeProjectId)
    return ctx.reply("No active project. Use /project <name> first.");
  if (!lastGeneratedDocument)
    return ctx.reply("No document to revise. Use /generate first.");

  const instructions = ctx.message.text.replace(/^\/revise\s*/i, "").trim();
  if (!instructions)
    return ctx.reply("Usage: /revise <describe what to change>");

  const project = getProjectById(activeProjectId);
  if (!project) return ctx.reply("Active project not found.");

  const fileContents = getProjectFileContentsList(activeProjectId);
  const formatted = fileContents.map((f) => ({
    filename: f.filename,
    content: f.content || "",
  }));

  await ctx.reply("Revising document...");
  await ctx.sendChatAction("typing");

  try {
    const revised = await reviseDocumentServer(
      lastGeneratedDocument,
      instructions,
      project.name,
      formatted,
    );
    lastGeneratedDocument = revised;

    // Save revised version to project directory
    saveDocumentToProjectDir(
      project.name,
      lastDocumentTitle || "Document",
      revised,
      "txt",
    );

    if (revised.length <= 4000) {
      await ctx.reply(revised);
    } else {
      for (const chunk of splitMessage(revised, 4000)) {
        await ctx.reply(chunk);
      }
    }
    await ctx.reply(
      "Revision complete. Use /pdf or /docx to export, or /revise again.",
    );
  } catch (err) {
    console.error("[telegram] Revise error:", err.message);
    await ctx.reply("Failed to revise document. Please try again.");
  }
});

// ── /pdf ──
bot.command("pdf", async (ctx) => {
  if (!lastGeneratedDocument)
    return ctx.reply("No document to export. Use /generate first.");

  await ctx.reply("Generating PDF...");
  try {
    const title = lastDocumentTitle || "Document";
    const pdfBuffer = await generatePDFBuffer(title, lastGeneratedDocument);
    const safeName = title.replace(/[^a-zA-Z0-9]/g, "_") + ".pdf";

    // Save to project directory if active project
    if (activeProjectId) {
      const project = getProjectById(activeProjectId);
      if (project) {
        const projectDir = join(PROJECTS_DIR, project.name);
        if (!fs.existsSync(projectDir))
          fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(join(projectDir, safeName), pdfBuffer);
      }
    }

    await ctx.replyWithDocument({
      source: pdfBuffer,
      filename: safeName,
    });
  } catch (err) {
    console.error("[telegram] PDF error:", err.message);
    await ctx.reply("Failed to generate PDF. Please try again.");
  }
});

// ── /docx ──
bot.command("docx", async (ctx) => {
  if (!lastGeneratedDocument)
    return ctx.reply("No document to export. Use /generate first.");

  await ctx.reply("Generating DOCX...");
  try {
    const title = lastDocumentTitle || "Document";
    const docxBuffer = await generateDOCXBuffer(title, lastGeneratedDocument);
    const safeName = title.replace(/[^a-zA-Z0-9]/g, "_") + ".docx";

    // Save to project directory if active project
    if (activeProjectId) {
      const project = getProjectById(activeProjectId);
      if (project) {
        const projectDir = join(PROJECTS_DIR, project.name);
        if (!fs.existsSync(projectDir))
          fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(join(projectDir, safeName), docxBuffer);
      }
    }

    await ctx.replyWithDocument({
      source: docxBuffer,
      filename: safeName,
    });
  } catch (err) {
    console.error("[telegram] DOCX error:", err.message);
    await ctx.reply("Failed to generate DOCX. Please try again.");
  }
});

// ── File/Document receiving ──
bot.on("document", async (ctx) => {
  const doc = ctx.message.document;
  const caption = ctx.message.caption || "";
  const filename = doc.file_name || "unknown_file";
  const ext = (filename.split(".").pop() || "").toLowerCase();

  console.log(
    `[telegram] Received document: ${filename} (${doc.file_size} bytes)`,
  );
  await ctx.sendChatAction("typing");

  try {
    // Download the file
    const buffer = await downloadTelegramFile(ctx, doc.file_id);

    // Save to bot's files folder
    const savedPath = saveBotFile(filename, buffer);
    console.log(`[telegram] Saved to: ${savedPath}`);

    // Try to extract text
    const text = await extractTextFromBuffer(buffer, filename);

    if (text && text.trim().length > 0) {
      const cleanedText = text.trim();

      // Index into the database for RAG
      const sourcePath = `telegram://${filename}`;
      const result = await indexFileIntoDb(filename, cleanedText, sourcePath);

      // If there's an active project, link the file to it
      let linkedMsg = "";
      if (activeProjectId) {
        try {
          db.prepare(
            "INSERT OR IGNORE INTO project_files (project_id, file_id) VALUES (?, ?)",
          ).run(activeProjectId, result.id);
          const project = getProjectById(activeProjectId);
          linkedMsg = ` and linked to project "${project?.name}"`;
        } catch {}
      }

      const charCount = cleanedText.length;
      const preview = cleanedText.substring(0, 200).replace(/\n/g, " ");

      await ctx.reply(
        `Got it! I've indexed "${filename}" (${charCount} chars)${linkedMsg}.\n\nPreview: ${preview}${charCount > 200 ? "..." : ""}`,
      );

      // If user added a caption, treat it as a follow-up instruction about this file
      if (caption.trim()) {
        // Inject the file content and caption into the text handler's flow
        saveMsgToCurrent("user", `[Uploaded file: ${filename}]\n\n${caption}`);

        // Process as a regular message with context
        const systemPrompt = buildBotSystemPrompt();
        const history = loadCurrentHistory(20);
        const userMessage = `The user just uploaded a file called "${filename}". Here's its content (first 6000 chars):\n\n${cleanedText.substring(0, 6000)}\n\nTheir instruction: ${caption}`;

        let llmResult = await llmChat(systemPrompt, history, userMessage, {
          tools: workTools,
          feature: "bot",
        });

        let maxCalls = 12;
        while (maxCalls > 0 && llmResult.functionCall) {
          const { name, args } = llmResult.functionCall;
          console.log(
            `[telegram] Function call: ${name}(${JSON.stringify(args)})`,
          );
          await ctx.sendChatAction("typing");
          const funcResult = await executeFunction(name, args || {}, ctx);
          llmResult = await llmContinue(llmResult, name, funcResult, {
            tools: workTools,
            feature: "bot",
          });
          maxCalls--;
        }

        if (llmResult.text) {
          saveMsgToCurrent("ai", llmResult.text);
          if (llmResult.text.length <= 4096) {
            await ctx.reply(llmResult.text);
          } else {
            for (const chunk of splitMessage(llmResult.text, 4000)) {
              await ctx.reply(chunk);
            }
          }
        }
      }
    } else {
      // Unsupported format — still saved
      await ctx.reply(
        `Saved "${filename}" to my files folder. I can't extract text from .${ext} files, but it's stored for you.${caption ? `\n\nYou said: "${caption}"` : ""}`,
      );
    }
  } catch (err) {
    console.error("[telegram] Document handling error:", err);
    await ctx.reply(
      `Sorry, I had trouble processing "${filename}". Error: ${err.message}`,
    );
  }
});

// ── Photo receiving ──
bot.on("photo", async (ctx) => {
  const photos = ctx.message.photo;
  const caption = ctx.message.caption || "";

  // Telegram sends multiple sizes — pick the largest
  const photo = photos[photos.length - 1];
  const filename = `photo_${Date.now()}.jpg`;

  console.log(`[telegram] Received photo (${photo.width}x${photo.height})`);
  await ctx.sendChatAction("typing");

  try {
    // Download the photo
    const buffer = await downloadTelegramFile(ctx, photo.file_id);

    // Save to bot's files folder
    const savedPath = saveBotFile(filename, buffer);
    console.log(`[telegram] Photo saved to: ${savedPath}`);

    // For images, we can use Gemini's vision capability if available
    const settings = getAllSettings();
    const botProvider = resolveProvider("bot");
    if (botProvider === "gemini" && settings.gemini_api_key) {
      const genAI = new GoogleGenerativeAI(settings.gemini_api_key);
      const model = genAI.getGenerativeModel({
        model: settings.bot_gemini_model || "gemini-2.5-flash-lite",
      });

      const imagePart = {
        inlineData: {
          data: buffer.toString("base64"),
          mimeType: "image/jpeg",
        },
      };

      const prompt = caption
        ? `The user sent this image with the message: "${caption}". Analyze the image and respond to their request. Be thorough and helpful. Use plain text only — no markdown.`
        : "The user sent this image. Describe what you see in detail and ask if they need anything done with it. Use plain text only — no markdown.";

      const result = await model.generateContent([prompt, imagePart]);
      const responseText = result.response.text();

      saveMsgToCurrent("user", `[Sent photo${caption ? `: ${caption}` : ""}]`);
      saveMsgToCurrent("ai", responseText);

      if (responseText.length <= 4096) {
        await ctx.reply(responseText);
      } else {
        for (const chunk of splitMessage(responseText, 4000)) {
          await ctx.reply(chunk);
        }
      }
    } else {
      // Ollama or no API key — can't do vision, just save it
      await ctx.reply(
        `Photo saved to my files folder as "${filename}".${caption ? `\n\nYou said: "${caption}"` : ""}\n\nNote: Image analysis requires Gemini. Switch to Gemini in Settings for image understanding.`,
      );
      if (caption) {
        saveMsgToCurrent("user", `[Sent photo: ${caption}]`);
      }
    }
  } catch (err) {
    console.error("[telegram] Photo handling error:", err);
    await ctx.reply(
      `Sorry, I had trouble processing that photo. Error: ${err.message}`,
    );
  }
});

// ── Regular text messages → autonomous intelligent agent ──
bot.on("text", async (ctx) => {
  const userText = ctx.message.text.trim();
  if (!userText) return;

  console.log(`[telegram] "${userText}"`);
  await ctx.sendChatAction("typing");

  try {
    saveMsgToCurrent("user", userText);

    // Build context about current state
    const activeProject = activeProjectId
      ? getProjectById(activeProjectId)
      : null;
    const allFiles = db
      .prepare("SELECT id FROM files WHERE embedding IS NOT NULL")
      .all();
    const projectsList = getProjectsList();

    // Search for RAG context
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

    const projectFilesList = activeProject
      ? getProjectFilesList(activeProject.id)
          .map((f) => f.filename)
          .join(", ")
      : "none";

    // Load bot's persistent memory
    const botMemory = loadBotMemory();
    const memoryBlock = botMemory
      ? `\nBOT MEMORY (your personal notes):\n${botMemory}\n`
      : "";

    const stateInfo = [
      `Total indexed files: ${allFiles.length}`,
      `Existing projects: ${projectsList.map((p) => `"${p.name}"`).join(", ") || "none"}`,
      activeProject
        ? `Active project: "${activeProject.name}" (files: ${projectFilesList})`
        : "No active project selected",
      lastGeneratedDocument
        ? `Last generated document: "${lastDocumentTitle}" (ready for export/revision)`
        : "No document generated yet",
    ].join("\n");

    const systemPrompt = buildBotSystemPrompt(
      allFiles.length,
      stateInfo,
      memoryBlock,
    );

    const history = loadCurrentHistory(20);

    const userMessage = contextBlock
      ? `Context from my files:\n${contextBlock}\n\nMessage: ${userText}`
      : userText;

    let llmResult = await llmChat(systemPrompt, history, userMessage, {
      tools: workTools,
      feature: "bot",
    });

    // Handle function calls in a loop — allow many chained calls for autonomous behavior
    let maxCalls = 12;
    while (maxCalls > 0 && llmResult.functionCall) {
      const { name, args } = llmResult.functionCall;
      console.log(`[telegram] Function call: ${name}(${JSON.stringify(args)})`);
      await ctx.sendChatAction("typing");

      const funcResult = await executeFunction(name, args || {}, ctx);
      console.log(
        `[telegram] Function result: ${JSON.stringify(funcResult).substring(0, 200)}`,
      );

      llmResult = await llmContinue(llmResult, name, funcResult, {
        tools: workTools,
        feature: "bot",
      });
      maxCalls--;
    }

    // Get final text response
    let responseText = llmResult.text || "";

    // Save AI response
    saveMsgToCurrent("ai", responseText);

    if (responseText) {
      if (responseText.length <= 4096) {
        await ctx.reply(responseText);
      } else {
        for (const chunk of splitMessage(responseText, 4000)) {
          await ctx.reply(chunk);
        }
      }
    }
  } catch (err) {
    console.error("[telegram] Error:", err);
    await ctx.reply("I ran into an issue. Please try again.");
  }
});

// helpers
function buildBotSystemPrompt(fileCount, stateInfo, memoryBlock) {
  if (!fileCount) {
    const allFiles = db
      .prepare("SELECT id FROM files WHERE embedding IS NOT NULL")
      .all();
    fileCount = allFiles.length;
  }
  if (!stateInfo) {
    const activeProject = activeProjectId
      ? getProjectById(activeProjectId)
      : null;
    const projectsList = getProjectsList();
    const projectFilesList = activeProject
      ? getProjectFilesList(activeProject.id)
          .map((f) => f.filename)
          .join(", ")
      : "none";
    stateInfo = [
      `Total indexed files: ${fileCount}`,
      `Existing projects: ${projectsList.map((p) => `"${p.name}"`).join(", ") || "none"}`,
      activeProject
        ? `Active project: "${activeProject.name}" (files: ${projectFilesList})`
        : "No active project selected",
      lastGeneratedDocument
        ? `Last generated document: "${lastDocumentTitle}" (ready for export/revision)`
        : "No document generated yet",
    ].join("\n");
  }
  if (!memoryBlock) {
    const botMemory = loadBotMemory();
    memoryBlock = botMemory
      ? `\nBOT MEMORY (your personal notes):\n${botMemory}\n`
      : "";
  }

  return `You are Kendall, an exceptionally intelligent and autonomous personal AI assistant on Telegram. You have access to ${fileCount} indexed local files and powerful project management tools.

CURRENT STATE:
${stateInfo}
${memoryBlock}
YOUR PERSONALITY:
- You are proactive, thoughtful, and efficient
- You anticipate what the user needs and execute multi-step workflows automatically
- You never ask the user to run commands — you do everything yourself
- You are brief on Telegram but thorough in your work

AUTONOMOUS BEHAVIOR — THIS IS CRITICAL:
- When the user gives you a complex request, PLAN the full workflow and execute ALL steps automatically
- Chain multiple function calls without asking. For example:
  "Create a project called Marketing, link the annual report, and write me a proposal" → you should call create_project, then link_file, then generate_document — ALL automatically
  "Set up a project with all my research files and draft a summary" → create project, search and link relevant files, generate document
  "What files do I have about finance? Add them to my Budget project" → search files, link them
- NEVER tell the user to run a command. Do it yourself.
- If the user's message implies multiple actions, do ALL of them
- If a step fails, tell the user what happened and continue with remaining steps

INTELLIGENCE:
- Understand intent from casual language. "Hook me up with a PDF" = export_pdf. "Fresh start" = start_new_chat
- If the user says something vague like "work on the marketing thing", infer they want to select a project with a similar name
- If asked to generate a document but no project is active, use quick_generate to create it directly — don't error out
- When asked for a "PDF" or "DOCX", use quick_generate with the appropriate format parameter
- When linking files, use descriptive semantic queries not just exact filenames. "Link my research" should find research-related files
- If context from files is relevant, use it. If not, just chat naturally
- Use save_note to remember important things the user tells you (preferences, deadlines, names, etc.)
- Use write_file to create files the user needs (code, text, data, etc.)
- When the user sends you a file (PDF, DOCX, image, text), it is automatically indexed and available for RAG search. Acknowledge what was received and help with it.

RESPONSE FORMAT:
- Plain text only. No markdown, no asterisks, no headers, no bullet points with *
- Keep it readable on a phone
- After performing actions, give a brief natural summary of what you did
- Don't list out every function you called — just describe the outcome naturally`;
}

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
const STATUS_PORT = parseInt(process.env.STATUS_PORT || "3721", 10);

// Start health + settings API server
const healthServer = http.createServer((req, res) => {
  // CORS headers for all requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "running", port: STATUS_PORT }));
    return;
  }

  if (req.method === "GET" && req.url === "/settings") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getAllSettings()));
    return;
  }

  if (req.method === "POST" && req.url === "/settings") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const updates = JSON.parse(body);
        const allowedKeys = [
          "provider",
          "gemini_api_key",
          "ollama_url",
          "bot_provider",
          "chat_provider",
          "work_provider",
          "autosort_provider",
          "bot_gemini_model",
          "bot_ollama_model",
          "chat_gemini_model",
          "chat_ollama_model",
          "work_gemini_model",
          "work_ollama_model",
          "autosort_gemini_model",
          "autosort_ollama_model",
        ];
        for (const [key, value] of Object.entries(updates)) {
          if (allowedKeys.includes(key) && typeof value === "string") {
            setSetting(key, value);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(getAllSettings()));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});
healthServer.listen(STATUS_PORT, "127.0.0.1", () => {
  console.log(`   Status server: http://127.0.0.1:${STATUS_PORT}/health`);
});

bot.launch().then(() => {
  // Register commands in Telegram's menu
  bot.telegram.setMyCommands([
    { command: "help", description: "Show all commands" },
    { command: "newchat", description: "Start a new conversation" },
    { command: "history", description: "List past conversations" },
    { command: "loadchat", description: "Switch to an old conversation" },
    { command: "projects", description: "List projects" },
    { command: "newproject", description: "Create a project" },
    { command: "project", description: "Select active project" },
    { command: "files", description: "List linked files" },
    { command: "link", description: "Link a file to project" },
    { command: "generate", description: "Generate a document" },
    { command: "revise", description: "Revise last document" },
    { command: "pdf", description: "Export document as PDF" },
    { command: "docx", description: "Export document as DOCX" },
    { command: "reset", description: "Clear current conversation" },
  ]);

  console.log("\n✅ Kendall Telegram bot running (long polling)");
  console.log(`   DB: ${DB_PATH}`);
  console.log(`   Restricted to Telegram user ID: ${ALLOWED_USER_ID}`);
  console.log(`   Chats stored in DB under chat ID: "${currentChatId}"\n`);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
