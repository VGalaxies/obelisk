import { CLAUDE_DIR, CODEX_DIR, openDb, trunc, truncJson, extractText, filePath, isDir, readLines, fs, path } from './db.mjs';

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_PATH = path.join(CLAUDE_DIR, 'history.jsonl');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');

function discoverJsonlFiles() {
  return [...discoverClaudeJsonlFiles(), ...discoverCodexJsonlFiles()];
}

function discoverClaudeJsonlFiles() {
  const files = [];
  if (!fs.existsSync(PROJECTS_DIR)) return files;
  let projects;
  try { projects = fs.readdirSync(PROJECTS_DIR); } catch (e) { process.stderr.write(`Warning: cannot read projects dir: ${e.message}\n`); return files; }
  for (const proj of projects) {
    const projPath = path.join(PROJECTS_DIR, proj);
    if (!isDir(projPath)) continue;
    let entries;
    try { entries = fs.readdirSync(projPath); } catch { continue; }
    for (const f of entries) {
      if (f.endsWith('.jsonl'))
        files.push({ source: 'claude', path: path.join(projPath, f), sessionId: f.slice(0, -6), project: proj, isSubagent: false });
    }
    for (const sd of entries) {
      const saDir = path.join(projPath, sd, 'subagents');
      if (!isDir(saDir)) continue;
      let saEntries;
      try { saEntries = fs.readdirSync(saDir); } catch { continue; }
      for (const sf of saEntries) {
        if (sf.endsWith('.jsonl'))
          files.push({ source: 'claude', path: path.join(saDir, sf), sessionId: sd, project: proj, isSubagent: true, agentId: sf.slice(0, -6) });
      }
      const wfRoot = path.join(saDir, 'workflows');
      if (!isDir(wfRoot)) continue;
      let wfDirs;
      try { wfDirs = fs.readdirSync(wfRoot); } catch { continue; }
      for (const wfDir of wfDirs) {
        const wfPath = path.join(wfRoot, wfDir);
        if (!isDir(wfPath)) continue;
        let wfEntries;
        try { wfEntries = fs.readdirSync(wfPath); } catch { continue; }
        for (const wf of wfEntries) {
          if (wf.endsWith('.jsonl'))
            files.push({ source: 'claude', path: path.join(wfPath, wf), sessionId: sd, project: proj, isSubagent: true, agentId: wf.slice(0, -6), workflowRunId: wfDir });
        }
      }
    }
  }
  return files;
}

function discoverCodexJsonlFiles() {
  const files = [];
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return files;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(codexFileInfo(p));
      }
    }
  };
  walk(CODEX_SESSIONS_DIR);
  return files;
}

function codexFileInfo(fp) {
  const info = {
    source: 'codex',
    path: fp,
    sessionId: path.basename(fp, '.jsonl'),
    project: 'codex',
    projectPath: null,
    originator: null,
    version: null,
    isSubagent: false,
  };
  let seen = 0;
  readLines(fp, (line) => {
    if (++seen > 80) return false;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj.type !== 'session_meta') return;
    const payload = obj.payload || {};
    info.sessionId = payload.id || info.sessionId;
    info.projectPath = payload.cwd || null;
    info.project = payload.cwd || 'codex';
    info.originator = payload.originator || payload.source || null;
    info.version = payload.cli_version || null;
    return false;
  });
  return info;
}

function needsReindex(db, fp) {
  const mt = fs.statSync(fp).mtimeMs;
  const row = db.prepare('SELECT mtime, lines_processed FROM index_state WHERE jsonl_path = ?').get(fp);
  if (!row) return { needed: true, skip: 0 };
  return mt > row.mtime ? { needed: true, skip: row.lines_processed } : { needed: false, skip: 0 };
}

function indexJsonl(db, fi) {
  if (fi.source === 'codex') return indexCodexJsonl(db, fi);
  return indexClaudeJsonl(db, fi);
}

