/**
 * Meta-aserciones de `check-dependencias.mjs`.
 *
 * Es la valla dirigida al unico fallo ESPECIFICO de la generacion por modelos: el
 * paquete alucinado. Su caso central —un import a un paquete que nadie declaro— pasa
 * limpio por todas las demas vallas, asi que si esta se equivoca no hay red debajo.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  marcarBase,
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
 * Repo con manifiesto, lockfile y un archivo de fuente en zona critica.
 * `deps` son las declaradas; `lock` lo que el lockfile menciona (por defecto, las mismas).
 */
function repoConPaquete(fuente, { deps = {}, lock = null, conLock = true } = {}) {
  const repo = repoTemporal();
  config(repo);
  escribir(repo, 'package.json', `${JSON.stringify({ name: 'demo', dependencies: deps }, null, 2)}\n`);
  if (conLock) {
    const contenido = lock === null ? Object.keys(deps) : lock;
    escribir(repo, 'package-lock.json', `${JSON.stringify({ packages: contenido }, null, 2)}\n`);
  }
  escribir(repo, 'src/critico/cobro.ts', fuente);
  commitear(repo);
  const alcance = calcularAlcance(repo);
  assert.equal(alcance.codigo, 0, `el alcance deberia calcularse:\n${alcance.salida}`);
  return repo;
}

describe('check-dependencias: lo que tiene que BLOQUEAR', () => {
  it('un import a un paquete no declarado bloquea', () => {
    // EL caso: el modelo invento `superfetch-retry`, lo importo, y nadie lo agrego al
    // manifiesto. Compila, tipa, testea y muta sin que ninguna otra valla lo vea.
    const repo = repoConPaquete(
      `import { retry } from 'superfetch-retry';\nexport const a = retry;\n`,
      { deps: { axios: '^1.7.0' } },
    );
    const r = correrGuarda(repo, 'check-dependencias.mjs');
    assert.equal(r.codigo, 1, 'un import sin declarar tiene que bloquear');
    assert.match(r.salida, /superfetch-retry/);
    assert.match(r.salida, /NO DECLARADOS|no declarados/i);
  });

  it('un require a un paquete no declarado tambien bloquea', () => {
    const repo = repoConPaquete(
      `const parse = require('json-parse-safe-v2');\nmodule.exports = parse;\n`,
      { deps: {} },
    );
    const r = correrGuarda(repo, 'check-dependencias.mjs');
    assert.equal(r.codigo, 1, 'la sintaxis CommonJS cuenta igual');
    assert.match(r.salida, /json-parse-safe-v2/);
  });

  it('un import dinamico a un paquete no declarado bloquea', () => {
    const repo = repoConPaquete(
      `export async function f() { return import('lodash-esm-fast'); }\n`,
      { deps: {} },
    );
    const r = correrGuarda(repo, 'check-dependencias.mjs');
    assert.equal(r.codigo, 1, 'import() diferido esconde igual una dependencia');
  });

  it('una dependencia nueva ausente del lockfile bloquea', () => {
    // Declarada y nunca instalada: el estado tipico de un nombre inventado que se
    // agrego al manifiesto "porque el import lo pedia".
    //
    // OJO: "nueva" se calcula contra el package.json de la BASE, asi que el fixture
    // tiene que establecer una base con manifiesto y recien despues agregar la
    // dependencia. Con el manifiesto naciendo en el mismo commit no hay con que
    // comparar y la rama no se ejercita — el caso pasaba en verde sin probar nada.
    const repo = repoTemporal();
    config(repo);
    escribir(repo, 'package.json', `${JSON.stringify({ name: 'demo', dependencies: {} }, null, 2)}\n`);
    escribir(repo, 'package-lock.json', `${JSON.stringify({ packages: [] }, null, 2)}\n`);
    commitear(repo, 'base con manifiesto');
    marcarBase(repo);

    escribir(
      repo,
      'package.json',
      `${JSON.stringify({ name: 'demo', dependencies: { 'paquete-fantasma': '^2.0.0' } }, null, 2)}\n`,
    );
    escribir(repo, 'src/critico/cobro.ts', `import x from 'paquete-fantasma';\nexport default x;\n`);
    commitear(repo, 'agrega la dependencia');
    assert.equal(calcularAlcance(repo).codigo, 0);

    const r = correrGuarda(repo, 'check-dependencias.mjs');
    assert.equal(r.codigo, 1, 'declarada y sin instalar nunca es sospechoso');
    assert.match(r.salida, /lockfile/i);
  });

  it('sin package.json bloquea', () => {
    // "No pude comprobar la procedencia" nunca es "la procedencia esta bien".
    const repo = repoTemporal();
    config(repo);
    escribir(repo, 'src/critico/cobro.ts', `import x from 'algo';\nexport default x;\n`);
    commitear(repo);
    const alcance = calcularAlcance(repo);
    assert.equal(alcance.codigo, 0);
    const r = correrGuarda(repo, 'check-dependencias.mjs');
    assert.equal(r.codigo, 1, 'sin manifiesto no hay contra que contrastar');
    assert.match(r.salida, /package\.json/i);
  });

  it('sin alcance calculado bloquea', () => {
    const repo = repoTemporal();
    config(repo);
    escribir(repo, 'package.json', '{"name":"demo"}\n');
    escribir(repo, 'src/critico/cobro.ts', 'export const a = 1;\n');
    commitear(repo);
    const r = correrGuarda(repo, 'check-dependencias.mjs');
    assert.equal(r.codigo, 1, 'revisar cero archivos no es aprobar');
  });
});

