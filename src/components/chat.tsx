import { useState } from "react";
import { askKendallOS } from "../services/rag";

export function ChatSection() {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "ai"; content: string; sources?: string[] }[]>([]);
  const [isTyping, setIsTyping] = useState(false);

  const handleAsk = async () => {
    if (!query.trim()) return;

    const unsubmittedQuery = query;
    setMessages(prev => [...prev, { role: "user", content: unsubmittedQuery }]);
    setQuery("");
    setIsTyping(true);

    try {
      const response = await askKendallOS(unsubmittedQuery);
      setMessages(prev => [...prev, { 
        role: "ai", 
        content: response.answer,
        sources: response.contextFiles
      }]);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: "ai", content: `❌ Error: ${err.message}` }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="flex-1 bg-gray-50 rounded-xl p-5 flex flex-col border border-gray-200 h-full">
      <div className="flex-1 overflow-y-auto flex flex-col gap-4 mb-5">
        {messages.length === 0 && (
          <p className="text-gray-500 text-center my-auto">
            Ask Kendall a question about your files...
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`max-w-[85%] ${msg.role === "user" ? "self-end" : "self-start"}`}>
            <div className={`px-4 py-3 rounded-xl ${
              msg.role === "user" 
                ? "bg-blue-600 text-white rounded-br-sm" 
                : "bg-gray-200 text-black rounded-bl-sm"
            }`}>
              {msg.content}
            </div>
            {msg.sources && msg.sources.length > 0 && (
              <div className="text-[11px] text-gray-500 mt-1 pl-1">
                Sources: {msg.sources.join(", ")}
              </div>
            )}
          </div>
        ))}
        {isTyping && (
          <div className="self-start text-gray-500 text-[13px]">
            Kendall is thinking...
          </div>
        )}
      </div>

      <div className="flex gap-2.5 mt-auto">
        <input 
          type="text" 
          placeholder="Ask Kendall..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAsk()}
          className="flex-1 p-3 rounded-lg border border-gray-300 text-[15px] text-black bg-white outline-none focus:border-blue-500"
        />
        <button 
          onClick={handleAsk}
          disabled={isTyping}
          className="px-5 rounded-lg border-none bg-blue-600 text-white cursor-pointer hover:bg-blue-700 disabled:opacity-50"
        >
          Ask
        </button>
      </div>
    </div>
  );
}
