/**
 * Meta-aserciones de `check-cobertura-diff.mjs`.
 *
 * Esta valla no es un gate terminal: su funcion real es decidir DONDE mutar. Por eso
 * sus modos de falla son todos de la misma familia — aprobar por falta de datos. Un
 * lcov ausente, uno que no menciona los archivos del diff, o un denominador cero
 * reportado como "100%" dejan a la mutacion mordiendo el vacio.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcularAlcance,
  commitear,
  config,
  correrGuarda,
  escribir,
  limpiar,
  repoTemporal,
} from './ayuda.mjs';

after(limpiar);

/**
 * lcov minimo. `lineas` es [[numero, veces]]: veces 0 = linea no cubierta.
 * El formato es el de LCOV: SF (archivo), DA (linea,hits), LF/LH (totales), end_of_record.
 */
function lcov(archivo, lineas) {
  const da = lineas.map(([n, hits]) => `DA:${n},${hits}`).join('\n');
  const cubiertas = lineas.filter(([, h]) => h > 0).length;
  return (
    `TN:\nSF:${archivo}\n${da}\n` + `LF:${lineas.length}\nLH:${cubiertas}\nend_of_record\n`
  );
}

/** Repo con un archivo de zona critica de 3 lineas y el alcance calculado. */
function repoConFuente() {
  const repo = repoTemporal();
  config(repo);
  escribir(repo, 'src/critico/cobro.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  commitear(repo);
  const alcance = calcularAlcance(repo);
  assert.equal(alcance.codigo, 0, `el alcance deberia calcularse:\n${alcance.salida}`);
  return repo;
}

describe('check-cobertura-diff: lo que tiene que BLOQUEAR', () => {
  it('sin lcov bloquea', () => {
    // "No hay datos" no es "esta cubierto". Un gate que aprueba por ausencia de
    // evidencia es peor que no tenerlo: da una garantia que nadie midio.
    const repo = repoConFuente();
    const r = correrGuarda(repo, 'check-cobertura-diff.mjs');
    assert.equal(r.codigo, 1, 'la ausencia de lcov tiene que bloquear');
    assert.match(r.salida, /lcov/i);
  });

  it('un lcov que no menciona los archivos del diff bloquea', () => {
    // Es "100% de nada": el reporte existe, esta bien formado, y habla de otro modulo.
    const repo = repoConFuente();
    escribir(repo, 'coverage/lcov.info', lcov('src/otro/lejos.ts', [[1, 5], [2, 5]]));
    const r = correrGuarda(repo, 'check-cobertura-diff.mjs');
    assert.equal(r.codigo, 1, 'medir otro archivo no es medir este');
  });

  it('un lcov vacio bloquea', () => {
    const repo = repoConFuente();
    escribir(repo, 'coverage/lcov.info', '');
    const r = correrGuarda(repo, 'check-cobertura-diff.mjs');
    assert.equal(r.codigo, 1, 'un lcov vacio es el mismo caso que no tenerlo');
  });

  it('lineas del diff sin cubrir en zona critica bloquea', () => {
    const repo = repoConFuente();
    escribir(
      repo,
      'coverage/lcov.info',
      lcov('src/critico/cobro.ts', [[1, 3], [2, 0], [3, 0]]),
    );
    const r = correrGuarda(repo, 'check-cobertura-diff.mjs');
    assert.equal(r.codigo, 1, 'en zona critica el umbral es 100%: sin cobertura no hay donde mutar');
  });
});

describe('check-cobertura-diff: lo que tiene que APROBAR', () => {
  it('todas las lineas del diff cubiertas aprueba', () => {
    const repo = repoConFuente();
    escribir(
      repo,
      'coverage/lcov.info',
      lcov('src/critico/cobro.ts', [[1, 3], [2, 3], [3, 3]]),
    );
    const r = correrGuarda(repo, 'check-cobertura-diff.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });

  it('un diff sin fuente aprueba sin exigir lcov', () => {
    // Cobrar cobertura por un cambio de documentacion es como se apaga un gate.
    const repo = repoTemporal();
    config(repo);
    escribir(repo, 'docs/notas.md', '# notas\n');
    commitear(repo);
    const alcance = calcularAlcance(repo);
    assert.equal(alcance.codigo, 0, `el alcance deberia calcularse:\n${alcance.salida}`);
    const r = correrGuarda(repo, 'check-cobertura-diff.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });
});
