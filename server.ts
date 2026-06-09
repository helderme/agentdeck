#!/usr/bin/env bun
/**
 * Claude Control — painel local pra ver/finalizar o que o Claude Code
 * (VSCode) deixou rodando em background e listar as sessões do Claude/Codex.
 * Serve o HTML + uma API que lê ps/ss/docker e ~/.claude e ~/.codex.
 * Tudo em 127.0.0.1 — nada exposto pra fora.
 *
 * Rodar:  bun server.ts   (ou ./start.sh)   →   http://localhost:7799
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

const PORT = 7799;
const SNAPSHOT_MARK = '.claude/shell-snapshots';
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CODEX_DIR = join(homedir(), '.codex', 'sessions');
const ARCHIVE_FILE = join(homedir(), '.claude', '.terminal-control-archived.json');
const NAMES_FILE = join(homedir(), '.claude', '.terminal-control-names.json');
const FLAGS_FILE = join(homedir(), '.claude', '.terminal-control-flags.json');

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
type Session = {
  id: string;
  title: string; // título exibido (nome customizado, se houver, senão o detectado)
  autoTitle: string; // título detectado automaticamente (pra poder reverter)
  renamed: boolean;
  folder: string;
  mtime: number;
  archived: boolean;
  fav: boolean;
  pinned: boolean;
  source: Source;
};

// favoritas (★) e fixadas no topo (📌), guardadas juntas
type Flags = { fav: Set<string>; pin: Set<string> };
const readFlags = (): Flags => {
  try {
    const o = JSON.parse(readFileSync(FLAGS_FILE, 'utf8'));
    return { fav: new Set(Array.isArray(o?.favorites) ? o.favorites : []), pin: new Set(Array.isArray(o?.pinned) ? o.pinned : []) };
  } catch {
    return { fav: new Set(), pin: new Set() };
  }
};
const writeFlags = (f: Flags): void => {
  try {
    writeFileSync(FLAGS_FILE, JSON.stringify({ favorites: [...f.fav], pinned: [...f.pin] }, null, 2));
  } catch {
    /* sem permissão — ignora */
  }
};

// chave (id pode coincidir entre ferramentas → prefixamos a fonte)
const archKey = (source: Source, id: string): string => `${source}:${id}`;

