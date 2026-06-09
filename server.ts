#!/usr/bin/env bun
/**
 * Claude Terminal Control — painel local pra ver/finalizar o que o Claude Code
 * (VSCode) deixou rodando em background. Serve o HTML + uma API que lê
 * ps/ss/docker e mata processos. Tudo em 127.0.0.1 — nada exposto pra fora.
 *
 * Rodar:  bun server.ts   (ou ./start.sh)   →   http://localhost:7799
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = 7799;
const SNAPSHOT_MARK = '.claude/shell-snapshots';
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CODEX_DIR = join(homedir(), '.codex', 'sessions');
const ARCHIVE_FILE = join(homedir(), '.claude', '.terminal-control-archived.json');

const sh = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e: any) {
    return e?.stdout?.toString?.() ?? '';
  }
};

type Proc = { pid: number; ppid: number; etimes: number; args: string };

const readProcs = (): Proc[] =>
  sh('ps -eo pid=,ppid=,etimes=,args=')
    .split('\n')
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: +m[1], ppid: +m[2], etimes: +m[3], args: m[4] } : null;
    })
    .filter((p): p is Proc => p !== null);

const childrenMap = (procs: Proc[]): Map<number, number[]> => {
  const map = new Map<number, number[]>();
  for (const p of procs) {
    if (!map.has(p.ppid)) map.set(p.ppid, []);
    map.get(p.ppid)!.push(p.pid);
  }
  return map;
};

const subtree = (pid: number, kids: Map<number, number[]>): number[] => {
  const out: number[] = [];
  const stack = [...(kids.get(pid) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    out.push(c);
    stack.push(...(kids.get(c) ?? []));
  }
  return out;
};

// pid -> [portas em LISTEN]
const listenPorts = (): Map<number, number[]> => {
  const map = new Map<number, number[]>();
  for (const line of sh('ss -ltnp').split('\n')) {
    if (!line.includes('LISTEN')) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[3] ?? '';
    const port = Number(local.split(':').pop());
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const pid = +m[1];
      if (!Number.isFinite(port)) continue;
      if (!map.has(pid)) map.set(pid, []);
      if (!map.get(pid)!.includes(port)) map.get(pid)!.push(port);
    }
  }
  return map;
};

const findPort = (pid: number, kids: Map<number, number[]>, ports: Map<number, number[]>): number | null => {
  for (const id of [pid, ...subtree(pid, kids)]) {
    const found = ports.get(id);
    if (found?.length) return found[0];
  }
  return null;
};

const cleanCmd = (args: string): string => {
  const m = args.match(/eval '(.+?)' < \/dev\/null/s) ?? args.match(/eval '(.+)'/s);
  let cmd = m ? m[1] : args;
  cmd = cmd.replace(/'"'"'/g, "'"); // desfaz o escape de aspas do wrapper
  return cmd.trim();
};

const tasks = () => {
  const procs = readProcs();
  const kids = childrenMap(procs);
  const ports = listenPorts();
  return procs
    .filter((p) => p.args.includes(SNAPSHOT_MARK) && !p.args.includes('claude-terminal-control'))
    .map((p) => ({
      pid: p.pid,
      etimes: p.etimes,
      cmd: cleanCmd(p.args),
      port: findPort(p.pid, kids, ports),
    }))
    .sort((a, b) => b.etimes - a.etimes);
};

const containers = () =>
  sh("docker ps --format '{{.Names}}|{{.Ports}}|{{.Status}}'")
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, ports, status] = l.split('|');
      return { name, ports, status };
    });

const killTree = (pid: number): { ok: boolean; killed: number[] } => {
  const procs = readProcs();
  const kids = childrenMap(procs);
  const all = [...subtree(pid, kids), pid]; // filhos primeiro, depois o pai
  for (const id of all) {
    try {
      process.kill(id, 'SIGTERM');
    } catch {
      /* já morreu */
    }
  }
  return { ok: true, killed: all };
};

