#!/usr/bin/env node
/**
 * FASE 0 de la revision — calcula el ALCANCE del cambio.
 *
 * POR QUE ESTA FASE EXISTE Y VA PRIMERA
 * -------------------------------------
 * Todo el resto de la revision se acota a este resultado. La decision practica
 * mas importante del diseno es que las vallas caras (mutacion, cobertura) miren
 * SOLO las lineas del diff: Google declara que computar el mutation score
 * absoluto de su repo es infactiblemente caro y que recomputarlo por commit es
 * casi imposible, y su solucion documentada es exactamente esta — mutar solo las
 * lineas del diff bajo revision, y solo las cubiertas.
 *
 * Una revision que tarda 40 minutos no se corre, y uno que no se corre es
 * decoracion.
 *
 * TRES MODOS DE FALLA QUE ESTE SCRIPT CIERRA
 * ------------------------------------------
 *  1. Base no resoluble (checkout superficial): aborta con el arreglo escrito en
 *     vez de reportar "0 archivos" y dejar pasar todo.
 *  2. Diff vacio: aborta salvo --sin-cambios-ok. "Nada que verificar" no es verde.
 *  3. Config ausente o sin zonas.critica: aborta. Una revision que no sabe que
 *     es critico aplica el nivel mas debil a todo, en silencio.
 *
 * USO
 *   node check-alcance-diff.mjs [--base origin/main] [--formato json|stryker|lista]
 *                              [--sin-cambios-ok] [--indexado]
 */

import {
  aprobar,
  avisar,
  calza,
  cargarConfig,
  escribirSalida,
  fallar,
  nivelDeRuta,
  NIVELES,
  parsearArgs,
  raizRepo,
  rangosAgregados,
  resolverBase,
  tipoDeRuta,
} from './lib/comun.mjs';

const args = parsearArgs(process.argv.slice(2));
const raiz = raizRepo();
if (!raiz) fallar('No estoy dentro de un repositorio git.', ['La revision mecanica se acota al diff; sin git no hay diff.']);

const { cfg, error: errCfg } = cargarConfig(raiz);
if (errCfg) fallar('Configuracion invalida', [errCfg]);

const base = args.base ?? process.env.MECHANICAL_REVIEW_BASE ?? cfg.base;
const res = resolverBase(base, raiz);
if (res.error) fallar('No se pudo resolver la base de comparacion', [res.error]);

const { porArchivo, error: errDiff } = rangosAgregados(res.mergeBase, raiz, {
  indexado: args.indexado === true,
});
if (errDiff) fallar('git diff fallo', [errDiff]);

const archivos = [];
for (const [ruta, rangos] of porArchivo) {
  if (calza(ruta, cfg.patrones.ignorar)) continue;
  const tipo = tipoDeRuta(ruta, cfg);
  const nivel = tipo === 'fuente' ? nivelDeRuta(ruta, cfg) : 0;
  const lineas = rangos.reduce((a, [i, f]) => a + (f - i + 1), 0);
  archivos.push({ ruta, tipo, nivel, rangos, lineas });
}

// --- Meta-aserciones -----------------------------------------------------------

if (archivos.length === 0 && args['sin-cambios-ok'] !== true) {
  fallar('El diff no contiene ningun archivo relevante', [
    `Base: ${base} (merge-base ${res.mergeBase.slice(0, 10)})\n` +
      `  No hay nada que verificar, asi que esta herramienta no puede afirmar nada.\n` +
      `  Si eso es correcto (por ejemplo, un pipeline que corre sobre la rama base\n` +
      `  sin cambios propios), pasar --sin-cambios-ok EXPLICITAMENTE.\n` +
      `  Se exige el flag para que la decision quede en el comando y no sea el\n` +
      `  resultado accidental de un patron que dejo de calzar.`,
  ]);
}

const fuente = archivos.filter((a) => a.tipo === 'fuente');
const tests = archivos.filter((a) => a.tipo === 'test');
const nivel = archivos.reduce((max, a) => Math.max(max, a.nivel), 0);
const zonasTocadas = fuente.filter((a) => a.nivel === 2).map((a) => a.ruta);