function indexClaudeJsonl(db, fi) {
  const { needed, skip } = needsReindex(db, fi.path);
  if (!needed) return;
  const mt = fs.statSync(fi.path).mtimeMs;

  const ins = {
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    msg: db.prepare('INSERT OR REPLACE INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,model,is_sidechain,agent_id,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
    tc:  db.prepare('INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path) VALUES (?,?,?,?,?,?)'),
    tr:  db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path) VALUES (?,?,?,?,?)'),
    idx: db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)'),
  };

  const existing = !fi.isSubagent ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(fi.sessionId) : null;
  const sm = {
    started_at: existing?.started_at || null,
    ended_at: existing?.ended_at || null,
    git_branch: existing?.git_branch || null,
    version: existing?.version || null,
    title: existing?.title || null,
    n: existing?.message_count || 0,
  };

  let lineNum = 0;
  readLines(fi.path, (line) => {
    lineNum++;
    if (lineNum <= skip) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    const sid = fi.sessionId;
    const ts = obj.timestamp || null;

    if (obj.type === 'ai-title' && obj.aiTitle) { sm.title = obj.aiTitle; return; }
    if (obj.type !== 'user' && obj.type !== 'assistant') return;

    if (ts && (!sm.started_at || ts < sm.started_at)) sm.started_at = ts;
    if (ts && (!sm.ended_at || ts > sm.ended_at)) sm.ended_at = ts;
    if (obj.gitBranch) sm.git_branch = obj.gitBranch;
    if (obj.version) sm.version = obj.version;
    sm.n++;

    const msg = obj.message || {};
    const text = extractText(msg.content);
    const usage = msg.usage || {};
    const aid = fi.isSubagent ? fi.agentId : (obj.agentId || null);

    if (obj.uuid) {
      ins.msg.run(obj.uuid, sid, obj.type, obj.parentUuid || null, ts,
        msg.role || obj.type, text, msg.model || null,
        obj.isSidechain ? 1 : 0, aid, usage.input_tokens || null, usage.output_tokens || null);
    }

    if (obj.type === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use' && b.id)
          ins.tc.run(b.id, obj.uuid, sid, b.name, truncJson(b.input || {}), filePath(b.name, b.input));
      }
    }

    if (obj.type === 'user' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const rt = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map(c => c.text || '').join('\n') : '';
        ins.tr.run(b.tool_use_id, obj.uuid, sid, trunc(rt), obj.toolUseResult?.filePath || null);
      }
    }
  });

  if (!fi.isSubagent) {
    const pp = '/' + fi.project.replace(/-/g, '/').replace(/^\//, '');
    ins.ses.run(fi.sessionId, sm.title, fi.project, pp, sm.started_at, sm.ended_at, sm.git_branch, sm.version, sm.n, fi.path, 'claude');
  }
  ins.idx.run(fi.path, mt, lineNum);
}

function indexCodexJsonl(db, fi) {
  const { needed, skip } = needsReindex(db, fi.path);
  if (!needed) return;
  const mt = fs.statSync(fi.path).mtimeMs;

  const ins = {
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    msg: db.prepare('INSERT OR REPLACE INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,model,is_sidechain,agent_id,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
    tc:  db.prepare('INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path) VALUES (?,?,?,?,?,?)'),
    tr:  db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path) VALUES (?,?,?,?,?)'),
    idx: db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)'),
  };

  const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(fi.sessionId);
  const sm = {
    started_at: existing?.started_at || null,
    ended_at: existing?.ended_at || null,
    git_branch: existing?.git_branch || null,
    version: existing?.version || fi.version || null,
    title: existing?.title || null,
    n: existing?.message_count || 0,
    project: existing?.project || fi.project || 'codex',
    project_path: existing?.project_path || fi.projectPath || null,
  };
  const toolIds = new Map();

  let lineNum = 0;
  readLines(fi.path, (line) => {
    lineNum++;
    if (lineNum <= skip) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    const ts = obj.timestamp || obj.payload?.timestamp || null;
    const sid = fi.sessionId;
    if (ts && (!sm.started_at || ts < sm.started_at)) sm.started_at = ts;
    if (ts && (!sm.ended_at || ts > sm.ended_at)) sm.ended_at = ts;

    if (obj.type === 'session_meta') {
      const payload = obj.payload || {};
      sm.project_path = payload.cwd || sm.project_path;
      sm.project = payload.cwd || sm.project;
      sm.version = payload.cli_version || sm.version;
      return;
    }
    if (obj.type === 'turn_context') {
      const payload = obj.payload || {};
      sm.project_path = payload.cwd || sm.project_path;
      sm.project = payload.cwd || sm.project;
      sm.git_branch = payload.git_branch || payload.gitBranch || sm.git_branch;
      return;
    }
    if (obj.type !== 'response_item') return;

    const payload = obj.payload || {};
    const uuid = `codex:${sid}:l${lineNum}`;
    if (payload.type === 'message') {
      const text = extractText(payload.content);
      const role = payload.role || 'assistant';
      ins.msg.run(uuid, sid, 'codex_message', null, ts, role, text, payload.model || null, 0, null, null, null);
      sm.n++;
      return;
    }
    if (payload.type === 'function_call') {
      const callId = payload.call_id || payload.id || `line-${lineNum}`;
      const dbCallId = `codex:${sid}:${callId}`;
      const input = parseCodexArguments(payload.arguments);
      const text = `${payload.name || 'function_call'} ${typeof input === 'string' ? input : JSON.stringify(input)}`;
      ins.msg.run(uuid, sid, 'codex_function_call', null, ts, 'assistant', trunc(text), payload.model || null, 0, null, null, null);
      ins.tc.run(dbCallId, uuid, sid, payload.name || 'function_call', truncJson(input), filePath(payload.name, input));
      toolIds.set(callId, dbCallId);
      sm.n++;
      return;
    }
    if (payload.type === 'function_call_output') {
      const callId = payload.call_id || payload.id || `line-${lineNum}`;
      const dbCallId = toolIds.get(callId) || `codex:${sid}:${callId}`;
      const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
      ins.msg.run(uuid, sid, 'codex_function_call_output', null, ts, 'tool', trunc(output), null, 0, null, null, null);
      ins.tr.run(dbCallId, uuid, sid, trunc(output), null);
      sm.n++;
    }
  });

  ins.ses.run(
    fi.sessionId,
    sm.title,
    sm.project || 'codex',
    sm.project_path || null,
    sm.started_at,
    sm.ended_at,
    sm.git_branch,
    sm.version,
    sm.n,
    fi.path,
    'codex',
  );
  ins.idx.run(fi.path, mt, lineNum);
}