describe('check-dependencias: lo que tiene que APROBAR', () => {
  it('imports a paquetes declarados aprueba', () => {
    const repo = repoConPaquete(
      `import axios from 'axios';\nimport { z } from 'zod';\nexport const a = { axios, z };\n`,
      { deps: { axios: '^1.7.0', zod: '^3.23.0' } },
    );
    const r = correrGuarda(repo, 'check-dependencias.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });

  it('los builtins de node no exigen declaracion', () => {
    // Cobrarle a `node:fs` una entrada en package.json seria un falso positivo diario,
    // y un gate que se equivoca a diario se apaga en una semana.
    const repo = repoConPaquete(
      `import { readFileSync } from 'node:fs';\nimport { join } from 'path';\nexport const a = { readFileSync, join };\n`,
      { deps: {} },
    );
    const r = correrGuarda(repo, 'check-dependencias.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });

  it('las rutas relativas no exigen declaracion', () => {
    const repo = repoConPaquete(
      `import { x } from './otro';\nimport { y } from '../lib/util';\nexport const a = { x, y };\n`,
      { deps: {} },
    );
    const r = correrGuarda(repo, 'check-dependencias.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });

  it('un subpath de un paquete declarado aprueba', () => {
    const repo = repoConPaquete(
      `import merge from 'lodash/merge';\nimport { render } from '@testing-library/react';\nexport const a = { merge, render };\n`,
      { deps: { lodash: '^4.17.21', '@testing-library/react': '^16.0.0' } },
    );
    const r = correrGuarda(repo, 'check-dependencias.mjs');
    assert.equal(r.codigo, 0, `un subpath pertenece al paquete raiz:\n${r.salida}`);
  });

  it('un alias declarado en la config aprueba', () => {
    const repo = repoTemporal();
    config(repo, { dependencias: { alias: { '@app': true } } });
    escribir(repo, 'package.json', '{"name":"demo","dependencies":{}}\n');
    escribir(repo, 'package-lock.json', '{"packages":[]}\n');
    escribir(repo, 'src/critico/cobro.ts', `import { x } from '@app/dominio';\nexport default x;\n`);
    commitear(repo);
    assert.equal(calcularAlcance(repo).codigo, 0);
    const r = correrGuarda(repo, 'check-dependencias.mjs');
    assert.equal(r.codigo, 0, `un alias de rutas declarado no es una dependencia:\n${r.salida}`);
  });

  it('un diff sin fuente aprueba', () => {
    const repo = repoTemporal();
    config(repo);
    escribir(repo, 'package.json', '{"name":"demo"}\n');
    escribir(repo, 'docs/notas.md', '# notas\n');
    commitear(repo);
    assert.equal(calcularAlcance(repo).codigo, 0);
    const r = correrGuarda(repo, 'check-dependencias.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });
});
