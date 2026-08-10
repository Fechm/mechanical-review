/**
 * Meta-aserciones de `check-excepciones.mjs`.
 *
 * Esta valla es la que impide que el archivo de excepciones se convierta en un `|| true`
 * con mejor letra. Si el vencimiento no se exige, o si vencer no rompe nada, la
 * herramienta entera queda apagada por acumulacion silenciosa.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config, correrGuarda, escribir, limpiar, repoTemporal } from './ayuda.mjs';

after(limpiar);

/** Fecha ISO desplazada en dias respecto de hoy. */
function enDias(dias) {
  const d = new Date(Date.now() + dias * 86400000);
  return d.toISOString().slice(0, 10);
}

function excepcion({ id = 'EXC-001', valla = 'mutacion', ruta = 'src/critico/cobro.ts:10-20', motivo = 'mutante equivalente: el operador cambia un log de telemetria que no participa del predicado', vence = enDias(10), responsable = 'nombre.apellido' } = {}) {
  return (
    `## ${id}\n` +
    `- valla: ${valla}\n` +
    `- ruta: ${ruta}\n` +
    `- motivo: ${motivo}\n` +
    `- vence: ${vence}\n` +
    `- responsable: ${responsable}\n`
  );
}

function repoCon(texto) {
  const repo = repoTemporal();
  config(repo);
  escribir(repo, '.mechanical-review/excepciones.md', `# Excepciones\n\n${texto}`);
  return repo;
}

describe('check-excepciones: lo que tiene que BLOQUEAR', () => {
  it('una excepcion vencida bloquea', () => {
    // Es el mecanismo entero: al vencer, el gate vuelve a ser obligatorio SOLO, sin
    // que nadie tenga que acordarse.
    const repo = repoCon(excepcion({ vence: enDias(-1) }));
    const r = correrGuarda(repo, 'check-excepciones.mjs');
    assert.equal(r.codigo, 1, 'vencer tiene que romper, o el vencimiento es decorativo');
    assert.match(r.salida, /venc/i);
  });

  it('un vencimiento a mas de 30 dias bloquea', () => {
    const repo = repoCon(excepcion({ vence: enDias(120) }));
    const r = correrGuarda(repo, 'check-excepciones.mjs');
    assert.equal(r.codigo, 1, 'sin techo de plazo, "vence" se puede poner en 2099');
  });

  it('sin campo vence bloquea', () => {
    const repo = repoCon(
      '## EXC-001\n- valla: mutacion\n- ruta: src/critico/cobro.ts\n- motivo: porque si por ahora, ya lo veremos\n- responsable: nombre.apellido\n',
    );
    const r = correrGuarda(repo, 'check-excepciones.mjs');
    assert.equal(r.codigo, 1, 'una excepcion sin vencimiento es permanente');
  });

  it('un motivo demasiado corto bloquea', () => {
    const repo = repoCon(excepcion({ motivo: 'no aplica' }));
    const r = correrGuarda(repo, 'check-excepciones.mjs');
    assert.equal(r.codigo, 1, '"no aplica" no es un motivo, es un encogimiento de hombros');
  });

  it('mas de 10 excepciones vivas bloquea', () => {
    // Cuando hacen falta mas de 10, el umbral esta mal calibrado o el modulo necesita
    // trabajo estructural. Las dos cosas se discuten; acumular no es ninguna.
    const muchas = Array.from({ length: 12 }, (_, i) =>
      excepcion({ id: `EXC-${String(i + 1).padStart(3, '0')}` }),
    ).join('\n');
    const repo = repoCon(muchas);
    const r = correrGuarda(repo, 'check-excepciones.mjs');
    assert.equal(r.codigo, 1, 'la acumulacion tiene que doler');
  });
});

describe('check-excepciones: lo que tiene que APROBAR', () => {
  it('una excepcion bien formada y vigente aprueba', () => {
    const repo = repoCon(excepcion());
    const r = correrGuarda(repo, 'check-excepciones.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });

  it('un archivo sin excepciones aprueba', () => {
    const repo = repoCon('');
    const r = correrGuarda(repo, 'check-excepciones.mjs');
    assert.equal(r.codigo, 0, 'no tener excepciones es el estado deseable, no un error');
  });
});
