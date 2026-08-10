#!/usr/bin/env node
/**
 * FASE 6 — COBERTURA DE LAS LINEAS DEL DIFF.
 *
 * POR QUE ACA NO ES UN GATE TERMINAL
 * ----------------------------------
 * El resumen que circulo pide "cobertura de lineas modificadas al 100%". Ese
 * numero NO tiene fuente primaria: no aparece en los hilos de Martin, ni en sus
 * repos, ni en su Acceptance-Pipeline-Specification (que omite deliberadamente
 * cualquier umbral cuantitativo). Y garantiza una sola cosa: que cada linea nueva
 * fue EJECUTADA. No dice absolutamente nada sobre si algo fue OBSERVADO — el test
 * de la pasarela tenia cobertura de linea completa y cero verificacion sobre la
 * llamada que su propio nombre prometia.
 *
 * Asi que aca la cobertura del diff cumple el rol que le da Google: decidir DONDE
 * MUTAR. Las lineas CUBIERTAS del diff son el insumo de la fase de mutacion (mutar
 * una linea que ningun test ejecuta es gastar computo para descubrir algo que la
 * cobertura ya dijo). Las lineas NO cubiertas del diff son un hallazgo por si
 * mismas y bloquean solo en zona critica.
 *
 * TRES MODOS DE FALLA QUE ESTE SCRIPT CIERRA
 * ------------------------------------------
 *  1. lcov ausente o vacio: falla. Un gate no puede aprobar por falta de datos.
 *  2. El diff toca fuente y NINGUN archivo del diff aparece en el lcov: falla.
 *     Es el sintoma de que la cobertura se recolecto con otro cwd, con otro glob de
 *     collectCoverageFrom, o de rutas excluidas — y produce 100% de nada.
 *  3. Denominador cero: no se reporta como 100%; se reporta como "0 lineas
 *     ejecutables" y se dice explicitamente, porque es distinto.
 *
 * USO
 *   node check-cobertura-diff.mjs [--lcov coverage/lcov.info] [--minimo 100]
 *                                [--formato stryker]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  aprobar,
  avisar,
  cargarConfig,
  escribirSalida,
  fallar,
  leerSalida,
  parsearArgs,
  raizRepo,
} from './lib/comun.mjs';

const args = parsearArgs(process.argv.slice(2));
const raiz = raizRepo() ?? process.cwd();
const { cfg, error: errCfg } = cargarConfig(raiz);
if (errCfg) fallar('Configuracion invalida', [errCfg]);

const alcance = leerSalida(raiz, 'alcance.json');
if (!alcance) {
  fallar('No hay alcance calculado', [
    'Falta .mechanical-review/out/alcance.json. Correr primero check-alcance-diff.mjs.',
  ]);
}

const rutaLcov = join(raiz, args.lcov ?? cfg.cobertura?.lcov ?? 'coverage/lcov.info');
const fuentes = alcance.archivos.filter((a) => a.tipo === 'fuente');

if (fuentes.length === 0) {
  aprobar('El diff no toca archivos de fuente: la cobertura del diff no aplica.');
  escribirSalida(raiz, 'cobertura-diff.json', {
    version: 1,
    aplicable: false,
    motivo: 'sin archivos de fuente en el diff',
    mutar: [],
  });
  process.exit(0);
}

if (!existsSync(rutaLcov)) {
  fallar('No hay reporte de cobertura', [
    `Se esperaba ${rutaLcov}.\n` +
      `  El diff toca ${fuentes.length} archivo(s) de fuente y no hay datos de cobertura,\n` +
      `  asi que este gate no puede afirmar nada. Un gate que aprueba por falta de datos\n` +
      `  es peor que no tenerlo.\n` +
      `  Arreglo segun el runner del repo:\n` +
      `    jest:      <gestor> jest --coverage --coverageReporters=lcov\n` +
      `    node:test: node --test --experimental-test-coverage \\\n` +
      `                 --test-reporter=lcov --test-reporter-destination=coverage/lcov.info`,
  ]);
}

// --- Parseo de lcov -------------------------------------------------------------

/** Map<rutaNormalizada, Map<linea, hits>> */
function leerLcov(ruta) {
  const porArchivo = new Map();
  let actual = null;
  for (const linea of readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    if (linea.startsWith('SF:')) {
      const cruda = linea.slice(3).trim().replace(/\\/g, '/');
      const abs = resolve(raiz, cruda).replace(/\\/g, '/');
      const base = resolve(raiz).replace(/\\/g, '/');
      actual = abs.startsWith(`${base}/`) ? abs.slice(base.length + 1) : cruda;
      if (!porArchivo.has(actual)) porArchivo.set(actual, new Map());
    } else if (linea.startsWith('DA:') && actual) {
      const [n, h] = linea.slice(3).split(',');
      porArchivo.get(actual).set(Number(n), Number(h));
    } else if (linea === 'end_of_record') actual = null;
  }
  return porArchivo;
}

