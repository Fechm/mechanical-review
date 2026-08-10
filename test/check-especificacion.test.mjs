/**
 * Meta-aserciones de `check-especificacion.mjs` — la valla que no admite excepcion.
 *
 * Es la unica que tapa dos agujeros que ninguna otra ve: la especificacion equivocada
 * (el agente implementa lo que no correspondia, lo cubre al 100%, mata todos los
 * mutantes, y el pipeline queda verde sobre la intencion errada) y la circularidad
 * autor/verificador. Por eso el mecanismo central que se prueba aca es que la
 * especificacion sea de SOLO LECTURA mientras se implementa.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, correrGuarda, escribir, limpiar, repoTemporal } from './ayuda.mjs';

after(limpiar);

const ESPEC_COMPLETA =
  `# Cobro\n\n` +
  `## Regla de negocio\n\nSolo se cobra una vez por periodo.\n\n` +
  `## Desenlaces\n\n` +
  `| desenlace | precondicion | disparador | estado persistido | efecto externo | reintentable |\n` +
  `| --- | --- | --- | --- | --- | --- |\n` +
  `| exito | tarjeta vigente | corrida mensual | COBRADO | cargo emitido | no |\n\n` +
  `## Invariantes\n\n- Nunca dos cobros exitosos para el mismo periodo. sosten: test \`test/cobro.spec.ts\`\n\n` +
  `## Escenarios\n\nDado una tarjeta vigente, cuando corre el cobro, entonces queda COBRADO.\n`;

function repoConEspec(contenido = ESPEC_COMPLETA) {
  const repo = repoTemporal();
  config(repo);
  escribir(repo, 'especificacion/cobro.md', contenido);
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

function aprobar(repo) {
  return correrGuarda(repo, 'check-especificacion.mjs', ['--aprobar', '--por', 'suite']);
}

describe('check-especificacion: lo que tiene que BLOQUEAR', () => {
  it('una especificacion que cambio despues de aprobada bloquea', () => {
    // ESTE es el mecanismo central: si la intencion se puede mover durante la
    // implementacion, se mueve para calzar con el codigo — y eso es la circularidad
    // autor/verificador con el pipeline en verde.
    const repo = repoConEspec();
    assert.equal(aprobar(repo).codigo, 0, 'la aprobacion inicial deberia funcionar');
    const ruta = join(repo, 'especificacion', 'cobro.md');
    writeFileSync(ruta, `${readFileSync(ruta, 'utf8')}\nUn parrafo agregado despues.\n`, 'utf8');
    const r = correrGuarda(repo, 'check-especificacion.mjs');
    assert.equal(r.codigo, 1, 'cambiar la especificacion sin re-aprobar tiene que bloquear');
    assert.match(r.salida, /cambio despues|SOLO LECTURA/i);
  });

  it('una zona critica sin especificacion que la cubra bloquea', () => {
    const repo = repoTemporal();
    config(repo);
    escribir(repo, 'especificacion/registro.json', `${JSON.stringify({ especificaciones: [] })}\n`);
    const r = correrGuarda(repo, 'check-especificacion.mjs');
    assert.equal(r.codigo, 1, 'sin intencion aprobada, todo lo demas verifica una intencion que nadie leyo');
  });

  it('una especificacion sin la seccion de desenlaces bloquea', () => {
    // La tabla de desenlaces es la pieza de la que se derivan los tests. Sin ella la
    // especificacion es prosa, y de la prosa el agente deriva lo que quiera.
    const repo = repoConEspec(
      `# Cobro\n\n## Regla de negocio\n\nSolo se cobra una vez.\n\n` +
        `## Invariantes\n\n- Nunca dos cobros. sosten: test \`test/cobro.spec.ts\`\n\n` +
        `## Escenarios\n\nDado X, cuando Y, entonces Z.\n`,
    );
    const r = aprobar(repo);
    assert.equal(r.codigo, 1, 'faltando una seccion obligatoria no se puede ni aprobar');
  });

  it('una tabla de desenlaces sin filas de datos bloquea', () => {
    const repo = repoConEspec(
      `# Cobro\n\n## Regla de negocio\n\nSolo se cobra una vez.\n\n` +
        `## Desenlaces\n\n` +
        `| desenlace | precondicion | disparador | estado persistido | efecto externo | reintentable |\n` +
        `| --- | --- | --- | --- | --- | --- |\n\n` +
        `## Invariantes\n\n- Nunca dos cobros. sosten: test \`test/cobro.spec.ts\`\n\n` +
        `## Escenarios\n\nDado X, cuando Y, entonces Z.\n`,
    );
    const r = aprobar(repo);
    assert.equal(r.codigo, 1, 'una tabla con encabezado y sin filas no enumera ningun caso');
  });

  it('una invariante sin sosten bloquea', () => {
    // Vive aca y no en check-invariantes: el guarda de especificacion la rechaza antes,
    // asi que una invariante sin soporte nunca llega a estar aprobada.
    const repo = repoConEspec(
      `# Cobro\n\n## Regla de negocio\n\nSolo se cobra una vez.\n\n` +
        `## Desenlaces\n\n` +
        `| desenlace | precondicion | disparador | estado persistido | efecto externo | reintentable |\n` +
        `| --- | --- | --- | --- | --- | --- |\n` +
        `| exito | tarjeta vigente | corrida | COBRADO | cargo | no |\n\n` +
        `## Invariantes\n\n- Nunca dos cobros exitosos para el mismo periodo.\n\n` +
        `## Escenarios\n\nDado X, cuando Y, entonces Z.\n`,
    );
    const r = aprobar(repo);
    assert.equal(r.codigo, 1, 'declarar la invariante no la sostiene');
    assert.match(r.salida, /sosten/i);
  });

  it('el registro que apunta a un archivo inexistente bloquea', () => {
    const repo = repoTemporal();
    config(repo);
    escribir(
      repo,
      'especificacion/registro.json',
      `${JSON.stringify({
        especificaciones: [
          { archivo: 'especificacion/fantasma.md', cubre: ['src/critico/**'], sha256: 'x', aprobadaPor: 'alguien' },
        ],
      })}\n`,
    );
    const r = correrGuarda(repo, 'check-especificacion.mjs');
    assert.equal(r.codigo, 1, 'una especificacion registrada que desaparecio deja su zona sin intencion');
  });
});

describe('check-especificacion: lo que tiene que APROBAR', () => {
  it('una especificacion completa se aprueba y despues verifica en verde', () => {
    const repo = repoConEspec();
    assert.equal(aprobar(repo).codigo, 0, 'la aprobacion deberia funcionar');
    const r = correrGuarda(repo, 'check-especificacion.mjs');
    assert.equal(r.codigo, 0, `sin cambios posteriores deberia verificar en verde:\n${r.salida}`);
  });

  it('re-aprobar despues de un cambio deliberado vuelve a verde', () => {
    // La salida correcta cuando la intencion SI cambio: leerla, decidir a mano, y
    // re-aprobar dejando constancia en el diff del registro.
    const repo = repoConEspec();
    assert.equal(aprobar(repo).codigo, 0);
    const ruta = join(repo, 'especificacion', 'cobro.md');
    writeFileSync(ruta, `${readFileSync(ruta, 'utf8')}\nLa intencion cambio a proposito.\n`, 'utf8');
    assert.equal(correrGuarda(repo, 'check-especificacion.mjs').codigo, 1, 'primero tiene que bloquear');
    assert.equal(aprobar(repo).codigo, 0, 're-aprobar es el acto humano que lo desbloquea');
    assert.equal(correrGuarda(repo, 'check-especificacion.mjs').codigo, 0, 'y despues queda verde');
  });
});
