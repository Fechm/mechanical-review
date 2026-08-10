/**
 * Meta-aserciones de `check-mutantes.mjs`.
 *
 * Cada caso de aca es una fila de la tabla de meta-aserciones de SKILL.md, y todos
 * menos dos afirman que el guarda **falla**. Ese es el punto: la tabla documenta modos
 * de aprobar sin verificar que ya ocurrieron de verdad, y un guarda que solo se probo
 * con la entrada buena no esta probado.
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
  reporteMutacion,
  repoTemporal,
} from './ayuda.mjs';

after(limpiar);

/** Repo con un cambio en zona critica y el alcance ya calculado. */
function repoConAlcance(extraConfig = {}) {
  const repo = repoTemporal();
  config(repo, extraConfig);
  escribir(repo, 'src/critico/cobro.ts', 'export const x = 1;\nexport const y = 2;\n');
  commitear(repo);
  const alcance = calcularAlcance(repo);
  assert.equal(alcance.codigo, 0, `el alcance deberia calcularse:\n${alcance.salida}`);
  return repo;
}

describe('check-mutantes: lo que tiene que BLOQUEAR', () => {
  it('un mutante sobreviviente bloquea', () => {
    const repo = repoConAlcance();
    reporteMutacion(repo, [
      { estado: 'Killed' },
      { estado: 'Survived', linea: 2 },
      { estado: 'Killed' },
    ]);
    const r = correrGuarda(repo, 'check-mutantes.mjs');
    assert.equal(r.codigo, 1, 'un sobreviviente sin justificar tiene que salir 1');
    assert.match(r.salida, /vivo|Survived|sobrevivi/i);
  });

  it('cero mutantes generados bloquea (el --mutate no calzo nada)', () => {
    // Modo de falla real: un --mutate mal armado no calza ningun archivo, Stryker
    // sale 0 y sin este guarda la fase quedaria en verde sin haber mutado nada.
    const repo = repoConAlcance();
    reporteMutacion(repo, []);
    const r = correrGuarda(repo, 'check-mutantes.mjs');
    assert.equal(r.codigo, 1, 'cero mutantes no es "todo bien", es "no se midio"');
    assert.match(r.salida, /CERO mutantes/i);
  });

  it('mayoria en RuntimeError bloquea aunque no haya sobrevivientes', () => {
    // Medido: un reporte con todos en RuntimeError imprimia "0 vivos" y salia 0.
    const repo = repoConAlcance();
    reporteMutacion(repo, [
      { estado: 'Killed' },
      ...Array.from({ length: 8 }, () => ({ estado: 'RuntimeError' })),
    ]);
    const r = correlativo(repo);
    assert.equal(r.codigo, 1, 'RuntimeError es "no se evaluo", no "esta cerrado"');
  });

  it('mayoria en Ignored bloquea: un mutante silenciado no garantiza nada', () => {
    // `// Stryker disable` apagaba el gate entero sin dejar rastro en el resultado.
    const repo = repoConAlcance();
    reporteMutacion(repo, [
      { estado: 'Killed' },
      ...Array.from({ length: 8 }, () => ({ estado: 'Ignored' })),
    ]);
    const r = correlativo(repo);
    assert.equal(r.codigo, 1, 'Ignored pasa por el mismo criterio que un sobreviviente');
  });

  it('ningun mutante con veredicto bloquea (montaje roto)', () => {
    const repo = repoConAlcance();
    reporteMutacion(repo, Array.from({ length: 6 }, () => ({ estado: 'RuntimeError' })));
    const r = correlativo(repo);
    assert.equal(r.codigo, 1);
    assert.match(r.salida, /evaluad|veredicto/i);
  });

  it('todos en Timeout con cero matados bloquea', () => {
    // Medido: 42 timeouts, 0 matados, score 87,5% y exit 0 — con diez vivos detras.
    const repo = repoConAlcance();
    reporteMutacion(repo, Array.from({ length: 10 }, () => ({ estado: 'Timeout' })));
    const r = correlativo(repo);
    assert.equal(r.codigo, 1, 'un score alto con Killed==0 es montaje roto disfrazado');
  });

  it('un reporte anterior al alcance bloquea', () => {
    // El caso "reports/ cacheado en CI": verde sobre codigo que nunca se muto.
    const repo = repoConAlcance();
    reporteMutacion(repo, [{ estado: 'Killed' }], { antiguedadMin: 90 });
    const r = correrGuarda(repo, 'check-mutantes.mjs');
    assert.equal(r.codigo, 1, 'un reporte viejo no dice nada del diff actual');
    assert.match(r.salida, /ANTERIOR|viej/i);
  });

  it('un reporte de otros archivos bloquea (no cruza el diff)', () => {
    const repo = repoConAlcance();
    reporteMutacion(repo, [{ estado: 'Killed', archivo: 'src/otro/lejos.ts' }]);
    const r = correrGuarda(repo, 'check-mutantes.mjs');
    assert.equal(r.codigo, 1, 'medir otro modulo no es medir este');
    assert.match(r.salida, /ningun archivo del diff|no habla/i);
  });

  it('sin reporte bloquea', () => {
    const repo = repoConAlcance();
    const r = correrGuarda(repo, 'check-mutantes.mjs');
    assert.equal(r.codigo, 1, 'ausencia de evidencia no es evidencia de ausencia');
  });

  it('CompileError con la fase tipos NO bloqueante bloquea', () => {
    // La premisa de contar CompileError como cerrado es que `tsc` bloquee de verdad.
    // Si no bloquea, el guarda estaria regalando mutantes.
    const repo = repoConAlcance({ fases: [{ id: 'tipos', bloquea: false }] });
    reporteMutacion(repo, [
      { estado: 'Killed' },
      { estado: 'Killed' },
      ...Array.from({ length: 7 }, () => ({ estado: 'CompileError' })),
    ]);
    const r = correlativo(repo);
    assert.equal(r.codigo, 1, 'sin fase tipos bloqueante, CompileError es medicion faltante');
    assert.match(r.salida, /tipos/i);
  });

  it('todos en CompileError bloquea aunque tipos bloquee', () => {
    const repo = repoConAlcance();
    reporteMutacion(repo, Array.from({ length: 9 }, () => ({ estado: 'CompileError' })));
    const r = correlativo(repo);
    assert.equal(r.codigo, 1, '9 de 9 sin compilar es un typescript-checker mal configurado');
  });
});

