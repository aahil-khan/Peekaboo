import Database from '@tauri-apps/plugin-sql';
import type { Session, HistoryMessage } from '../store/history';

let db: Database | null = null;

async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load('sqlite:peekaboo.db');
  }
  return db;
}

// ─── Sessions ───────────────────────────────────────────────────────

export async function createSession(
  id: string,
  model: string,
  providerId: string,
  title?: string
): Promise<void> {
  const d = await getDb();
  const now = Date.now();
  await d.execute(
    'INSERT INTO sessions (id, created_at, updated_at, title, model, provider_id) VALUES (?, ?, ?, ?, ?, ?)',
    [id, now, now, title ?? null, model, providerId]
  );
}

export async function updateSessionTitle(
  id: string,
  title: string
): Promise<void> {
  const d = await getDb();
  await d.execute(
    'UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?',
    [title, Date.now(), id]
  );
}

export async function deleteSession(id: string): Promise<void> {
  const d = await getDb();
  // messages have ON DELETE CASCADE so deleting session is enough
  await d.execute('DELETE FROM sessions WHERE id = ?', [id]);
}

export async function getRecentSessions(
  limit: number = 50
): Promise<Session[]> {
  const d = await getDb();
  const rows = await d.select<
    {
      id: string;
      created_at: number;
      updated_at: number;
      title: string | null;
      model: string;
      provider_id: string;
    }[]
  >('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?', [limit]);

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    title: r.title,
    model: r.model,
    providerId: r.provider_id,
  }));
}


// ─── Messages ───────────────────────────────────────────────────────

export async function saveMessage(
  id: string,
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  hasAttachment: boolean = false
): Promise<void> {
  const d = await getDb();
  const now = Date.now();
  await d.execute(
    'INSERT INTO messages (id, session_id, role, content, created_at, has_attachment) VALUES (?, ?, ?, ?, ?, ?)',
    [id, sessionId, role, content, now, hasAttachment ? 1 : 0]
  );
  // Touch session updated_at
  await d.execute('UPDATE sessions SET updated_at = ? WHERE id = ?', [
    now,
    sessionId,
  ]);
}

export async function getSessionMessages(
  sessionId: string
): Promise<HistoryMessage[]> {
  const d = await getDb();
  const rows = await d.select<
    {
      id: string;
      session_id: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
      created_at: number;
      has_attachment: number;
    }[]
  >('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', [
    sessionId,
  ]);

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    hasAttachment: r.has_attachment === 1,
  }));
}

export async function getLastUserMessage(): Promise<string | null> {
  const d = await getDb();
  const rows = await d.select<{ content: string }[]>(
    "SELECT content FROM messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1"
  );
  return rows.length > 0 ? rows[0].content : null;
}

// ─── Cleanup ────────────────────────────────────────────────────────

export async function cleanOldSessions(retentionDays: number): Promise<void> {
  const d = await getDb();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  await d.execute('DELETE FROM sessions WHERE updated_at < ?', [cutoff]);
}

// ─── Memories ───────────────────────────────────────────────────────

export interface Memory {
  id: string;
  content: string;
  isPinned: boolean;
  usageCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export async function saveMemory(id: string, content: string): Promise<void> {
  const d = await getDb();
  const now = Date.now();
  await d.execute(
    'INSERT INTO memories (id, content, created_at, updated_at, is_pinned, usage_count, last_used_at) VALUES (?, ?, ?, ?, 0, 0, NULL)',
    [id, content, now, now]
  );
}

export async function updateMemory(id: string, content: string): Promise<void> {
  const d = await getDb();
  await d.execute(
    'UPDATE memories SET content = ?, updated_at = ? WHERE id = ?',
    [content, Date.now(), id]
  );
}

export async function togglePinMemory(id: string, isPinned: boolean): Promise<void> {
  const d = await getDb();
  await d.execute(
    'UPDATE memories SET is_pinned = ?, updated_at = ? WHERE id = ?',
    [isPinned ? 1 : 0, Date.now(), id]
  );
}

export async function incrementMemoryUsage(id: string): Promise<void> {
  const d = await getDb();
  await d.execute(
    'UPDATE memories SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?',
    [Date.now(), id]
  );
}

export async function deleteMemory(id: string): Promise<void> {
  const d = await getDb();
  await d.execute('DELETE FROM memories WHERE id = ?', [id]);
}

export async function searchMemories(query: string = '', limit: number = 20): Promise<Memory[]> {
  const d = await getDb();
  
  let rows;
  if (query.trim() === '') {
    rows = await d.select<{ id: string; content: string; created_at: number; updated_at: number; is_pinned: number; usage_count: number; last_used_at: number | null }[]>(
      'SELECT * FROM memories ORDER BY is_pinned DESC, created_at DESC LIMIT ?',
      [limit]
    );
  } else {
    const trimmed = query.trim();
    const exactQuery = trimmed;
    const prefixQuery = `${trimmed}%`;
    const substringQuery = `%${trimmed}%`;

    rows = await d.select<{ id: string; content: string; created_at: number; updated_at: number; is_pinned: number; usage_count: number; last_used_at: number | null }[]>(
      `SELECT * FROM memories 
       WHERE content LIKE ? 
       ORDER BY 
         CASE 
           WHEN LOWER(content) = LOWER(?) THEN 1
           WHEN LOWER(content) LIKE LOWER(?) THEN 2
           ELSE 3
         END ASC,
         is_pinned DESC, 
         usage_count DESC, 
         last_used_at DESC 
       LIMIT ?`,
      [substringQuery, exactQuery, prefixQuery, limit]
    );
  }

  return rows.map(r => ({
    id: r.id,
    content: r.content,
    isPinned: Boolean(r.is_pinned),
    usageCount: r.usage_count || 0,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}
