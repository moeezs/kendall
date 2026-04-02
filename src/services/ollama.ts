const OLLAMA_BASE_URL = import.meta.env.VITE_OLLAMA_URL || "http://localhost:11434";

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export async function getOllamaModels(): Promise<OllamaModel[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Ollama responded with ${res.status}`);
    const data = await res.json();
    return (data.models || []) as OllamaModel[];
  } catch (err) {
    console.error("[ollama] Failed to fetch models:", err);
    return [];
  }
}

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ollamaGenerate(
  model: string,
  prompt: string,
  system?: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    prompt,
    stream: false,
  };
  if (system) body.system = system;

  const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`Ollama generate failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.response || "";
}

export async function ollamaChat(
  model: string,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`Ollama chat failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.message?.content || "";
}
