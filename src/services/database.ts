import Database from "@tauri-apps/plugin-sql";

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!dbInstance) {
    dbInstance = await Database.load("sqlite:kendall.db");
    await initDb(dbInstance);
  }
  return dbInstance;
}

async function initDb(db: Database) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      content TEXT,
      embedding TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export async function saveFileRecord(
  path: string, 
  filename: string, 
  content: string, 
  embeddingVector?: number[]
) {
  const db = await getDb();
  
  const embeddingString = embeddingVector ? JSON.stringify(embeddingVector) : null;

  await db.execute(
    `INSERT INTO files (path, filename, content, embedding)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(path) DO UPDATE SET 
        content=excluded.content, 
        embedding=excluded.embedding,
        created_at=CURRENT_TIMESTAMP`,
    [path, filename, content, embeddingString]
  );
}

export async function getFileRecord(path: string) {
  const db = await getDb();
  const results = await db.select<any[]>("SELECT * FROM files WHERE path = $1", [path]);
  return results.length > 0 ? results[0] : null;
}

