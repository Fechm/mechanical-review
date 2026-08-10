/**
 * Meta-aserciones de `check-invariantes.mjs`.
 *
 * Esta valla existe porque hay garantias que NINGUN test puede dar: el doble cobro no
 * lo cierra un test, ni un linter, ni un mutante (los mutantes se evaluan con la misma
 * suite secuencial). Lo cierra un indice unico. El guarda verifica que cada invariante
 * declarada tenga un soporte mecanico que exista de verdad — no que suene bien.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config, correrGuarda, escribir, limpiar, repoTemporal } from './ayuda.mjs';

after(limpiar);

/**
 * Especificacion minima con el bloque de invariantes que se quiera probar, YA APROBADA.
 *
 * OJO — la aprobacion no es decorativa en el fixture: sin ella el guarda aborta con "No
 * hay registro de especificaciones" y sale 1. Los casos de bloqueo aprobaban por esa
 * razon y no por la que dicen. Lo delataron, otra vez, los casos que esperan verde.
 */
function repoConInvariantes(bloque) {
  const repo = repoTemporal();
  config(repo);
  escribir(
    repo,
    'especificacion/cobro.md',
    `# Cobro\n\n` +
      `## Regla de negocio\n\nSolo se cobra una vez por periodo.\n\n` +
      `## Desenlaces\n\n` +
      `| desenlace | precondicion | disparador | estado persistido | efecto externo | reintentable |\n` +
      `| --- | --- | --- | --- | --- | --- |\n` +
      `| exito | tarjeta vigente | corrida mensual | COBRADO | cargo emitido | no |\n\n` +
      `## Invariantes\n\n${bloque}\n\n` +
      `## Escenarios\n\nDado una tarjeta vigente, cuando corre el cobro, entonces queda COBRADO.\n`,
  );
  // El `cubre` vive en el REGISTRO, no en el .md: es lo que enlaza una zona critica con
  // la especificacion que declara su intencion. Sin esa entrada, toda zona critica queda
  // sin intencion aprobada y la revision falla antes de mirar las invariantes.
  escribir(
    repo,
    'especificacion/registro.json',
    `${JSON.stringify(
      { especificaciones: [{ archivo: 'especificacion/cobro.md', cubre: ['src/critico/**'] }] },
      null,
      2,
    )}\n`,
  );
  return repo;
}

/**
 * Aprueba la especificacion como lo hace un humano. En CI nunca se pasa `--aprobar`;
 * aca se pasa porque el fixture esta simulando el acto humano previo.
 */
function aprobarEspec(repo) {
  const r = correrGuarda(repo, 'check-especificacion.mjs', ['--aprobar', '--por', 'suite']);
  assert.equal(r.codigo, 0, `la especificacion deberia aprobarse:\n${r.salida}`);
}

describe('check-invariantes: lo que tiene que BLOQUEAR', () => {
  // NOTA de capas, encontrada escribiendo esta suite: una invariante SIN `sosten:` no
  // llega hasta aca. La rechaza antes `check-especificacion`, que no deja siquiera
  // aprobar una especificacion cuyas invariantes no declaren su soporte. El caso vive
  // en check-especificacion.test.mjs, que es donde de verdad se bloquea.

  it('un sosten de tipo test con archivo inexistente bloquea', () => {
    const repo = repoConInvariantes(
      '- Nunca dos cobros exitosos para el mismo periodo. sosten: test `test/no-existe.spec.ts`',
    );
    aprobarEspec(repo);
    const r = correrGuarda(repo, 'check-invariantes.mjs');
    assert.equal(r.codigo, 1, 'apuntar a un archivo que no existe es peor que no apuntar');
  });

  it('un sosten de tipo indice que no aparece en el SQL bloquea', () => {
    const repo = repoConInvariantes(
      '- Nunca dos cobros exitosos para el mismo periodo. sosten: indice unico `uq_cobro_periodo`',
    );
    aprobarEspec(repo);
    const r = correrGuarda(repo, 'check-invariantes.mjs');
    assert.equal(r.codigo, 1, 'el indice tiene que estar en el SQL versionado, no solo nombrado');
  });

  it('un sosten de tipo produccion sin declarar en el archivo bloquea', () => {
    const repo = repoConInvariantes(
      '- Nunca dos cobros exitosos para el mismo periodo. sosten: produccion `barrido-diario`',
    );
    aprobarEspec(repo);
    const r = correrGuarda(repo, 'check-invariantes.mjs');
    assert.equal(
      r.codigo,
      1,
      'la salida de "se verifica en produccion" existe, pero hay que escribir donde y que hace al fallar',
    );
  });
});

describe('check-invariantes: lo que tiene que APROBAR', () => {
  it('un sosten de tipo test con el archivo presente aprueba', () => {
    const repo = repoConInvariantes(
      '- Nunca dos cobros exitosos para el mismo periodo. sosten: test `test/cobro.spec.ts`',
    );
    escribir(repo, 'test/cobro.spec.ts', "it('no cobra dos veces', () => { expect(1).toBe(1); });\n");
    aprobarEspec(repo);
    const r = correrGuarda(repo, 'check-invariantes.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });

  it('un sosten de tipo indice presente en el SQL aprueba', () => {
    const repo = repoConInvariantes(
      '- Nunca dos cobros exitosos para el mismo periodo. sosten: indice unico `uq_cobro_periodo`',
    );
    escribir(
      repo,
      'migrations/001-cobro.sql',
      'CREATE UNIQUE INDEX uq_cobro_periodo ON cobros (profesional_id, periodo) WHERE estado = 1;\n',
    );
    aprobarEspec(repo);
    const r = correrGuarda(repo, 'check-invariantes.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });

  it('un sosten de tipo produccion declarado aprueba', () => {
    // Es la clase que hace VISIBLE cuantas invariantes viven fuera del pipeline.
    const repo = repoConInvariantes(
      '- Nunca dos cobros exitosos para el mismo periodo. sosten: produccion `barrido-diario`',
    );
    escribir(
      repo,
      '.mechanical-review/invariantes-produccion.md',
      '# Invariantes verificadas en produccion\n\n' +
        '## barrido-diario\n' +
        '- corre: cron diario 03:00 UTC\n' +
        '- comprueba: cero pares (profesional, periodo) con mas de un cobro exitoso\n' +
        '- al fallar: alerta a la guardia y bloquea la corrida siguiente\n',
    );
    aprobarEspec(repo);
    const r = correrGuarda(repo, 'check-invariantes.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });
});
