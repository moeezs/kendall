import { readTextFile } from "@tauri-apps/plugin-fs";
import { readFile } from "@tauri-apps/plugin-fs";
import mammoth from "mammoth";
import Tesseract from "tesseract.js";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.js?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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

    case 'docx': {
      const docxBytes = await readFileWithRetry(filePath);
      const docxResult = await mammoth.extractRawText({ arrayBuffer: new Uint8Array(docxBytes).buffer });
      return docxResult.value;
    }

    case 'pdf': {
      const pdfBytes = await readFileWithRetry(filePath);
      const loadingTask = pdfjsLib.getDocument({ 
        data: new Uint8Array(pdfBytes),
        isEvalSupported: false
      });
      const pdf = await loadingTask.promise;
      
      let fullText = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent({
          includeMarkedContent: false,
          disableNormalization: false
        });
        const pageText = textContent.items.map((item: any) => item.str).join(" ");
        fullText += pageText + "\n";
      }
      return fullText;
    }

    case 'png':
    case 'jpg':
    case 'jpeg': {
      const imageBytes = await readFileWithRetry(filePath);
      const blob = new Blob([new Uint8Array(imageBytes)], { type: `image/${extension === 'jpg' ? 'jpeg' : extension}` });
      const imageUrl = URL.createObjectURL(blob);
      try {
        const ocrResult = await Tesseract.recognize(imageUrl, 'eng');
        return ocrResult.data.text;
      } finally {
        URL.revokeObjectURL(imageUrl);
      }
    }

    default:
      throw new Error(`Unsupported file type: ${extension}`);
  }
};
