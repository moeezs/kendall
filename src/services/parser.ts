import { readTextFile, readFile } from "@tauri-apps/plugin-fs";
import mammoth from "mammoth";
import Tesseract from "tesseract.js";
import * as pdfjsLib from "pdfjs-dist";


import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?raw";
const workerBlob = new Blob([pdfWorkerSrc], { type: "application/javascript" });
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);

// Helpers
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toError(err: unknown, fallback: string): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(fallback);
  }
}

async function readFileWithRetry(
  filePath: string,
  attempts = 8,
  delayMs = 300
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const bytes = await readFile(filePath);
      if (bytes.length > 0) return bytes;
      lastError = new Error("File read returned 0 bytes");
    } catch (err) {
      lastError = err;
    }
    await sleep(delayMs);
  }
  throw toError(lastError, `Failed to read file after ${attempts} attempts: ${filePath}`);
}

/** Normalize whitespace: collapse runs, trim each line, drop blank lines. */
function cleanText(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

// PDF

async function extractPdf(filePath: string): Promise<string> {
  const pdfBytes = await readFileWithRetry(filePath);
  console.log(`[parser] PDF ${filePath} — ${pdfBytes.length} bytes`);

  const loadingTask = pdfjsLib.getDocument({
    data: pdfBytes,
    useSystemFonts: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  });

  const pdf = await loadingTask.promise;
  console.log(`[parser] PDF loaded — ${pdf.numPages} page(s)`);

  const pages: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);

    // Use streamTextContent + reader instead of getTextContent(),
    // because Tauri's WKWebView doesn't support async iteration on ReadableStream.
    const stream = page.streamTextContent();
    const reader = stream.getReader();
    const allItems: any[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.items) allItems.push(...value.items);
    }

    // Reconstruct text respecting vertical gaps (new lines)
    let lastY: number | null = null;
    let line = "";
    const lines: string[] = [];

    for (const item of allItems) {
      if (!("str" in item) || typeof item.str !== "string") continue;
      const y = item.transform?.[5] as number | undefined;

      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
        // Y position jumped → new line
        if (line.trim()) lines.push(line.trim());
        line = "";
      }

      line += (line ? " " : "") + item.str;
      if (y !== undefined) lastY = y;
    }
    if (line.trim()) lines.push(line.trim());

    const pageText = lines.join("\n");
    if (pageText) pages.push(pageText);
  }

  const fullText = pages.join("\n\n");
  console.log(`[parser] PDF extracted ${fullText.length} chars from ${pdf.numPages} page(s)`);
  return fullText;
}

// DOCX

async function extractDocx(filePath: string): Promise<string> {
  const bytes = await readFileWithRetry(filePath);
  const result = await mammoth.extractRawText({
    arrayBuffer: bytes.buffer as ArrayBuffer,
  });
  return result.value;
}

// Images

async function extractImage(filePath: string, ext: string): Promise<string> {
  const bytes = await readFileWithRetry(filePath);
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const { data } = await Tesseract.recognize(url, "eng");
    return data.text;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// API

export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  console.log(`[parser] Extracting text from ${filePath} (type: ${ext})`);

  let raw = "";

  switch (ext) {
    case "txt":
    case "md":
      raw = await readTextFile(filePath);
      break;

    case "docx":
      raw = await extractDocx(filePath);
      break;

    case "pdf":
      raw = await extractPdf(filePath);
      break;

    case "png":
    case "jpg":
    case "jpeg":
      raw = await extractImage(filePath, ext);
      break;

    default:
      console.warn(`[parser] Unsupported file type: .${ext}`);
      return "";
  }

  const cleaned = cleanText(raw);
  console.log(`[parser] Result: ${cleaned.length} chars`);
  return cleaned;
}
