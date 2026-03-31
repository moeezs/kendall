import "./App.css";

function App() {
  return (
    <div style={{ padding: "20px", fontFamily: "system-ui, sans-serif" }}>
      <h2>Kendall</h2>
      <p style={{ color: "gray" }}>Your local, private agent.</p>
      
      <div style={{ marginTop: "30px" }}>
        <h3>Active Directories</h3>
        <div style={{ display: "flex", gap: "15px", marginTop: "10px" }}>
          
          <div style={{ padding: "15px", border: "2px dashed #ccc", borderRadius: "8px" }}>
            📥 Dump (Auto-Sort)
          </div>
          
          <div style={{ padding: "15px", border: "1px solid #ccc", borderRadius: "8px" }}>
            📚 McMaster
          </div>
          
          <div style={{ padding: "15px", border: "1px solid #ccc", borderRadius: "8px" }}>
            📌 Projects
          </div>
          
          <div style={{ padding: "15px", border: "1px solid #ccc", borderRadius: "8px" }}>
            🫡 Random
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;