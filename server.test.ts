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
} from './server.ts';

describe('encodeProject / decodeDir', () => {
  test('codifica caminho no nome de pasta do Claude', () => {
    expect(encodeProject('/home/h/efex')).toBe('-home-h-efex');
    expect(encodeProject('/a/b c/d.e')).toBe('-a-b-c-d-e');
  });
  test('decodeDir reverte o caso simples', () => {
    expect(decodeDir('-home-h-efex')).toBe('/home/h/efex');
  });
});

describe('occurrences', () => {
  test('conta ocorrências e trata vazio', () => {
    expect(occurrences('a.b.a.b.a', 'a')).toBe(3);
    expect(occurrences('abc', '')).toBe(0);
  });
});

describe('remapContent (fronteira de caminho)', () => {
  test('NÃO troca /a/efex dentro de /a/efex-backend, mas troca o isolado', () => {
    const out = remapContent('cd /a/efex-backend && roda /a/efex', [['/a/efex', '/x/y']], {});
    expect(out).toBe('cd /a/efex-backend && roda /x/y');
  });
  test('troca em fronteira de aspas/barra', () => {
    const out = remapContent('"cwd":"/a/efex","x":"/a/efex/sub"', [['/a/efex', '/novo']], {});
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
  });
});

describe('unescapeJson', () => {
  test('desfaz aspas escapadas e barra solta de corte do grep', () => {
    expect(unescapeJson('diz \\"oi\\"')).toBe('diz "oi"');
    expect(unescapeJson('caminho\\')).toBe('caminho');
  });
});
