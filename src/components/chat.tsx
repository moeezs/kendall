import { useState, useRef, useEffect } from "react";
import { askKendallOS } from "../services/rag";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { createChat, addMessage, getMessages } from "../services/database";
import kendallLogo from "../assets/kendall.png";

export function ChatSection({ activeChatId, setActiveChatId }: { activeChatId?: string | null, setActiveChatId?: (id: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "ai"; content: string; sources?: string[] }[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [chatId, setChatId] = useState<string | null>(activeChatId || null);
  const loadedChatIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  useEffect(() => {
    if (activeChatId && activeChatId !== loadedChatIdRef.current) {
      loadedChatIdRef.current = activeChatId;
      setChatId(activeChatId);
      // Load previous messages for this chat
      getMessages(activeChatId).then(msgs => {
        const formattedMsgs = msgs.map(m => ({
          role: m.role as "user" | "ai",
          content: m.content,
          sources: m.sources
        }));
        setMessages(formattedMsgs);
      }).catch(err => console.error("Failed to load messages:", err));
    }
  }, [activeChatId]);

  const handleAsk = async () => {
    if (!query.trim()) return;

    let currentChatId = chatId;
    if (!currentChatId) {
      currentChatId = crypto.randomUUID();
      loadedChatIdRef.current = currentChatId;
      setChatId(currentChatId);
      if (setActiveChatId) setActiveChatId(currentChatId);
      await createChat(currentChatId, query.slice(0, 30) + "...");
    }

    const unsubmittedQuery = query;
    setMessages(prev => [...prev, { role: "user", content: unsubmittedQuery }]);
    setQuery("");
    setIsTyping(true);

    try {
      await addMessage(currentChatId, "user", unsubmittedQuery);
      
      // Get last few messages for context
      const chatHistoryForAi = messages.slice(-5).map(m => ({ role: m.role, content: m.content }));
      const response = await askKendallOS(unsubmittedQuery, chatHistoryForAi);
      
      setMessages(prev => [...prev, { 
        role: "ai", 
        content: response.answer,
        sources: response.contextFiles
      }]);
      await addMessage(currentChatId, "ai", response.answer, response.contextFiles);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: "ai", content: `❌ Error: ${err.message}` }]);
    } finally {
      setIsTyping(false);
    }
  };

  const getSourceIcon = (source: string) => {
    const ext = source.split('.').pop()?.toLowerCase();
    if (['pdf'].includes(ext || '')) return 'description';
    if (['csv', 'xlsx'].includes(ext || '')) return 'table_chart';
    if (['png', 'jpg', 'jpeg', 'svg'].includes(ext || '')) return 'image';
    return 'article';
  };

  return (
    <main className="flex-1 flex flex-col bg-[#18181b] overflow-hidden -mx-8 -mb-20">
      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto px-6 pt-24 pb-32">
        <div className="max-w-4xl mx-auto space-y-12">
          
          {messages.length === 0 && (
            <div className="pt-10 pb-4 flex flex-col items-center justify-center opacity-70 mt-20">
              <h1 className="text-3xl font-extrabold tracking-tighter mb-2 text-[#e7e5e5]">Kendall</h1>
              <p className="text-[#acabab] text-center max-w-lg leading-relaxed">
                Synthesizing local intelligence. Direct retrieval, no cloud inference.
              </p>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex flex-col gap-4 ${msg.role === "user" ? "items-end" : "items-start"}`}>
              {msg.role === "user" ? (
                <div className="flex flex-col items-end gap-3 group">
                  <div className="bg-[#202022] px-5 py-4 rounded-2xl rounded-tr-none max-w-[85%] shadow-sm">
                    <p className="text-sm leading-relaxed text-[#e7e5e5] whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-start gap-4">
                  <div className="flex items-center gap-2 mb-2">
                    <img src={kendallLogo} alt="Kendall" className="w-6 h-6 rounded-full object-cover" />
                    <span className="text-xs font-semibold text-[#adc6ff]">Kendall</span>
                  </div>
                  
                  <div className="space-y-4 max-w-[90%]">
                    <p className="text-sm leading-7 text-[#e7e5e5] whitespace-pre-wrap">{msg.content}</p>
                    
                    {msg.sources && msg.sources.length > 0 && (
                      <div className="pt-4 space-y-2">
                        <p className="text-[10px] font-bold text-[#acabab] uppercase tracking-widest">Sources & Citations</p>
                        <div className="flex flex-wrap gap-2">
                          {msg.sources.map((source, idx) => (
                            <div 
                              key={idx} 
                              onClick={() => revealItemInDir(source)}
                              className="flex items-center gap-2 px-3 py-1.5 bg-[#191a1a] rounded-lg border border-[#474848]/30 hover:bg-[#2b2c2c] hover:border-[#adc6ff]/50 cursor-pointer transition-colors group"
                            >
                              <span className="material-symbols-outlined text-xs text-[#acabab] group-hover:text-[#adc6ff]">{getSourceIcon(source)}</span>
                              <span className="text-[11px] text-[#acabab] truncate max-w-50" title={source}>
                                {source.split(/[/\\]/).pop()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          {isTyping && (
             <div className="flex flex-col items-start gap-4">
               <div className="flex items-center gap-2 mb-2">
                 <img src={kendallLogo} alt="Kendall" className="w-6 h-6 rounded-full object-cover animate-pulse" />
                 <span className="text-xs font-semibold text-[#adc6ff]">Kendall is thinking...</span>
               </div>
             </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Sticky Input Container */}
      <div className="absolute bottom-0 w-full p-6 bg-[#18181b]/80 backdrop-blur-md">
        <div className="max-w-4xl mx-auto relative group">
          <div className="bg-[#202022] rounded-xl p-1 shadow-2xl transition-all border border-[#474848]/30 focus-within:border-[#adc6ff]/50">
            <div className="flex items-end gap-2 px-3 py-2">
              <textarea 
                className="flex-1 bg-transparent border-none focus:ring-0 text-[#e7e5e5] placeholder:text-[#acabab] text-sm py-2 resize-none max-h-48 outline-none" 
                placeholder="Ask Kendall about your documents..." 
                rows={1}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 192)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleAsk();
                    e.currentTarget.style.height = 'auto';
                  }
                }}
              />
              <button 
                onClick={handleAsk}
                disabled={isTyping || !query.trim()}
                className="mb-1 flex items-center justify-center h-8 w-8 bg-[#18181b] border border-[#2b2c2c] text-[#adc6ff] rounded-sm hover:border-[#adc6ff]/50 hover:bg-[#2b2c2c] transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px] font-medium">arrow_upward</span>
              </button>
            </div>
          </div>
        </div>
        <p className="text-center text-[10px] text-[#acabab] mt-3 opacity-60">
          Kendall operates locally. Your data never leaves this environment.
        </p>
      </div>
    </main>
  );
}