// nomes customizados pelo usuário: { "fonte:id": "título" }
const readNames = (): Record<string, string> => {
  try {
    const o = JSON.parse(readFileSync(NAMES_FILE, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
};
const writeNames = (names: Record<string, string>): void => {
  try {
    writeFileSync(NAMES_FILE, JSON.stringify(names, null, 2));
  } catch {
    /* sem permissão de escrita — ignora */
  }
};

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
const claudeSessions = (archived: Set<string>, names: Record<string, string>, flags: Flags): Session[] => {
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
    const autoTitle = ai
      ? unescapeJson(ai)
      : first
        ? unescapeJson(first).slice(0, 90).trim() || '(sem título)'
        : '(sem título)';
    const key = archKey('claude', f.id);
    const custom = names[key];
    return { id: f.id, title: custom ?? autoTitle, autoTitle, renamed: custom != null, folder, mtime: f.mtime, archived: archived.has(key), fav: flags.fav.has(key), pinned: flags.pin.has(key), source: 'claude' };
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

const codexSessions = async (archived: Set<string>, names: Record<string, string>, flags: Flags): Promise<Session[]> => {
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
      const autoTitle = title || '(sem título)';
      const key = archKey('codex', id);
      const custom = names[key];
      return { id, title: custom ?? autoTitle, autoTitle, renamed: custom != null, folder: cwd ?? '—', mtime, archived: archived.has(key), fav: flags.fav.has(key), pinned: flags.pin.has(key), source: 'codex' };
    }),
  );
  return out.filter((s): s is Session => s !== null);
};

const sessions = async (want: Record<Source, boolean>): Promise<Session[]> => {
  const archived = readArchived();
  const names = readNames();
  const flags = readFlags();
  const all: Session[] = [];
  if (want.claude) all.push(...claudeSessions(archived, names, flags));
  if (want.codex) all.push(...(await codexSessions(archived, names, flags)));
  return all.sort((a, b) => b.mtime - a.mtime);
};

// ─── Importar / Exportar sessões ─────────────────────────────────────────
// Codifica um caminho no nome de pasta que o Claude usa em ~/.claude/projects
// (cada char fora de [A-Za-z0-9] vira '-'). Ex.: /home/h/efex -> -home-h-efex
const encodeProject = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-');
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const occurrences = (text: string, sub: string): number => (sub ? text.split(sub).length - 1 : 0);

// Possíveis segredos no conteúdo (pra avisar antes de exportar/compartilhar).
const SECRET_PATTERNS: [string, RegExp][] = [
  ['Chave Anthropic', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['Chave OpenAI', /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['Token GitHub', /gh[pousr]_[A-Za-z0-9]{20,}/g],
  ['AWS Access Key', /AKIA[0-9A-Z]{16}/g],
  ['Chave Google', /AIza[0-9A-Za-z_-]{30,}/g],
  ['Token Slack', /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['Chave privada', /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g],
];
const mask = (s: string): string => (s.length <= 10 ? s.slice(0, 3) + '…' : s.slice(0, 6) + '…' + s.slice(-3));
const scanSecrets = (text: string): { kind: string; count: number; sample: string }[] => {
  const out: { kind: string; count: number; sample: string }[] = [];
  for (const [kind, re] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m?.length) out.push({ kind, count: m.length, sample: mask(m[0]) });
  }
  return out;
};

// Apontamentos que o remap automático (home/cwd) não cobre: homes de outros
// usuários, drives externos, caminhos Windows. São os que pedem decisão manual.
const foreignPointers = (text: string, oldUser: string): { path: string; count: number }[] => {
  const found = new Map<string, number>();
  const scan = (re: RegExp, keep?: (m: string) => boolean) => {
    for (const m of text.matchAll(re)) {
      const v = m[0];
      if (keep && !keep(v)) continue;
      found.set(v, (found.get(v) ?? 0) + 1);
    }
  };
  scan(/\/home\/[A-Za-z0-9._-]+/g, (v) => v !== '/home/' + oldUser);
  scan(/\/Users\/[A-Za-z0-9._-]+/g, (v) => v !== '/Users/' + oldUser);
  scan(/\/(?:mnt|media|srv)\/[A-Za-z0-9._-]+/g);
  scan(/\/run\/media\/[A-Za-z0-9._-]+/g);
  scan(/[A-Za-z]:\\[^\s"'<>):;,]+/g);
  return [...found.entries()].slice(0, 60).map(([path, count]) => ({ path, count }));
};

// Localiza o arquivo de uma sessão pelo id.
const locateClaude = (id: string): { path: string; projectDir: string } | null => {
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(PROJECTS_DIR, d, id + '.jsonl');
    try {
      if (statSync(p).isFile()) return { path: p, projectDir: d };
    } catch {
      /* segue */
    }
  }
  return null;
};
const locateCodex = (id: string): { path: string; relPath: string } | null => {
  let rel: string[];
  try {
    rel = readdirSync(CODEX_DIR, { recursive: true }) as string[];
  } catch {
    return null;
  }
  const hit = rel.find((f) => /rollout-.*\.jsonl$/.test(f) && f.includes(id));
  return hit ? { path: join(CODEX_DIR, hit), relPath: hit } : null;
};

// Substitui um caminho só quando ele termina numa fronteira (evita trocar
// /a/efex dentro de /a/efex-backend).
const BOUNDARY = '(?=$|[/"\'\\\\\\s:?<>),;])';
const remapContent = (
  text: string,
  pairs: [string | undefined, string | undefined][],
  manual: Record<string, string>,
): string => {
  let out = text;
  for (const [from, to] of pairs) {
    if (from && to !== undefined && from !== to) out = out.replace(new RegExp(escRe(from) + BOUNDARY, 'g'), to);
  }
  for (const [from, to] of Object.entries(manual)) if (from && to) out = out.split(from).join(to);
  return out;
};

type ExportSession = {
  source: Source;
  id: string;
  title: string;
  cwd: string;
  projectDir?: string;
  relPath?: string;
  version?: string;
  bytes: number;
  content: string;
  secrets: { kind: string; count: number; sample: string }[];
  foreign: { path: string; count: number }[];
};

const buildExport = (items: { source: Source; id: string }[], scan: boolean): ExportSession[] => {
  const me = userInfo().username;
  const out: ExportSession[] = [];
  for (const it of items) {
    const source: Source = it.source === 'codex' ? 'codex' : 'claude';
    let path: string, projectDir: string | undefined, relPath: string | undefined;
    if (source === 'claude') {
      const loc = locateClaude(it.id);
      if (!loc) continue;
      path = loc.path;
      projectDir = loc.projectDir;
    } else {
      const loc = locateCodex(it.id);
      if (!loc) continue;
      path = loc.path;
      relPath = loc.relPath;
    }
    let content = '';
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    let cwd = '', title = '', version: string | undefined;
    if (source === 'claude') {
      cwd = content.match(/"cwd":"([^"]*)"/)?.[1] ?? '';
      const t = [...content.matchAll(/"aiTitle":"([^"]*)"/g)].pop();
      title = t ? unescapeJson(t[1]) : '(sem título)';
      version = content.match(/"version":"([^"]*)"/)?.[1];
    } else {
      const meta = codexMeta(content.slice(0, 524288));
      cwd = meta.cwd ?? '';
      title = meta.title ?? '(sem título)';
    }
    out.push({
      source,
      id: it.id,
      title,
      cwd,
      projectDir,
      relPath,
      version,
      bytes: content.length,
      content,
      secrets: scan ? scanSecrets(content) : [],
      foreign: foreignPointers(content, me),
    });
  }
  return out;
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

    if (url.pathname === '/api/export' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { items?: { source: Source; id: string }[]; scanSecrets?: boolean };
      const items = Array.isArray(body.items) ? body.items : [];
      const sessions = buildExport(items, body.scanSecrets !== false);
      return json({
        format: 'claude-control/sessions',
        version: 1,
        exportedAt: Date.now(),
        machine: { home: homedir(), user: userInfo().username, host: hostname(), platform: platform() },
        sessions,
      });
    }

    if (url.pathname === '/api/import' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        mode?: string;
        bundle?: any;
        decisions?: Record<string, { newCwd?: string; remaps?: Record<string, string>; overwrite?: boolean }>;
      };
      const bundle = body.bundle;
      if (!bundle || bundle.format !== 'claude-control/sessions' || !Array.isArray(bundle.sessions)) {
        return json({ ok: false, error: 'arquivo de importação inválido' }, 400);
      }
      const newHome = homedir();
      const newUser = userInfo().username;
      const oldHome: string = bundle.machine?.home ?? '';
      const oldUser: string = bundle.machine?.user ?? '';
      const underHome = (p: string) => oldHome && (p === oldHome || p.startsWith(oldHome + '/'));
      const suggest = (cwd: string) => (underHome(cwd) ? newHome + cwd.slice(oldHome.length) : cwd);

      if (body.mode === 'apply') {
        const decisions = body.decisions ?? {};
        const results = (bundle.sessions as ExportSession[]).map((s) => {
          const key = s.source + ':' + s.id;
          const d = decisions[key] ?? {};
          const newCwd = (d.newCwd || suggest(s.cwd)).trim() || s.cwd;
          const pairs: [string | undefined, string | undefined][] = [
            [s.cwd, newCwd],
            [oldHome, newHome],
          ];
          if (s.source === 'claude' && s.projectDir) pairs.push([s.projectDir, encodeProject(newCwd)]);
          const content = remapContent(s.content, pairs, d.remaps ?? {});
          const target =
            s.source === 'claude'
              ? join(PROJECTS_DIR, encodeProject(newCwd), s.id + '.jsonl')
              : join(CODEX_DIR, s.relPath ?? `${s.id}.jsonl`);
          if (existsSync(target) && !d.overwrite) {
            return { key, id: s.id, source: s.source, skipped: true, reason: 'já existe nesta máquina', target };
          }
          try {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, content);
          } catch (e: any) {
            return { key, id: s.id, source: s.source, ok: false, error: String(e?.message ?? e) };
          }
          const resume =
            (s.source === 'codex' ? 'codex resume ' : 'claude --resume ') + s.id;
          return { key, id: s.id, source: s.source, ok: true, target, newCwd, resume: `cd ${JSON.stringify(newCwd)} && ${resume}` };
        });
        return json({ ok: true, results });
      }

      // mode = preview (default): nada é escrito
      const plan = (bundle.sessions as ExportSession[]).map((s) => {
        const suggestedCwd = suggest(s.cwd);
        const projectDir = s.source === 'claude' ? encodeProject(suggestedCwd) : null;
        const target =
          s.source === 'claude'
            ? join(PROJECTS_DIR, projectDir!, s.id + '.jsonl')
            : join(CODEX_DIR, s.relPath ?? `${s.id}.jsonl`);
        return {
          key: s.source + ':' + s.id,
          source: s.source,
          id: s.id,
          title: s.title,
          version: s.version,
          oldCwd: s.cwd,
          suggestedCwd,
          cwdHits: occurrences(s.content, s.cwd),
          homeHits: oldHome ? occurrences(s.content, oldHome) : 0,
          foreign: s.foreign ?? [],
          secrets: s.secrets ?? [],
          target,
          collision: existsSync(target),
          bytes: s.bytes,
        };
      });
      return json({ ok: true, oldHome, oldUser, newHome, newUser, host: bundle.machine?.host, exportedAt: bundle.exportedAt, plan });
    }

    if (url.pathname === '/api/flag' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { id?: string; source?: Source; flag?: string; on?: boolean };
      if (!body.id || (body.flag !== 'fav' && body.flag !== 'pin')) return json({ ok: false, error: 'id e flag (fav|pin) requeridos' }, 400);
      const flags = readFlags();
      const set = body.flag === 'fav' ? flags.fav : flags.pin;
      const key = archKey(body.source === 'codex' ? 'codex' : 'claude', body.id);
      if (body.on) set.add(key);
      else set.delete(key);
      writeFlags(flags);
      return json({ ok: true });
    }

    if (url.pathname === '/api/rename' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { id?: string; source?: Source; title?: string };
      if (!body.id) return json({ ok: false, error: 'id requerido' }, 400);
      const names = readNames();
      const key = archKey(body.source === 'codex' ? 'codex' : 'claude', body.id);
      const title = (body.title ?? '').trim();
      if (title) names[key] = title.slice(0, 120);
      else delete names[key]; // título vazio = volta ao automático
      writeNames(names);
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

console.log(`\n  Claude Control → http://localhost:${PORT}\n  (Ctrl+C pra parar este painel — não afeta os processos do Claude)\n`);

const HTML = /* html */ `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Claude Control</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<script>(function(){try{var q=new URLSearchParams(location.search).get('theme');var t=(q==='light'||q==='dark')?q:localStorage.getItem('cc-theme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t;}catch(e){}})();</script>
<style>
  :root {
    /* neutros quentes — sem preto puro, sem tom roxo */
    --bg: oklch(20% 0.006 70); --surface: oklch(24% 0.006 70); --surface-2: oklch(28% 0.008 72);
    --line: oklch(33% 0.009 75); --ink: oklch(95% 0.008 85); --muted: oklch(70% 0.013 75);
    /* acento de marca: clay/terracota (o tom quente do Claude) */
    --clay: oklch(72% 0.115 50); --clay-ink: oklch(25% 0.04 50); --clay-soft: oklch(72% 0.115 50 / .15);
    /* secundário: teal (Codex) */
    --teal: oklch(76% 0.08 185); --teal-soft: oklch(76% 0.08 185 / .14);
    /* semânticos */
    --green: oklch(77% 0.1 160); --red: oklch(66% 0.16 25); --red-soft: oklch(66% 0.16 25 / .15);
    --blue: oklch(72% 0.11 240); --blue-soft: oklch(72% 0.11 240 / .15);
    /* tipografia */
    --display: "Fraunces", Georgia, serif; --body: "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif;
    --mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", monospace;
    /* espaço (7 passos) e raio */
    --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:36px; --s7:56px; --r:12px; --r-sm:8px;
  }
  /* tema claro: off-white quente (não branco puro, não creme), acentos mais escuros pra contraste */
  :root[data-theme="light"] {
    --bg: oklch(97% 0.008 85); --surface: oklch(99.5% 0.003 85); --surface-2: oklch(94% 0.008 80);
    --line: oklch(88% 0.01 80); --ink: oklch(28% 0.02 60); --muted: oklch(51% 0.02 65);
    --clay: oklch(56% 0.14 45); --clay-ink: oklch(99% 0.01 85); --clay-soft: oklch(56% 0.14 45 / .12);
    --teal: oklch(52% 0.09 195); --teal-soft: oklch(52% 0.09 195 / .12);
    --green: oklch(54% 0.13 160); --red: oklch(55% 0.18 25); --red-soft: oklch(55% 0.18 25 / .12);
    --blue: oklch(52% 0.15 250); --blue-soft: oklch(52% 0.15 250 / .12);
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--body); font-size:15px; line-height:1.6; -webkit-font-smoothing:antialiased; min-height:100vh; }
  .wrap { max-width:880px; margin:0 auto; padding:var(--s6) var(--s4) var(--s7); }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:var(--s4); margin-bottom:var(--s5); }
  h1 { font-family:var(--display); font-weight:500; font-size:23px; letter-spacing:-.01em; margin:0; display:flex; align-items:center; gap:var(--s3); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); flex:none; }
  .dot.live { background:var(--green); }
  .sub { color:var(--muted); font-size:13px; font-variant-numeric:tabular-nums; }
  .tabs { display:flex; gap:var(--s1); margin-bottom:var(--s5); border-bottom:1px solid var(--line); }
  .tab { background:transparent; border:0; border-bottom:2px solid transparent; color:var(--muted); font-family:var(--body); font-weight:600; font-size:14px; padding:var(--s3); margin-bottom:-1px; cursor:pointer; transition:color .15s,border-color .15s; display:flex; align-items:center; gap:var(--s2); }
  .tab:hover { color:var(--ink); }
  .tab.active { color:var(--ink); border-bottom-color:var(--clay); }
  .tab .badge { font-size:11.5px; font-weight:600; padding:1px 8px; border-radius:999px; background:var(--surface-2); color:var(--muted); font-variant-numeric:tabular-nums; }
  .tab.active .badge { color:var(--clay); background:var(--clay-soft); }
  .panel { display:none; }
  .panel.active { display:block; animation:fade .18s ease-out; }
  @keyframes fade { from { opacity:0; } }
  h2.section-title { font-family:var(--display); font-weight:500; font-size:19px; letter-spacing:-.005em; color:var(--ink); margin:var(--s6) 0 var(--s3); }
  .panel > h2.section-title:first-child { margin-top:var(--s2); }
  .sess-head { margin:var(--s6) 0 var(--s3); } .sess-head h2 { margin:0; }
  .section-title .sub { font-family:var(--body); font-weight:400; }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:var(--r); padding:var(--s4); margin-bottom:var(--s2); display:flex; align-items:center; gap:var(--s4); }
  .card .main { min-width:0; flex:1; }
  .cmd { font-family:var(--mono); font-size:13px; line-height:1.5; color:var(--ink); word-break:break-all; display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .meta { margin-top:var(--s2); display:flex; flex-wrap:wrap; gap:var(--s2); align-items:center; }
  .chip { font-size:12px; font-weight:500; padding:2px 9px; border-radius:999px; background:var(--surface-2); color:var(--muted); display:inline-flex; align-items:center; gap:6px; }
  .chip.port { color:var(--clay); background:var(--clay-soft); }
  .chip.up { color:var(--green); }
  .chip.pid { font-family:var(--mono); font-size:11.5px; }
  .chip.folder { font-family:var(--mono); font-size:11.5px; color:var(--ink); max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip.src-claude, .chip.src-codex { font-weight:600; }
  .chip.src-claude { color:var(--clay); background:var(--clay-soft); }
  .chip.src-codex { color:var(--teal); background:var(--teal-soft); }
  .chip.src-claude::before, .chip.src-codex::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
  .btn { font-family:var(--body); border:1px solid transparent; cursor:pointer; font-weight:600; font-size:13px; padding:8px 14px; border-radius:var(--r-sm); transition:background .15s,color .15s,border-color .15s; white-space:nowrap; }
  .btn:disabled { opacity:.5; cursor:default; }
  .btn-kill { background:var(--red-soft); color:var(--red); }
  .btn-kill:hover { background:var(--red); color:var(--bg); }
  .btn-ghost { background:transparent; color:var(--muted); border-color:var(--line); padding:6px 12px; font-size:12.5px; }
  .btn-ghost:hover { color:var(--ink); border-color:var(--muted); }
  .btn-ghost.on { color:var(--ink); border-color:var(--muted); background:var(--surface-2); }
  .btn-copy { background:var(--clay); color:var(--clay-ink); }
  .btn-copy:hover { filter:brightness(1.08); }
  .btn-arch { background:transparent; color:var(--muted); border-color:var(--line); }
  .btn-arch:hover { color:var(--ink); border-color:var(--muted); background:var(--surface-2); }
  .btn-icon { padding:7px; line-height:0; display:inline-flex; align-items:center; }
  .btn-vscode { background:var(--blue-soft); color:var(--blue); }
  .btn-vscode:hover { background:var(--blue); color:var(--bg); }
  .btn-vscode svg { width:15px; height:15px; fill:currentColor; }
  .btn-edit { background:transparent; color:var(--muted); border-color:var(--line); }
  .btn-edit:hover { color:var(--ink); border-color:var(--muted); background:var(--surface-2); }
  .btn-edit svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .btn-fav, .btn-pin { background:transparent; color:var(--muted); border-color:transparent; }
  .btn-fav:hover, .btn-pin:hover { color:var(--ink); background:var(--surface-2); }
  .btn-fav.on, .btn-pin.on { color:var(--clay); }
  .btn-fav svg, .btn-pin svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .btn-fav.on svg, .btn-pin.on svg { fill:currentColor; }
  .actions { display:flex; gap:var(--s2); flex-shrink:0; }
  .card.dim { opacity:.55; }
  .card.dim:hover { opacity:1; }
  .srcbar { display:flex; gap:var(--s2); margin-bottom:var(--s3); }
  .src { display:inline-flex; align-items:center; gap:var(--s2); padding:7px 14px; border-radius:999px; border:1px solid var(--line); background:transparent; color:var(--muted); font-family:var(--body); font-weight:600; font-size:12.5px; cursor:pointer; transition:.15s; }
  .src .ico { width:15px; height:15px; fill:currentColor; flex:none; }
  .src:hover { color:var(--ink); }
  #src-claude.on { background:var(--clay-soft); border-color:transparent; color:var(--clay); }
  #src-codex.on { background:var(--teal-soft); border-color:transparent; color:var(--teal); }
  .row { display:flex; align-items:baseline; justify-content:space-between; gap:var(--s3); }
  .title { font-size:15px; font-weight:600; line-height:1.4; color:var(--ink); word-break:break-word; }
  .title-wrap { display:flex; align-items:center; gap:6px; min-width:0; }
  .title-wrap .title { min-width:0; }
  .title-wrap .btn-edit { padding:3px; border-color:transparent; opacity:.4; flex:none; }
  .card:hover .title-wrap .btn-edit { opacity:.7; }
  .title-wrap .btn-edit:hover { opacity:1; background:var(--surface-2); }
  .title-edit { font-family:var(--body); font-size:15px; font-weight:600; color:var(--ink); background:var(--bg); border:1px solid var(--clay); border-radius:6px; padding:3px 9px; flex:1; min-width:0; outline:none; }
  .title-wrap .ck { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:2.5; stroke-linecap:round; stroke-linejoin:round; }
  .hdr-right { display:flex; align-items:center; gap:var(--s3); }
  #theme-btn { padding:6px; }
  #theme-btn svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .ic-moon { display:none; }
  :root[data-theme="light"] .ic-sun { display:none; }
  :root[data-theme="light"] .ic-moon { display:inline; }
  .filter { width:100%; margin-bottom:var(--s3); padding:9px 12px; border-radius:var(--r-sm); border:1px solid var(--line); background:var(--surface); color:var(--ink); font-family:var(--body); font-size:14px; outline:none; transition:border-color .15s; }
  .filter:focus { border-color:var(--clay); }
  .filter::placeholder { color:var(--muted); }
  .empty { color:var(--muted); text-align:center; padding:var(--s7) var(--s4); border:1px dashed var(--line); border-radius:var(--r); }
  a.open { color:var(--clay); text-decoration:none; font-size:12px; font-weight:600; }
  a.open:hover { text-decoration:underline; }
  .hint { color:var(--muted); font-size:13px; line-height:1.6; max-width:72ch; margin:0 0 var(--s3); }
  .hint b { color:var(--ink); font-weight:600; }
  .check { display:flex; align-items:center; gap:var(--s2); color:var(--muted); font-size:13px; margin-bottom:var(--s3); cursor:pointer; }
  .check input { accent-color:var(--clay); width:15px; height:15px; }
  .filebtn { display:inline-flex; align-items:center; gap:var(--s2); padding:8px 14px; border-radius:var(--r-sm); border:1px solid var(--line); color:var(--ink); font-weight:600; font-size:13px; cursor:pointer; }
  .filebtn:hover { border-color:var(--muted); background:var(--surface-2); }
  .filebtn input { display:none; }
  .xfer { display:flex; align-items:center; gap:var(--s3); }
  .xfer input[type=checkbox] { accent-color:var(--clay); width:16px; height:16px; flex:none; }
  .plan-card { background:var(--surface); border:1px solid var(--line); border-radius:var(--r); padding:var(--s4); margin-bottom:var(--s2); }
  .plan-card .lbl { color:var(--muted); font-size:12px; }
  .arrow { color:var(--muted); }
  .mono { font-family:var(--mono); font-size:12px; color:var(--ink); word-break:break-all; }
  .pathin { width:100%; margin-top:4px; padding:7px 10px; border-radius:var(--r-sm); border:1px solid var(--line); background:var(--bg); color:var(--ink); font-family:var(--mono); font-size:12px; outline:none; }
  .pathin:focus { border-color:var(--clay); }
  .warn { border:1px solid color-mix(in oklch, var(--red) 45%, var(--line)); background:var(--red-soft); color:var(--ink); border-radius:var(--r); padding:var(--s3) var(--s4); margin-bottom:var(--s3); font-size:13px; }
  .warn b { color:var(--red); }
  .ptr { display:flex; align-items:flex-start; gap:var(--s2); padding:6px 0; border-top:1px solid var(--line); font-size:12.5px; }
  .ptr:first-of-type { border-top:0; }
  .ptr .grow { flex:1; min-width:0; }
  .ok-line { color:var(--green); font-size:13px; }
  .foot { max-width:68ch; margin-top:var(--s6); padding-top:var(--s4); border-top:1px solid var(--line); color:var(--muted); font-size:13px; line-height:1.65; }
  .foot b { color:var(--ink); font-weight:600; }
  code { font-family:var(--mono); background:var(--surface-2); padding:1px 6px; border-radius:5px; color:var(--ink); font-size:12.5px; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1><span class="dot" id="status-dot"></span> Claude Control</h1>
      <div class="hdr-right">
        <span class="sub" id="status">atualizando…</span>
        <button class="btn btn-ghost btn-icon" id="theme-btn" onclick="toggleTheme()" title="Alternar tema claro/escuro">
          <svg class="ic-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          <svg class="ic-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>
        </button>
      </div>
    </header>

    <div class="tabs">
      <button class="tab active" id="tab-sessions" onclick="switchTab('sessions')">Sessões <span class="badge" id="badge-sessions">–</span></button>
      <button class="tab" id="tab-watch" onclick="switchTab('watch')">Processos <span class="badge" id="badge-watch">0</span></button>
      <button class="tab" id="tab-transfer" onclick="switchTab('transfer')">Transferir</button>
    </div>

    <section class="panel active" id="panel-sessions">
      <div class="row sess-head">
        <h2 class="section-title">Sessões <span class="sub" id="sess-count"></span></h2>
        <span class="actions">
          <button class="btn btn-ghost" id="sess-fav-toggle" onclick="toggleFav()">Favoritas (0)</button>
          <button class="btn btn-ghost" id="sess-archived-toggle" onclick="toggleArchived()">Arquivadas (0)</button>
          <button class="btn btn-ghost" id="sess-reload" onclick="loadSessions()">Atualizar</button>
        </span>
      </div>
      <div class="srcbar">
        <button class="src on" id="src-claude" onclick="toggleSource('claude')"><svg class="ico" viewBox="0 0 24 24"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg> Claude</button>
        <button class="src" id="src-codex" onclick="toggleSource('codex')"><svg class="ico" viewBox="0 0 24 24"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"/></svg> Codex</button>
      </div>
      <input class="filter" id="sess-filter" placeholder="filtrar por título ou pasta…" oninput="renderSessions()" />
      <div id="sessions"></div>
    </section>

    <section class="panel" id="panel-watch">
      <h2 class="section-title">Processos do Claude em background</h2>
      <div id="tasks"></div>

      <h2 class="section-title">Containers Docker</h2>
      <div id="containers"></div>
    </section>

    <section class="panel" id="panel-transfer">
      <h2 class="section-title">Exportar</h2>
      <p class="hint">Empacota sessões num arquivo <code>.json</code> portátil. Os caminhos da máquina
        (home, pasta do projeto, nome de usuário) ficam registrados pra serem remapeados na importação.
        Sidecars (subagentes, workflows, file-history) não vão junto: a conversa retoma, esses artefatos não.</p>
      <input class="filter" id="xfer-filter" placeholder="filtrar sessões para exportar…" oninput="renderXfer()" />
      <label class="check"><input type="checkbox" id="xfer-scan" checked /> Avisar sobre possíveis segredos antes de baixar</label>
      <div class="row sess-head">
        <span class="sub" id="xfer-count">—</span>
        <span class="actions">
          <button class="btn btn-ghost" id="xfer-all" onclick="xferToggleAll()">Selecionar todas</button>
          <button class="btn btn-copy" id="xfer-export" onclick="exportSelected()">Exportar (0)</button>
        </span>
      </div>
      <div id="xfer-warn"></div>
      <div id="xfer-list"><div class="empty">Carregando sessões…</div></div>

      <h2 class="section-title">Importar</h2>
      <p class="hint">Carregue um <code>.json</code> exportado. O painel mostra um <b>preview</b> do que vai mudar
        (home, cwd, pasta codificada) sem escrever nada. Apontamentos que o remap automático não cobre
        aparecem pra você <b>ignorar</b> ou ajustar. Se preferir resolver com uma IA, copie o prompt no fim.</p>
      <label class="filebtn">Escolher arquivo .json<input type="file" id="imp-file" accept=".json,application/json" onchange="impPick(event)" /></label>
      <span class="sub" id="imp-name"></span>
      <div id="imp-plan"></div>
    </section>

    <div class="foot">
      Processos e containers atualizam sozinhos a cada 2,5s. <b>Finalizar</b> mata o processo e seus filhos com SIGTERM.
      As <b>sessões</b> são lidas sob demanda do <b>Claude</b> (<code>~/.claude/projects</code>) e do <b>Codex</b>
      (<code>~/.codex/sessions</code>): ligue as fontes e clique em <b>Atualizar</b>. O ícone do <b>VS Code</b>
      abre a pasta da sessão, <b>Retomar</b> copia o comando <code>claude --resume</code> ou <code>codex resume</code>, e
      <b>Arquivar</b> só organiza a visão (nada é apagado). Painel local em <code>localhost:7799</code>: só lê e mata na sua máquina.
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
  catch { document.getElementById('status').textContent = 'painel offline'; document.getElementById('status-dot').classList.remove('live'); return; }

  document.getElementById('status').textContent =
    data.tasks.length + ' processo(s) · ' + new Date(data.now).toLocaleTimeString('pt-BR');
  document.getElementById('badge-watch').textContent = data.tasks.length + data.containers.length;
  document.getElementById('status-dot').classList.toggle('live', data.tasks.length > 0);

  const t = document.getElementById('tasks');
  t.innerHTML = data.tasks.length ? data.tasks.map(x => \`
    <div class="card">
      <div class="main">
        <div class="cmd" title="\${esc(x.cmd)}">\${esc(x.cmd)}</div>
        <div class="meta">
          <span class="chip pid">PID \${x.pid}</span>
          <span class="chip up">▲ \${fmtUp(x.etimes)}</span>
          \${x.port ? \`<span class="chip port">porta \${x.port}</span> <a class="open" href="http://localhost:\${x.port}" target="_blank">abrir ↗</a>\` : ''}
        </div>
      </div>
      <button class="btn btn-kill" onclick='kill(\${JSON.stringify({pid:x.pid})}, \${JSON.stringify("PID "+x.pid+": "+x.cmd)})'>Finalizar</button>
    </div>\`).join('') : '<div class="empty">Nada rodando pelo Claude agora.</div>';

  const c = document.getElementById('containers');
  c.innerHTML = data.containers.length ? data.containers.map(x => \`
    <div class="card">
      <div class="main">
        <div class="cmd">\${esc(x.name)}</div>
        <div class="meta"><span class="chip">Docker</span>\${x.ports ? \`<span class="chip">\${esc(x.ports)}</span>\` : ''}<span class="chip up">\${esc(x.status)}</span></div>
      </div>
      <button class="btn btn-kill" onclick='kill(\${JSON.stringify({container:x.name})}, \${JSON.stringify("container "+x.name)})'>Parar</button>
    </div>\`).join('') : '<div class="empty">Nenhum container Docker ativo.</div>';
}
// ── Abas ──
let sessLoaded = false;
function switchTab(name) {
  for (const t of ['watch', 'sessions', 'transfer']) {
    document.getElementById('tab-' + t).classList.toggle('active', t === name);
    document.getElementById('panel-' + t).classList.toggle('active', t === name);
  }
  if (name === 'sessions' && !sessLoaded) loadSessions(); // só escaneia ao abrir a 1ª vez
  if (name === 'transfer' && !xferLoaded) loadXfer();
}

// ── Sessões (carregadas sob demanda, não no loop de 2,5s) ──
let SESS = [];
let showArchived = false;
let showFav = false;
let sources = { claude: true, codex: false }; // default: só Claude
const fmtAgo = (ms) => { const s = Math.floor((Date.now() - ms) / 1000);
  const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60);
  return d ? 'há '+d+'d' : h ? 'há '+h+'h' : m ? 'há '+m+'min' : 'agora'; };

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
function toggleFav() { showFav = !showFav; renderSessions(); }

async function flag(id, source, which, on, btn) {
  try { await fetch('/api/flag', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id, source, flag: which, on }) }); }
  catch { return; }
  const s = SESS.find(x => x.id === id && x.source === source);
  if (s) { if (which === 'fav') s.fav = on; else s.pinned = on; }
  renderSessions();
}

function startRename(btn, id, source) {
  const wrap = btn.closest('.title-wrap');
  const s = SESS.find(x => x.id === id && x.source === source);
  const cur = s ? s.title : wrap.querySelector('.title').textContent;
  wrap.innerHTML =
    '<input class="title-edit" /> '
    + '<button class="btn btn-copy btn-icon" data-act="ok" title="Confirmar"><svg class="ck" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></button>'
    + '<button class="btn btn-arch btn-icon" data-act="cancel" title="Cancelar"><svg class="ck" viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6"/></svg></button>';
  const inp = wrap.querySelector('input');
  inp.value = cur; inp.focus(); inp.select();
  const ok = () => commitRename(wrap, id, source);
  wrap.querySelector('[data-act=ok]').onclick = ok;
  wrap.querySelector('[data-act=cancel]').onclick = () => renderSessions();
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } else if (e.key === 'Escape') renderSessions(); };
}
async function commitRename(wrap, id, source) {
  const name = (wrap.querySelector('input.title-edit').value || '').trim();
  const s = SESS.find(x => x.id === id && x.source === source);
  try {
    await fetch('/api/rename', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id, source, title: name }) });
  } catch { renderSessions(); return; }
  if (s) { s.title = name || s.autoTitle; s.renamed = !!name; }
  renderSessions();
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('cc-theme', next); } catch {}
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
  const favCount = SESS.filter(s => s.fav && !s.archived).length;
  let base = SESS.filter(s => showArchived ? s.archived : !s.archived);
  if (showFav) base = base.filter(s => s.fav);
  const list = base.filter(s => !q || s.title.toLowerCase().includes(q) || s.folder.toLowerCase().includes(q))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)); // fixadas no topo (mantém ordem por recência dentro de cada grupo)

  document.getElementById('sess-count').textContent =
    base.length ? '· ' + list.length + '/' + base.length + (showArchived ? ' arquivadas' : showFav ? ' favoritas' : '') : '';
  document.getElementById('badge-sessions').textContent = activeCount;
  const tgl = document.getElementById('sess-archived-toggle');
  tgl.textContent = showArchived ? '← Ver ativas' : 'Arquivadas (' + archivedCount + ')';
  tgl.classList.toggle('on', showArchived);
  const ftg = document.getElementById('sess-fav-toggle');
  ftg.textContent = 'Favoritas (' + favCount + ')';
  ftg.classList.toggle('on', showFav);

  const noSource = !sources.claude && !sources.codex;
  const emptyMsg = noSource ? 'Selecione Claude e/ou Codex acima.'
    : showFav ? 'Nenhuma sessão favoritada.'
    : showArchived ? 'Nenhuma sessão arquivada.'
    : q ? 'Nenhuma sessão bate com o filtro.'
    : SESS.length ? 'Nenhuma sessão ativa — veja as arquivadas.' : 'Nenhuma sessão encontrada.';

  document.getElementById('sessions').innerHTML = list.length ? list.map(s => \`
    <div class="card\${s.archived ? ' dim' : ''}">
      <div class="main">
        <div class="title-wrap">
          <span class="title"\${s.renamed ? \` title="auto: \${esc(s.autoTitle)}"\` : ''}>\${esc(s.title)}</span>
          <button class="btn btn-edit btn-icon" title="Renomear" onclick='startRename(this, \${JSON.stringify(s.id)}, \${JSON.stringify(s.source)})'><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        </div>
        <div class="meta">
          <span class="chip src-\${s.source}">\${s.source === 'codex' ? 'Codex' : 'Claude'}</span>
          <span class="chip folder" title="\${esc(s.folder)}">\${esc(s.folder)}</span>
          <span class="chip up">\${fmtAgo(s.mtime)}</span>
          <span class="chip pid">\${esc(s.id.slice(0,8))}</span>
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-icon btn-fav\${s.fav ? ' on' : ''}" title="\${s.fav ? 'Desfavoritar' : 'Favoritar'}" onclick='flag(\${JSON.stringify(s.id)}, \${JSON.stringify(s.source)}, "fav", \${!s.fav}, this)'><svg viewBox="0 0 24 24"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg></button>
        <button class="btn btn-icon btn-pin\${s.pinned ? ' on' : ''}" title="\${s.pinned ? 'Desafixar' : 'Fixar no topo'}" onclick='flag(\${JSON.stringify(s.id)}, \${JSON.stringify(s.source)}, "pin", \${!s.pinned}, this)'><svg viewBox="0 0 24 24"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg></button>
        <button class="btn btn-vscode btn-icon" title="Abrir a pasta no VS Code" onclick='openIn(\${JSON.stringify(s.folder)}, this)'><svg viewBox="0 0 24 24"><path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg></button>
        <button class="btn btn-copy" onclick='resume(\${JSON.stringify(s.folder)}, \${JSON.stringify(s.id)}, \${JSON.stringify(s.source)}, this)'>Retomar</button>
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

// ── Transferir: exportar ──
let xferLoaded = false, XFER = [], xferSel = new Set();
const encProj = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const xferKey = (s) => s.source + ':' + s.id;

async function loadXfer() {
  xferLoaded = true;
  const box = document.getElementById('xfer-list');
  box.innerHTML = '<div class="empty">Carregando sessões…</div>';
  try { XFER = (await (await fetch('/api/sessions?sources=claude,codex')).json()).sessions || []; }
  catch { box.innerHTML = '<div class="empty">Falha ao ler sessões.</div>'; return; }
  renderXfer();
}

function xferFiltered() {
  const q = (document.getElementById('xfer-filter').value || '').toLowerCase();
  return XFER.filter(s => !q || s.title.toLowerCase().includes(q) || s.folder.toLowerCase().includes(q));
}
function renderXfer() {
  const list = xferFiltered();
  document.getElementById('xfer-count').textContent = xferSel.size + ' selecionada(s) · ' + list.length + ' na lista';
  const exp = document.getElementById('xfer-export');
  exp.textContent = 'Exportar (' + xferSel.size + ')'; exp.disabled = xferSel.size === 0;
  document.getElementById('xfer-list').innerHTML = list.length ? list.map(s => {
    const k = xferKey(s);
    return \`<div class="card"><div class="xfer">
      <input type="checkbox" \${xferSel.has(k) ? 'checked' : ''} onchange="xferPick(\${JSON.stringify(k)}, this.checked)" />
      <div class="main">
        <div class="title">\${esc(s.title)}</div>
        <div class="meta">
          <span class="chip src-\${s.source}">\${s.source === 'codex' ? 'Codex' : 'Claude'}</span>
          <span class="chip folder">\${esc(s.folder)}</span>
        </div>
      </div></div></div>\`;
  }).join('') : '<div class="empty">Nenhuma sessão.</div>';
}
function xferPick(k, on) { if (on) xferSel.add(k); else xferSel.delete(k); renderXfer(); }
function xferToggleAll() {
  const list = xferFiltered(), allOn = list.length && list.every(s => xferSel.has(xferKey(s)));
  for (const s of list) { const k = xferKey(s); if (allOn) xferSel.delete(k); else xferSel.add(k); }
  renderXfer();
}

let pendingBundle = null;
async function exportSelected() {
  const items = XFER.filter(s => xferSel.has(xferKey(s))).map(s => ({ source: s.source, id: s.id }));
  if (!items.length) return;
  const btn = document.getElementById('xfer-export'), old = btn.textContent; btn.disabled = true; btn.textContent = 'gerando…';
  let bundle;
  try { bundle = await (await fetch('/api/export', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ items, scanSecrets: document.getElementById('xfer-scan').checked }) })).json(); }
  catch { btn.textContent = old; btn.disabled = false; return; }
  btn.textContent = old; btn.disabled = false;
  const warn = document.getElementById('xfer-warn');
  const withSecrets = (bundle.sessions || []).filter(s => (s.secrets || []).length);
  if (document.getElementById('xfer-scan').checked && withSecrets.length) {
    pendingBundle = bundle;
    warn.innerHTML = '<div class="warn"><b>Atenção:</b> possíveis segredos em ' + withSecrets.length + ' sessão(ões) — '
      + esc(withSecrets.map(s => (s.secrets || []).map(x => x.kind + ' ×' + x.count).join(', ')).join(' · '))
      + '. Revise antes de compartilhar. <div style="margin-top:8px"><button class="btn btn-copy" onclick="downloadPending()">Baixar mesmo assim</button></div></div>';
  } else { warn.innerHTML = ''; downloadBundle(bundle); }
}
function downloadPending() { if (pendingBundle) { downloadBundle(pendingBundle); document.getElementById('xfer-warn').innerHTML = ''; pendingBundle = null; } }
function downloadBundle(bundle) {
  const n = (bundle.sessions || []).length;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
  a.download = 'claude-control-' + n + 'sessoes-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click(); URL.revokeObjectURL(a.href);
}

// ── Transferir: importar ──
let impBundle = null, impPlan = null;
async function impPick(ev) {
  const file = ev.target.files && ev.target.files[0]; if (!file) return;
  document.getElementById('imp-name').textContent = file.name;
  const plan = document.getElementById('imp-plan');
  let bundle;
  try { bundle = JSON.parse(await file.text()); }
  catch { plan.innerHTML = '<div class="warn"><b>Erro:</b> arquivo não é JSON válido.</div>'; return; }
  impBundle = bundle;
  let resp;
  try { resp = await (await fetch('/api/import', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ mode:'preview', bundle }) })).json(); }
  catch { plan.innerHTML = '<div class="warn">Falha ao analisar.</div>'; return; }
  if (!resp.ok) { plan.innerHTML = '<div class="warn"><b>Erro:</b> ' + esc(resp.error || 'bundle inválido') + '</div>'; return; }
  impPlan = resp; renderPlan();
}
function renderPlan() {
  const r = impPlan;
  const head = '<div class="hint" style="margin-top:8px">Origem: <span class="mono">' + esc(r.oldHome || '?') + '</span> (' + esc(r.oldUser || '?')
    + (r.host ? '@' + esc(r.host) : '') + ') <span class="arrow">→</span> esta máquina: <span class="mono">' + esc(r.newHome) + '</span> (' + esc(r.newUser) + ')</div>';
  const cards = r.plan.map((p, i) => {
    const collision = p.collision ? '<label class="check" style="margin:8px 0 0"><input type="checkbox" id="imp-ow-' + i + '" /> Sobrescrever (já existe nesta máquina)</label>' : '';
    const secrets = (p.secrets || []).length ? '<div class="warn" style="margin-top:8px"><b>Segredos:</b> ' + esc(p.secrets.map(x => x.kind + ' ×' + x.count).join(', ')) + '</div>' : '';
    const foreign = (p.foreign || []).length
      ? '<div class="lbl" style="margin-top:10px">Apontamentos fora da home (marcado = ignora; desmarque para substituir):</div>'
        + p.foreign.map((f, j) => '<div class="ptr"><input type="checkbox" id="imp-ig-' + i + '-' + j + '" checked onchange="document.getElementById(\\'imp-rp-' + i + '-' + j + '\\').disabled=this.checked" />'
          + '<div class="grow"><span class="mono">' + esc(f.path) + '</span> <span class="lbl">×' + f.count + '</span>'
          + '<input class="pathin" id="imp-rp-' + i + '-' + j + '" data-from="' + esc(f.path) + '" placeholder="substituir por…" disabled /></div></div>').join('')
      : '<div class="lbl" style="margin-top:10px">Sem apontamentos fora da home — o remap automático cobre tudo.</div>';
    return '<div class="plan-card"><div class="row"><div class="title">' + esc(p.title) + '</div><span class="chip src-' + p.source + '">' + (p.source === 'codex' ? 'Codex' : 'Claude') + '</span></div>'
      + '<div class="lbl" style="margin-top:8px">Pasta de destino (cwd nesta máquina):</div>'
      + '<input class="pathin" id="imp-cwd-' + i + '" value="' + esc(p.suggestedCwd || p.oldCwd || '') + '" oninput="updTarget(' + i + ')" />'
      + '<div class="lbl" style="margin-top:8px">Vai escrever em: <span class="mono" id="imp-tgt-' + i + '">' + esc(p.target) + '</span></div>'
      + '<div class="lbl" style="margin-top:6px">' + p.homeHits + ' caminho(s) sob a home e ' + p.cwdHits + ' no cwd serão reescritos.</div>'
      + collision + secrets + foreign + '</div>';
  }).join('');
  document.getElementById('imp-plan').innerHTML = head + cards
    + '<div class="actions" style="margin-top:12px"><button class="btn btn-copy" onclick="applyImport()">Aplicar importação</button>'
    + '<button class="btn btn-ghost" onclick="copyAiPrompt(this)">Copiar prompt pra IA</button></div>';
}
function updTarget(i) {
  const p = impPlan.plan[i];
  if (p.source !== 'claude') return; // Codex: caminho do arquivo não depende do cwd
  const cwd = document.getElementById('imp-cwd-' + i).value || '';
  document.getElementById('imp-tgt-' + i).textContent = impPlan.newHome + '/.claude/projects/' + encProj(cwd) + '/' + p.id + '.jsonl';
}
async function applyImport() {
  const decisions = {};
  impPlan.plan.forEach((p, i) => {
    const ow = document.getElementById('imp-ow-' + i);
    const d = { newCwd: document.getElementById('imp-cwd-' + i).value, remaps: {}, overwrite: !!(ow && ow.checked) };
    (p.foreign || []).forEach((f, j) => {
      const ig = document.getElementById('imp-ig-' + i + '-' + j), rp = document.getElementById('imp-rp-' + i + '-' + j);
      if (ig && !ig.checked && rp && rp.value.trim()) d.remaps[rp.dataset.from] = rp.value.trim();
    });
    decisions[p.key] = d;
  });
  let resp;
  try { resp = await (await fetch('/api/import', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ mode:'apply', bundle: impBundle, decisions }) })).json(); }
  catch { return; }
  const items = (resp.results || []).map(x => x.ok
    ? '<div class="ok-line">✓ importada: <span class="mono">' + esc(x.target) + '</span><br><span class="lbl">retomar:</span> <span class="mono">' + esc(x.resume) + '</span></div>'
    : x.skipped ? '<div class="lbl">— pulada (' + esc(x.reason) + '): ' + esc(x.id) + '</div>'
    : '<div class="warn">erro em ' + esc(x.id) + ': ' + esc(x.error || '') + '</div>').join('<div style="height:8px"></div>');
  document.getElementById('imp-plan').innerHTML = '<div class="plan-card"><div class="title">Resultado</div><div style="margin-top:10px">' + (items || 'nada') + '</div></div>';
}
function copyAiPrompt(btn) {
  const r = impPlan, L = [];
  L.push('Preciso adaptar sessões de IA (Claude Code / Codex) exportadas de outra máquina para rodarem nesta. Vou anexar o arquivo .json exportado.');
  L.push('');
  L.push('Origem: home=' + r.oldHome + ' usuário=' + r.oldUser + (r.host ? ' host=' + r.host : ''));
  L.push('Esta máquina: home=' + r.newHome + ' usuário=' + r.newUser);
  L.push('');
  L.push('Para cada sessão, reescreva o "content" (texto JSONL):');
  r.plan.forEach(p => {
    L.push('- [' + p.source + '] ' + p.title + ' (id ' + p.id + ')');
    L.push('    cwd: ' + p.oldCwd + '  ->  ' + (p.suggestedCwd || '<defina>'));
    L.push('    troque o prefixo da home ' + r.oldHome + ' por ' + r.newHome + ' em todos os caminhos');
    if (p.source === 'claude') L.push('    troque o nome de pasta codificado (cada char fora de [A-Za-z0-9] vira "-") do cwd antigo pelo do novo');
    if ((p.foreign || []).length) {
      L.push('    apontamentos fora da home (pergunte antes de mudar; posso querer ignorar):');
      p.foreign.forEach(f => L.push('      • ' + f.path + ' (×' + f.count + ')'));
    }
  });
  L.push('');
  L.push('Regra: quando não souber para onde apontar um caminho, NÃO adivinhe — me pergunte e me dê a opção de ignorar (deixar como está). Grave cada sessão Claude em ~/.claude/projects/<pasta-codificada-do-novo-cwd>/<id>.jsonl e cada Codex em ~/.codex/sessions/<caminho-original-do-bundle>.');
  navigator.clipboard.writeText(L.join('\\n')).then(() => { const o = btn.textContent; btn.textContent = 'copiado ✓'; setTimeout(() => { btn.textContent = o; }, 1400); });
}

refresh();
setInterval(refresh, 2500);
// aba padrão é Sessões; #watch / #transfer abrem direto na respectiva aba
const startHash = location.hash.slice(1);
if (startHash === 'watch' || startHash === 'transfer') switchTab(startHash);
else loadSessions();
</script>
</body>
</html>`;
