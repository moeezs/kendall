import { GoogleGenerativeAI } from "@google/generative-ai";
import { generateEmbedding } from "./ai";
import { getAllFiles } from "./database";

// Cosine similarity function
function cosineSimilarity(vecA: number[], vecB: number[]) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// search
export async function searchContext(query: string, topK: number = 3) {
  // Turn the query into a vector using the local model
  const queryVector = await generateEmbedding(query);
  
  // Get all indexed files from our local SQLite Database
  const allFiles = await getAllFiles();
  
  const scoredFiles = allFiles.map((file) => {
    let embedding: number[] = [];
    try {
      if (typeof file.embedding === "string") {
        embedding = JSON.parse(file.embedding);
      }
    } catch (e) {
      console.error("Failed to parse embedding for file:", file.filename);
    }
    
    let score = -1;
    if (embedding && embedding.length > 0) {
      // Calculate how mathematically similar the query is to the document
      score = cosineSimilarity(queryVector, embedding);
    }
    
    return { ...file, score };
  });

  // Sort by highest similarity first
  scoredFiles.sort((a, b) => b.score - a.score);
  
  // Return only the top few matching files
  return scoredFiles.slice(0, topK);
}

// generation
export async function askKendallOS(query: string) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing Gemini API Key. Please add it to your .env file.");

  console.log("Searching local database for context...");
  const contexts = await searchContext(query, 3);
  const allFiles = await getAllFiles();
  const totalFiles = allFiles.length;
  
  // If no files were found/indexed at all
  if (contexts.length === 0 || contexts[0].score < 0) {
    return {
      answer: "I don't have any documents indexed to answer that question yet. Try moving some files into the Dump folder!",
      contextFiles: []
    };
  }

  // Format context snippets (Limiting size to avoid overloading prompt)
  const contextText = contexts.map((c) => `[Source: ${c.filename}]\n${(c.content || '').substring(0, 1500)}...`).join("\n\n");

  const prompt = `You are Kendall OS, a helpful, conversational, and concise personal AI assistant. 
You are currently indexing and have access to ${totalFiles} local files from the user's system.

Guidelines:
- Act like a natural personal assistant. Keep responses brief, friendly, and conversational. Do not write long essays.
- If the user asks general questions about you or your system (e.g., "how many files do you have?"), answer naturally using the information provided above.
- When the user asks about their data, use the provided "Context" to answer. 
- If they ask about their data and the answer isn't in the Context, politely mention that you didn't find anything relevant in their parsed files.

Context from User's Files:
${contextText}

User: "${query}"`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 

  console.log("Sending structured prompt to Gemini API...");
  try {
    const result = await model.generateContent(prompt);
    return {
      answer: result.response.text(),
      contextFiles: contexts.map((c) => c.filename)
    };
  } catch (err: any) {
    console.error("Gemini API Error:", err);
    throw new Error(err.message || "Failed to contact Gemini API");
  }
}

export async function categorizeFile(fileText: string, availableFolders: string[]) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) return "Misc";
  try {
    const prompt = `
      You are an automated file sorter.
      Look at the following text extracted from a file, and determine which folder it belongs in.
      
      Available Folders: ${availableFolders.join(", ")}
      
      Reply with ONLY the exact name of the folder it belongs to. Do not add punctuation, explanations, or quotes.
      If it does not clearly fit into any of the available folders, reply with exactly: Misc
      
      File Text (Preview):
      ${fileText.substring(0, 1500)}
    `;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
    
  } catch (error) {
    console.error("Sorting error:", error);
    return "Random";
  }
}
