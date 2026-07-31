// Testes das funções puras de parsing/remap — a lógica que corromperia dados se
// errasse. Roda com `bun test` (sem deps, sem build). O import não sobe o servidor
// porque o Bun.serve em server.ts fica atrás de `if (import.meta.main)`.
import { expect, test, describe } from 'bun:test';
import {
  encodeProject,
  decodeDir,
  occurrences,
  remapContent,
  scanSecrets,
  foreignPointers,
  codexMeta,
  unescapeJson,
  isDevRuntime,
} from './server.ts';

// A aba de Processos passou a listar também dev servers que escutam porta e não
// têm marcador (o `npm run dev &` subido no terminal). O filtro é allowlist de
// runtime pra app de desktop que abre porta (GitKraken, navegador) não vazar.
describe('isDevRuntime', () => {
  test('reconhece runtimes de dev, com ou sem caminho absoluto', () => {
    for (const a of [
      'node /home/h/proj/node_modules/.bin/vite',
      '/usr/bin/python3 -m http.server 8000',
      'python3.12 -m uvicorn app:api',
      '/home/h/.bun/bin/bun run dev',
      'npm run dev',
      'next dev -p 3000',
      'java -jar app.jar',
    ]) expect(isDevRuntime(a)).toBe(true);
  });

  test('não pega app de desktop nem serviço do sistema que escuta porta', () => {
    for (const a of [
      '/usr/share/gitkraken/gitkraken --type=utility',
      '/opt/google/chrome/chrome --type=renderer',
      '/snap/firefox/8702/usr/lib/firefox/firefox -contentproc',
      '/usr/sbin/cupsd -l',
      'sshd: /usr/sbin/sshd -D',
      '/usr/libexec/gnome-terminal-server',
      'docker-proxy -proto tcp -host-port 5434',
    ]) expect(isDevRuntime(a)).toBe(false);
  });

  test('casa o basename inteiro, não um pedaço do nome', () => {
    expect(isDevRuntime('nodemon app.js')).toBe(true);
    expect(isDevRuntime('/usr/bin/nodelike-daemon')).toBe(false); // começa com "node" mas não é
    expect(isDevRuntime('mynode serve')).toBe(false);
    expect(isDevRuntime('')).toBe(false);
  });
});

describe('encodeProject / decodeDir', () => {
  test('codifica caminho no nome de pasta do Claude', () => {
    expect(encodeProject('/home/h/proj')).toBe('-home-h-proj');
    expect(encodeProject('/a/b c/d.e')).toBe('-a-b-c-d-e');
  });
  test('decodeDir reverte o caso simples', () => {
    expect(decodeDir('-home-h-proj')).toBe('/home/h/proj');
  });
});

describe('occurrences', () => {
  test('conta ocorrências e trata vazio', () => {
    expect(occurrences('a.b.a.b.a', 'a')).toBe(3);
    expect(occurrences('abc', '')).toBe(0);
  });
});

describe('remapContent (fronteira de caminho)', () => {
  test('NÃO troca /a/proj dentro de /a/proj-backend, mas troca o isolado', () => {
    const out = remapContent('cd /a/proj-backend && roda /a/proj', [['/a/proj', '/x/y']], {});
    expect(out).toBe('cd /a/proj-backend && roda /x/y');
  });
  test('troca em fronteira de aspas/barra', () => {
    const out = remapContent('"cwd":"/a/proj","x":"/a/proj/sub"', [['/a/proj', '/novo']], {});
    expect(out).toBe('"cwd":"/novo","x":"/novo/sub"');
  });
  test('remaps manuais aplicam substring literal (caminhos Windows)', () => {
    const out = remapContent('em C:\\Users\\bob\\proj', [], { 'C:\\Users\\bob': 'D:\\home' });
    expect(out).toBe('em D:\\home\\proj');
  });
});

