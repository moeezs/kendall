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

  await db.execute(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sources TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration: ensure project_files has the correct schema.
  // A previous version may have created it with different columns.
  try {
    await db.select("SELECT file_id FROM project_files LIMIT 0");
  } catch {
    await db.execute("DROP TABLE IF EXISTS project_files");
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS project_files (
      project_id TEXT NOT NULL,
      file_id INTEGER NOT NULL,
      PRIMARY KEY (project_id, file_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
    );
  `);

  // Ensure settings table exists (can also be created by the server)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
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


export async function getAllFiles() {
  const db = await getDb();
  return await db.select<any[]>("SELECT * FROM files WHERE embedding IS NOT NULL");
}

export async function getAllFilesMetadata() {
  const db = await getDb();
  return await db.select<any[]>("SELECT id, path, filename, length(content) as content_length FROM files WHERE embedding IS NOT NULL");
}

export async function deleteFileRecord(id: number) {
  const db = await getDb();
  console.log("Attempting to delete ID:", id);
  const result = await db.execute("DELETE FROM files WHERE id = $1", [id]);
  console.log("Delete query result:", result);
}

export async function createChat(id: string, title: string) {
  const db = await getDb();
  await db.execute("INSERT INTO chats (id, title) VALUES ($1, $2)", [id, title]);
}

export async function addMessage(chatId: string, role: string, content: string, sources?: string[]) {
  const db = await getDb();
  const sourcesStr = sources ? JSON.stringify(sources) : null;
  await db.execute(
    "INSERT INTO messages (chat_id, role, content, sources) VALUES ($1, $2, $3, $4)",
    [chatId, role, content, sourcesStr]
  );
}

export async function getChats() {
  const db = await getDb();
  return await db.select<any[]>("SELECT * FROM chats ORDER BY created_at DESC");
}

export async function getMessages(chatId: string) {
  const db = await getDb();
  const msgs = await db.select<any[]>("SELECT * FROM messages WHERE chat_id = $1 ORDER BY id ASC", [chatId]);
  return msgs.map(m => ({
    ...m,
    sources: m.sources ? JSON.parse(m.sources) : undefined
  }));
}

export async function deleteChat(chatId: string) {
  const db = await getDb();
  await db.execute("DELETE FROM messages WHERE chat_id = $1", [chatId]);
  await db.execute("DELETE FROM chats WHERE id = $1", [chatId]);
}

// ── Projects ──

export async function createProject(id: string, name: string, description: string = "") {
  const db = await getDb();
  await db.execute("INSERT INTO projects (id, name, description) VALUES ($1, $2, $3)", [id, name, description]);
}

export async function getProjects() {
  const db = await getDb();
  return await db.select<any[]>("SELECT * FROM projects ORDER BY created_at DESC");
}

export async function updateProject(id: string, name: string, description: string) {
  const db = await getDb();
  await db.execute("UPDATE projects SET name = $1, description = $2 WHERE id = $3", [name, description, id]);
}

export async function deleteProject(id: string) {
  const db = await getDb();
  await db.execute("DELETE FROM project_files WHERE project_id = $1", [id]);
  await db.execute("DELETE FROM projects WHERE id = $1", [id]);
}

export async function getProjectFiles(projectId: string) {
  const db = await getDb();
  return await db.select<any[]>(
    `SELECT f.id, f.path, f.filename, length(f.content) as content_length
     FROM project_files pf
     JOIN files f ON pf.file_id = f.id
     WHERE pf.project_id = $1`,
    [projectId]
  );
}

export async function getProjectFileContents(projectId: string) {
  const db = await getDb();
  return await db.select<any[]>(
    `SELECT f.id, f.path, f.filename, f.content
     FROM project_files pf
     JOIN files f ON pf.file_id = f.id
     WHERE pf.project_id = $1`,
    [projectId]
  );
}

export async function addProjectFile(projectId: string, fileId: number) {
  const db = await getDb();
  await db.execute("INSERT OR IGNORE INTO project_files (project_id, file_id) VALUES ($1, $2)", [projectId, fileId]);
}

export async function removeProjectFile(projectId: string, fileId: number) {
  const db = await getDb();
  await db.execute("DELETE FROM project_files WHERE project_id = $1 AND file_id = $2", [projectId, fileId]);
}

