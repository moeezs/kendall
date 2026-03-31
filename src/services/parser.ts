import { readTextFile } from "@tauri-apps/plugin-fs";
import { readFile } from "@tauri-apps/plugin-fs";
import mammoth from "mammoth";
import Tesseract from "tesseract.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toError = (err: unknown, fallback: string): Error => {
  if (err instanceof Error) return err;

  if (typeof err === "string") {
    return new Error(err);
  }

  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(fallback);
  }
};

const readFileWithRetry = async (
  filePath: string,
  attempts = 8,
  delayMs = 300
): Promise<Uint8Array> => {
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      const bytes = await readFile(filePath);
      if (bytes.length > 0) {
        return bytes;
      }
      lastError = new Error("File is empty");
    } catch (err) {
      lastError = err;
    }

    await sleep(delayMs);
  }

  throw toError(lastError, `Failed to read file: ${filePath}`);
};

export const extractTextFromFile = async (filePath: string): Promise<string> => {
  const extension = filePath.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'txt':
    case 'md':
      return await readTextFile(filePath);

    case 'docx':
      const docxBytes = await readFileWithRetry(filePath);
      const docxBuffer = docxBytes.buffer.slice(
        docxBytes.byteOffset,
        docxBytes.byteOffset + docxBytes.byteLength
      ) as ArrayBuffer;
      const docxResult = await mammoth.extractRawText({ arrayBuffer: docxBuffer });
      return docxResult.value;

    case 'png':
    case 'jpg':
    case 'jpeg': {
      const imageBytes = await readFileWithRetry(filePath);
      const imageBuffer = imageBytes.buffer.slice(
        imageBytes.byteOffset,
        imageBytes.byteOffset + imageBytes.byteLength
      ) as ArrayBuffer;
      const mimeType = extension === "png" ? "image/png" : "image/jpeg";
      const imageBlob = new Blob([imageBuffer], { type: mimeType });
      const ocrResult = await Tesseract.recognize(imageBlob, 'eng');
      return ocrResult.data.text;
    }

    default:
      throw new Error(`Unsupported file type: ${extension}`);
  }
};