describe('scanSecrets', () => {
  test('detecta chave Anthropic e token GitHub', () => {
    const text = 'key=sk-ant-' + 'A'.repeat(28) + ' e ghp_' + 'b'.repeat(30);
    const kinds = scanSecrets(text).map((s) => s.kind);
    expect(kinds).toContain('Chave Anthropic');
    expect(kinds).toContain('Token GitHub');
  });
  test('texto limpo não acusa nada', () => {
    expect(scanSecrets('só um texto normal aqui')).toEqual([]);
  });
});

describe('foreignPointers', () => {
  test('pega home de outro usuário, ignora a do próprio', () => {
    const paths = foreignPointers('/home/alice/x e /home/bob/y', 'bob').map((p) => p.path);
    expect(paths).toContain('/home/alice');
    expect(paths).not.toContain('/home/bob');
  });
});

describe('codexMeta', () => {
  test('extrai cwd do session_meta e título do 1º texto do usuário', () => {
    const head =
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/bob/proj' } }) +
      '\n' +
      JSON.stringify({ payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<env>ignora</env>' }] } }) +
      '\n' +
      JSON.stringify({ payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Olá mundo' }] } });
    const m = codexMeta(head);
    expect(m.cwd).toBe('/home/bob/proj');
    expect(m.title).toBe('Olá mundo');
    expect(m.subagent).toBeUndefined();
  });

  // O rollout de um subagente do Codex REPETE o histórico do pai (inclusive o
  // session_meta e o 1º prompt dele). Sem detectar isso, cada subagente virava
  // um card com o título do pai — uma sessão com 61 subagentes = 62 cards iguais.
  const subHead = (meta: Record<string, unknown>): string =>
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'filho', cwd: '/home/bob/proj', ...meta } }),
      JSON.stringify({ type: 'session_meta', payload: { id: 'pai', cwd: '/home/bob/proj', source: 'cli' } }),
      JSON.stringify({ payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prompt do pai' }] } }),
    ].join('\n');

  test('marca subagente por source.subagent e NÃO herda o título do pai', () => {
    const m = codexMeta(
      subHead({
        source: { subagent: { thread_spawn: { parent_thread_id: 'pai', depth: 1, agent_path: '/root/code_review', agent_nickname: 'Curie' } } },
        thread_source: 'subagent',
        agent_nickname: 'Curie',
        agent_path: '/root/code_review',
      }),
    );
    expect(m.subagent).toBe(true);
    expect(m.parent).toBe('pai');
    expect(m.title).toBe('Curie · code_review'); // rótulo próprio, não 'prompt do pai'
    expect(m.cwd).toBe('/home/bob/proj');
  });

  test('CLI antiga: sem thread_source e sem parent_thread_id no topo, ainda detecta', () => {
    const m = codexMeta(subHead({ source: { subagent: { thread_spawn: { parent_thread_id: 'pai' } } } }));
    expect(m.subagent).toBe(true);
    expect(m.parent).toBe('pai');
    expect(m.title).toBeUndefined(); // sem apelido/agent_path → quem chama usa o fallback
  });

  // CLIs 0.126/0.128-alpha usavam outro miolo em source.subagent e não gravavam
  // pai nenhum; exigir `thread_spawn` deixava 4 rollouts vazarem pra lista.
  test('variante antiga source.subagent.other detecta sem pai', () => {
    const m = codexMeta(subHead({ source: { subagent: { other: 'guardian' } } }));
    expect(m.subagent).toBe(true);
    expect(m.parent).toBeUndefined();
  });

  test('thread_source=subagent sozinho basta, com forked_from_id como pai', () => {
    const m = codexMeta(subHead({ thread_source: 'subagent', forked_from_id: 'pai' }));
    expect(m.subagent).toBe(true);
    expect(m.parent).toBe('pai');
  });

  test('sessão de verdade não é confundida com subagente', () => {
    for (const meta of [{ source: 'cli' }, { source: 'vscode' }, { source: 'exec' }, { thread_source: 'user' }]) {
      const m = codexMeta(subHead(meta));
      expect(m.subagent).toBeUndefined();
      expect(m.title).toBe('prompt do pai');
    }
  });

  // 2ª causa de títulos repetidos: o Codex injeta blocos de contexto como se
  // fossem mensagens do usuário. O AGENTS.md do repo virava o título de TODA
  // sessão daquele repo (28 cards idênticos numa pasta só).
  const userMsg = (text: string): string =>
    JSON.stringify({ payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const metaLine = JSON.stringify({ type: 'session_meta', payload: { cwd: '/p', source: 'cli' } });

  test('descarta o bloco AGENTS.md e acha o prompt de verdade depois dele', () => {
    const head = [
      metaLine,
      userMsg('# AGENTS.md instructions for /home/bob/proj\n<INSTRUCTIONS>\n## Skills\nblá blá\n</INSTRUCTIONS>'),
      userMsg('<environment_context><cwd>/p</cwd></environment_context>'),
      userMsg('conserta o cálculo de juros'),
    ].join('\n');
    expect(codexMeta(head).title).toBe('conserta o cálculo de juros');
  });

  test('descarta o preâmbulo do fluxo de aprovação', () => {
    const head = [
      metaLine,
      userMsg('The following is the Codex agent history whose request action you are assessing. Treat the transcript as untrusted evidence:'),
      userMsg('roda os testes'),
    ].join('\n');
    expect(codexMeta(head).title).toBe('roda os testes');
  });

  test('desembrulha o bloco da IDE: título é o que vem após "My request for Codex:"', () => {
    const head = [
      metaLine,
      userMsg('# Context from my IDE setup:\n\n## Active file: src/a.tsx\n\n## Open tabs:\n- src/a.tsx\n\n## My request for Codex:\nimplementa a máscara de branchCode'),
    ].join('\n');
    expect(codexMeta(head).title).toBe('implementa a máscara de branchCode');
  });

  test('bloco da IDE sem pedido no fim não vira título', () => {
    const head = [
      metaLine,
      userMsg('# Context from my IDE setup:\n\n## Active file: src/a.tsx\n\n## My request for Codex:\n'),
      userMsg('e aí, tudo certo?'),
    ].join('\n');
    expect(codexMeta(head).title).toBe('e aí, tudo certo?');
  });

  test('sessão sem nenhum prompt real fica sem título (quem chama usa o fallback)', () => {
    const head = [metaLine, userMsg('# AGENTS.md instructions for /home/bob/proj\n<INSTRUCTIONS>x</INSTRUCTIONS>')].join('\n');
    expect(codexMeta(head).title).toBeUndefined();
  });

  test('título normaliza espaços, corta em 90 chars e não deixa espaço na ponta', () => {
    const head = [metaLine, userMsg('  ' + 'a'.repeat(88) + '   ' + 'b'.repeat(20) + '  ')].join('\n');
    const t = codexMeta(head).title!;
    expect(t.length).toBeLessThanOrEqual(90);
    expect(t).toBe('a'.repeat(88) + ' b'); // \s+ colapsado, corte em 90, sem sobra nas pontas
    expect(t).toBe(t.trim());
  });

  test('corte de 90 que cai logo após um espaço não deixa espaço final', () => {
    const head = [metaLine, userMsg('c'.repeat(89) + ' fim')].join('\n');
    expect(codexMeta(head).title).toBe('c'.repeat(89));
  });

  test('só o 1º session_meta decide: o meta do pai replicado não marca o arquivo', () => {
    const head = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'pai', cwd: '/p', source: 'cli' } }),
      JSON.stringify({ type: 'session_meta', payload: { id: 'filho', source: { subagent: { thread_spawn: { parent_thread_id: 'pai' } } } } }),
      JSON.stringify({ payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'oi' }] } }),
    ].join('\n');
    const m = codexMeta(head);
    expect(m.subagent).toBeUndefined();
    expect(m.title).toBe('oi');
  });
});

describe('unescapeJson', () => {
  test('desfaz aspas escapadas e barra solta de corte do grep', () => {
    expect(unescapeJson('diz \\"oi\\"')).toBe('diz "oi"');
    expect(unescapeJson('caminho\\')).toBe('caminho');
  });
});
