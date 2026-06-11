#!/usr/bin/env bun
/**
 * AgentDeck — painel local pra ver/finalizar o que o Claude Code
 * (VSCode) deixou rodando em background e listar as sessões do Claude/Codex.
 * Serve o HTML + uma API que lê ps/ss/docker e ~/.claude e ~/.codex.
 * Tudo em 127.0.0.1 — nada exposto pra fora.
 *
 * Rodar:  bun server.ts   (ou ./start.sh)   →   http://localhost:7799
 */
import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const PORT = 7799;
// origens aceitas nos POSTs — barra CSRF de qualquer página aberta na máquina
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const SNAPSHOT_MARK = '.claude/shell-snapshots';
// marca que entra nos args (via $0 do `bash -c`) dos processos reiniciados pelo AgentDeck,
// pra eles continuarem aparecendo na lista mesmo sem a assinatura do shell do Claude.
const TASK_MARK = 'agentdeck-task';
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CODEX_DIR = join(homedir(), '.codex', 'sessions');
const ARCHIVE_FILE = join(homedir(), '.claude', '.terminal-control-archived.json');
const NAMES_FILE = join(homedir(), '.claude', '.terminal-control-names.json');
const FLAGS_FILE = join(homedir(), '.claude', '.terminal-control-flags.json');
const HISTORY_FILE = join(homedir(), '.claude', '.agentdeck-history.json'); // processos iniciados pela plataforma
const LOGS_DIR = join(homedir(), '.claude', '.agentdeck-logs'); // saída (stdout+stderr) dos processos iniciados
const WORKSPACES_FILE = join(homedir(), '.claude', '.agentdeck-workspaces.json'); // grupos de pastas
let logSeq = 0;

const sh = (cmd: string): string => {
  try {
    // maxBuffer alto: o padrão (~1MB) truncaria a saída de grep em massa no meio de
    // uma linha (ENOBUFS), e o resultado parcial viraria título errado no cache.
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e: any) {
    return e?.stdout?.toString?.() ?? '';
  }
};