const lcov = leerLcov(rutaLcov);
if (lcov.size === 0) {
  fallar('El reporte de cobertura esta vacio', [
    `${rutaLcov} no contiene ningun registro SF:.\n` +
      `  Causa habitual: la suite corrio sin --coverage, o corrio 0 tests. Revisar si\n` +
      `  el script de test trae --passWithNoTests: ese flag hace que 0 tests salga en\n` +
      `  verde, y con 0 tests la cobertura es un archivo vacio.`,
  ]);
}

/** Resuelve la ruta del diff dentro del lcov, tolerando prefijos distintos. */
function buscarEnLcov(rutaRel) {
  if (lcov.has(rutaRel)) return lcov.get(rutaRel);
  const candidatos = [...lcov.keys()].filter((k) => k.endsWith(`/${rutaRel}`) || rutaRel.endsWith(`/${k}`));
  return candidatos.length === 1 ? lcov.get(candidatos[0]) : null;
}

// --- Cruce diff x cobertura -----------------------------------------------------

const detalle = [];
let totalEjecutables = 0;
let totalCubiertas = 0;
let archivosEnLcov = 0;

for (const f of fuentes) {
  const mapa = buscarEnLcov(f.ruta);
  if (!mapa) {
    detalle.push({ ruta: f.ruta, nivel: f.nivel, enLcov: false, ejecutables: 0, cubiertas: 0, noCubiertas: [] });
    continue;
  }
  archivosEnLcov++;
  const noCubiertas = [];
  const cubiertas = [];
  for (const [ini, fin] of f.rangos) {
    for (let l = ini; l <= fin; l++) {
      if (!mapa.has(l)) continue; // linea no ejecutable (declaracion, tipo, comentario)
      totalEjecutables++;
      if (mapa.get(l) > 0) {
        totalCubiertas++;
        cubiertas.push(l);
      } else noCubiertas.push(l);
    }
  }
  detalle.push({
    ruta: f.ruta,
    nivel: f.nivel,
    enLcov: true,
    ejecutables: cubiertas.length + noCubiertas.length,
    cubiertas: cubiertas.length,
    lineasCubiertas: cubiertas,
    noCubiertas,
  });
}

// --- Meta-aserciones ------------------------------------------------------------

if (archivosEnLcov === 0) {
  fallar('Ningun archivo del diff aparece en el reporte de cobertura', [
    `${fuentes.length} archivo(s) de fuente cambiaron y ninguno figura en ${rutaLcov}.\n` +
      `  Esto NO es 100% de cobertura: es cobertura de otra cosa. Causas verificadas en\n` +
      `  estos repos:\n` +
      `    · collectCoverageFrom no incluye esas rutas;\n` +
      `    · sonar.coverage.exclusions / coveragePathIgnorePatterns las excluye;\n` +
      `    · la suite corrio desde otro cwd y las rutas del lcov no calzan.\n` +
      `  Archivos del diff: ${fuentes.slice(0, 5).map((f) => f.ruta).join(', ')}${fuentes.length > 5 ? ' …' : ''}\n` +
      `  Rutas de ejemplo en el lcov: ${[...lcov.keys()].slice(0, 3).join(', ')}`,
  ]);
}

const fueraDeLcov = detalle.filter((d) => !d.enLcov);
if (fueraDeLcov.length > 0) {
  avisar(
    `${fueraDeLcov.length} archivo(s) del diff no figuran en el lcov y quedan SIN MEDIR:\n` +
      fueraDeLcov.map((d) => `      · ${d.ruta}${d.nivel === 2 ? '  ← ZONA CRITICA' : ''}`).join('\n') +
      '\n      Un archivo excluido de la cobertura no es un archivo cubierto. Si la\n' +
      '      exclusion es deliberada, tiene que estar en .mechanical-review/excepciones.md.',
  );
}