describe('check-mutantes: lo que tiene que APROBAR', () => {
  it('matados sin sobrevivientes aprueba', () => {
    const repo = repoConAlcance();
    reporteMutacion(repo, Array.from({ length: 5 }, () => ({ estado: 'Killed' })));
    const r = correrGuarda(repo, 'check-mutantes.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });

  it('mayoria de CompileError con tipos bloqueante aprueba', () => {
    // El defecto de la 1.0.0: un archivo de cableado tipado da mayoria de CompileError
    // POR NATURALEZA, y la regla de la mitad ponia en rojo un diff con CERO vivos.
    const repo = repoConAlcance();
    reporteMutacion(repo, [
      { estado: 'Killed' },
      { estado: 'Killed' },
      ...Array.from({ length: 7 }, () => ({ estado: 'CompileError' })),
    ]);
    const r = correrGuarda(repo, 'check-mutantes.mjs');
    assert.equal(r.codigo, 0, `2 matados + 7 sin compilar con tipos bloqueante aprueba:\n${r.salida}`);
  });

  it('Timeout junto a matados aprueba: el timeout cuenta como detectado', () => {
    const repo = repoConAlcance();
    reporteMutacion(repo, [
      { estado: 'Killed' },
      { estado: 'Killed' },
      { estado: 'Killed' },
      { estado: 'Timeout' },
    ]);
    const r = correrGuarda(repo, 'check-mutantes.mjs');
    assert.equal(r.codigo, 0, `deberia aprobar:\n${r.salida}`);
  });
});

/** Corre el guarda y devuelve el resultado. Alias legible para los casos que bloquean. */
function correlativo(repo) {
  return correrGuarda(repo, 'check-mutantes.mjs');
}
