import { pipeline, FeatureExtractionPipeline } from "@huggingface/transformers";

let instance: FeatureExtractionPipeline | null = null;

export const getEmbeddingModel = async () => {
  if (!instance) {
    console.log("🤖 Loading local AI model...");
    instance = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  return instance;
};

export const generateEmbedding = async (text: string) => {
  const model = await getEmbeddingModel();
  const output = await model(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
};