// --- Alcance de mutacion (solo lineas CUBIERTAS del diff) -----------------------

function aRangos(lineas) {
  const r = [];
  const orden = [...lineas].sort((a, b) => a - b);
  for (const l of orden) {
    const ult = r[r.length - 1];
    if (ult && l === ult[1] + 1) ult[1] = l;
    else r.push([l, l]);
  }
  return r;
}

const mutar = [];
for (const d of detalle) {
  if (!d.enLcov || !d.lineasCubiertas?.length) continue;
  for (const [i, f] of aRangos(d.lineasCubiertas)) mutar.push(`${d.ruta}:${i}-${f}`);
}

const pct = totalEjecutables === 0 ? null : Math.round((totalCubiertas / totalEjecutables) * 1000) / 10;

const resultado = {
  version: 1,
  aplicable: true,
  nivel: alcance.nivel,
  lcov: args.lcov ?? cfg.cobertura?.lcov ?? 'coverage/lcov.info',
  ejecutables: totalEjecutables,
  cubiertas: totalCubiertas,
  porcentaje: pct,
  sinMedir: fueraDeLcov.map((d) => d.ruta),
  detalle,
  mutar,
};
escribirSalida(raiz, 'cobertura-diff.json', resultado);

if (args.formato === 'stryker') {
  if (mutar.length === 0) process.exit(3); // nada que mutar
  console.log(mutar.join(','));
  process.exit(0);
}

// --- Reporte y umbral -----------------------------------------------------------

const umbrales = cfg.umbrales.coberturaDiff ?? { 0: 0, 1: 0, 2: 100 };
const minimo = args.minimo !== undefined ? Number(args.minimo) : Number(umbrales[alcance.nivel] ?? 0);

console.log(`\nCobertura de las lineas del diff  (nivel ${alcance.nivel}, minimo exigido ${minimo}%)`);
console.log('─'.repeat(72));
for (const d of detalle) {
  if (!d.enLcov) {
    console.log(`  sin medir            ${d.ruta}`);
    continue;
  }
  const p = d.ejecutables === 0 ? '  n/a  ' : `${String(Math.round((d.cubiertas / d.ejecutables) * 100)).padStart(4)}% `;
  console.log(
    `  ${p} ${String(d.cubiertas).padStart(4)}/${String(d.ejecutables).padEnd(4)} ${d.ruta}` +
      (d.noCubiertas.length ? `\n         sin cubrir: ${d.noCubiertas.slice(0, 20).join(', ')}${d.noCubiertas.length > 20 ? ' …' : ''}` : ''),
  );
}
console.log('─'.repeat(72));

if (totalEjecutables === 0) {
  aprobar(
    'CERO lineas ejecutables en el diff (todo lo agregado son tipos, declaraciones,\n' +
      '  comentarios o firmas). No es 100% de cobertura: es un denominador vacio, y se\n' +
      '  dice asi a proposito para que nadie lo lea como una verificacion.',
  );
  process.exit(0);
}

console.log(`  ${totalCubiertas}/${totalEjecutables} lineas ejecutables agregadas cubiertas = ${pct}%`);
console.log(`  Alcance de mutacion derivado: ${mutar.length} rango(s) de lineas CUBIERTAS.`);

if (pct < minimo) {
  fallar('Cobertura del diff por debajo del minimo', [
    `${pct}% < ${minimo}% exigido para nivel ${alcance.nivel}.\n` +
      `  Que hacer, en este orden:\n` +
      `   1. Si la linea sin cubrir es un desenlace real del comportamiento, escribir el\n` +
      `      test que afirma el ESTADO PERSISTIDO de ese desenlace (no solo que no lanzo).\n` +
      `   2. Si es codigo inalcanzable, borrarlo: un try/catch alrededor de una funcion\n` +
      `      que nunca lanza es codigo muerto, y ya aparecio una vez en este historial.\n` +
      `   3. Si de verdad no se puede cubrir (rama de defensa, wiring), registrar la\n` +
      `      excepcion en .mechanical-review/excepciones.md con vencimiento. NO bajar el umbral.\n` +
      `  Advertencia de diseno: no perseguir el numero con tests que ejecutan sin\n` +
      `  afirmar. Eso es lo que produjo el test de la pasarela.`,
  ]);
}

aprobar(`Cobertura del diff: ${pct}% (minimo ${minimo}% para nivel ${alcance.nivel}).`);