// ─── Sessões do Claude Code ──────────────────────────────────────────────
// Cada sessão é um .jsonl no nível raiz de ~/.claude/projects/<pasta>/.
// Os .jsonl aninhados em <uuid>/subagents/ são subagentes — ficam de fora,
// pois só varremos o primeiro nível de cada pasta de projeto.
type Source = 'claude' | 'codex';
type Session = { id: string; title: string; folder: string; mtime: number; archived: boolean; source: Source };

// chave de arquivamento (id pode coincidir entre ferramentas → prefixamos a fonte)
const archKey = (source: Source, id: string): string => `${source}:${id}`;

// IDs arquivados pelo usuário (só pra organizar a visão — não toca nos .jsonl)
const readArchived = (): Set<string> => {
  try {
    const arr = JSON.parse(readFileSync(ARCHIVE_FILE, 'utf8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set(); // arquivo ainda não existe
  }
};
const writeArchived = (set: Set<string>): void => {
  try {
    writeFileSync(ARCHIVE_FILE, JSON.stringify([...set], null, 2));
  } catch {
    /* sem permissão de escrita — ignora */
  }
};

// nome de pasta -> caminho (fallback; o cwd lido do .jsonl é a fonte real)
const decodeDir = (d: string): string => '/' + d.replace(/^-/, '').replace(/-/g, '/');

// desfaz o escape JSON do valor capturado pelo grep
const unescapeJson = (s: string): string => {
  const clean = s.replace(/\\+$/, ''); // tira barra solta de um corte do grep
  try {
    return JSON.parse(`"${clean}"`);
  } catch {
    return clean.replace(/\\n/g, ' ').replace(/\\"/g, '"');
  }
};

// ─── Claude Code: ~/.claude/projects/<pasta>/<uuid>.jsonl ────────────────
const claudeSessions = (archived: Set<string>): Session[] => {
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }

  const files: { path: string; id: string; dir: string; mtime: number }[] = [];
  for (const d of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(join(PROJECTS_DIR, d));
    } catch {
      continue; // não é pasta ou sem permissão
    }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const path = join(PROJECTS_DIR, d, e);
      try {
        const st = statSync(path);
        if (st.isFile()) files.push({ path, id: e.slice(0, -6), dir: d, mtime: st.mtimeMs });
      } catch {
        /* sumiu no meio do caminho */
      }
    }
  }
  if (!files.length) return [];

  // grep em massa: rápido mesmo em ~150MB e sem carregar tudo na heap.
  const flist = files.map((f) => `'${f.path.replace(/'/g, `'\\''`)}'`).join(' ');
  const collect = (out: string, mode: 'first' | 'last'): Map<string, string> => {
    const map = new Map<string, string>();
    for (const line of out.split('\n')) {
      const m = line.match(/^(.+?):"(?:cwd|aiTitle|text)":"([^"]*)"$/);
      if (!m) continue;
      if (mode === 'first' && map.has(m[1])) continue; // mantém o 1º
      map.set(m[1], m[2]); // 'last' sobrescreve até o último
    }
    return map;
  };

  const cwds = collect(sh(`grep -m1 -aoH '"cwd":"[^"]*"' ${flist}`), 'first');
  const titles = collect(sh(`grep -aoH '"aiTitle":"[^"]*"' ${flist}`), 'last');
  const prompts = collect(sh(`grep -m1 -aoH '"text":"[^"]*"' ${flist}`), 'first');

  return files.map((f): Session => {
    const folder = cwds.get(f.path) ?? decodeDir(f.dir);
    const ai = titles.get(f.path);
    const first = prompts.get(f.path);
    const title = ai
      ? unescapeJson(ai)
      : first
        ? unescapeJson(first).slice(0, 90).trim() || '(sem título)'
        : '(sem título)';
    return { id: f.id, title, folder, mtime: f.mtime, archived: archived.has(archKey('claude', f.id)), source: 'claude' };
  });
};

// ─── Codex: ~/.codex/sessions/AAAA/MM/DD/rollout-<ts>-<uuid>.jsonl ────────
// Sem aiTitle: o título vem do 1º texto do usuário que não seja um bloco de
// contexto/instrução (<environment_context>, etc.). O cwd está no session_meta.
const codexMeta = (head: string): { cwd?: string; title?: string } => {
  let cwd: string | undefined;
  let title: string | undefined;
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // última linha pode estar cortada pelo slice
    }
    const p = o?.payload;
    if (!p) continue;
    if (!cwd && o.type === 'session_meta' && typeof p.cwd === 'string') cwd = p.cwd;
    if (!title && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
      const c = p.content.find(
        (x: any) => x?.type === 'input_text' && typeof x.text === 'string' && !x.text.startsWith('<'),
      );
      if (c) title = c.text.replace(/\s+/g, ' ').trim().slice(0, 90);
    }
    if (cwd && title) break;
  }
  return { cwd, title };
};

const codexSessions = async (archived: Set<string>): Promise<Session[]> => {
  let rel: string[];
  try {
    rel = readdirSync(CODEX_DIR, { recursive: true }) as string[];
  } catch {
    return []; // Codex não instalado
  }
  const paths = rel.filter((f) => /(^|\/)rollout-.*\.jsonl$/.test(f)).map((f) => join(CODEX_DIR, f));

  const out = await Promise.all(
    paths.map(async (path): Promise<Session | null> => {
      let mtime: number;
      try {
        const st = statSync(path);
        if (!st.isFile()) return null;
        mtime = st.mtimeMs;
      } catch {
        return null;
      }
      const m = path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
      const id = m ? m[1] : path.split('/').pop()!.replace(/\.jsonl$/, '');
      let head = '';
      try {
        head = await Bun.file(path).slice(0, 524288).text(); // só o começo: o 1º prompt aparece em ~6–8KB
      } catch {
        /* ignora */
      }
      const { cwd, title } = codexMeta(head);
      return { id, title: title || '(sem título)', folder: cwd ?? '—', mtime, archived: archived.has(archKey('codex', id)), source: 'codex' };
    }),
  );
  return out.filter((s): s is Session => s !== null);
};

const sessions = async (want: Record<Source, boolean>): Promise<Session[]> => {
  const archived = readArchived();
  const all: Session[] = [];
  if (want.claude) all.push(...claudeSessions(archived));
  if (want.codex) all.push(...(await codexSessions(archived)));
  return all.sort((a, b) => b.mtime - a.mtime);
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/api/state') {
      return json({ tasks: tasks(), containers: containers(), now: Date.now() });
    }

    if (url.pathname === '/api/sessions') {
      const src = url.searchParams.get('sources') ?? 'claude'; // default: só Claude
      const want: Record<Source, boolean> = { claude: src.includes('claude'), codex: src.includes('codex') };
      return json({ sessions: await sessions(want), now: Date.now() });
    }

    if (url.pathname === '/api/open' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { folder?: string };
      if (!body.folder) return json({ ok: false, error: 'folder requerido' }, 400);
      // abre a pasta no VS Code (nova janela; reusa se já estiver aberta). Em bg pra não travar.
      sh(`code ${JSON.stringify(body.folder)} >/dev/null 2>&1 &`);
      return json({ ok: true });
    }

    if (url.pathname === '/api/archive' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { id?: string; source?: Source; archived?: boolean };
      if (!body.id) return json({ ok: false, error: 'id requerido' }, 400);
      const set = readArchived();
      const key = archKey(body.source === 'codex' ? 'codex' : 'claude', body.id);
      if (body.archived) set.add(key);
      else set.delete(key);
      writeArchived(set);
      return json({ ok: true });
    }

    if (url.pathname === '/api/kill' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { pid?: number; port?: number; container?: string };
      if (body.container) {
        sh(`docker stop ${JSON.stringify(body.container)}`);
        return json({ ok: true });
      }
      if (body.port) {
        sh(`fuser -k ${body.port}/tcp`);
        return json({ ok: true });
      }
      if (body.pid) return json(killTree(body.pid));
      return json({ ok: false, error: 'pid|port|container requerido' }, 400);
    }

    return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});

console.log(`\n  Claude Terminal Control → http://localhost:${PORT}\n  (Ctrl+C pra parar este painel — não afeta os processos do Claude)\n`);

const HTML = /* html */ `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Claude Terminal Control</title>
<style>
  :root { --bg:#0e0b1e; --panel:#171430; --panel2:#1f1b3d; --line:#2b2750; --ink:#e9e7f5; --muted:#9b96c4; --purple:#8b5cf6; --purple2:#a78bfa; --red:#f0506a; --green:#34d399; --amber:#fbbf24; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif; background:
    radial-gradient(1000px 500px at 100% -10%, rgba(139,92,246,.12), transparent 60%), var(--bg); color:var(--ink); min-height:100vh; }
  .wrap { max-width:960px; margin:0 auto; padding:28px 20px 60px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:22px; }
  h1 { font-size:19px; margin:0; display:flex; align-items:center; gap:10px; letter-spacing:.2px; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--green); box-shadow:0 0 0 4px rgba(52,211,153,.18); animation:pulse 2s infinite; }
  @keyframes pulse { 50% { opacity:.45; } }
  .sub { color:var(--muted); font-size:12px; }
  .tabs { display:flex; gap:4px; margin-bottom:22px; border-bottom:1px solid var(--line); }
  .tab { background:transparent; border:0; border-bottom:2px solid transparent; color:var(--muted); font-weight:600; font-size:13.5px; padding:10px 14px; margin-bottom:-1px; cursor:pointer; transition:.15s; display:flex; align-items:center; gap:8px; }
  .tab:hover { color:var(--ink); }
  .tab.active { color:var(--purple2); border-bottom-color:var(--purple2); }
  .tab .badge { font-size:11px; font-weight:700; padding:1px 8px; border-radius:999px; background:var(--panel2); border:1px solid var(--line); color:var(--muted); }
  .tab.active .badge { color:var(--purple2); border-color:rgba(167,139,250,.4); background:rgba(139,92,246,.12); }
  .panel { display:none; }
  .panel.active { display:block; animation:fade .2s ease; }
  @keyframes fade { from { opacity:0; transform:translateY(4px); } }
  .section-title { font-size:11px; text-transform:uppercase; letter-spacing:.16em; color:var(--muted); margin:26px 0 10px; }
  .section-title:first-child { margin-top:6px; }
  .card { background:linear-gradient(180deg,var(--panel2),var(--panel)); border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:12px; display:flex; align-items:center; gap:16px; overflow:hidden; }
  .card .main { min-width:0; flex:1; }
  .cmd { font-family:ui-monospace,"JetBrains Mono",monospace; font-size:13.5px; color:var(--ink); word-break:break-all; display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; max-height:3.2em; cursor:help; }
  .meta { margin-top:7px; display:flex; flex-wrap:wrap; gap:7px; align-items:center; }
  .chip { font-size:11px; font-weight:600; padding:3px 9px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
  .chip.port { color:var(--purple2); border-color:rgba(167,139,250,.4); background:rgba(139,92,246,.12); }
  .chip.up { color:var(--green); border-color:rgba(52,211,153,.35); }
  .chip.pid { color:var(--muted); }
  .btn { border:0; cursor:pointer; font-weight:600; font-size:13px; padding:9px 16px; border-radius:10px; transition:.15s; white-space:nowrap; }
  .btn-kill { background:rgba(240,80,106,.14); color:var(--red); border:1px solid rgba(240,80,106,.4); }
  .btn-kill:hover { background:var(--red); color:#fff; }
  .btn-ghost { background:transparent; color:var(--purple2); border:1px solid var(--line); padding:5px 12px; font-size:12px; }
  .btn-ghost:hover { background:var(--panel); }
  .btn-ghost:disabled { opacity:.5; cursor:default; }
  .btn-ghost.on { background:var(--panel); color:var(--ink); border-color:var(--muted); }
  .btn-copy { background:rgba(139,92,246,.14); color:var(--purple2); border:1px solid rgba(139,92,246,.4); }
  .btn-copy:hover { background:var(--purple); color:#fff; }
  .btn-arch { background:rgba(155,150,196,.10); color:var(--muted); border:1px solid var(--line); }
  .btn-arch:hover { background:var(--panel); color:var(--ink); border-color:var(--muted); }
  .btn-icon { padding:8px; line-height:0; display:inline-flex; align-items:center; }
  .btn-vscode { background:rgba(36,156,255,.12); color:#3aa6ff; border:1px solid rgba(36,156,255,.4); }
  .btn-vscode:hover { background:#249cff; color:#fff; }
  .btn-vscode svg { width:15px; height:15px; fill:currentColor; }
  .actions { display:flex; gap:8px; flex-shrink:0; }
  .card.dim { opacity:.6; }
  .card.dim:hover { opacity:1; }
  .srcbar { display:flex; gap:8px; margin-bottom:12px; }
  .src { display:inline-flex; align-items:center; gap:7px; padding:7px 14px; border-radius:999px; border:1px solid var(--line); background:var(--panel); color:var(--muted); font-weight:600; font-size:12.5px; cursor:pointer; transition:.15s; }
  .src .ico { font-size:13px; }
  .src:hover { color:var(--ink); }
  #src-claude.on { background:rgba(139,92,246,.20); border-color:var(--purple); color:var(--purple2); }
  #src-codex.on { background:rgba(52,211,153,.16); border-color:var(--green); color:var(--green); }
  .chip.src-claude { color:var(--purple2); border-color:rgba(167,139,250,.4); background:rgba(139,92,246,.12); }
  .chip.src-codex { color:var(--green); border-color:rgba(52,211,153,.35); background:rgba(52,211,153,.10); }
  .row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .title { font-size:14.5px; font-weight:600; color:var(--ink); word-break:break-word; }
  .chip.folder { color:var(--purple2); border-color:rgba(167,139,250,.35); background:rgba(139,92,246,.10); font-family:ui-monospace,"JetBrains Mono",monospace; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .filter { width:100%; margin-bottom:12px; padding:9px 12px; border-radius:10px; border:1px solid var(--line); background:var(--panel); color:var(--ink); font-size:13px; outline:none; }
  .filter:focus { border-color:rgba(167,139,250,.5); }
  .filter::placeholder { color:var(--muted); }
  .empty { color:var(--muted); text-align:center; padding:40px 0; border:1px dashed var(--line); border-radius:14px; }
  a.open { color:var(--purple2); text-decoration:none; font-size:12px; }
  .foot { margin-top:30px; color:var(--muted); font-size:11.5px; line-height:1.6; }
  code { background:var(--panel); padding:1px 6px; border-radius:5px; color:var(--purple2); }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1><span class="dot"></span> Claude Terminal Control</h1>
      <div class="sub" id="status">atualizando…</div>
    </header>

    <div class="tabs">
      <button class="tab active" id="tab-watch" onclick="switchTab('watch')">Acompanhar <span class="badge" id="badge-watch">0</span></button>
      <button class="tab" id="tab-sessions" onclick="switchTab('sessions')">Sessões <span class="badge" id="badge-sessions">–</span></button>
    </div>

    <section class="panel active" id="panel-watch">
      <div class="section-title">Processos do Claude (background)</div>
      <div id="tasks"></div>

      <div class="section-title">Containers Docker</div>
      <div id="containers"></div>
    </section>

    <section class="panel" id="panel-sessions">
      <div class="section-title row">
        <span>Sessões <span class="sub" id="sess-count"></span></span>
        <span class="actions">
          <button class="btn btn-ghost" id="sess-archived-toggle" onclick="toggleArchived()">Arquivadas (0)</button>
          <button class="btn btn-ghost" id="sess-reload" onclick="loadSessions()">↻ Atualizar</button>
        </span>
      </div>
      <div class="srcbar">
        <button class="src on" id="src-claude" onclick="toggleSource('claude')"><span class="ico">✶</span> Claude</button>
        <button class="src" id="src-codex" onclick="toggleSource('codex')"><span class="ico">◆</span> Codex</button>
      </div>
      <input class="filter" id="sess-filter" placeholder="filtrar por título ou pasta…" oninput="renderSessions()" />
      <div id="sessions"></div>
    </section>

    <div class="foot">
      Processos e containers atualizam sozinhos a cada 2,5s. "Finalizar" mata o processo e seus filhos (SIGTERM).
      As <b>sessões</b> são lidas sob demanda do <b>Claude</b> (<code>~/.claude/projects</code>) e do <b>Codex</b>
      (<code>~/.codex/sessions</code>) — ligue as fontes e clique em <b>↻ Atualizar</b>. O ícone do <b>VS Code</b>
      abre a pasta da sessão; "Retomar" copia o <code>claude --resume</code> / <code>codex resume</code>.
      "Arquivar" só organiza a visão (não apaga nada).
      Painel local em <code>localhost:7799</code> — só lê/mata na sua máquina.
    </div>
  </div>

<script>
const fmtUp = (s) => { const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  return h ? \`\${h}h \${m}m\` : m ? \`\${m}m \${sec}s\` : \`\${sec}s\`; };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function kill(payload, label) {
  if (!confirm('Finalizar ' + label + ' ?')) return;
  await fetch('/api/kill', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
  setTimeout(refresh, 400);
}

async function refresh() {
  let data;
  try { data = await (await fetch('/api/state')).json(); }
  catch { document.getElementById('status').textContent = 'painel offline'; return; }

  document.getElementById('status').textContent =
    data.tasks.length + ' processo(s) · ' + new Date(data.now).toLocaleTimeString('pt-BR');
  document.getElementById('badge-watch').textContent = data.tasks.length + data.containers.length;

  const t = document.getElementById('tasks');
  t.innerHTML = data.tasks.length ? data.tasks.map(x => \`
    <div class="card">
      <div class="main">
        <div class="cmd" title="\${esc(x.cmd)}">\${esc(x.cmd)}</div>
        <div class="meta">
          <span class="chip pid">PID \${x.pid}</span>
          <span class="chip up">▲ \${fmtUp(x.etimes)}</span>
          \${x.port ? \`<span class="chip port">:\${x.port}</span> <a class="open" href="http://localhost:\${x.port}" target="_blank">abrir ↗</a>\` : ''}
        </div>
      </div>
      <button class="btn btn-kill" onclick='kill(\${JSON.stringify({pid:x.pid})}, \${JSON.stringify("PID "+x.pid+" — "+x.cmd)})'>Finalizar</button>
    </div>\`).join('') : '<div class="empty">Nada rodando pelo Claude agora 🎉</div>';

  const c = document.getElementById('containers');
  c.innerHTML = data.containers.length ? data.containers.map(x => \`
    <div class="card">
      <div class="main">
        <div class="cmd">🐳 \${esc(x.name)}</div>
        <div class="meta"><span class="chip">\${esc(x.ports||'')}</span><span class="chip up">\${esc(x.status)}</span></div>
      </div>
      <button class="btn btn-kill" onclick='kill(\${JSON.stringify({container:x.name})}, \${JSON.stringify("container "+x.name)})'>Parar</button>
    </div>\`).join('') : '<div class="empty">Nenhum container Docker ativo.</div>';
}
// ── Abas ──
let sessLoaded = false;
function switchTab(name) {
  for (const t of ['watch', 'sessions']) {
    document.getElementById('tab-' + t).classList.toggle('active', t === name);
    document.getElementById('panel-' + t).classList.toggle('active', t === name);
  }
  if (name === 'sessions' && !sessLoaded) loadSessions(); // só escaneia ao abrir a 1ª vez
}

// ── Sessões (carregadas sob demanda, não no loop de 2,5s) ──
let SESS = [];
let showArchived = false;
let sources = { claude: true, codex: false }; // default: só Claude
const fmtAgo = (ms) => { const s = Math.floor((Date.now() - ms) / 1000);
  const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60);
  return d ? d+'d' : h ? h+'h' : m ? m+'min' : 'agora'; };

function toggleSource(name) {
  sources[name] = !sources[name];
  document.getElementById('src-' + name).classList.toggle('on', sources[name]);
  loadSessions(); // reescaneia com as fontes ativas (Codex é lido só quando ligado)
}

async function loadSessions() {
  sessLoaded = true; // evita recarregar a cada troca de aba (o botão ↻ força sempre)
  const box = document.getElementById('sessions'), btn = document.getElementById('sess-reload');
  const active = Object.keys(sources).filter(k => sources[k]);
  if (!active.length) { SESS = []; renderSessions(); return; }
  btn.disabled = true;
  document.getElementById('sess-count').textContent = '· carregando…';
  if (!SESS.length) box.innerHTML = '<div class="empty">Lendo sessões…</div>';
  try { SESS = (await (await fetch('/api/sessions?sources=' + active.join(','))).json()).sessions || []; }
  catch { box.innerHTML = '<div class="empty">Falha ao ler as sessões.</div>'; btn.disabled = false; sessLoaded = false; return; }
  btn.disabled = false;
  renderSessions();
}

function toggleArchived() {
  showArchived = !showArchived;
  document.getElementById('sess-filter').value = ''; // limpa o filtro ao trocar de visão
  renderSessions();
}

async function archive(id, source, flag, btn) {
  btn.disabled = true;
  try {
    await fetch('/api/archive', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id, source, archived: flag }) });
  } catch { btn.disabled = false; return; }
  const s = SESS.find(x => x.id === id && x.source === source);
  if (s) s.archived = flag;
  renderSessions(); // some da visão atual
}

function renderSessions() {
  const q = (document.getElementById('sess-filter').value || '').toLowerCase();
  const archivedCount = SESS.filter(s => s.archived).length;
  const activeCount = SESS.length - archivedCount;
  const base = SESS.filter(s => showArchived ? s.archived : !s.archived);
  const list = base.filter(s => !q || s.title.toLowerCase().includes(q) || s.folder.toLowerCase().includes(q));

  document.getElementById('sess-count').textContent =
    base.length ? '· ' + list.length + '/' + base.length + (showArchived ? ' arquivadas' : '') : '';
  document.getElementById('badge-sessions').textContent = activeCount;
  const tgl = document.getElementById('sess-archived-toggle');
  tgl.textContent = showArchived ? '← Ver ativas' : 'Arquivadas (' + archivedCount + ')';
  tgl.classList.toggle('on', showArchived);

  const noSource = !sources.claude && !sources.codex;
  const emptyMsg = noSource ? 'Selecione Claude e/ou Codex acima.'
    : showArchived ? 'Nenhuma sessão arquivada.'
    : q ? 'Nenhuma sessão bate com o filtro.'
    : SESS.length ? 'Nenhuma sessão ativa — veja as arquivadas.' : 'Nenhuma sessão encontrada.';

  document.getElementById('sessions').innerHTML = list.length ? list.map(s => \`
    <div class="card\${s.archived ? ' dim' : ''}">
      <div class="main">
        <div class="title">\${esc(s.title)}</div>
        <div class="meta">
          <span class="chip src-\${s.source}">\${s.source === 'codex' ? '◆ Codex' : '✶ Claude'}</span>
          <span class="chip folder" title="\${esc(s.folder)}">📁 \${esc(s.folder)}</span>
          <span class="chip up">▲ \${fmtAgo(s.mtime)}</span>
          <span class="chip pid">\${esc(s.id.slice(0,8))}</span>
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-vscode btn-icon" title="Abrir a pasta no VS Code" onclick='openIn(\${JSON.stringify(s.folder)}, this)'><svg viewBox="0 0 24 24"><path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg></button>
        <button class="btn btn-copy" onclick='resume(\${JSON.stringify(s.folder)}, \${JSON.stringify(s.id)}, \${JSON.stringify(s.source)}, this)'>Retomar ⧉</button>
        <button class="btn btn-arch" onclick='archive(\${JSON.stringify(s.id)}, \${JSON.stringify(s.source)}, \${!s.archived}, this)'>\${s.archived ? 'Desarquivar' : 'Arquivar'}</button>
      </div>
    </div>\`).join('') : \`<div class="empty">\${emptyMsg}</div>\`;
}

async function openIn(folder, btn) {
  btn.disabled = true;
  try { await fetch('/api/open', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ folder }) }); }
  catch {}
  setTimeout(() => { btn.disabled = false; }, 600);
}

function resume(folder, id, source, btn) {
  const cmd = 'cd ' + JSON.stringify(folder) + (source === 'codex' ? ' && codex resume ' : ' && claude --resume ') + id;
  navigator.clipboard.writeText(cmd).then(() => {
    const old = btn.textContent; btn.textContent = 'copiado ✓';
    setTimeout(() => { btn.textContent = old; }, 1200);
  });
}

refresh();
setInterval(refresh, 2500);
</script>
</body>
</html>`;