// roda um binário sem shell e espera o término (argv direto — imune a injeção
// por aspas/$()/crase, ao contrário de sh() que passa pelo /bin/sh).
const run = (file: string, args: string[]): boolean => {
  try {
    execFileSync(file, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
// dispara em background sem shell e não espera (abrir o VS Code não pode travar a resposta).
const runBg = (file: string, args: string[]): void => {
  try {
    spawn(file, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* binário ausente */
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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// ids de sessão citados na linha de comando de algum processo vivo (ex.: o
// claude aberto agora com `--resume <id>`) → usado pra marcar "ativa agora".
const liveSessionIds = (): Set<string> => {
  const ids = new Set<string>();
  for (const p of readProcs()) {
    if (!/claude|codex/i.test(p.args)) continue;
    for (const m of p.args.matchAll(UUID_RE)) ids.add(m[0].toLowerCase());
  }
  return ids;
};

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
  // iniciados/reiniciados pelo AgentDeck: `bash -c <cmd> >"<log>" 2>&1 & wait agentdeck-task`
  let t = args.match(/bash -c (.+) >"[^"]+\.log" 2>&1 & wait agentdeck-task\s*$/s);
  if (t) return t[1].trim();
  t = args.match(/bash -c (.+) & wait agentdeck-task\s*$/s); // formato antigo (sem log)
  if (t) return t[1].trim();
  const m = args.match(/eval '(.+?)' < \/dev\/null/s) ?? args.match(/eval '(.+)'/s);
  let cmd = m ? m[1] : args;
  cmd = cmd.replace(/'"'"'/g, "'"); // desfaz o escape de aspas do wrapper
  return cmd.trim();
};
// caminho do log embutido nos args dos processos iniciados pelo AgentDeck
const taskLog = (args: string): string => { const m = args.match(/>"([^"]+\.log)" 2>&1 & wait agentdeck-task/); return m ? m[1] : ''; };

// roda um comando numa pasta, em background, com a saída (stdout+stderr) num arquivo de
// log — assim dá pra ver POR QUE falhou (ex.: porta em uso). Devolve o caminho do log ('' se falhou).
// O marcador entra como $0 do `bash -c` (aparece nos args do ps, sem afetar o comando);
// `<cmd> & wait` mantém o bash vivo como pai (senão ele se auto-substituiria e perderia o marcador).
const runTask = (cmd: string, cwd: string): string => {
  try {
    if (!cwd || !existsSync(cwd)) return '';
    mkdirSync(LOGS_DIR, { recursive: true });
    const logFile = join(LOGS_DIR, `${Date.now()}-${(logSeq = (logSeq + 1) % 100000)}.log`);
    spawn('bash', ['-c', `${cmd} >"${logFile}" 2>&1 & wait`, TASK_MARK], { cwd, detached: true, stdio: 'ignore' }).unref();
    return logFile;
  } catch {
    return '';
  }
};
// tail de um log (últimos ~64KB), validado dentro de LOGS_DIR
const readTaskLog = (path: string): string => {
  try {
    if (!within(LOGS_DIR, path) || !path.endsWith('.log')) return '';
    const buf = readFileSync(path, 'utf8');
    return buf.length > 65536 ? '…\n' + buf.slice(buf.length - 65536) : buf;
  } catch {
    return '';
  }
};

// pasta onde o processo está rodando (cwd real, via /proc/<pid>/cwd no Linux)
const procCwd = (pid: number): string => {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return ''; // sem permissão / processo sumiu / não-Linux
  }
};

const tasks = () => {
  const procs = readProcs();
  const kids = childrenMap(procs);
  const ports = listenPorts();
  return procs
    .filter((p) => (p.args.includes(SNAPSHOT_MARK) || p.args.includes(TASK_MARK)) && !p.args.includes('claude-terminal-control'))
    .map((p) => ({
      pid: p.pid,
      etimes: p.etimes,
      cmd: cleanCmd(p.args),
      port: findPort(p.pid, kids, ports),
      cwd: procCwd(p.pid),
      log: taskLog(p.args), // caminho do log (só pros iniciados pelo AgentDeck)
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
// soma dos tokens da sessão (dos registros "usage" do .jsonl)
type Usage = { in: number; out: number; cc: number; cr: number; turns: number } | null;
type Session = {
  id: string;
  title: string; // título exibido (nome customizado, se houver, senão o detectado)
  autoTitle: string; // título detectado automaticamente (pra poder reverter)
  renamed: boolean;
  folder: string;
  lastMsg: string; // trecho da última mensagem (onde paramos) — só Claude por ora
  origin: string; // onde a sessão começou: 'cli' (terminal), 'claude-vscode', 'sdk-cli' ou '' — só Claude
  usage: Usage; // tokens somados — só Claude por ora
  mtime: number;
  archived: boolean;
  fav: boolean;
  pinned: boolean;
  live: boolean; // sendo escrita agora ou citada por um processo vivo
  source: Source;
};

// leitura tolerante + escrita atômica (tmp+rename) pros sidecars JSON: um crash
// no meio da escrita não trunca o arquivo (o rename é atômico no mesmo FS), então
// não se perde favoritos/nomes silenciosamente.
const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
};
const writeJsonAtomic = (path: string, data: unknown): void => {
  try {
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  } catch {
    /* sem permissão — ignora */
  }
};

// ─── Histórico de processos iniciados pela plataforma (~/.agentdeck-history) ──
type HistItem = { cmd: string; folder: string; lastRun: number; runs: number; pinned: boolean; log?: string };
const readHistory = (): HistItem[] => { const a = readJson<HistItem[]>(HISTORY_FILE, []); return Array.isArray(a) ? a : []; };
const recordHistory = (cmd: string, folder: string, log: string): void => {
  const items = readHistory();
  const i = items.findIndex((x) => x.cmd === cmd && x.folder === folder);
  if (i >= 0) { items[i].lastRun = Date.now(); items[i].runs = (items[i].runs || 0) + 1; items[i].log = log; }
  else items.push({ cmd, folder, lastRun: Date.now(), runs: 1, pinned: false, log });
  // poda: mantém os fixados + os 100 mais recentes
  const pinned = items.filter((x) => x.pinned);
  const rest = items.filter((x) => !x.pinned).sort((a, b) => b.lastRun - a.lastRun).slice(0, 100);
  writeJsonAtomic(HISTORY_FILE, [...pinned, ...rest]);
};
const historySorted = (): HistItem[] =>
  readHistory().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.lastRun - a.lastRun);

// ─── Workspaces: grupos nomeados de pastas (~/.agentdeck-workspaces) ──────
type Workspace = { name: string; folders: string[] };
const readWorkspaces = (): Workspace[] => {
  const a = readJson<Workspace[]>(WORKSPACES_FILE, []);
  return Array.isArray(a) ? a.filter((w) => w && typeof w.name === 'string' && Array.isArray(w.folders)) : [];
};
const saveWorkspace = (name: string, folders: string[]): boolean => {
  name = name.trim();
  const valid = folders.map((f) => (f || '').trim()).filter((f) => f && existsSync(f));
  if (!name || !valid.length) return false;
  const all = readWorkspaces().filter((w) => w.name !== name); // upsert por nome
  all.push({ name, folders: [...new Set(valid)] });
  all.sort((a, b) => a.name.localeCompare(b.name));
  writeJsonAtomic(WORKSPACES_FILE, all);
  return true;
};
const deleteWorkspace = (name: string): void => writeJsonAtomic(WORKSPACES_FILE, readWorkspaces().filter((w) => w.name !== name));

// favoritas (★) e fixadas no topo (📌), guardadas juntas
type Flags = { fav: Set<string>; pin: Set<string> };
const readFlags = (): Flags => {
  const o = readJson<any>(FLAGS_FILE, {});
  return { fav: new Set(Array.isArray(o?.favorites) ? o.favorites : []), pin: new Set(Array.isArray(o?.pinned) ? o.pinned : []) };
};
const writeFlags = (f: Flags): void => writeJsonAtomic(FLAGS_FILE, { favorites: [...f.fav], pinned: [...f.pin] });

// chave (id pode coincidir entre ferramentas → prefixamos a fonte)
const archKey = (source: Source, id: string): string => `${source}:${id}`;

// nomes customizados pelo usuário: { "fonte:id": "título" }
const readNames = (): Record<string, string> => {
  const o = readJson<any>(NAMES_FILE, {});
  return o && typeof o === 'object' ? o : {};
};
const writeNames = (names: Record<string, string>): void => writeJsonAtomic(NAMES_FILE, names);

// IDs arquivados pelo usuário (só pra organizar a visão — não toca nos .jsonl)
const readArchived = (): Set<string> => {
  const arr = readJson<string[]>(ARCHIVE_FILE, []);
  return new Set(Array.isArray(arr) ? arr : []);
};
const writeArchived = (set: Set<string>): void => writeJsonAtomic(ARCHIVE_FILE, [...set]);

// nome de pasta -> caminho (fallback; o cwd lido do .jsonl é a fonte real)
export const decodeDir = (d: string): string => '/' + d.replace(/^-/, '').replace(/-/g, '/');

// desfaz o escape JSON do valor capturado pelo grep
export const unescapeJson = (s: string): string => {
  const clean = s.replace(/\\+$/, ''); // tira barra solta de um corte do grep
  try {
    return JSON.parse(`"${clean}"`);
  } catch {
    return clean.replace(/\\n/g, ' ').replace(/\\"/g, '"');
  }
};

// Cache por arquivo (path -> {mtime, autoTitle, folder, lastMsg}): pula o grep/
// leitura de arquivos que não mudaram desde o último scan. Como título e cwd
// vêm do conteúdo, mtime igual ⇒ resultado igual. Vale tanto pro Claude quanto
// pro Codex (que lê 512KB por arquivo). Entradas de arquivos sumidos são podadas.
type Parsed = { autoTitle: string; folder: string; lastMsg: string; origin: string; usage: Usage };
const claudeCache = new Map<string, { mtime: number } & Parsed>();
const codexCache = new Map<string, { mtime: number } & Parsed>();
const pruneCache = (cache: Map<string, unknown>, alivePaths: Iterable<string>): void => {
  const alive = new Set(alivePaths);
  for (const k of cache.keys()) if (!alive.has(k)) cache.delete(k);
};

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
// grep em massa de um campo JSON, com duas correções sobre a versão ingênua:
// (1) lotea os arquivos (≤400/chamada) pra não estourar ARG_MAX — senão o grep
//     falha, sh() devolve '' e TODAS as sessões viram "(sem título)" sem erro;
// (2) regex tolera aspas escapadas (\") dentro do valor, que truncavam títulos.
const grepField = (paths: string[], field: string, keep: 'first' | 'last'): Map<string, string> => {
  const map = new Map<string, string>();
  const flag = keep === 'first' ? '-m1 ' : '';
  for (const part of chunk(paths, 400)) {
    const flist = part.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
    const out = sh(`grep ${flag}-aoHE '"${field}":"([^"\\\\]|\\\\.)*"' ${flist}`);
    for (const line of out.split('\n')) {
      const m = line.match(/^(.+?):"[^"]+":"((?:[^"\\]|\\.)*)"$/);
      if (!m) continue;
      if (keep === 'first' && map.has(m[1])) continue;
      map.set(m[1], m[2]);
    }
  }
  return map;
};
// soma os tokens de todos os registros "usage" do arquivo. Cada turno do assistant
// tem "usage":{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens,...}.
const RE_IN = /"input_tokens":(\d+)/, RE_OUT = /"output_tokens":(\d+)/;
const RE_CC = /"cache_creation_input_tokens":(\d+)/, RE_CR = /"cache_read_input_tokens":(\d+)/;
const grepUsage = (paths: string[]): Map<string, Usage> => {
  const map = new Map<string, Usage>();
  for (const part of chunk(paths, 400)) {
    const flist = part.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
    // [^}]*} casa até o 1º '}': os 4 campos de token vêm antes do server_tool_use aninhado.
    const out = sh(`grep -aoH '"usage":{[^}]*}' ${flist}`);
    for (const line of out.split('\n')) {
      const at = line.indexOf(':"usage":{');
      if (at < 0) continue;
      const path = line.slice(0, at);
      const m = line.slice(at + 1);
      const n = (re: RegExp) => { const x = m.match(re); return x ? +x[1] : 0; };
      let u = map.get(path);
      if (!u) { u = { in: 0, out: 0, cc: 0, cr: 0, turns: 0 }; map.set(path, u); }
      u.in += n(RE_IN); u.out += n(RE_OUT); u.cc += n(RE_CC); u.cr += n(RE_CR); u.turns += 1;
    }
  }
  return map;
};
// trecho legível da última mensagem: lê só o fim do arquivo (8KB) e pega o último
// "text" — barato e independente do tamanho da sessão (não grepa o corpo inteiro).
const lastMessage = async (path: string, size: number): Promise<string> => {
  try {
    const tail = await Bun.file(path).slice(Math.max(0, size - 8192)).text();
    const all = [...tail.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)];
    if (!all.length) return '';
    return unescapeJson(all[all.length - 1][1]).replace(/\s+/g, ' ').trim().slice(0, 140);
  } catch {
    return '';
  }
};

// ─── Claude Code: ~/.claude/projects/<pasta>/<uuid>.jsonl ────────────────
const claudeSessions = async (archived: Set<string>, names: Record<string, string>, flags: Flags): Promise<Session[]> => {
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }

  const files: { path: string; id: string; dir: string; mtime: number; size: number }[] = [];
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
        if (st.isFile()) files.push({ path, id: e.slice(0, -6), dir: d, mtime: st.mtimeMs, size: st.size });
      } catch {
        /* sumiu no meio do caminho */
      }
    }
  }
  if (!files.length) return [];

  // só relê (grep + leitura de cauda) os arquivos cujo mtime mudou; o resto sai do cache.
  const stale = files.filter((f) => claudeCache.get(f.path)?.mtime !== f.mtime);
  if (stale.length) {
    const paths = stale.map((f) => f.path);
    const cwds = grepField(paths, 'cwd', 'first');
    const titles = grepField(paths, 'aiTitle', 'last'); // aiTitle é reescrito ao longo da sessão → pega o último
    const prompts = grepField(paths, 'text', 'first');
    const origins = grepField(paths, 'entrypoint', 'first'); // onde a sessão começou (cli/claude-vscode)
    const usages = grepUsage(paths);
    await Promise.all(
      stale.map(async (f) => {
        // sem cwd, o grep não conseguiu ler este arquivo (permissão/erro transitório):
        // NÃO cacheia — deixa stale pra reler na próxima, em vez de grudar '(sem título)'.
        if (!cwds.has(f.path)) return;
        const ai = titles.get(f.path);
        const first = prompts.get(f.path);
        const autoTitle = ai
          ? unescapeJson(ai)
          : first
            ? unescapeJson(first).replace(/\s+/g, ' ').slice(0, 90).trim() || '(sem título)'
            : '(sem título)';
        const folder = unescapeJson(cwds.get(f.path)!);
        const lastMsg = await lastMessage(f.path, f.size);
        claudeCache.set(f.path, { mtime: f.mtime, autoTitle, folder, lastMsg, origin: origins.get(f.path) ?? '', usage: usages.get(f.path) ?? null });
      }),
    );
  }
  pruneCache(claudeCache, files.map((f) => f.path));

  // lê do cache de forma defensiva: outra chamada concorrente a sessions() pode ter
  // podado uma entrada entre o await acima e aqui (Map global compartilhado), então
  // um fallback evita o crash de `.get(...)!` undefined em vez de derrubar a request.
  return files.map((f): Session => {
    const c = claudeCache.get(f.path) ?? { autoTitle: '(sem título)', folder: decodeDir(f.dir), lastMsg: '', origin: '', usage: null };
    const key = archKey('claude', f.id);
    const custom = names[key];
    return { id: f.id, title: custom ?? c.autoTitle, autoTitle: c.autoTitle, renamed: custom != null, folder: c.folder, lastMsg: c.lastMsg, origin: c.origin, usage: c.usage, mtime: f.mtime, archived: archived.has(key), fav: flags.fav.has(key), pinned: flags.pin.has(key), live: false, source: 'claude' };
  });
};

// ─── Codex: ~/.codex/sessions/AAAA/MM/DD/rollout-<ts>-<uuid>.jsonl ────────
// Sem aiTitle: o título vem do 1º texto do usuário que não seja um bloco de
// contexto/instrução (<environment_context>, etc.). O cwd está no session_meta.
export const codexMeta = (head: string): { cwd?: string; title?: string } => {
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
      let cached = codexCache.get(path);
      if (!cached || cached.mtime !== mtime) {
        let head = '';
        try {
          head = await Bun.file(path).slice(0, 524288).text(); // só o começo: o 1º prompt aparece em ~6–8KB
        } catch {
          /* ignora */
        }
        const { cwd, title } = codexMeta(head);
        cached = { mtime, autoTitle: title || '(sem título)', folder: cwd ?? '—', lastMsg: '', origin: '', usage: null };
        codexCache.set(path, cached);
      }
      const key = archKey('codex', id);
      const custom = names[key];
      return { id, title: custom ?? cached.autoTitle, autoTitle: cached.autoTitle, renamed: custom != null, folder: cached.folder, lastMsg: cached.lastMsg, origin: cached.origin, usage: cached.usage, mtime, archived: archived.has(key), fav: flags.fav.has(key), pinned: flags.pin.has(key), live: false, source: 'codex' };
    }),
  );
  pruneCache(codexCache, paths);
  return out.filter((s): s is Session => s !== null);
};

const sessions = async (want: Record<Source, boolean>): Promise<Session[]> => {
  const archived = readArchived();
  const names = readNames();
  const flags = readFlags();
  const all: Session[] = [];
  if (want.claude) all.push(...(await claudeSessions(archived, names, flags)));
  if (want.codex) all.push(...(await codexSessions(archived, names, flags)));
  // "ativa agora": id citado por um processo vivo (ex. claude --resume <id>) ou
  // arquivo escrito nos últimos 90s (sendo gravado neste momento).
  const live = liveSessionIds();
  const now = Date.now();
  for (const s of all) s.live = live.has(s.id.toLowerCase()) || now - s.mtime < 90_000;
  return all.sort((a, b) => b.mtime - a.mtime);
};

// ─── Conta logada no Claude ──────────────────────────────────────────────
// Lê o e-mail/org/plano de ~/.claude.json (multiplataforma) e a presença do
// login OAuth em ~/.claude/.credentials.json. NUNCA devolve o token em si.
const prettyPlan = (tier?: string, sub?: string): string => {
  const m = tier?.match(/max_(\d+x)/i);
  if (m) return 'Max ' + m[1];
  if (tier && /pro/i.test(tier)) return 'Pro';
  if (tier && /free/i.test(tier)) return 'Free';
  return sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : '';
};
const claudeAccount = () => {
  const cfg = readJson<any>(join(homedir(), '.claude.json'), {});
  const acc = cfg?.oauthAccount ?? {};
  const creds = readJson<any>(join(homedir(), '.claude', '.credentials.json'), {});
  const oauth = creds?.claudeAiOauth;
  return {
    loggedIn: !!oauth || !!acc.emailAddress,
    email: acc.emailAddress ?? null,
    name: acc.displayName ?? null,
    org: acc.organizationName ?? null,
    plan: prettyPlan(acc.userRateLimitTier, oauth?.subscriptionType),
    expiresAt: typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null, // só o timestamp, sem o token
  };
};

// ─── Conta logada no Codex (~/.codex/auth.json) ──────────────────────────
// Login via ChatGPT guarda um id_token (JWT) com email/plano nos claims. Decodifica
// só o payload (que NÃO é segredo) pra exibir; nunca devolve o token em si.
const decodeJwt = (jwt?: string): any => {
  try {
    const seg = (jwt ?? '').split('.')[1];
    if (!seg) return {};
    return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
};
const codexAccount = () => {
  const a = readJson<any>(join(homedir(), '.codex', 'auth.json'), {});
  const tok = a?.tokens ?? {};
  const claims = decodeJwt(tok.id_token);
  const planRaw = claims?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? '';
  const plan = planRaw ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1) : a?.OPENAI_API_KEY ? 'API key' : '';
  return {
    loggedIn: !!tok.id_token || !!a?.OPENAI_API_KEY,
    email: claims?.email ?? null,
    plan,
  };
};
const account = () => ({ claude: claudeAccount(), codex: codexAccount() });

// ─── Importar / Exportar sessões ─────────────────────────────────────────
// Codifica um caminho no nome de pasta que o Claude usa em ~/.claude/projects
// (cada char fora de [A-Za-z0-9] vira '-'). Ex.: /home/h/efex -> -home-h-efex
export const encodeProject = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-');
export const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const occurrences = (text: string, sub: string): number => (sub ? text.split(sub).length - 1 : 0);

// contém um caminho dentro de uma base (anti path-traversal): true só se o
// alvo resolvido é a própria base ou está abaixo dela.
const within = (base: string, target: string): boolean => {
  const r = resolve(target);
  return r === resolve(base) || r.startsWith(resolve(base) + sep);
};

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
export const mask = (s: string): string => (s.length <= 10 ? s.slice(0, 3) + '…' : s.slice(0, 6) + '…' + s.slice(-3));
export const scanSecrets = (text: string): { kind: string; count: number; sample: string }[] => {
  const out: { kind: string; count: number; sample: string }[] = [];
  for (const [kind, re] of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m?.length) out.push({ kind, count: m.length, sample: mask(m[0]) });
  }
  return out;
};

// Apontamentos que o remap automático (home/cwd) não cobre: homes de outros
// usuários, drives externos, caminhos Windows. São os que pedem decisão manual.
export const foreignPointers = (text: string, oldUser: string): { path: string; count: number }[] => {
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
export const BOUNDARY = '(?=$|[/"\'\\\\\\s:?<>),;])';
export const remapContent = (
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

// ─── Detalhes de uma sessão (modal "ℹ") ──────────────────────────────────
// Lê o .jsonl e junta o que é fácil de coletar e existe em toda sessão.
const humanSize = (n: number): string =>
  n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
const fmtMs = (ms: number): string => { try { return new Date(ms).toLocaleString('pt-BR'); } catch { return ''; } };
const fmtTs = (s: string): string => { const d = Date.parse(s); return Number.isNaN(d) ? s : new Date(d).toLocaleString('pt-BR'); };
const nf = (n: number): string => n.toLocaleString('pt-BR');

const sessionInfo = (source: Source, id: string): { ok: boolean; title?: string; source?: Source; resume?: string; rows?: { k: string; v: string }[] } => {
  const loc = source === 'codex' ? locateCodex(id) : locateClaude(id);
  if (!loc) return { ok: false };
  const path = loc.path;
  let st: ReturnType<typeof statSync>;
  try { st = statSync(path); } catch { return { ok: false }; }
  const created = st.birthtimeMs && st.birthtimeMs > 1000 ? st.birthtimeMs : st.ctimeMs;
  const big = st.size > 64 * 1024 * 1024;
  let content = '';
  if (!big) { try { content = readFileSync(path, 'utf8'); } catch {} }
  const recs = content ? content.split('\n') : [];
  const custom = readNames()[archKey(source, id)];
  const rows: { k: string; v: string }[] = [];
  const add = (k: string, v: any) => { if (v != null && v !== '') rows.push({ k, v: String(v) }); };
  let title = '', cwd = '', resume = '';

  if (source === 'claude') {
    let version = '', branch = '', aiTitle = '', firstPrompt = '', firstTs = '', lastTs = '', entry = '';
    const models = new Set<string>();
    let uc = 0, ac = 0, uin = 0, uout = 0, ucc = 0, ucr = 0, turns = 0;
    for (const line of recs) {
      if (!line.trim()) continue;
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      if (o.version) version = o.version;
      if (o.gitBranch) branch = o.gitBranch;
      if (o.cwd && !cwd) cwd = o.cwd;
      if (o.entrypoint && !entry) entry = o.entrypoint;
      if (o.aiTitle) aiTitle = o.aiTitle;
      if (o.timestamp) { if (!firstTs) firstTs = o.timestamp; lastTs = o.timestamp; }
      if (o.type === 'user') uc++;
      if (o.type === 'assistant') ac++;
      const m = o.message;
      if (m?.model) models.add(m.model);
      const u = m?.usage;
      if (u) { turns++; uin += u.input_tokens || 0; uout += u.output_tokens || 0; ucc += u.cache_creation_input_tokens || 0; ucr += u.cache_read_input_tokens || 0; }
      if (!firstPrompt && o.type === 'user' && typeof m?.content === 'string') firstPrompt = m.content;
    }
    if (!cwd) cwd = decodeDir((loc as { projectDir: string }).projectDir);
    title = custom || aiTitle || firstPrompt.replace(/\s+/g, ' ').slice(0, 80).trim() || '(sem título)';
    const origin = entry === 'claude-vscode' ? 'VS Code' : entry === 'cli' ? 'terminal' : entry === 'sdk-cli' ? 'SDK' : '';
    resume = `cd ${JSON.stringify(cwd)} && claude --resume ${id}`;
    add('Fonte', 'Claude Code');
    add('Título', title);
    if (custom && aiTitle && custom !== aiTitle) add('Título automático', aiTitle);
    add('ID', id);
    add('Pasta', cwd);
    add('Origem', origin);
    add('Branch git', branch);
    add('Versão (Claude Code)', version);
    add('Modelo(s)', [...models].join(', '));
    add('Criado', fmtMs(created));
    add('Modificado', fmtMs(st.mtimeMs));
    add('1ª atividade', firstTs && fmtTs(firstTs));
    add('Última atividade', lastTs && fmtTs(lastTs));
    add('Mensagens', big ? '— (arquivo grande)' : `${uc + ac} (${uc} suas, ${ac} do assistente)`);
    if (turns) add('Tokens', `saída ${nf(uout)} · entrada ${nf(uin)} · cache ${nf(ucc + ucr)} · ${turns} turnos`);
    add('Tamanho', humanSize(st.size));
    add('Arquivo', path);
  } else {
    let cliVer = '', originator = '', model = '', firstTs = '', lastTs = '', firstText = '', msgs = 0, cxin = 0, cxout = 0;
    for (const line of recs) {
      if (!line.trim()) continue;
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      const p = o.payload ?? {};
      if (o.type === 'session_meta') { if (p.cwd) cwd = p.cwd; if (p.cli_version) cliVer = p.cli_version; if (p.originator) originator = p.originator; }
      const ts = o.timestamp || p.timestamp;
      if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
      if (p.model && !model) model = p.model;
      if (p.type === 'message') {
        msgs++;
        if (!firstText && p.role === 'user' && Array.isArray(p.content)) {
          const c = p.content.find((x: any) => x?.type === 'input_text' && typeof x.text === 'string' && !x.text.startsWith('<'));
          if (c) firstText = c.text;
        }
      }
      if (p.type === 'token_count' && p.info?.total_token_usage) { cxin = p.info.total_token_usage.input_tokens ?? cxin; cxout = p.info.total_token_usage.output_tokens ?? cxout; }
    }
    title = custom || firstText.replace(/\s+/g, ' ').slice(0, 80).trim() || '(sem título)';
    resume = `cd ${JSON.stringify(cwd || '.')} && codex resume ${id}`;
    add('Fonte', 'Codex');
    add('Título', title);
    add('ID', id);
    add('Pasta', cwd);
    add('Originador', originator);
    add('Versão (Codex CLI)', cliVer);
    add('Modelo', model);
    add('Criado', fmtMs(created));
    add('Modificado', fmtMs(st.mtimeMs));
    add('1ª atividade', firstTs && fmtTs(firstTs));
    add('Última atividade', lastTs && fmtTs(lastTs));
    add('Mensagens', big ? '— (arquivo grande)' : String(msgs));
    if (cxin || cxout) add('Tokens', `saída ${nf(cxout)} · entrada ${nf(cxin)}`);
    add('Tamanho', humanSize(st.size));
    add('Arquivo', path);
  }
  return { ok: true, title, source, resume, rows };
};

// ─── Seletor de pasta nativo do SO ───────────────────────────────────────
const hasBin = (bin: string): boolean => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
// abre o diálogo nativo (zenity/kdialog/yad) e devolve o caminho absoluto escolhido.
// async (spawn) pra não travar o servidor enquanto o diálogo está aberto.
const pickFolder = (): Promise<{ ok: boolean; path?: string; error?: string }> => {
  const tools: [string, string[]][] = [
    ['zenity', ['--file-selection', '--directory', '--title=Escolha a pasta']],
    ['kdialog', ['--getexistingdirectory', homedir()]],
    ['yad', ['--file', '--directory']],
  ];
  const tool = tools.find(([bin]) => hasBin(bin));
  if (!tool) return Promise.resolve({ ok: false, error: 'sem seletor de pasta (instale zenity, kdialog ou yad)' });
  const [bin, args] = tool;
  return new Promise((resolve) => {
    try {
      const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout?.on('data', (d) => { out += d.toString(); });
      p.on('close', () => resolve({ ok: true, path: out.trim() })); // path vazio = cancelou
      p.on('error', () => resolve({ ok: false, error: 'falha ao abrir o seletor' }));
    } catch {
      resolve({ ok: false, error: 'falha ao abrir o seletor' });
    }
  });
};

// ─── Nova sessão: abre claude/codex num terminal, na pasta escolhida ──────
// São TUIs interativas, então precisam de um terminal de verdade (não dá detached).
// `bash -ic` usa shell interativo → carrega o PATH do usuário (nvm etc.) e acha o agente.
// aspas simples seguras pra shell (paths com espaço/$/aspas)
const shq = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

// Abre UMA sessão na pasta-raiz `folder`. `addDirs` são repos extras do workspace que
// a sessão também enxerga — Claude via `--add-dir <d...>`, Codex via `--add-dir <d>` repetido
// (o equivalente, no terminal, ao multi-root do VS Code: uma sessão ciente de vários repos).
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'minimal'];
const CLAUDE_MODES = ['default', 'acceptEdits', 'plan', 'auto']; // --permission-mode
const CODEX_MODES: Record<string, string> = { ask: '-a untrusted', approve: '-a on-request', full: '--dangerously-bypass-approvals-and-sandbox' };
const newSession = (source: Source, folder: string, addDirs: string[] = [], opts: { model?: string; effort?: string; mode?: string } = {}): boolean => {
  if (!folder || !existsSync(folder)) return false;
  const agent = source === 'codex' ? 'codex' : 'claude';
  const dirs = [...new Set(addDirs)].filter((d) => d && d !== folder && existsSync(d));
  const addPart = !dirs.length
    ? ''
    : source === 'codex'
      ? ' ' + dirs.map((d) => '--add-dir ' + shq(d)).join(' ')
      : ' --add-dir ' + dirs.map(shq).join(' ');
  // modelo/effort opcionais (o "padrão" daquela sessão). Tudo via shq → imune a injeção.
  const model = /^[A-Za-z0-9._-]{1,60}$/.test(opts.model ?? '') ? (opts.model as string) : '';
  const effort = EFFORTS.includes(opts.effort ?? '') ? (opts.effort as string) : '';
  let optPart = '';
  if (model) optPart += ' --model ' + shq(model);
  if (effort) optPart += source === 'codex' ? ' -c ' + shq('model_reasoning_effort=' + effort) : ' --effort ' + shq(effort);
  // modo de permissão/aprovação (Claude --permission-mode; Codex flags de approval/sandbox)
  const mode = opts.mode ?? '';
  if (mode) {
    if (source === 'codex') { if (CODEX_MODES[mode]) optPart += ' ' + CODEX_MODES[mode]; }
    else if (CLAUDE_MODES.includes(mode)) optPart += ' --permission-mode ' + shq(mode);
  }
  const run = agent + optPart + addPart;             // ex.: claude --model 'opus' --effort 'high' --add-dir '/a'
  const inner = 'cd ' + shq(folder) + ' && ' + run;
  const launch = (bin: string, args: string[]): boolean => {
    try { spawn(bin, args, { detached: true, stdio: 'ignore' }).unref(); return true; } catch { return false; }
  };
  if (hasBin('gnome-terminal')) return launch('gnome-terminal', ['--working-directory=' + folder, '--', 'bash', '-ic', run]);
  for (const t of ['kgx', 'konsole', 'tilix', 'xfce4-terminal', 'x-terminal-emulator', 'xterm']) {
    if (hasBin(t)) return launch(t, ['-e', 'bash', '-ic', inner]);
  }
  return false;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// `bun server.ts` sobe o servidor; `import` (ex. nos testes) não — só expõe as funções puras.
if (import.meta.main) {
Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);

    // CSRF: bloqueia POSTs de outra origem (kill/open/import). req.json() aceita
    // corpo text/plain (simple request, sem preflight), então Origin/Sec-Fetch-Site
    // é a barreira contra páginas web maliciosas — navegador sempre manda Origin em
    // POST cross-origin e Sec-Fetch-Site em toda request, então o ataque real é
    // barrado. (Um cliente local sem headers — curl/script — ainda passa, mas isso
    // exige acesso local à máquina, fora do modelo de ameaça do navegador.)
    if (req.method === 'POST') {
      const origin = req.headers.get('origin');
      const site = req.headers.get('sec-fetch-site');
      if ((origin && !ALLOWED_ORIGINS.has(origin)) || (site && site !== 'same-origin')) {
        return json({ ok: false, error: 'origem não permitida' }, 403);
      }
    }

    if (url.pathname === '/api/account') {
      return json(account());
    }

    if (url.pathname === '/api/session-info') {
      const source: Source = url.searchParams.get('source') === 'codex' ? 'codex' : 'claude';
      const id = url.searchParams.get('id') ?? '';
      if (!/^[A-Za-z0-9._-]+$/.test(id)) return json({ ok: false, error: 'id inválido' }, 400);
      try { return json(sessionInfo(source, id)); } catch (e: any) { return json({ ok: false, error: String(e?.message ?? e) }, 500); }
    }

    if (url.pathname === '/api/state') {
      try {
        return json({ tasks: tasks(), containers: containers(), now: Date.now() });
      } catch (e: any) {
        return json({ tasks: [], containers: [], now: Date.now(), error: String(e?.message ?? e) }, 500);
      }
    }

    if (url.pathname === '/api/sessions') {
      const src = url.searchParams.get('sources') ?? 'claude'; // default: só Claude
      const want: Record<Source, boolean> = { claude: src.includes('claude'), codex: src.includes('codex') };
      try {
        return json({ sessions: await sessions(want), now: Date.now() });
      } catch (e: any) {
        return json({ sessions: [], now: Date.now(), error: String(e?.message ?? e) }, 500);
      }
    }

    if (url.pathname === '/api/open' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { folder?: string; session?: string; source?: Source };
      if (!body.folder || typeof body.folder !== 'string') return json({ ok: false, error: 'folder requerido' }, 400);
      // '--' garante que um folder começando com '-' seja tratado como caminho, não flag do `code`.
      runBg('code', ['--', body.folder]); // abre a pasta no VS Code sem passar pelo shell
      // Claude: além da pasta, abre a conversa na extensão via deep link. A extensão
      // do Claude Code registra um URI handler vscode://anthropic.claude-code/open?session=<id>;
      // a sessão tem que pertencer ao workspace aberto, então disparamos depois que a
      // pasta abriu (o setTimeout vive no processo do servidor, que é de longa duração).
      if (body.source !== 'codex' && typeof body.session === 'string' && /^[A-Za-z0-9._-]+$/.test(body.session)) {
        const uri = `vscode://anthropic.claude-code/open?session=${body.session}`;
        const opener = platform() === 'darwin' ? 'open' : 'xdg-open';
        setTimeout(() => runBg(opener, [uri]), 1500); // sem shell — argv direto
      }
      return json({ ok: true });
    }

    if (url.pathname === '/api/export' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { items?: { source: Source; id: string }[]; scanSecrets?: boolean };
      const items = Array.isArray(body.items) ? body.items : [];
      const sessions = buildExport(items, body.scanSecrets !== false);
      return json({
        format: 'agentdeck/sessions',
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
      // aceita o formato novo e o antigo (claude-control) pra não quebrar bundles já exportados
      if (!bundle || (bundle.format !== 'agentdeck/sessions' && bundle.format !== 'claude-control/sessions') || !Array.isArray(bundle.sessions)) {
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
          const base = s.source === 'claude' ? PROJECTS_DIR : CODEX_DIR;
          const target =
            s.source === 'claude'
              ? join(PROJECTS_DIR, encodeProject(newCwd), s.id + '.jsonl')
              : join(CODEX_DIR, s.relPath ?? `${s.id}.jsonl`);
          // o bundle é controlado por quem o gerou: id/relPath com ../ poderiam
          // gravar fora do diretório base (ex. ~/.bashrc). Rejeita o que escapa.
          const idOk =
            s.source === 'claude'
              ? /^[A-Za-z0-9._-]+$/.test(s.id)
              : !!s.relPath && !s.relPath.includes('..') && /^[\w./-]+\.jsonl$/.test(s.relPath);
          if (!idOk || !within(base, target)) {
            return { key, id: s.id, source: s.source, ok: false, error: 'caminho inseguro no bundle (rejeitado)' };
          }
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
          // re-deriva do conteúdo real em vez de confiar nos campos do bundle (um
          // bundle pode declarar "sem segredos" e mesmo assim trazer chaves no content).
          foreign: foreignPointers(s.content, oldUser),
          secrets: scanSecrets(s.content),
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
        if (typeof body.container !== 'string' || !/^[A-Za-z0-9][\w.-]*$/.test(body.container)) return json({ ok: false, error: 'container inválido' }, 400);
        run('docker', ['stop', body.container]);
        return json({ ok: true });
      }
      if (body.port != null) {
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return json({ ok: false, error: 'porta inválida' }, 400);
        run('fuser', ['-k', `${port}/tcp`]);
        return json({ ok: true });
      }
      if (body.pid != null) {
        const pid = Number(body.pid);
        if (!Number.isInteger(pid) || pid <= 1) return json({ ok: false, error: 'pid inválido' }, 400);
        // só mata o que ainda aparece como tarefa — reconfirma a assinatura num ps
        // fresco, fechando DoS por CSRF e a corrida de PID reusado.
        if (!tasks().some((t) => t.pid === pid)) return json({ ok: false, error: 'pid não é um processo gerenciado' }, 403);
        return json(killTree(pid));
      }
      return json({ ok: false, error: 'pid|port|container requerido' }, 400);
    }

    // inicia um processo: pasta + comando digitados pelo usuário no painel (exec local
    // intencional, como um terminal; o guard de CSRF impede que outra página dispare isto).
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { cmd?: string; folder?: string };
      const cmd = (body.cmd ?? '').trim();
      const folder = (body.folder ?? '').trim();
      if (!cmd) return json({ ok: false, error: 'comando requerido' }, 400);
      if (!folder || !existsSync(folder)) return json({ ok: false, error: 'pasta inexistente' }, 400);
      const log = runTask(cmd, folder);
      if (log) recordHistory(cmd, folder, log); // só registra os iniciados pela própria plataforma
      return json({ ok: !!log, log });
    }

    // tail do log de um processo iniciado pelo AgentDeck (pra ver erro/saída)
    if (url.pathname === '/api/task-log') {
      const path = url.searchParams.get('path') ?? '';
      return json({ ok: true, text: readTaskLog(path) });
    }

    // histórico de processos iniciados pela plataforma
    if (url.pathname === '/api/history') {
      return json({ items: historySorted() });
    }

    // ── Workspaces ──
    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { name?: string; folders?: string[] };
      const ok = saveWorkspace(body.name ?? '', Array.isArray(body.folders) ? body.folders : []);
      return json({ ok, error: ok ? undefined : 'nome e ao menos uma pasta válida são necessários' });
    }
    if (url.pathname === '/api/workspaces') {
      return json({ items: readWorkspaces() });
    }
    if (url.pathname === '/api/workspaces/delete' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      deleteWorkspace(body.name ?? '');
      return json({ ok: true });
    }
    if (url.pathname === '/api/open-workspace' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      const ws = readWorkspaces().find((w) => w.name === body.name);
      if (!ws || !ws.folders.length) return json({ ok: false, error: 'workspace vazio' }, 400);
      runBg('code', ['--', ...ws.folders]); // abre todas as pastas numa janela multi-root do VS Code
      return json({ ok: true });
    }
    if (url.pathname === '/api/history/pin' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { cmd?: string; folder?: string; on?: boolean };
      const items = readHistory();
      const it = items.find((x) => x.cmd === body.cmd && x.folder === body.folder);
      if (it) { it.pinned = !!body.on; writeJsonAtomic(HISTORY_FILE, items); }
      return json({ ok: !!it });
    }

    // reinicia o próprio servidor: re-lança a si mesmo (após a porta liberar) e sai.
    // abre o seletor de pasta nativo do SO e devolve o caminho escolhido
    if (url.pathname === '/api/pick-folder' && req.method === 'POST') {
      return json(await pickFolder());
    }

    // nova sessão: abre claude/codex num terminal, na pasta escolhida
    if (url.pathname === '/api/new-session' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { source?: Source; folder?: string; addDirs?: string[]; model?: string; effort?: string; mode?: string };
      const source: Source = body.source === 'codex' ? 'codex' : 'claude';
      const folder = (body.folder ?? '').trim();
      const addDirs = Array.isArray(body.addDirs) ? body.addDirs.map((d) => String(d).trim()).filter(Boolean) : [];
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      const effort = typeof body.effort === 'string' ? body.effort.trim() : '';
      const mode = typeof body.mode === 'string' ? body.mode.trim() : '';
      if (!folder || !existsSync(folder)) return json({ ok: false, error: 'pasta inexistente' }, 400);
      return json({ ok: newSession(source, folder, addDirs, { model, effort, mode }) });
    }

    // reinicia: mata o processo atual e re-roda o mesmo comando na mesma pasta.
    if (url.pathname === '/api/restart' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { pid?: number };
      const pid = Number(body.pid);
      if (!Number.isInteger(pid) || pid <= 1) return json({ ok: false, error: 'pid inválido' }, 400);
      const t = tasks().find((x) => x.pid === pid);
      if (!t) return json({ ok: false, error: 'pid não é um processo gerenciado' }, 403);
      const cmd = t.cmd, cwd = t.cwd;
      if (!cwd) return json({ ok: false, error: 'pasta do processo desconhecida' }, 400);
      killTree(pid);
      // pequeno atraso pra liberar a porta antes de subir de novo
      setTimeout(() => runTask(cmd, cwd), 600);
      return json({ ok: true });
    }

    return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});

console.log(`\n  AgentDeck → http://localhost:${PORT}\n  (Ctrl+C pra parar este painel — não afeta os processos do Claude)\n`);
}

