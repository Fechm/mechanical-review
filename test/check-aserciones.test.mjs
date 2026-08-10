/**
 * Meta-aserciones de `check-aserciones.mjs` — el piso de aserciones.
 *
 * Es la valla mas rentable del conjunto: la evidencia publicada dice que el numero de
 * aserciones correlaciona con detectar fallos reales y que la cobertura de linea no.
 * Un test sin `expect` da cobertura y no verifica nada — el defecto que origino todo esto.
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
 * Repo con un spec y su fuente, commiteados y con el alcance ya calculado.
 *
 * OJO — defecto encontrado escribiendo esta suite: sin calcular el alcance, el guarda
 * aborta con "No hay alcance calculado" y sale 1. Los casos de bloqueo pasaban **por
 * esa razon y no por el defecto que dicen probar**: una suite verde que no verificaba
 * nada. Lo delataron los casos de aprobacion, que es exactamente por lo que una suite
 * de gates necesita las dos mitades y no solo la que espera rojo.
 */
function repoConSpec(contenido, ruta = 'src/critico/cobro.spec.ts') {
  const repo = repoTemporal();
  config(repo);
  escribir(repo, 'src/critico/cobro.ts', 'export const cobrar = () => true;\n');
  escribir(repo, ruta, contenido);
  commitear(repo);
  const alcance = calcularAlcance(repo);
  assert.equal(alcance.codigo, 0, `el alcance deberia calcularse:\n${alcance.salida}`);
  return repo;
}

describe('check-aserciones: lo que tiene que BLOQUEAR', () => {
  it('un test sin ninguna asercion bloquea', () => {
    const repo = repoConSpec(
      `import { cobrar } from './cobro';\n\n` +
        `describe('cobro', () => {\n` +
        `  it('cobra', () => {\n` +
        `    cobrar();\n` +
        `  });\n` +
        `});\n`,
    );
    const r = correrGuarda(repo, 'check-aserciones.mjs');
    assert.equal(r.codigo, 1, 'un test sin expect ejecuta codigo y no observa nada');
  });

  it('un expect sin matcher bloquea', () => {
    // `expect(x);` a secas compila, corre, suma cobertura y no compara nada.
    const repo = repoConSpec(
      `import { cobrar } from './cobro';\n\n` +
        `describe('cobro', () => {\n` +
        `  it('cobra', () => {\n` +
        `    expect(cobrar());\n` +
        `  });\n` +
        `});\n`,
    );
    const r = correrGuarda(repo, 'check-aserciones.mjs');
    assert.equal(r.codigo, 1, 'un expect sin matcher es una asercion aparente');
  });

  it('un test tautologico bloquea', () => {
    const repo = repoConSpec(
      `describe('cobro', () => {\n` +
        `  it('funciona', () => {\n` +
        `    expect(true).toBe(true);\n` +
        `  });\n` +
        `});\n`,
    );
    const r = correrGuarda(repo, 'check-aserciones.mjs');
    assert.equal(r.codigo, 1, 'afirmar que true es true pasa siempre, incluso con el codigo roto');
  });

  it('un archivo de test sin ningun caso bloquea', () => {
    // El runner lo cuenta como suite verde: cero tests, cero fallos, todo bien.
    const repo = repoConSpec(
      `import { cobrar } from './cobro';\n\n` + `// TODO: escribir los tests\n`,
    );
    const r = correrGuarda(repo, 'check-aserciones.mjs');
    assert.equal(r.codigo, 1, 'un spec vacio suma un archivo y cero garantias');
  });
});

describe('check-aserciones: lo que tiene que APROBAR', () => {
  it('un test que afirma el resultado aprueba', () => {
    const repo = repoConSpec(
      `import { cobrar } from './cobro';\n\n` +
        `describe('cobro', () => {\n` +
        `  it('devuelve true al cobrar', () => {\n` +
        `    expect(cobrar()).toBe(true);\n` +
        `  });\n` +
        `});\n`,
    );
    const r = correrGuarda(repo, 'check-aserciones.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });

  it('un diff sin archivos de test aprueba: esta valla no exige tests, exige que los que hay verifiquen', () => {
    const repo = repoTemporal();
    config(repo);
    escribir(repo, 'docs/notas.md', '# notas\n');
    commitear(repo);
    const alcance = calcularAlcance(repo);
    assert.equal(alcance.codigo, 0, `el alcance deberia calcularse:\n${alcance.salida}`);
    const r = correrGuarda(repo, 'check-aserciones.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });
});