function parseCodexArguments(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function indexSubagentMeta(db, fi) {
  if (!fi.isSubagent) return;
  const mp = fi.path.replace('.jsonl', '.meta.json');
  if (!fs.existsSync(mp)) return;
  try {
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const tok = db.prepare('SELECT COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) as t FROM messages WHERE agent_id=?').get(fi.agentId);
    const ts = db.prepare('SELECT MIN(timestamp) as t0, MAX(timestamp) as t1 FROM messages WHERE agent_id=?').get(fi.agentId);
    const dur = ts?.t0 && ts?.t1 ? new Date(ts.t1).getTime() - new Date(ts.t0).getTime() : null;
    if (fi.workflowRunId) {
      db.prepare('INSERT OR REPLACE INTO workflow_agents VALUES(?,?,?,?,?)').run(fi.agentId, fi.workflowRunId, fi.sessionId, meta.agentType||null, meta.description||null);
    } else {
      db.prepare('INSERT OR REPLACE INTO subagents VALUES(?,?,?,?,?,?,?)').run(fi.agentId, fi.sessionId, meta.toolUseId||null, meta.agentType||null, meta.description||null, dur, tok?.t||0);
    }
  } catch (e) { process.stderr.write(`Warning: failed to read subagent meta ${mp}: ${e.message}\n`); }
}

function indexWorkflows(db) {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  let projects;
  try { projects = fs.readdirSync(PROJECTS_DIR); } catch { return; }
  for (const proj of projects) {
    const pp = path.join(PROJECTS_DIR, proj);
    if (!isDir(pp)) continue;
    let entries;
    try { entries = fs.readdirSync(pp); } catch { continue; }
    for (const sd of entries) {
      const wd = path.join(pp, sd, 'workflows');
      if (!isDir(wd)) continue;
      let wfFiles;
      try { wfFiles = fs.readdirSync(wd); } catch { continue; }
      for (const f of wfFiles) {
        if (!f.endsWith('.json')) continue;
        try {
          const wf = JSON.parse(fs.readFileSync(path.join(wd, f), 'utf8'));
          if (!wf.runId) continue;
          const ac = db.prepare('SELECT COUNT(*) as c FROM workflow_agents WHERE run_id=?').get(wf.runId);
          db.prepare('INSERT OR REPLACE INTO workflows VALUES(?,?,?,?,?,?,?)').run(
            wf.runId, sd, wf.taskId||null, wf.script||null,
            wf.result ? JSON.stringify(wf.result) : null, wf.timestamp||null, ac?.c||0);
        } catch (e) { process.stderr.write(`Warning: failed to index workflow ${f}: ${e.message}\n`); }
      }
    }
  }
}

function indexHistory(db) {
  if (!fs.existsSync(HISTORY_PATH)) return;
  readLines(HISTORY_PATH, (line) => {
    try {
      const o = JSON.parse(line);
      if (o.sessionId && o.title) db.prepare('UPDATE sessions SET title=? WHERE id=? AND title IS NULL').run(o.title, o.sessionId);
    } catch (e) { process.stderr.write(`Warning: malformed history line: ${e.message}\n`); }
  });
}

function buildIndex() {
  const db = openDb();
  const files = discoverJsonlFiles();
  for (const f of files) {
    db.exec('BEGIN');
    try {
      indexJsonl(db, f);
      indexSubagentMeta(db, f);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      process.stderr.write(`Warning: failed to index ${f.path}: ${e.message}\n`);
    }
  }
  db.exec('BEGIN');
  try {
    indexWorkflows(db);
    indexHistory(db);
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    process.stderr.write(`Warning: failed to finalize index: ${e.message}\n`);
  }
  db.close();
}

export { buildIndex };