// El propio config es zona critica: bajar una ruta de nivel 2 a nivel 1 es la via
// mas barata para saltarse la mitad de la revision, asi que tiene que ser visible.
const configTocado = [...porArchivo.keys()].some(
  (r) => r === '.mechanical-review/config.json' || r.endsWith('/.mechanical-review/config.json'),
);

const alcance = {
  version: 1,
  generado: new Date().toISOString(),
  base,
  mergeBase: res.mergeBase,
  nivel,
  nivelNombre: NIVELES[nivel],
  configTocado,
  zonasTocadas,
  resumen: {
    archivos: archivos.length,
    fuente: fuente.length,
    tests: tests.length,
    lineasFuente: fuente.reduce((a, f) => a + f.lineas, 0),
    lineasCriticas: fuente.filter((a) => a.nivel === 2).reduce((a, f) => a + f.lineas, 0),
  },
  archivos,
};

const rutaSalida = escribirSalida(raiz, 'alcance.json', alcance);

// --- Formatos de salida ---------------------------------------------------------

if (args.formato === 'stryker') {
  // Sintaxis oficial de StrykerJS: archivo:lineaInicio-lineaFin
  // NO existe la opcion `--since` en StrykerJS (es de Stryker.NET). Los blogs que
  // dicen `--since main` estan mezclando productos; copiar ese comando produce
  // una corrida que muta el subconjunto equivocado, en verde.
  const partes = [];
  for (const a of fuente) for (const [i, f] of a.rangos) partes.push(`${a.ruta}:${i}-${f}`);
  if (partes.length === 0) {
    console.error(
      'Sin lineas de fuente en el diff: no hay nada que mutar. ' +
        'Omitir la fase de mutacion explicitamente, no invocar Stryker sin --mutate.',
    );
    process.exit(3); // codigo distinto: "nada que mutar" != "fallo"
  }
  console.log(partes.join(','));
  process.exit(0);
}

if (args.formato === 'lista') {
  archivos.forEach((a) => console.log(a.ruta));
  process.exit(0);
}

// --- Reporte legible ------------------------------------------------------------

console.log(`\nAlcance del cambio  (base ${base} · merge-base ${res.mergeBase.slice(0, 10)})`);
console.log('─'.repeat(72));
for (const a of archivos.slice(0, 40)) {
  const etiqueta = a.tipo === 'fuente' ? `N${a.nivel}` : a.tipo.slice(0, 4);
  console.log(`  ${etiqueta.padEnd(5)} ${String(a.lineas).padStart(5)} lin  ${a.ruta}`);
}
if (archivos.length > 40) console.log(`  … y ${archivos.length - 40} archivo(s) mas`);
console.log('─'.repeat(72));
console.log(
  `  ${alcance.resumen.fuente} fuente / ${alcance.resumen.tests} test · ` +
    `${alcance.resumen.lineasFuente} lineas de fuente agregadas · ` +
    `nivel exigido: ${nivel} (${NIVELES[nivel]})`,
);

if (nivel === 2) {
  console.log(
    `\n  ZONA CRITICA tocada (${alcance.resumen.lineasCriticas} lineas):\n` +
      zonasTocadas.map((z) => `    · ${z}`).join('\n'),
  );
  console.log(
    '  A nivel 2 son obligatorias: cobertura del diff, mutacion acotada,\n' +
      '  escaneo de secretos, invariantes de esquema y lectura adversarial firmada.',
  );
}

if (configTocado) {
  avisar(
    '\nEste diff MODIFICA .mechanical-review/config.json.\n' +
      '  Sacar una ruta de zonas.critica es la forma mas barata de saltarse la mitad\n' +
      '  de la revision. El cambio tiene que quedar justificado en la revision; no es\n' +
      '  un error, pero no puede pasar sin que alguien lo mire.',
  );
}

if (fuente.length > 0 && tests.length === 0) {
  avisar(
    'El diff toca fuente y NO toca ningun test.\n' +
      '  No es un error por si mismo (un refactor puro puede no cambiar tests), pero\n' +
      '  es la firma del cambio de comportamiento sin verificacion. La cobertura del\n' +
      '  diff y la mutacion van a decidirlo.',
  );
}

aprobar(`Alcance calculado → ${rutaSalida}`);
