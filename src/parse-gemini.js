import { readFileSync, readdirSync, statSync } from 'fs'
import { join, basename, extname } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'

const GEMINI_DIR = join(homedir(), '.gemini')
const TMP_DIR = join(GEMINI_DIR, 'tmp')
const PROJECTS_FILE = join(GEMINI_DIR, 'projects.json')

function sha256(s) {
  return createHash('sha256').update(s).digest('hex')
}

// Map dir-name (hash OR friendly name from projects.json) → absolute path.
// Gemini's tmp/ uses either form depending on version.
let _projectMap = null
function loadProjectMap() {
  if (_projectMap) return _projectMap
  const map = {}
  try {
    const raw = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'))
    const entries = raw?.projects && typeof raw.projects === 'object' ? raw.projects : {}
    for (const [absPath, friendly] of Object.entries(entries)) {
      map[sha256(absPath)] = absPath
      if (friendly) map[friendly] = absPath
    }
  } catch {}
  _projectMap = map
  return map
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(p => p && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n')
  }
  return ''
}

// Convert a stream of records into { metadata, turns }.
// Handles JSONL line shapes: header, $set, $rewindTo, MessageRecord.
function reduceRecords(records) {
  let metadata = null
  const turns = []
  const msgIdToTurnIdx = new Map()

  for (const obj of records) {
    if (!obj || typeof obj !== 'object') continue

    if (obj.$rewindTo) {
      const idx = msgIdToTurnIdx.get(obj.$rewindTo)
      if (idx !== undefined) {
        turns.length = idx
        for (const [id, i] of msgIdToTurnIdx) {
          if (i >= idx) msgIdToTurnIdx.delete(id)
        }
      }
      continue
    }
    if (obj.$set) {
      metadata = { ...(metadata || {}), ...obj.$set }
      continue
    }

    // Header line (no `id`/`type`, but has sessionId/projectHash)
    if (!obj.id && !obj.type && (obj.sessionId || obj.projectHash)) {
      metadata = { ...(metadata || {}), ...obj }
      continue
    }

    // MessageRecord
    if (obj.id && obj.type) {
      if (obj.type !== 'user' && obj.type !== 'gemini') continue
      const text = extractText(obj.content)
      if (!text) continue
      const role = obj.type === 'user' ? 'user' : 'assistant'
      msgIdToTurnIdx.set(obj.id, turns.length)
      turns.push({ role, text })
    }
  }

  return { metadata, turns }
}

function readSessionRecords(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  if (extname(filePath) === '.jsonl') {
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch {}
    }
    return out
  }
  // Legacy single-object .json
  try {
    const obj = JSON.parse(raw)
    const messages = Array.isArray(obj?.messages) ? obj.messages : []
    const header = { ...obj }
    delete header.messages
    return [header, ...messages]
  } catch {
    return []
  }
}

export function parseGeminiSession(filePath) {
  const records = readSessionRecords(filePath)
  const { metadata, turns } = reduceRecords(records)

  const fileBase = basename(filePath).replace(/\.(jsonl|json)$/, '')
  const idFromName = fileBase.split('-').pop() || fileBase
  const sessionId = metadata?.sessionId || idFromName

  const projectMap = loadProjectMap()
  const cwd = metadata?.projectHash ? (projectMap[metadata.projectHash] || null) : null

  const taskTurn = turns.find(t => t.role === 'user')
  const task = taskTurn?.text || ''

  return {
    sessionId,
    cwd,
    startCommit: null,
    task,
    turns,
  }
}

function listChatFilesIn(chatsDir) {
  let entries
  try { entries = readdirSync(chatsDir) } catch { return [] }
  const out = []
  for (const f of entries) {
    if (!f.startsWith('session-')) continue
    if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue
    const path = join(chatsDir, f)
    let mtime = 0
    try { mtime = statSync(path).mtimeMs } catch { continue }
    out.push({ path, mtime })
  }
  return out
}

export function findGeminiSessions(filterDir = null) {
  // Fast path: --dir given → check only the matching tmp subdirs
  if (filterDir) {
    const projectMap = loadProjectMap()
    const candidates = new Set([sha256(filterDir)])
    for (const [key, absPath] of Object.entries(projectMap)) {
      if (absPath === filterDir) candidates.add(key)
    }
    const out = []
    for (const dirName of candidates) {
      out.push(...listChatFilesIn(join(TMP_DIR, dirName, 'chats')))
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  let subdirs
  try { subdirs = readdirSync(TMP_DIR) } catch { return [] }

  const all = []
  for (const sub of subdirs) {
    all.push(...listChatFilesIn(join(TMP_DIR, sub, 'chats')))
  }
  return all.sort((a, b) => b.mtime - a.mtime)
}

export function findGeminiSessionById(id) {
  if (!id) return null
  const id8 = id.slice(0, 8).toLowerCase()
  let subdirs
  try { subdirs = readdirSync(TMP_DIR) } catch { return null }

  for (const sub of subdirs) {
    const chatsDir = join(TMP_DIR, sub, 'chats')
    let files
    try { files = readdirSync(chatsDir) } catch { continue }
    for (const f of files) {
      if (!f.startsWith('session-')) continue
      const base = f.replace(/\.(jsonl|json)$/, '')
      const suffix = base.split('-').pop()?.toLowerCase()
      if (suffix === id8) return join(chatsDir, f)
    }
  }
  return null
}

export function getLastGeminiSession(filterDir = null) {
  return findGeminiSessions(filterDir)[0]?.path || null
}