const HTML = /* html */ `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AgentDeck</title>
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
    /* marca Claude — laranja fixo (não segue o acento dinâmico, pra identidade da fonte não mudar) */
    --claude-brand: oklch(72% 0.115 50); --claude-brand-soft: oklch(72% 0.115 50 / .15);
    /* marca Codex — verde fixo (chip de conta do Codex) */
    --codex-brand: oklch(75% 0.12 155); --codex-brand-soft: oklch(75% 0.12 155 / .15);
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
    --claude-brand: oklch(56% 0.14 45); --claude-brand-soft: oklch(56% 0.14 45 / .12);
    --codex-brand: oklch(50% 0.14 155); --codex-brand-soft: oklch(50% 0.14 155 / .12);
    --teal: oklch(52% 0.09 195); --teal-soft: oklch(52% 0.09 195 / .12);
    --green: oklch(54% 0.13 160); --red: oklch(55% 0.18 25); --red-soft: oklch(55% 0.18 25 / .12);
    --blue: oklch(52% 0.15 250); --blue-soft: oklch(52% 0.15 250 / .12);
  }
  /* acento dinâmico pelo mix de fontes: só Claude = clay (padrão), só Codex = verde,
     Claude+Codex = azul. Sobrescreve o trio --clay (que pinta tabs/botões/foco/etc.). */
  :root[data-accent="codex"] { --clay: oklch(75% 0.12 155); --clay-ink: oklch(24% 0.05 155); --clay-soft: oklch(75% 0.12 155 / .15); }
  :root[data-accent="both"]  { --clay: oklch(72% 0.12 245); --clay-ink: oklch(25% 0.05 245); --clay-soft: oklch(72% 0.12 245 / .15); }
  :root[data-theme="light"][data-accent="codex"] { --clay: oklch(50% 0.14 155); --clay-ink: oklch(99% 0.01 155); --clay-soft: oklch(50% 0.14 155 / .12); }
  :root[data-theme="light"][data-accent="both"]  { --clay: oklch(52% 0.16 250); --clay-ink: oklch(99% 0.01 250); --clay-soft: oklch(52% 0.16 250 / .12); }
  * { box-sizing:border-box; }
  /* scrollbar segue o acento dinâmico (--clay: laranja só-Claude / verde só-Codex / azul ambos|nenhum) */
  html { scrollbar-color: var(--clay) transparent; scrollbar-width: thin; } /* Firefox */
  ::-webkit-scrollbar { width:14px; height:14px; }                          /* Chromium: vertical + horizontal */
  ::-webkit-scrollbar-track { background:transparent; }
  ::-webkit-scrollbar-thumb { background:var(--clay); border-radius:999px; border:4px solid var(--bg); background-clip:padding-box; }
  ::-webkit-scrollbar-thumb:hover { border-width:3px; }
  ::-webkit-scrollbar-corner { background:transparent; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--body); font-size:15px; line-height:1.6; -webkit-font-smoothing:antialiased; min-height:100vh; }
  .wrap { max-width:880px; margin:0 auto; padding:var(--s6) var(--s4) var(--s7); }
  /* barra de painel offline: fixa no topo, sobre todas as abas */
  .offbar { position:fixed; top:0; left:0; right:0; z-index:100; display:none; align-items:center; justify-content:center; gap:var(--s3); padding:9px 16px; background:var(--red-soft); color:var(--red); border-bottom:1px solid color-mix(in oklch, var(--red) 45%, var(--line)); font-size:13px; font-weight:600; }
  .offbar.show { display:flex; }
  .offbar svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .offbar button { background:var(--red); color:var(--bg); border:0; border-radius:var(--r-sm); padding:5px 13px; font-family:var(--body); font-weight:600; font-size:12.5px; cursor:pointer; }
  .offbar button:hover { filter:brightness(1.08); }
  body.off { padding-top:42px; } /* abre espaço pra barra não cobrir o conteúdo */
  header { display:flex; align-items:center; gap:var(--s4); margin-bottom:var(--s5); position:relative; min-height:34px; }
  h1 { font-family:var(--display); font-weight:500; font-size:23px; letter-spacing:-.01em; margin:0; display:flex; align-items:center; gap:var(--s3); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); flex:none; }
  .dot.live { background:var(--green); }
  .sub { color:var(--muted); font-size:13px; font-variant-numeric:tabular-nums; }
  .tabs { display:flex; width:fit-content; gap:var(--s1); margin-bottom:var(--s5); border-bottom:1px solid var(--line); } /* linha só sob as abas, não até o fim */
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
  .cmd-sub { font-family:var(--mono); font-size:12px; color:var(--muted); margin-top:3px; word-break:break-all; display:-webkit-box; -webkit-line-clamp:1; line-clamp:1; -webkit-box-orient:vertical; overflow:hidden; }
  .meta { margin-top:var(--s2); display:flex; flex-wrap:wrap; gap:var(--s2); align-items:center; }
  .chip { font-size:12px; font-weight:500; padding:2px 9px; border-radius:999px; background:var(--surface-2); color:var(--muted); display:inline-flex; align-items:center; gap:6px; }
  .chip.port { color:var(--clay); background:var(--clay-soft); }
  .chip.up { color:var(--green); }
  .chip.pid { font-family:var(--mono); font-size:11.5px; }
  .chip.folder { font-family:var(--mono); font-size:11.5px; color:var(--ink); max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip.folder.clickable { cursor:pointer; }
  .chip.folder.clickable:hover { color:var(--clay); background:var(--clay-soft); }
  .chip.live { color:var(--green); background:color-mix(in oklch, var(--green) 15%, transparent); font-weight:600; }
  .lastmsg { color:var(--muted); font-size:12.5px; line-height:1.45; margin-top:4px; display:-webkit-box; -webkit-line-clamp:1; line-clamp:1; -webkit-box-orient:vertical; overflow:hidden; }
  .chip.src-claude, .chip.src-codex { font-weight:600; }
  .chip.src-claude { color:var(--claude-brand); background:var(--claude-brand-soft); }
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
  .btn-arch svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .btn-resume { background:var(--clay-soft); color:var(--clay); border-color:transparent; }
  .btn-resume:hover { background:var(--clay); color:var(--clay-ink); }
  .btn-resume svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .btn-resume.ok { background:var(--green); color:var(--bg); }
  .btn-icon { padding:7px; line-height:0; display:inline-flex; align-items:center; }
  .btn-vscode { background:var(--blue-soft); color:var(--blue); }
  .btn-vscode:hover { background:var(--blue); color:var(--bg); }
  .btn-vscode svg { width:15px; height:15px; fill:currentColor; }
  .btn-edit { background:transparent; color:var(--muted); border-color:var(--line); }
  .btn-edit:hover { color:var(--ink); border-color:var(--muted); background:var(--surface-2); }
  .btn-edit svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .btn-export { background:transparent; color:var(--muted); border-color:var(--line); }
  .btn-export:hover { color:var(--clay); border-color:var(--clay); background:var(--clay-soft); }
  .btn-export svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .btn-fav, .btn-pin { background:transparent; color:var(--muted); border-color:transparent; }
  .btn-fav:hover, .btn-pin:hover { color:var(--ink); background:var(--surface-2); }
  .btn-fav.on, .btn-pin.on { color:var(--clay); }
  .btn-fav svg, .btn-pin svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .btn-fav.on svg, .btn-pin.on svg { fill:currentColor; }
  .actions { display:flex; gap:var(--s2); flex-shrink:0; }
  /* card de sessão: ações em duas fileiras à direita (topo: ★ 📌 ⋮ / base: VS Code · retomar · arquivar) */
  .card.sess { align-items:stretch; }
  .side { display:flex; flex-direction:column; justify-content:space-between; align-items:flex-end; gap:var(--s3); flex-shrink:0; }
  .side-top, .side-bottom { display:flex; gap:var(--s2); }
  .kebab-wrap { position:relative; display:inline-flex; }
  .btn-kebab { background:transparent; color:var(--muted); border-color:transparent; }
  .btn-kebab:hover { color:var(--ink); background:var(--surface-2); }
  .btn-kebab svg { width:16px; height:16px; fill:currentColor; }
  .menu { position:absolute; top:calc(100% + 4px); right:0; min-width:184px; background:var(--surface); border:1px solid var(--line); border-radius:var(--r-sm); padding:4px; box-shadow:0 10px 28px oklch(0% 0 0 / .28); display:none; z-index:30; }
  .menu.open { display:block; animation:fade .12s ease-out; }
  .menu-item { display:flex; align-items:center; gap:8px; width:100%; text-align:left; background:transparent; border:0; color:var(--ink); font-family:var(--body); font-size:13px; font-weight:500; padding:8px 10px; border-radius:6px; cursor:pointer; white-space:nowrap; }
  .menu-item:hover { background:var(--surface-2); }
  .menu-item svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; flex:none; }
  .info-row { display:flex; gap:var(--s4); padding:7px 0; border-top:1px solid var(--line); font-size:13px; }
  .info-row:first-child { border-top:0; }
  .info-k { flex:none; width:150px; color:var(--muted); }
  .info-v { flex:1; min-width:0; color:var(--ink); word-break:break-word; }
  .info-v.mono { font-family:var(--mono); font-size:12px; }
  .hist-list { display:flex; flex-direction:column; gap:var(--s2); }
  .hist-list.scroll { max-height:56vh; overflow-y:auto; padding-right:4px; }
  .hist-row { display:flex; align-items:center; gap:var(--s3); padding:8px 10px; border:1px solid var(--line); border-radius:var(--r-sm); background:var(--bg); }
  .hist-main { flex:1; min-width:0; }
  .hist-cmd { font-family:var(--mono); font-size:13px; color:var(--ink); word-break:break-all; }
  .hist-folder { font-family:var(--mono); font-size:11.5px; color:var(--muted); word-break:break-all; margin-top:2px; }
  .btn-play { background:var(--clay-soft); color:var(--clay); border-color:transparent; }
  .btn-play:hover { background:var(--clay); color:var(--clay-ink); }
  .btn-play svg { width:15px; height:15px; fill:currentColor; }
  .logbox { margin:0; max-height:60vh; overflow:auto; background:var(--bg); border:1px solid var(--line); border-radius:var(--r-sm); padding:var(--s3); font-family:var(--mono); font-size:12px; line-height:1.5; color:var(--ink); white-space:pre-wrap; word-break:break-word; }
  .logbox:empty::before { content:'(sem saída ainda)'; color:var(--muted); }
  .card.dim { opacity:.55; }
  .card.dim:hover { opacity:1; }
  .srcbar { display:flex; gap:var(--s2); margin-bottom:var(--s3); }
  .src { display:inline-flex; align-items:center; gap:var(--s2); padding:7px 14px; border-radius:999px; border:1px solid var(--line); background:transparent; color:var(--muted); font-family:var(--body); font-weight:600; font-size:12.5px; cursor:pointer; transition:.15s; }
  .src .ico { width:15px; height:15px; fill:currentColor; flex:none; }
  .src:hover { color:var(--ink); }
  #src-claude.on { background:var(--claude-brand-soft); border-color:transparent; color:var(--claude-brand); }
  #src-codex.on { background:var(--teal-soft); border-color:transparent; color:var(--teal); }
  .new-sess { margin-left:auto; } /* empurra pro fim da barra de fontes */
  .new-sess:hover { color:var(--clay); border-color:var(--clay); }
  .newsess-actions { display:flex; gap:var(--s2); margin-top:var(--s4); }
  .newsess-actions .btn { flex:1; justify-content:center; padding:10px; font-size:14px; display:flex; align-items:center; gap:var(--s2); }
  .ns-claude { background:var(--claude-brand-soft); color:var(--claude-brand); } .ns-claude:hover { filter:brightness(1.1); }
  .ns-codex { background:var(--teal-soft); color:var(--teal); } .ns-codex:hover { filter:brightness(1.1); }
  .row { display:flex; align-items:baseline; justify-content:space-between; gap:var(--s3); }
  .title { font-size:15px; font-weight:600; line-height:1.4; color:var(--ink); word-break:break-word; }
  .title-wrap { display:flex; align-items:center; gap:6px; min-width:0; }
  .title-wrap .title { min-width:0; }
  .title-wrap .btn-edit { padding:3px; border-color:transparent; opacity:.4; flex:none; }
  .card:hover .title-wrap .btn-edit { opacity:.7; }
  .title-wrap .btn-edit:hover { opacity:1; background:var(--surface-2); }
  .title-edit { font-family:var(--body); font-size:15px; font-weight:600; color:var(--ink); background:var(--bg); border:1px solid var(--clay); border-radius:6px; padding:3px 9px; flex:1; min-width:0; outline:none; }
  .title-wrap .ck { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:2.5; stroke-linecap:round; stroke-linejoin:round; }
  /* fora do fluxo: os chips (1 ou 2) não aumentam a altura do cabeçalho nem descem as abas */
  .hdr-right { display:flex; align-items:center; gap:var(--s3); position:absolute; right:0; top:50%; transform:translateY(-50%); }
  .acct-row { display:flex; flex-direction:column; align-items:flex-end; gap:4px; } /* chips empilhados (não ficam largos lado a lado) */
  .acct { font-size:12px; font-weight:600; padding:3px 11px; border-radius:999px; white-space:nowrap; max-width:300px; overflow:hidden; text-overflow:ellipsis; }
  .acct.claude { background:var(--claude-brand-soft); color:var(--claude-brand); } /* sempre laranja */
  .acct.codex  { background:var(--codex-brand-soft);  color:var(--codex-brand); }  /* sempre verde */
  .chip.tok { font-family:var(--mono); font-size:11.5px; color:var(--muted); cursor:default; }
  .chip.origin { font-size:11.5px; }
  #theme-btn { padding:6px; }
  #theme-btn svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .ic-moon { display:none; }
  :root[data-theme="light"] .ic-sun { display:none; }
  :root[data-theme="light"] .ic-moon { display:inline; }
  .filter { width:100%; margin-bottom:var(--s3); padding:9px 12px; border-radius:var(--r-sm); border:1px solid var(--line); background:var(--surface); color:var(--ink); font-family:var(--body); font-size:14px; outline:none; transition:border-color .15s; }
  .run-form { display:flex; gap:var(--s2); margin-bottom:var(--s3); align-items:center; }
  .run-form .filter { margin-bottom:0; }
  .run-form #run-folder { flex:1; } .run-form #run-cmd { flex:1.4; font-family:var(--mono); font-size:13px; }
  .run-form .btn { white-space:nowrap; }
  .filter:focus { border-color:var(--clay); }
  .filter::placeholder { color:var(--muted); }
  .empty { color:var(--muted); text-align:center; padding:var(--s7) var(--s4); border:1px dashed var(--line); border-radius:var(--r); }
  .loadmore { display:flex; gap:var(--s2); justify-content:center; padding:var(--s4) 0 var(--s2); }
  .ws-frow { display:flex; gap:var(--s2); margin-bottom:var(--s2); }
  .ws-frow .filter { margin-bottom:0; }
  .card.ws { flex-direction:column; align-items:stretch; gap:var(--s3); position:relative; }
  .card.ws .main { padding-right:36px; } /* espaço pro ⋮ no canto */
  .card.ws .actions { justify-content:flex-start; flex-wrap:wrap; }
  .ws-kebab { position:absolute; top:var(--s3); right:var(--s3); }
  .ws-banner { display:flex; align-items:center; gap:var(--s2); margin-bottom:var(--s3); padding:8px 12px; border-radius:var(--r-sm); background:var(--clay-soft); color:var(--clay); font-size:13px; font-weight:600; }
  .ws-banner button { margin-left:auto; background:transparent; border:1px solid currentColor; color:inherit; border-radius:var(--r-sm); padding:3px 10px; font-family:var(--body); font-weight:600; font-size:12px; cursor:pointer; }
  .ns-folders-pick { display:flex; flex-direction:column; gap:6px; margin-top:var(--s2); max-height:200px; overflow:auto; }
  .ns-folders-pick label { display:flex; align-items:center; gap:var(--s2); font-size:13px; color:var(--ink); cursor:pointer; }
  .ns-folders-pick input { accent-color:var(--clay); }
  .ns-seg { display:flex; gap:var(--s2); margin-top:var(--s3); }
  .ns-seg button { flex:1; display:flex; align-items:center; justify-content:center; gap:7px; padding:9px; border-radius:var(--r-sm); border:1px solid var(--line); background:transparent; color:var(--muted); cursor:pointer; font-family:var(--body); font-size:13px; font-weight:600; transition:all .12s; }
  .ns-seg button svg { width:15px; height:15px; fill:currentColor; }
  .ns-seg button:hover { color:var(--ink); }
  #ns-ag-claude.active { background:var(--claude-brand-soft); color:var(--claude-brand); border-color:transparent; }
  #ns-ag-codex.active { background:var(--teal-soft); color:var(--teal); border-color:transparent; }
  .ns-opt-row { display:flex; gap:var(--s3); margin-top:var(--s3); }
  .ns-opt { flex:1; display:flex; flex-direction:column; gap:5px; font-size:12px; color:var(--muted); }
  .ns-opt .filter { margin:0; }
  .info-i { display:inline-flex; vertical-align:middle; margin-left:5px; color:var(--muted); cursor:help; }
  .info-i svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .info-i:hover { color:var(--ink); }
  a.open { color:var(--clay); text-decoration:none; font-size:12px; font-weight:600; }
  a.open:hover { text-decoration:underline; }
  .hint { color:var(--muted); font-size:13px; line-height:1.6; max-width:72ch; margin:0 0 var(--s3); }
  .hint b { color:var(--ink); font-weight:600; }
  .check { display:flex; align-items:center; gap:var(--s2); color:var(--muted); font-size:13px; margin-bottom:var(--s3); cursor:pointer; }
  .check input { accent-color:var(--clay); width:15px; height:15px; }
  .modal-bg { position:fixed; inset:0; background:oklch(0% 0 0 / .5); display:none; align-items:flex-start; justify-content:center; padding:var(--s6) var(--s4); overflow:auto; z-index:50; }
  .modal-bg.open { display:flex; animation:fade .15s ease-out; }
  .modal { background:var(--surface); border:1px solid var(--line); border-radius:var(--r); width:100%; max-width:740px; padding:var(--s5); box-shadow:0 12px 40px oklch(0% 0 0 / .3); }
  .modal-head { display:flex; align-items:center; justify-content:space-between; gap:var(--s3); margin-bottom:var(--s3); }
  .plan-card { background:var(--bg); border:1px solid var(--line); border-radius:var(--r); padding:var(--s4); margin-bottom:var(--s2); }
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
  .modal.confirm { max-width:420px; }
  .confirm-msg { font-size:15px; color:var(--ink); margin:0 0 var(--s5); line-height:1.5; word-break:break-word; white-space:pre-wrap; }
  .confirm-actions { display:flex; gap:var(--s2); justify-content:flex-end; }
  .toasts { position:fixed; bottom:var(--s5); left:50%; transform:translateX(-50%); display:flex; flex-direction:column; gap:var(--s2); align-items:center; z-index:60; pointer-events:none; }
  .toast { background:var(--surface); border:1px solid var(--line); border-radius:999px; padding:9px 16px; font-size:13px; font-weight:600; color:var(--ink); box-shadow:0 8px 24px oklch(0% 0 0 / .3); animation:toastin .18s ease-out; max-width:80vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .toast.ok { border-color:color-mix(in oklch, var(--green) 55%, var(--line)); color:var(--green); }
  .toast.err { border-color:color-mix(in oklch, var(--red) 55%, var(--line)); background:var(--red-soft); color:var(--red); }
  @keyframes toastin { from { opacity:0; transform:translateY(10px); } }
  .help-text { color:var(--muted); font-size:13.5px; line-height:1.7; }
  .help-text b { color:var(--ink); font-weight:600; }
  .help-text p { margin:0 0 var(--s3); } .help-text p:last-child { margin-bottom:0; }
  .foot-info { display:flex; align-items:center; gap:7px; width:fit-content; margin:var(--s5) auto var(--s7); background:transparent; border:1px solid var(--line); color:var(--muted); border-radius:999px; padding:7px 16px; font-family:var(--body); font-size:13px; font-weight:600; cursor:pointer; transition:color .15s,border-color .15s; }
  .foot-info:hover { color:var(--ink); border-color:var(--muted); }
  .foot-info svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  code { font-family:var(--mono); background:var(--surface-2); padding:1px 6px; border-radius:5px; color:var(--ink); font-size:12.5px; }
</style>
</head>
<body>
  <div class="offbar" id="offbar">
    <svg viewBox="0 0 24 24"><path d="M3 3l18 18M8.5 8.5A6 6 0 0 0 6 14h2M16.5 16.5a6 6 0 0 0-3-2.4M12 6a8 8 0 0 1 7 4"/><path d="M12 18h.01"/></svg>
    <span>Painel offline — reabra pelo ícone do AgentDeck</span>
    <button onclick="closePanel()">Fechar</button>
  </div>
  <div class="wrap">
    <header>
      <h1><span class="dot" id="status-dot"></span> AgentDeck</h1>
      <div class="hdr-right">
        <span class="acct-row" id="acct"></span>
        <button class="btn btn-ghost btn-icon" id="theme-btn" onclick="toggleTheme()" title="Alternar tema claro/escuro">
          <svg class="ic-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          <svg class="ic-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>
        </button>
      </div>
    </header>

    <div class="tabs">
      <button class="tab active" id="tab-sessions" onclick="switchTab('sessions')">Sessões <span class="badge" id="badge-sessions">–</span></button>
      <button class="tab" id="tab-watch" onclick="switchTab('watch')">Processos <span class="badge" id="badge-watch">0</span></button>
      <button class="tab" id="tab-workspaces" onclick="switchTab('workspaces')">Workspaces <span class="badge" id="badge-ws">0</span></button>
    </div>

    <section class="panel active" id="panel-sessions">
      <div class="row sess-head">
        <h2 class="section-title">Sessões <span class="sub" id="sess-count"></span></h2>
        <span class="actions">
          <button class="btn btn-ghost" id="sess-fav-toggle" onclick="toggleFav()">Favoritas (0)</button>
          <button class="btn btn-ghost" id="sess-archived-toggle" onclick="toggleArchived()">Arquivadas (0)</button>
          <label class="btn btn-ghost" title="Importar sessões de um .json exportado">Importar<input type="file" id="imp-file" accept=".json,application/json" onchange="impPick(event)" hidden /></label>
          <button class="btn btn-ghost" id="sess-reload" onclick="loadSessions()">Atualizar</button>
        </span>
      </div>
      <div class="srcbar">
        <button class="src on" id="src-claude" onclick="toggleSource('claude')"><svg class="ico" viewBox="0 0 24 24"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg> Claude</button>
        <button class="src on" id="src-codex" onclick="toggleSource('codex')"><svg class="ico" viewBox="0 0 24 24"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"/></svg> Codex</button>
        <button class="src new-sess" onclick="openNewSession()" title="Nova sessão"><svg class="ico" viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round"><path d="M12 5v14M5 12h14"/></svg> Nova sessão</button>
      </div>
      <input class="filter" id="sess-filter" placeholder="filtrar por título ou pasta…" oninput="resetPage(); renderSessions()" />
      <div id="sessions"></div>
    </section>

    <section class="panel" id="panel-watch">
      <div class="row sess-head">
        <h2 class="section-title">Iniciar um processo</h2>
        <button class="btn btn-ghost btn-icon" onclick="openHistory()" title="Histórico de processos iniciados"><svg viewBox="0 0 24 24" style="width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg></button>
      </div>
      <div class="run-form">
        <input class="filter" id="run-folder" placeholder="pasta (ex.: /home/você/projeto)" />
        <button class="btn btn-ghost btn-icon" id="pick-folder" onclick="pickFolder()" title="Escolher pasta (seletor do sistema)"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></button>
        <input class="filter" id="run-cmd" placeholder="comando (ex.: npm run dev)" onkeydown="if(event.key==='Enter')startProc()" />
        <button class="btn btn-copy" onclick="startProc()">Iniciar</button>
      </div>

      <h2 class="section-title">Processos em background</h2>
      <div id="tasks"></div>

      <h2 class="section-title">Containers Docker</h2>
      <div id="containers"></div>
    </section>

    <section class="panel" id="panel-workspaces">
      <div class="row sess-head">
        <h2 class="section-title" style="margin:0">Workspaces</h2>
        <button class="btn btn-copy" onclick="openWsModal()">+ Novo workspace</button>
      </div>
      <p class="hint">Agrupe pastas de projetos (ex.: <code>admin</code>, <code>dashboard</code>, <code>api</code>). Depois dá pra
        abrir tudo no VS Code de uma vez, criar sessões em qualquer pasta dele e filtrar as Sessões por workspace.</p>
      <div id="ws-list"></div>
    </section>

    <div class="modal-bg" id="imp-modal" onclick="if(event.target===this)closeImport()">
      <div class="modal">
        <div class="modal-head">
          <h2 class="section-title" style="margin:0">Importar sessões <span class="sub" id="imp-name"></span></h2>
          <button class="btn btn-ghost btn-icon" title="Fechar" onclick="closeImport()"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M6 6l12 12M6 18L18 6"/></svg></button>
        </div>
        <p class="hint">Preview do que vai mudar (home, cwd, pasta codificada) — nada é escrito até você
          <b>Aplicar</b>. Apontamentos que o remap automático não cobre aparecem pra você <b>ignorar</b> ou ajustar.</p>
        <div id="imp-plan"></div>
      </div>
    </div>

    <div class="modal-bg" id="info-modal" onclick="if(event.target===this)closeInfo()">
      <div class="modal">
        <div class="modal-head">
          <h2 class="section-title" style="margin:0">Detalhes da sessão</h2>
          <button class="btn btn-ghost btn-icon" title="Fechar" onclick="closeInfo()"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M6 6l12 12M6 18L18 6"/></svg></button>
        </div>
        <div id="info-body"></div>
      </div>
    </div>

    <div class="modal-bg" id="confirm-modal">
      <div class="modal confirm">
        <p class="confirm-msg" id="confirm-msg"></p>
        <div class="confirm-actions">
          <button class="btn btn-ghost" id="confirm-cancel">Cancelar</button>
          <button class="btn btn-copy" id="confirm-ok">Confirmar</button>
        </div>
      </div>
    </div>

    <div class="modal-bg" id="hist-modal" onclick="if(event.target===this)closeHistory()">
      <div class="modal">
        <div class="modal-head">
          <h2 class="section-title" style="margin:0">Processos iniciados</h2>
          <button class="btn btn-ghost btn-icon" title="Fechar" onclick="closeHistory()"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M6 6l12 12M6 18L18 6"/></svg></button>
        </div>
        <div id="hist-body"></div>
      </div>
    </div>

    <div class="modal-bg" id="log-modal" onclick="if(event.target===this)closeLog()">
      <div class="modal">
        <div class="modal-head">
          <h2 class="section-title" style="margin:0">Logs <span class="sub" id="log-title"></span></h2>
          <button class="btn btn-ghost btn-icon" title="Fechar" onclick="closeLog()"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M6 6l12 12M6 18L18 6"/></svg></button>
        </div>
        <pre class="logbox" id="log-body"></pre>
      </div>
    </div>

    <div class="modal-bg" id="newsess-modal" onclick="if(event.target===this)closeNewSession()">
      <div class="modal">
        <div class="modal-head">
          <h2 class="section-title" style="margin:0">Nova sessão</h2>
          <button class="btn btn-ghost btn-icon" title="Fechar" onclick="closeNewSession()"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M6 6l12 12M6 18L18 6"/></svg></button>
        </div>
        <p class="hint">Escolha a pasta e abra uma sessão nova num terminal.<span class="info-i" title="o agente roda lá e a sessão aparece aqui ao atualizar"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg></span></p>
        <label class="check"><input type="checkbox" id="ns-ws-toggle" onchange="nsToggleWs()" /> Usar um workspace (uma sessão com acesso a vários repos)</label>
        <div class="run-form" id="ns-single">
          <input class="filter" id="ns-folder" placeholder="pasta do projeto (ex.: /home/você/projeto)" />
          <button class="btn btn-ghost btn-icon" onclick="pickFolder('ns-folder')" title="Escolher pasta"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></button>
        </div>
        <div id="ns-ws-area" style="display:none">
          <select class="filter" id="ns-ws-select" onchange="nsRenderWsFolders()"></select>
          <div class="ns-folders-pick" id="ns-ws-folders"></div>
        </div>
        <div class="ns-seg">
          <button type="button" id="ns-ag-claude" onclick="nsSetAgent('claude')"><svg viewBox="0 0 24 24"><path d="M4.7 16l4.7-2.6.08-.23-.08-.13h-.23l-.79-.05-2.7-.07-2.33-.1-2.26-.12-.57-.12-.53-.7.05-.35.48-.32.69.06 1.52.1 2.28.16 1.65.1 2.45.25h.39l.05-.16-.13-.1-.1-.1L7 9.84 4.45 8.15l-1.34-.97-.72-.49-.36-.46-.16-1.01.66-.72.88.06.22.06.9.69 1.9 1.47 2.49 1.83.36.3.15-.1.02-.07-.16-.27-1.36-2.45-1.44-2.49-.64-1.03-.17-.62a3 3 0 0 1-.1-.73L6.29.13 6.7 0l1 .13.42.37.62 1.41 1 2.23 1.55 3.03.46.9.24.83.09.25h.16V9.7l.13-1.7.24-2.1.23-2.69.08-.76.38-.91.74-.49.59.28.48.69-.07.44-.28 1.85-.56 2.9-.36 1.94h.21l.24-.24.98-1.3 1.65-2.07.73-.82.85-.9.55-.43h1.03l.76 1.13-.34 1.16-1.06 1.35-.88 1.14-1.26 1.7-.79 1.36.07.1.19-.01 2.85-.61 1.54-.28 1.84-.31.83.39.09.39-.33.81-1.97.49-2.3.46-3.44.81-.04.03.05.06 1.55.15.66.03h1.62l3.02.23.79.52.47.64-.08.49-1.21.62-1.64-.39-3.83-.91-1.31-.33h-.18v.11l1.09 1.07 2 1.8 2.51 2.34.13.57-.32.46-.34-.05-2.2-1.66-.85-.74-1.93-1.62h-.12v.17l.44.65 2.34 3.52.12 1.08-.17.35-.6.21-.67-.12-1.37-1.92-1.42-2.16-.14.08-.67 7.26-.32.37-.73.28-.6-.46-.32-.75.32-1.47.39-1.93.31-1.53.29-1.9.17-.63-.01-.04-.14.02-1.43 1.97-2.18 2.94-1.72 1.85-.41.16-.72-.37.07-.66.4-.59 2.39-3.04 1.44-1.88.93-1.09v-.16h-.06l-6.34 4.12-1.13.14-.49-.45.06-.75.23-.24 1.91-1.31z"/></svg> Claude</button>
          <button type="button" id="ns-ag-codex" onclick="nsSetAgent('codex')"><svg viewBox="0 0 24 24"><path d="M22.28 9.82a5.98 5.98 0 0 0-.51-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18 5.98 5.98 0 0 0 .98 7.08a6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.98 5.98 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07zM13.26 22.43a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.79.79 0 0 0 .4-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.5 4.5zM3.6 18.3a4.47 4.47 0 0 1-.53-3.01l.14.08 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65zM2.34 7.9a4.49 4.49 0 0 1 2.37-1.98v5.68a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0L3.99 14a4.5 4.5 0 0 1-1.65-6.1zm16.6 3.86L13.1 8.36 15.12 7.2a.08.08 0 0 1 .07 0l4.83 2.8a4.5 4.5 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.4-.66zm2.01-3.02l-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66zM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08L8.7 5.46a.79.79 0 0 0-.39.68zm1.1-2.37l2.6-1.5 2.61 1.5v3l-2.6 1.5-2.6-1.5z"/></svg> Codex</button>
        </div>
        <div class="ns-opt-row">
          <label class="ns-opt">Modelo
            <select class="filter" id="ns-model"></select>
          </label>
          <label class="ns-opt">Effort
            <select class="filter" id="ns-effort"></select>
          </label>
          <label class="ns-opt">Modo
            <select class="filter" id="ns-mode"></select>
          </label>
        </div>
        <div class="newsess-actions">
          <button class="btn ns-claude" id="ns-go" onclick="createSession()">Abrir sessão</button>
        </div>
      </div>
    </div>

    <div class="modal-bg" id="ws-modal" onclick="if(event.target===this)closeWsModal()">
      <div class="modal">
        <div class="modal-head">
          <h2 class="section-title" style="margin:0" id="ws-modal-title">Novo workspace</h2>
          <button class="btn btn-ghost btn-icon" title="Fechar" onclick="closeWsModal()"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M6 6l12 12M6 18L18 6"/></svg></button>
        </div>
        <p class="hint">Dê um nome e escolha as pastas do grupo. Use o <b>+ adicionar pasta</b> pra incluir mais de uma.</p>
        <input class="filter" id="ws-name" placeholder="nome do workspace (ex.: Efex)" />
        <div id="ws-folders"></div>
        <div class="row sess-head" style="margin-top:var(--s2)">
          <button class="btn btn-ghost" onclick="wsAddFolder()">+ adicionar pasta</button>
          <button class="btn btn-copy" id="ws-save-btn" onclick="createWorkspace()">Criar workspace</button>
        </div>
      </div>
    </div>

    <div class="toasts" id="toasts"></div>

    <div class="modal-bg" id="help-modal" onclick="if(event.target===this)closeHelp()">
      <div class="modal">
        <div class="modal-head">
          <h2 class="section-title" style="margin:0">Como funciona</h2>
          <button class="btn btn-ghost btn-icon" title="Fechar" onclick="closeHelp()"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M6 6l12 12M6 18L18 6"/></svg></button>
        </div>
        <div class="help-text">
          <p><b>Sessões.</b> Lista as sessões do <b>Claude Code</b> (<code>~/.claude/projects</code>) e do
          <b>Codex</b> (<code>~/.codex/sessions</code>) — ligue as fontes (Claude/Codex) e clique em <b>Atualizar</b>.
          Cada sessão mostra pasta, origem (terminal/VS Code), tokens, se está <b>● ativa</b> e um trecho da última mensagem.
          Filtre por título/pasta (atalho <code>/</code>), clique no chip da pasta pra filtrar por projeto, e <b>Enter</b> retoma a 1ª.
          Ícones do card (passe o mouse): abrir no <b>VS Code</b> (pasta + a conversa na extensão), <b>retomar</b>
          (copia <code>claude --resume</code> / <code>codex resume</code> pro terminal), <b>★ favoritar</b>, <b>📌 fixar</b>,
          <b>⋮</b> (detalhes da sessão e baixar o <code>.json</code>) e <b>arquivar</b> (só organiza a visão, nada é apagado).
          Renomear é inline (lápis). A lista mostra 20 por vez (<b>Ver mais</b>/<b>Ver todas</b>). O botão <b>Importar</b>
          (topo) carrega um <code>.json</code> exportado com preview de remap. O acento muda com as fontes: só Claude = laranja,
          só Codex = verde, ambos/nenhum = azul.</p>
          <p><b>Processos.</b> Lista o que ficou rodando em background (dev servers iniciados pelo Claude + os iniciados aqui),
          com a pasta de cada um; atualiza a cada 2,5s na aba. Dá pra <b>Iniciar</b> um processo (escolhendo a pasta no seletor
          do sistema 📁 e o comando), ver o <b>histórico</b> 🕐 dos iniciados (com pin e re-iniciar), <b>Reiniciar</b> ou
          <b>Finalizar</b> (mata o processo e os filhos com SIGTERM). Também para <b>containers Docker</b>.</p>
          <p>No topo, os chips mostram a conta logada (Claude/Codex). Tudo é local em <code>127.0.0.1</code>: só lê e mata
          na sua máquina, e nenhum token de login é exposto.</p>
        </div>
      </div>
    </div>
  </div>

  <button class="foot-info" onclick="openHelp()" title="Como funciona"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5h.01"/></svg> Como funciona</button>

<script>
const fmtUp = (s) => { const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  return h ? \`\${h}h \${m}m\` : m ? \`\${m}m \${sec}s\` : \`\${sec}s\`; };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const folderName = (p) => { const a = String(p || '').split('/').filter(Boolean); return a[a.length - 1] || ''; }; // nome da pasta final

// notificação discreta que some sozinha (substitui avisos transitórios)
function toast(msg, type) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, type === 'err' ? 4200 : 2400);
}

// confirmação no tema do app (substitui o confirm() nativo do browser)
function askConfirm(message, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const bg = document.getElementById('confirm-modal');
    const ok = document.getElementById('confirm-ok'), cancel = document.getElementById('confirm-cancel');
    document.getElementById('confirm-msg').textContent = message;
    ok.textContent = opts.okLabel || 'Confirmar';
    ok.className = 'btn ' + (opts.danger ? 'btn-kill' : 'btn-copy');
    bg.classList.add('open');
    setTimeout(() => ok.focus(), 0);
    const done = (v) => {
      bg.classList.remove('open');
      ok.onclick = cancel.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      bg.onclick = null;
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    bg.onclick = (e) => { if (e.target === bg) done(false); };
    document.addEventListener('keydown', onKey, true);
  });
}

async function kill(payload, cmd, cwd) {
  const isContainer = payload && payload.container;
  const msg = isContainer
    ? 'Parar este container?\\n\\n' + payload.container
    : 'Finalizar este processo?\\n\\n' + cmd + (cwd ? '\\n' + cwd : '');
  if (!(await askConfirm(msg, { danger: true, okLabel: isContainer ? 'Parar' : 'Finalizar' }))) return;
  try { await fetch('/api/kill', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) }); toast(isContainer ? 'Container parado' : 'Finalizado', 'ok'); } catch { toast('Falha', 'err'); }
  setTimeout(refresh, 400);
}

async function restartProc(pid, cmd, cwd) {
  const msg = 'Reiniciar este processo?\\n\\n' + cmd + (cwd ? '\\n' + cwd : '');
  if (!(await askConfirm(msg, { okLabel: 'Reiniciar' }))) return;
  try { await fetch('/api/restart', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ pid }) }); toast('Reiniciando…', 'ok'); } catch { toast('Falha ao reiniciar', 'err'); }
  setTimeout(refresh, 1000); // dá tempo de matar e subir de novo
}

async function pickFolder(inputId) {
  inputId = inputId || 'run-folder';
  let r; try { r = await (await fetch('/api/pick-folder', { method:'POST', headers:{'content-type':'application/json'}, body:'{}' })).json(); }
  catch { return; }
  if (r.ok && r.path) document.getElementById(inputId).value = r.path;
  else if (!r.ok) toast(r.error || 'sem seletor — digite o caminho', 'err');
}

// ── Nova sessão (modal do "+") ──
function openNewSession() {
  document.getElementById('ns-ws-toggle').checked = false; nsToggleWs();
  nsSetAgent('claude');           // define agente + popula modelo/effort
  document.getElementById('newsess-modal').classList.add('open');
  setTimeout(() => document.getElementById('ns-folder').focus(), 0);
}
function closeNewSession() { document.getElementById('newsess-modal').classList.remove('open'); }
// escolhe o agente primeiro; modelo/effort listam só o que aquele CLI aceita
let nsAgent = 'claude';
const NS_MODELS = { claude: ['opus', 'sonnet', 'haiku', 'fable'], codex: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'] };
const NS_EFFORTS = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh'] };
const NS_MODES = {
  claude: [['default', 'Ask before edits'], ['acceptEdits', 'Edit automatically'], ['plan', 'Plan mode'], ['auto', 'Auto mode']],
  codex: [['ask', 'Ask for approval'], ['approve', 'Approve for me'], ['full', 'Full access']],
};
function nsSetAgent(a) {
  nsAgent = a === 'codex' ? 'codex' : 'claude';
  document.getElementById('ns-ag-claude').classList.toggle('active', nsAgent === 'claude');
  document.getElementById('ns-ag-codex').classList.toggle('active', nsAgent === 'codex');
  const opts = (list, label) => '<option value="">' + label + '</option>' + list.map(x => '<option value="' + x + '">' + x + '</option>').join('');
  const optsPairs = (pairs, label) => '<option value="">' + label + '</option>' + pairs.map(p => '<option value="' + p[0] + '">' + p[1] + '</option>').join('');
  document.getElementById('ns-model').innerHTML = opts(NS_MODELS[nsAgent], 'padrão do CLI');
  document.getElementById('ns-effort').innerHTML = opts(NS_EFFORTS[nsAgent], 'padrão');
  document.getElementById('ns-mode').innerHTML = optsPairs(NS_MODES[nsAgent], 'padrão');
  document.getElementById('ns-go').className = 'btn ' + (nsAgent === 'codex' ? 'ns-codex' : 'ns-claude');
}
function nsToggleWs() {
  const on = document.getElementById('ns-ws-toggle').checked;
  document.getElementById('ns-single').style.display = on ? 'none' : '';
  document.getElementById('ns-ws-area').style.display = on ? '' : 'none';
  if (on) {
    const sel = document.getElementById('ns-ws-select');
    sel.innerHTML = WS.length ? WS.map(w => '<option>' + esc(w.name) + '</option>').join('') : '<option value="">(nenhum workspace — crie na aba Workspaces)</option>';
    nsRenderWsFolders();
  }
}
function nsRenderWsFolders() {
  const name = document.getElementById('ns-ws-select').value;
  const w = WS.find(x => x.name === name);
  const fs = w ? w.folders : [];
  const head = fs.length > 1
    ? '<div class="hint">Escolha a <b>pasta-raiz</b> (cwd) da sessão.<span class="info-i" title="As demais entram como --add-dir — uma sessão só, ciente de todos os repos."><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg></span></div>'
    : '';
  document.getElementById('ns-ws-folders').innerHTML = head + fs.map((f, i) =>
    '<label><input type="radio" name="ns-root" value="' + esc(f) + '"' + (i === 0 ? ' checked' : '') + ' /> <span class="mono">' + esc(f) + '</span></label>').join('');
}
async function createSession(source) {
  source = source || nsAgent;     // botão único usa o agente escolhido no topo
  let folder, addDirs = [];
  if (document.getElementById('ns-ws-toggle').checked) {
    const all = [...document.querySelectorAll('#ns-ws-folders input[name="ns-root"]')].map(r => r.value);
    if (!all.length) { toast('Esse workspace não tem pastas', 'err'); return; }
    const picked = document.querySelector('#ns-ws-folders input[name="ns-root"]:checked');
    folder = picked ? picked.value : all[0];          // raiz (cwd)
    addDirs = all.filter(f => f !== folder);          // demais repos → --add-dir
  } else {
    folder = document.getElementById('ns-folder').value.trim();
    if (!folder) { toast('Escolha a pasta', 'err'); return; }
  }
  const model = document.getElementById('ns-model').value.trim();
  const effort = document.getElementById('ns-effort').value;
  const mode = document.getElementById('ns-mode').value;
  let r; try { r = await (await fetch('/api/new-session', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ source, folder, addDirs, model, effort, mode }) })).json(); } catch {}
  if (r && r.ok) {
    const label = source === 'codex' ? 'Codex' : 'Claude';
    toast(addDirs.length ? '✓ sessão ' + label + ' aberta (' + (addDirs.length + 1) + ' repos)' : '✓ sessão ' + label + ' aberta', 'ok');
    closeNewSession();
  } else toast('não consegui abrir o terminal', 'err');
}

// ── Workspaces (aba) ──
let WS = [], wsEditing = null; // wsEditing = nome original em edição (ou null)
async function loadWorkspaces() {
  try { WS = (await (await fetch('/api/workspaces')).json()).items || []; } catch { WS = []; }
  document.getElementById('badge-ws').textContent = WS.length;
  renderWorkspaces();
}
function wsAddFolder(value) {
  const row = document.createElement('div');
  row.className = 'ws-frow';
  row.innerHTML = '<input class="filter ws-folder" placeholder="pasta…" />'
    + '<button class="btn btn-ghost btn-icon" title="Escolher pasta" onclick="pickWsRow(this)"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></button>'
    + '<button class="btn btn-ghost btn-icon" title="Remover" onclick="this.closest(\\'.ws-frow\\').remove()"><svg viewBox="0 0 24 24" style="width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M6 6l12 12M6 18L18 6"/></svg></button>';
  if (value) row.querySelector('.ws-folder').value = value;
  document.getElementById('ws-folders').appendChild(row);
}
function resetWsForm() {
  wsEditing = null;
  document.getElementById('ws-name').value = '';
  document.getElementById('ws-folders').innerHTML = ''; wsAddFolder();
  document.getElementById('ws-modal-title').textContent = 'Novo workspace';
  document.getElementById('ws-save-btn').textContent = 'Criar workspace';
}
function openWsModal() {
  resetWsForm();
  document.getElementById('ws-modal').classList.add('open');
  setTimeout(() => document.getElementById('ws-name').focus(), 0);
}
function closeWsModal() { document.getElementById('ws-modal').classList.remove('open'); }
function uniqueCopyName(base) {
  const names = new Set(WS.map(w => w.name));
  let n = base + ' (cópia)', i = 2;
  while (names.has(n)) n = base + ' (cópia ' + (i++) + ')';
  return n;
}
async function duplicateWorkspace(name) {
  const w = WS.find(x => x.name === name); if (!w) return;
  const novo = uniqueCopyName(w.name);
  try { await fetch('/api/workspaces', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name: novo, folders: w.folders }) }); }
  catch { toast('Falha ao duplicar', 'err'); return; }
  toast('✓ duplicado como "' + novo + '"', 'ok');
  await loadWorkspaces();
  editWorkspace(novo); // já abre a cópia em edição pra você remover/ajustar pastas
}
function editWorkspace(name) {
  const w = WS.find(x => x.name === name); if (!w) return;
  wsEditing = name;
  document.getElementById('ws-name').value = w.name;
  document.getElementById('ws-folders').innerHTML = '';
  w.folders.forEach(f => wsAddFolder(f));
  document.getElementById('ws-modal-title').innerHTML = 'Editar workspace <span class="sub">' + esc(w.name) + '</span>';
  document.getElementById('ws-save-btn').textContent = 'Salvar alterações';
  document.getElementById('ws-modal').classList.add('open');
  setTimeout(() => document.getElementById('ws-name').focus(), 0);
}
async function pickWsRow(btn) {
  let r; try { r = await (await fetch('/api/pick-folder', { method:'POST', headers:{'content-type':'application/json'}, body:'{}' })).json(); } catch { return; }
  if (r.ok && r.path) btn.closest('.ws-frow').querySelector('.ws-folder').value = r.path;
  else if (!r.ok) toast(r.error || 'sem seletor', 'err');
}
async function createWorkspace() {
  const name = document.getElementById('ws-name').value.trim();
  const folders = [...document.querySelectorAll('#ws-folders .ws-folder')].map(i => i.value.trim()).filter(Boolean);
  if (!name) { toast('Dê um nome ao workspace', 'err'); return; }
  if (!folders.length) { toast('Adicione ao menos uma pasta', 'err'); return; }
  let r; try { r = await (await fetch('/api/workspaces', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name, folders }) })).json(); }
  catch { toast('Falha ao salvar', 'err'); return; }
  if (!r.ok) { toast(r.error || 'não consegui salvar', 'err'); return; }
  // se estava editando e renomeou, remove o original (senão upsert por nome cria um 2º)
  if (wsEditing && wsEditing !== name) { try { await fetch('/api/workspaces/delete', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name: wsEditing }) }); } catch {} }
  toast('✓ workspace "' + name + '" salvo', 'ok');
  closeWsModal();
  loadWorkspaces();
}
function renderWorkspaces() {
  const box = document.getElementById('ws-list');
  if (!WS.length) { box.innerHTML = '<div class="empty">Nenhum workspace ainda — crie um acima.</div>'; return; }
  box.innerHTML = WS.map(w => { const n = esc(JSON.stringify(w.name)); return \`
    <div class="card ws">
      <div class="kebab-wrap ws-kebab">
        <button class="btn btn-icon btn-kebab" title="Mais ações" onclick='toggleMenu(event, this)'><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
        <div class="menu">
          <button class="menu-item" onclick='duplicateWorkspace(\${n}); closeMenus()'><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg> Duplicar</button>
          <button class="menu-item" onclick='editWorkspace(\${n}); closeMenus()'><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg> Editar</button>
          <button class="menu-item" onclick='deleteWorkspaceUI(\${n}); closeMenus()'><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg> Excluir</button>
        </div>
      </div>
      <div class="main">
        <div class="title">\${esc(w.name)}</div>
        <div class="meta">\${w.folders.map(f => \`<span class="chip folder" title="\${esc(f)}">\${esc(folderName(f))}</span>\`).join('')}</div>
      </div>
      <div class="actions">
        <button class="btn btn-vscode btn-icon" title="Abrir tudo no VS Code" onclick='openWorkspaceVSCode(\${n})'><svg viewBox="0 0 24 24"><path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg></button>
        <button class="btn btn-ghost" onclick='newSessionForWorkspace(\${n})'>Nova sessão</button>
        <button class="btn btn-ghost" onclick='filterByWorkspace(\${n})'>Filtrar sessões</button>
      </div>
    </div>\`; }).join('');
}
async function openWorkspaceVSCode(name) {
  try { await fetch('/api/open-workspace', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name }) }); toast('Abrindo no VS Code…', 'ok'); } catch { toast('Falha', 'err'); }
}
async function deleteWorkspaceUI(name) {
  if (!(await askConfirm('Excluir o workspace "' + name + '"?\\n\\n(as pastas e sessões não são tocadas)', { danger: true, okLabel: 'Excluir' }))) return;
  try { await fetch('/api/workspaces/delete', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name }) }); } catch {}
  loadWorkspaces();
}
function newSessionForWorkspace(name) {
  openNewSession();
  document.getElementById('ns-ws-toggle').checked = true; nsToggleWs();
  document.getElementById('ns-ws-select').value = name; nsRenderWsFolders();
}
function filterByWorkspace(name) {
  const w = WS.find(x => x.name === name); if (!w) return;
  wsFilter = { name: w.name, folders: w.folders };
  switchTab('sessions');
  if (!sessLoaded) loadSessions(); else { resetPage(); renderSessions(); }
}
function clearWsFilter() { wsFilter = null; renderSessions(); }

async function startProc() {
  const folder = document.getElementById('run-folder').value.trim();
  const cmd = document.getElementById('run-cmd').value.trim();
  if (!folder || !cmd) { toast('Informe a pasta e o comando', 'err'); return; }
  let r; try { r = await (await fetch('/api/run', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ cmd, folder }) })).json(); }
  catch { toast('Falha ao iniciar', 'err'); return; }
  if (!r.ok) { toast(r.error || 'não consegui iniciar', 'err'); return; }
  toast('✓ ' + cmd + ' iniciado', 'ok');
  document.getElementById('run-cmd').value = '';
  refresh();
  checkAlive(cmd, folder, r.log);
}

function openHelp() { document.getElementById('help-modal').classList.add('open'); }
function closeHelp() { document.getElementById('help-modal').classList.remove('open'); }

// ── Visualizador de logs dos processos iniciados ──
let logPath = '', logTimer = null;
async function fetchLog() {
  if (!logPath) return;
  const box = document.getElementById('log-body');
  try {
    const r = await (await fetch('/api/task-log?path=' + encodeURIComponent(logPath))).json();
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.textContent = r.text || '';
    if (atBottom) box.scrollTop = box.scrollHeight; // segue o fim se já estava no fim
  } catch {}
}
async function openLog(path, title) {
  if (!path) { toast('Esse processo não tem log', 'err'); return; }
  logPath = path;
  document.getElementById('log-title').textContent = title || '';
  document.getElementById('log-body').textContent = 'Lendo…';
  document.getElementById('log-modal').classList.add('open');
  await fetchLog();
  document.getElementById('log-body').scrollTop = document.getElementById('log-body').scrollHeight;
  if (!logTimer) logTimer = setInterval(fetchLog, 1500); // acompanha em tempo quase real
}
function closeLog() {
  document.getElementById('log-modal').classList.remove('open');
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  logPath = '';
}

// ── Histórico de processos iniciados (modal do reloginho) ──
let HIST = [], histAll = false;
function closeHistory() { document.getElementById('hist-modal').classList.remove('open'); }
async function openHistory() {
  const m = document.getElementById('hist-modal'), body = document.getElementById('hist-body');
  histAll = false; m.classList.add('open'); body.innerHTML = '<div class="empty">Carregando…</div>';
  try { HIST = (await (await fetch('/api/history')).json()).items || []; }
  catch { body.innerHTML = '<div class="warn">Falha ao ler o histórico.</div>'; return; }
  renderHistory();
}
function histShowAll() { histAll = true; renderHistory(); }
function renderHistory() {
  const body = document.getElementById('hist-body');
  if (!HIST.length) { body.innerHTML = '<div class="empty">Nenhum processo iniciado ainda.</div>'; return; }
  const list = histAll ? HIST : HIST.slice(0, 15);
  body.innerHTML = '<div class="hist-list' + (histAll ? ' scroll' : '') + '">' + list.map(h => \`
    <div class="hist-row">
      <button class="btn btn-icon btn-pin\${h.pinned ? ' on' : ''}" title="\${h.pinned ? 'Desafixar' : 'Fixar'}" onclick='pinHistory(\${esc(JSON.stringify(h.cmd))}, \${esc(JSON.stringify(h.folder))}, \${!h.pinned})'><svg viewBox="0 0 24 24"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg></button>
      <div class="hist-main">
        <div class="hist-cmd">\${esc(h.cmd)}</div>
        <div class="hist-folder" title="\${esc(h.folder)}">\${esc(h.folder)}</div>
      </div>
      \${h.log ? \`<button class="btn btn-ghost btn-icon" title="Ver logs da última execução" onclick='openLog(\${esc(JSON.stringify(h.log))}, \${esc(JSON.stringify(folderName(h.folder)))})'><svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M7 8h10M7 12h10M7 16h6"/></svg></button>\` : ''}
      <button class="btn btn-play btn-icon" title="Iniciar de novo" onclick='startFromHistory(\${esc(JSON.stringify(h.cmd))}, \${esc(JSON.stringify(h.folder))})'><svg viewBox="0 0 24 24"><path d="M7 5v14l11-7z"/></svg></button>
    </div>\`).join('') + '</div>'
    + (!histAll && HIST.length > 15 ? '<div class="loadmore"><button class="btn btn-ghost" onclick="histShowAll()">Ver tudo (' + HIST.length + ')</button></div>' : '');
}
async function startFromHistory(cmd, folder) {
  let r; try { r = await (await fetch('/api/run', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ cmd, folder }) })).json(); }
  catch { toast('Falha ao iniciar', 'err'); return; }
  if (!r.ok) { toast(r.error || 'não consegui iniciar', 'err'); return; }
  toast('✓ ' + cmd + ' iniciado', 'ok');
  closeHistory();
  refresh();
  checkAlive(cmd, folder, r.log);
}

// se o processo recém-iniciado sair em ~1,6s (ex.: porta em uso), abre o log com o erro
function checkAlive(cmd, folder, log) {
  if (!log) return;
  const norm = (s) => { s = String(s || ''); while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1); return s; };
  setTimeout(async () => {
    let d; try { d = await (await fetch('/api/state')).json(); } catch { return; }
    const alive = (d.tasks || []).some(t => t.cmd === cmd && norm(t.cwd) === norm(folder));
    if (!alive) { toast('o processo saiu logo — veja os logs', 'err'); openLog(log, cmd); }
  }, 1600);
}
async function pinHistory(cmd, folder, on) {
  try { await fetch('/api/history/pin', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ cmd, folder, on }) }); } catch {}
  const h = HIST.find(x => x.cmd === cmd && x.folder === folder);
  if (h) h.pinned = on;
  HIST.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.lastRun - a.lastRun);
  renderHistory();
}

let reconnectTimer = null;
function setOffline(off) {
  document.getElementById('offbar').classList.toggle('show', off);
  document.body.classList.toggle('off', off);
  if (off && !reconnectTimer) reconnectTimer = setInterval(refresh, 2000); // tenta reconectar sozinho
  if (!off && reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
}
function reconnect() { refresh(); }
function closePanel() {
  // servidor morto não dá pra religar pelo navegador — só fecha a janela do app.
  // (reabra depois pelo ícone do AgentDeck, que sobe o servidor de novo)
  window.close();
  // se o navegador bloquear o close (aba normal, não janela --app), dá a dica
  setTimeout(() => toast('Feche a janela com Ctrl+W', 'err'), 250);
}

async function refresh() {
  let data;
  try { data = await (await fetch('/api/state')).json(); }
  catch { setOffline(true); document.getElementById('status-dot').classList.remove('live'); return; }
  setOffline(false);
  document.getElementById('badge-watch').textContent = data.tasks.length + data.containers.length;
  document.getElementById('status-dot').classList.toggle('live', data.tasks.length > 0);

  const t = document.getElementById('tasks');
  t.innerHTML = data.tasks.length ? data.tasks.map(x => \`
    <div class="card">
      <div class="main">
        <div class="title">\${esc(folderName(x.cwd) || x.cmd)}</div>
        \${folderName(x.cwd) ? \`<div class="cmd-sub" title="\${esc(x.cmd)}">\${esc(x.cmd)}</div>\` : ''}
        <div class="meta">
          <span class="chip pid">PID \${x.pid}</span>
          <span class="chip up">▲ \${fmtUp(x.etimes)}</span>
          \${x.cwd ? \`<span class="chip folder" title="\${esc(x.cwd)}">\${esc(x.cwd)}</span>\` : ''}
          \${x.port ? \`<span class="chip port">porta \${x.port}</span> <a class="open" href="http://localhost:\${x.port}" target="_blank">abrir ↗</a>\` : ''}
        </div>
      </div>
      <div class="actions">
        \${x.log ? \`<button class="btn btn-ghost btn-icon" title="Ver logs" onclick='openLog(\${esc(JSON.stringify(x.log))}, \${esc(JSON.stringify(folderName(x.cwd) || x.cmd))})'><svg viewBox="0 0 24 24" style="width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M4 4h16v16H4z" opacity="0"/><path d="M7 8h10M7 12h10M7 16h6"/></svg></button>\` : ''}
        <button class="btn btn-ghost" onclick='restartProc(\${x.pid}, \${JSON.stringify(x.cmd)}, \${JSON.stringify(x.cwd||'')})'>Reiniciar</button>
        <button class="btn btn-kill" onclick='kill(\${JSON.stringify({pid:x.pid})}, \${JSON.stringify(x.cmd)}, \${JSON.stringify(x.cwd||'')})'>Finalizar</button>
      </div>
    </div>\`).join('') : '<div class="empty">Nada rodando em background agora.</div>';

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
// ── Poll dos Processos: 2,5s na aba Processos; 20s em segundo plano (mantém o
// badge/relógio do cabeçalho frescos sem martelar ps+ss+docker); pausa se oculto.
let pollTimer = null, curTab = 'sessions';
function pollMs() { return curTab === 'watch' ? 2500 : 20000; }
function startPoll() {
  stopPoll();
  if (document.visibilityState !== 'hidden') { refresh(); pollTimer = setInterval(refresh, pollMs()); }
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stopPoll(); else startPoll(); });

// ── Menu ⋮ (kebab) dos cards ──
function closeMenus() { document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open')); }
function toggleMenu(ev, btn) {
  ev.stopPropagation();
  const menu = btn.nextElementSibling, wasOpen = menu.classList.contains('open');
  closeMenus();
  if (!wasOpen) menu.classList.add('open');
}
document.addEventListener('click', closeMenus); // clique fora fecha o menu

// ── Modal de detalhes da sessão ──
function closeInfo() { document.getElementById('info-modal').classList.remove('open'); document.getElementById('info-body').innerHTML = ''; }
async function sessionDetails(id, source) {
  const m = document.getElementById('info-modal'), body = document.getElementById('info-body');
  m.classList.add('open');
  body.innerHTML = '<div class="empty">Lendo…</div>';
  let r;
  try { r = await (await fetch('/api/session-info?source=' + encodeURIComponent(source) + '&id=' + encodeURIComponent(id))).json(); }
  catch { body.innerHTML = '<div class="warn">Falha ao ler os detalhes.</div>'; return; }
  if (!r || !r.ok) { body.innerHTML = '<div class="warn">Sessão não encontrada.</div>'; return; }
  const rows = (r.rows || []).map(row => {
    const mono = /Arquivo|Pasta|^ID$/.test(row.k) ? ' mono' : '';
    return '<div class="info-row"><span class="info-k">' + esc(row.k) + '</span><span class="info-v' + mono + '">' + esc(row.v) + '</span></div>';
  }).join('');
  const resume = r.resume ? '<div class="info-row"><span class="info-k">Retomar</span><span class="info-v mono">' + esc(r.resume) + '</span></div>' : '';
  body.innerHTML = rows + resume;
}

// ── Abas ──
let sessLoaded = false;
function switchTab(name) {
  curTab = name;
  for (const t of ['watch', 'sessions', 'workspaces']) {
    document.getElementById('tab-' + t).classList.toggle('active', t === name);
    document.getElementById('panel-' + t).classList.toggle('active', t === name);
  }
  if (name === 'sessions' && !sessLoaded) loadSessions(); // só escaneia ao abrir a 1ª vez
  if (name === 'workspaces') loadWorkspaces();
  startPoll(); // reinicia com a cadência da aba atual (rápida no watch, lenta fora)
}

// ── Sessões (carregadas sob demanda, não no loop de 2,5s) ──
let SESS = [];
let showArchived = false;
let showFav = false;
let firstSession = null; // 1ª da lista renderizada (alvo do Enter na busca)
let shown = 20; // quantas sessões mostrar (paginação: "ver mais" / "ver todas")
let wsFilter = null; // {name, folders[]} quando filtrando Sessões por um workspace
let sources = { claude: true, codex: true }; // default: Claude + Codex
const PAGE = 20;
function showMore() { shown += PAGE; renderSessions(); }
function showAll() { shown = 1e9; renderSessions(); }
function resetPage() { shown = PAGE; } // volta pro topo ao trocar filtro/fonte/visão

function filterByFolder(folder) {
  const f = document.getElementById('sess-filter');
  f.value = f.value === folder ? '' : folder; // clicar de novo limpa
  resetPage();
  renderSessions();
}
const fmtAgo = (ms) => { const s = Math.floor((Date.now() - ms) / 1000);
  const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60);
  return d ? 'há '+d+'d' : h ? 'há '+h+'h' : m ? 'há '+m+'min' : 'agora'; };
const fmtTok = (n) => n >= 1e6 ? (n/1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.0','') + 'M' : n >= 1e3 ? Math.round(n/1e3) + 'k' : '' + n;
const fmtNum = (n) => (n || 0).toLocaleString('pt-BR');
// rótulo curto da origem da sessão (campo "entrypoint" do .jsonl)
const originLabel = (o) => o === 'claude-vscode' ? 'VS Code' : o === 'cli' ? 'terminal' : o === 'sdk-cli' ? 'SDK' : '';

// ── Conta logada (chip no cabeçalho) ──
let ACCT = null;
async function loadAccount() {
  try { ACCT = await (await fetch('/api/account')).json(); } catch { ACCT = null; }
  renderAccount();
}
// dois chips no topo: Claude (laranja) só com a fonte Claude ativa; Codex (verde) só
// com a fonte Codex ativa. Cada um some quando a respectiva fonte está desligada.
function renderAccount() {
  const el = document.getElementById('acct'); if (!el) return;
  const a = ACCT || {}, chips = [];
  const cl = a.claude;
  if (sources.claude && cl && cl.loggedIn) {
    const label = [cl.email || cl.name, cl.plan].filter(Boolean).join(' · '); // email no lugar da org (universal)
    const tip = 'Claude' + (cl.org ? ' · ' + cl.org : '') + (cl.expiresAt ? ' · token válido até ' + new Date(cl.expiresAt).toLocaleString('pt-BR') : '');
    chips.push('<span class="acct claude" title="' + esc(tip) + '">' + esc(label || 'Claude') + '</span>');
  }
  const cx = a.codex;
  if (sources.codex && cx && cx.loggedIn) {
    const label = [cx.email, cx.plan].filter(Boolean).join(' · ');
    chips.push('<span class="acct codex" title="Codex">' + esc(label || 'Codex') + '</span>');
  }
  el.innerHTML = chips.join('');
}

// acento do app pelo mix de fontes: só Claude = laranja, só Codex = verde,
// ambos OU nenhum = azul.
function applyAccent() {
  const onlyClaude = sources.claude && !sources.codex;
  const onlyCodex = sources.codex && !sources.claude;
  document.documentElement.dataset.accent = onlyClaude ? '' : (onlyCodex ? 'codex' : 'both');
}

function toggleSource(name) {
  sources[name] = !sources[name];
  document.getElementById('src-' + name).classList.toggle('on', sources[name]);
  applyAccent();
  renderAccount(); // mostra/esconde o chip de conta da fonte ligada/desligada
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
  resetPage();
  renderSessions();
}

function toggleArchived() {
  showArchived = !showArchived;
  document.getElementById('sess-filter').value = ''; // limpa o filtro ao trocar de visão
  resetPage();
  renderSessions();
}
function toggleFav() { showFav = !showFav; resetPage(); renderSessions(); }

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
  if (wsFilter) base = base.filter(s => wsFilter.folders.some(f => s.folder === f || s.folder.startsWith(f + '/')));
  const list = base.filter(s => !q || s.title.toLowerCase().includes(q) || s.folder.toLowerCase().includes(q))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)); // fixadas no topo (mantém ordem por recência dentro de cada grupo)
  firstSession = list[0] || null; // alvo do Enter na busca

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

  const wsBanner = wsFilter ? '<div class="ws-banner">Workspace: <b>' + esc(wsFilter.name) + '</b> <button onclick="clearWsFilter()">limpar filtro</button></div>' : '';
  document.getElementById('sessions').innerHTML = wsBanner + (list.length ? list.slice(0, shown).map(s => \`
    <div class="card sess\${s.archived ? ' dim' : ''}">
      <div class="main">
        <div class="title-wrap">
          <span class="title"\${s.renamed ? \` title="auto: \${esc(s.autoTitle)}"\` : ''}>\${esc(s.title)}</span>
          <button class="btn btn-edit btn-icon" title="Renomear" onclick='startRename(this, \${JSON.stringify(s.id)}, \${JSON.stringify(s.source)})'><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        </div>
        \${s.lastMsg ? \`<div class="lastmsg" title="\${esc(s.lastMsg)}">\${esc(s.lastMsg)}</div>\` : ''}
        <div class="meta">
          <span class="chip src-\${s.source}">\${s.source === 'codex' ? 'Codex' : 'Claude'}</span>
          \${originLabel(s.origin) ? \`<span class="chip origin" title="Sessão iniciada no \${originLabel(s.origin)} — dá pra retomar tanto no terminal quanto no VS Code">\${originLabel(s.origin)}</span>\` : ''}
          \${s.live ? '<span class="chip live">● ativa</span>' : ''}
          <span class="chip folder clickable" title="\${esc(s.folder)} — clique p/ filtrar por esta pasta" onclick='filterByFolder(\${esc(JSON.stringify(s.folder))})'>\${esc(s.folder)}</span>
          <span class="chip up">\${fmtAgo(s.mtime)}</span>
          \${s.usage && s.usage.turns ? \`<span class="chip tok" title="saída (gerados): \${fmtNum(s.usage.out)} · entrada: \${fmtNum(s.usage.in)} · cache: criação \${fmtNum(s.usage.cc)} + leitura \${fmtNum(s.usage.cr)} · \${s.usage.turns} turnos">\${fmtTok(s.usage.out)} tok</span>\` : ''}
          <span class="chip pid">\${esc(s.id.slice(0,8))}</span>
        </div>
      </div>
      <div class="side">
        <div class="side-top">
          <button class="btn btn-icon btn-fav\${s.fav ? ' on' : ''}" title="\${s.fav ? 'Desfavoritar' : 'Favoritar'}" onclick='flag(\${JSON.stringify(s.id)}, \${JSON.stringify(s.source)}, "fav", \${!s.fav}, this)'><svg viewBox="0 0 24 24"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg></button>
          <button class="btn btn-icon btn-pin\${s.pinned ? ' on' : ''}" title="\${s.pinned ? 'Desafixar' : 'Fixar no topo'}" onclick='flag(\${JSON.stringify(s.id)}, \${JSON.stringify(s.source)}, "pin", \${!s.pinned}, this)'><svg viewBox="0 0 24 24"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg></button>
          <div class="kebab-wrap">
            <button class="btn btn-icon btn-kebab" title="Mais ações" onclick='toggleMenu(event, this)'><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
            <div class="menu">
              <button class="menu-item" onclick='sessionDetails(\${JSON.stringify(s.id)}, \${JSON.stringify(s.source)}); closeMenus()'><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5h.01"/></svg> Detalhes</button>
              <button class="menu-item" onclick='exportOne(\${JSON.stringify(s.id)}, \${JSON.stringify(s.source)}, this); closeMenus()'><svg viewBox="0 0 24 24"><path d="M12 3v12M8 11l4 4 4-4M5 21h14"/></svg> Baixar sessão (.json)</button>
            </div>
          </div>
        </div>
        <div class="side-bottom">
          <button class="btn btn-vscode btn-icon" title="\${s.source === 'codex' ? 'Abrir a pasta no VS Code' : 'Abrir no VS Code (pasta + esta conversa na extensão)'}" onclick='openIn(\${esc(JSON.stringify(s.folder))}, \${JSON.stringify(s.id)}, \${JSON.stringify(s.source)}, this)'><svg viewBox="0 0 24 24"><path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg></button>
          <button class="btn btn-resume btn-icon" title="Copiar comando pra retomar no terminal (\${s.source === 'codex' ? 'codex resume' : 'claude --resume'})" onclick='resume(\${esc(JSON.stringify(s.folder))}, \${JSON.stringify(s.id)}, \${JSON.stringify(s.source)}, this)'><svg viewBox="0 0 24 24"><path d="M4 17l6-5-6-5"/><path d="M12 19h8"/></svg></button>
          <button class="btn btn-arch btn-icon" title="\${s.archived ? 'Desarquivar — volta pra lista de ativas' : 'Arquivar — tira da lista (não apaga nada)'}" onclick='archive(\${JSON.stringify(s.id)}, \${JSON.stringify(s.source)}, \${!s.archived}, this)'>\${s.archived ? '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M12 18v-6"/><path d="M9.5 14.5 12 12l2.5 2.5"/></svg>' : '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 13h4"/></svg>'}</button>
        </div>
      </div>
    </div>\`).join('') + (list.length > shown
      ? \`<div class="loadmore"><button class="btn btn-ghost" onclick="showMore()">Ver mais (+\${Math.min(PAGE, list.length - shown)})</button><button class="btn btn-ghost" onclick="showAll()">Ver todas (\${list.length})</button></div>\`
      : '') : \`<div class="empty">\${emptyMsg}</div>\`);
}

async function openIn(folder, id, source, btn) {
  btn.disabled = true;
  try { await fetch('/api/open', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ folder, session: id, source }) }); }
  catch {}
  setTimeout(() => { btn.disabled = false; }, 600);
}

function resume(folder, id, source, btn) {
  const cmd = 'cd ' + JSON.stringify(folder) + (source === 'codex' ? ' && codex resume ' : ' && claude --resume ') + id;
  navigator.clipboard.writeText(cmd).then(() => {
    if (!btn) return;
    // botão é ícone (sem texto): troca o SVG por um ✓ e pisca verde, sem apagar o ícone
    const old = btn.innerHTML, t = btn.title;
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
    btn.classList.add('ok'); btn.title = 'comando copiado ✓';
    setTimeout(() => { btn.innerHTML = old; btn.classList.remove('ok'); btn.title = t; }, 1200);
  });
}

// ── Exportar (por sessão) ──
const encProj = (p) => p.replace(/[^A-Za-z0-9]/g, '-'); // usado pelo preview de import

async function exportOne(id, source, btn) {
  btn.disabled = true; btn.style.opacity = '.5';
  let bundle;
  try { bundle = await (await fetch('/api/export', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ items: [{ source, id }], scanSecrets: true }) })).json(); }
  catch { btn.disabled = false; btn.style.opacity = ''; toast('Falha ao exportar', 'err'); return; }
  btn.disabled = false; btn.style.opacity = '';
  const secrets = ((bundle.sessions || [])[0] || {}).secrets || [];
  if (secrets.length) {
    const kinds = secrets.map(x => x.kind + ' ×' + x.count).join(', ');
    if (!(await askConfirm('Possíveis segredos nesta sessão (' + kinds + '). Baixar mesmo assim?', { danger: true, okLabel: 'Baixar mesmo assim' }))) return;
  }
  downloadBundle(bundle);
  toast('✓ sessão exportada', 'ok');
}
function downloadBundle(bundle) {
  const n = (bundle.sessions || []).length;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
  a.download = 'agentdeck-' + n + 'sessoes-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click(); URL.revokeObjectURL(a.href);
}

// ── Importar (modal aberto pelo botão do cabeçalho) ──
let impBundle = null, impPlan = null;
function openImport() { document.getElementById('imp-modal').classList.add('open'); }
function closeImport(reload) {
  document.getElementById('imp-modal').classList.remove('open');
  document.getElementById('imp-plan').innerHTML = '';
  document.getElementById('imp-name').textContent = '';
  document.getElementById('imp-file').value = ''; // permite re-selecionar o mesmo arquivo
  if (reload === true) loadSessions();
}
async function impPick(ev) {
  const file = ev.target.files && ev.target.files[0]; if (!file) return;
  document.getElementById('imp-name').textContent = file.name;
  openImport();
  const plan = document.getElementById('imp-plan');
  plan.innerHTML = '<div class="empty">Analisando…</div>';
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
  document.getElementById('imp-plan').innerHTML = '<div class="plan-card"><div class="title">Resultado</div><div style="margin-top:10px">' + (items || 'nada') + '</div></div>'
    + '<div class="actions" style="margin-top:12px"><button class="btn btn-copy" onclick="closeImport(true)">Fechar e atualizar</button></div>';
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

// começa o poll na cadência da aba inicial (Sessões → 20s; popula badge/relógio já).
startPoll();
loadAccount(); // chip de conta no cabeçalho (uma leitura, não entra no poll)
loadWorkspaces(); // popula o badge de Workspaces e os dados pro modal de nova sessão
applyAccent(); // acento inicial pelo mix de fontes (default: só Claude → laranja)

// atalhos de teclado na aba Sessões: '/' foca a busca, Esc limpa, Enter retoma a 1ª.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('ws-modal').classList.contains('open')) { closeWsModal(); return; }
  if (e.key === 'Escape' && document.getElementById('newsess-modal').classList.contains('open')) { closeNewSession(); return; }
  if (e.key === 'Escape' && document.getElementById('log-modal').classList.contains('open')) { closeLog(); return; }
  if (e.key === 'Escape' && document.getElementById('help-modal').classList.contains('open')) { closeHelp(); return; }
  if (e.key === 'Escape' && document.getElementById('hist-modal').classList.contains('open')) { closeHistory(); return; }
  if (e.key === 'Escape' && document.getElementById('info-modal').classList.contains('open')) { closeInfo(); return; }
  if (e.key === 'Escape' && document.getElementById('imp-modal').classList.contains('open')) { closeImport(); return; }
  if (e.key === 'Escape' && document.querySelector('.menu.open')) { closeMenus(); return; }
  if (curTab !== 'sessions') return;
  const f = document.getElementById('sess-filter');
  const el = document.activeElement;
  const typing = el && (/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable);
  if (e.key === '/' && !typing) { e.preventDefault(); f.focus(); f.select(); }
  else if (e.key === 'Escape' && el === f) { f.value = ''; renderSessions(); f.blur(); }
  else if (e.key === 'Enter' && el === f && firstSession) {
    e.preventDefault();
    // .btn-resume (não .btn-copy) — o ✓ do rename também é .btn-copy e poderia ser pego
    resume(firstSession.folder, firstSession.id, firstSession.source, document.querySelector('#sessions .btn-resume'));
  }
});

// aba padrão é Sessões; #watch abre direto na aba de Processos
const startHash = location.hash.slice(1);
if (startHash === 'watch') switchTab(startHash);
else loadSessions();
</script>
</body>
</html>`;
