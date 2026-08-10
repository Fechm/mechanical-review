/**
 * Meta-aserciones de `check-alcance-diff.mjs` — la fase 0.
 *
 * Es el guarda mas critico de todos y el menos vistoso: si aprueba con un diff vacio o
 * con un clon superficial, **todas** las fases siguientes miran cero archivos y la
 * corrida entera sale verde sin haber revisado nada. Un falso negativo aca no degrada
 * la revision: la anula.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commitear, config, correrGuarda, escribir, limpiar, repoTemporal } from './ayuda.mjs';

after(limpiar);

describe('check-alcance-diff: lo que tiene que BLOQUEAR', () => {
  it('sin config bloquea', () => {
    const repo = repoTemporal();
    escribir(repo, 'src/a.ts', 'export const a = 1;\n');
    commitear(repo);
    const r = correrGuarda(repo, 'check-alcance-diff.mjs');
    assert.equal(r.codigo, 1, 'sin config no se sabe que es zona critica');
    assert.match(r.salida, /config/i);
  });

  it('config sin zonas.critica bloquea', () => {
    // Modo de falla: sin zonas.critica declaradas TODO el diff seria nivel 0/1 y la
    // mutacion no correria nunca — la herramienta instalada y sin verificar nada.
    const repo = repoTemporal();
    escribir(repo, '.mechanical-review/config.json', JSON.stringify({ base: 'origin/main' }));
    escribir(repo, 'src/a.ts', 'export const a = 1;\n');
    commitear(repo);
    const r = correrGuarda(repo, 'check-alcance-diff.mjs');
    assert.equal(r.codigo, 1, 'a nivel 0 por omision no se llega');
    assert.match(r.salida, /critica/i);
  });

  it('una base que no existe bloquea con el arreglo escrito', () => {
    // Es el caso del checkout superficial (fetch-depth: 1 / clone depth 50): el
    // merge-base no resuelve y un guarda ingenuo lo leeria como "no hay cambios".
    const repo = repoTemporal();
    config(repo);
    escribir(repo, 'src/a.ts', 'export const a = 1;\n');
    commitear(repo);
    const r = correrGuarda(repo, 'check-alcance-diff.mjs', ['--base', 'origin/no-existe']);
    assert.equal(r.codigo, 1, 'sin base no se puede calcular el diff, y sin diff no se aprueba');
    assert.match(r.salida, /fetch-depth|depth: full|no existe/i);
  });

  it('un diff vacio bloquea salvo permiso explicito', () => {
    const repo = repoTemporal();
    config(repo);
    const r = correrGuarda(repo, 'check-alcance-diff.mjs');
    assert.equal(r.codigo, 1, 'un diff vacio no es "nada que objetar", es "nada que verificar"');
  });
});

describe('check-alcance-diff: lo que tiene que APROBAR', () => {
  it('un diff normal aprueba y deja alcance.json', () => {
    const repo = repoTemporal();
    config(repo);
    escribir(repo, 'src/critico/cobro.ts', 'export const a = 1;\n');
    commitear(repo);
    const r = correrGuarda(repo, 'check-alcance-diff.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
    assert.ok(
      existsSync(join(repo, '.mechanical-review', 'out', 'alcance.json')),
      'el artefacto alimenta a las fases siguientes; sin el, la mutacion no puede cruzar nada',
    );
  });

  it('un diff vacio con --sin-cambios-ok aprueba', () => {
    const repo = repoTemporal();
    config(repo);
    const r = correrGuarda(repo, 'check-alcance-diff.mjs', ['--sin-cambios-ok']);
    assert.equal(r.codigo, 0, 'el permiso tiene que ser explicito, pero tiene que existir');
  });

  it('un cambio en zona critica se clasifica nivel 2', () => {
    const repo = repoTemporal();
    config(repo);
    escribir(repo, 'src/critico/cobro.ts', 'export const a = 1;\n');
    commitear(repo);
    const r = correrGuarda(repo, 'check-alcance-diff.mjs');
    assert.equal(r.codigo, 0);
    assert.match(r.salida, /2|critico/i, 'tocar zona critica tiene que subir el nivel');
  });

  it('un cambio solo en documentacion NO llega a nivel 2', () => {
    const repo = repoTemporal();
    config(repo);
    escribir(repo, 'docs/notas.md', '# notas\n');
    commitear(repo);
    const r = correrGuarda(repo, 'check-alcance-diff.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
    assert.doesNotMatch(
      r.salida,
      /nivel 2/i,
      'cobrar mutacion por un cambio de docs hace que la herramienta se apague',
    );
  });
});
