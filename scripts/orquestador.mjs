#!/usr/bin/env node
/**
 * MECHANICAL-REVIEW — orquestador. Un comando, acotado al diff, igual en local y en CI.
 *
 * POR QUE UN ORQUESTADOR Y NO UNA LISTA DE PASOS EN EL YAML
 * --------------------------------------------------------
 * Bitbucket Pipelines no tiene workflows reutilizables ni composite actions: una
 * definicion central de la revision tendria que copiarse en 27 archivos YAML y
 * divergir. Lo que si viaja entre GitHub Actions y Bitbucket es `node scripts/...`.
 * Ademas, si el gate solo existe dentro del YAML, nadie lo puede reproducir ni
 * depurar en local — y un gate que no se puede reproducir se empieza a ignorar.
 *
 * ORDEN: BARATO PRIMERO, Y DENTRO DE LO BARATO LO QUE FALLA MAS SEGUIDO.
 * La mutacion va ultima porque cuesta entre 10x y 100x una corrida de tests. Si el
 * tipo no compila, gastar veinte minutos en mutantes es tirar computo.
 *
 * CALIBRACION POR CRITICIDAD (el "dial", no el dogma)
 * --------------------------------------------------
 * Martin mismo escribio que sobrecargo de tests, que poder hacerlo no implica
 * deberlo, y que muchas veces usa solo tests unitarios y CRAP. El agregador
 * convirtio en protocolo obligatorio lo que el autor describe como un dial. Aca el
 * dial son tres niveles, y el nivel NO lo elige quien corre el comando: lo deduce
 * el alcance del diff contra las zonas declaradas en .mechanical-review/config.json.
 *
 * USO
 *   node scripts/mechanical-review/orquestador.mjs                 # sobre el diff vs la base
 *   node scripts/mechanical-review/orquestador.mjs --base origin/uat
 *   node scripts/mechanical-review/orquestador.mjs --nivel 2        # forzar hacia ARRIBA
 *   node scripts/mechanical-review/orquestador.mjs --fase mutacion  # una sola fase
 *   node scripts/mechanical-review/orquestador.mjs --seco           # que correria, sin correr
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aprobar,
  avisar,
  cargarConfig,
  correrShell,
  escribirSalida,
  fallar,
  leerSalida,
  NIVELES,
  parsearArgs,
  raizRepo,
  VERSION_HERRAMIENTA,
} from './lib/comun.mjs';
import { cargarExcepciones, cubiertoPorExcepcion } from './lib/excepciones.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const args = parsearArgs(process.argv.slice(2));
const raiz = raizRepo() ?? process.cwd();
const { cfg, error: errCfg } = cargarConfig(raiz);
if (errCfg) fallar('Configuracion invalida', [errCfg]);

/**
 * Fases que un repo con zona critica declarada NO puede omitir.
 * Si el config declara zonas.critica y no cablea estas fases, la revision mecanica
 * estaria prometiendo una proteccion que no tiene. Se falla en la configuracion,
 * no en la corrida: es mas barato descubrirlo el primer dia.
 *
 * POR QUE `mutantes` ESTA EN LA LISTA (defecto encontrado auditando este archivo)
 * -----------------------------------------------------------------------------
 * Antes la lista traia `mutacion` (la corrida de Stryker) y NO `mutantes`
 * (check-mutantes.mjs). Eso dejaba pasar exactamente el modo de falla que la propia
 * skill documenta: Stryker con `thresholds.break: null` imprime "mutation score 3%"
 * y sale con codigo 0, asi que un config que declara `mutacion` y borra `mutantes`
 * corria la mutacion, no verificaba nada, y el orquestador imprimia "Revision mecanica
 * completo, 0 en rojo". Se comprobo rompiendolo a proposito: pasaba en verde.
 * El gate real es `mutantes`; el productor es `mutacion`. Se exigen los dos.
 */
const OBLIGATORIAS_NIVEL_2 = [
  'especificacion',
  'aserciones',
  'cobertura-diff',
  'mutacion',
  'mutantes',
  'secretos',
  'invariantes',
];

const fases = cfg.fases ?? [];
if (fases.length === 0) {
  fallar('El config no declara ninguna fase', [
    'Sin fases, este comando no verifica nada y saldria en verde: el defecto exacto\n' +
      '  que la revision mecanica existe para eliminar. Correr init.mjs o copiar el bloque\n' +
      '  "fases" del perfil correspondiente (references/perfil-*.md del skill).',
  ]);
}

if (cfg.zonas.critica.length > 0) {
  const faltantes = OBLIGATORIAS_NIVEL_2.filter((id) => !fases.some((f) => f.id === id));
  if (faltantes.length > 0) {
    fallar('El config declara zona critica y no cablea las fases obligatorias de nivel 2', [
      `Faltan: ${faltantes.join(', ')}.\n` +
        `  Zona critica declarada: ${cfg.zonas.critica.join(', ')}\n` +
        `  Una revision que declara zona critica sin sus vallas produce falsa confianza,\n` +
        `  que es peor que no tener revision mecanica. Dos salidas legitimas:\n` +
        `   a) cablear las fases que faltan (ver references/perfil-*.md);\n` +
        `   b) sacar esas rutas de zonas.critica A MANO, dejando en el commit por que.`,
    ]);
  }
}

const informativas = fases.filter((f) => f.bloquea === false);
if (informativas.length > 0) {
  avisar(
    `${informativas.length} fase(s) declaradas NO bloqueantes: ${informativas.map((f) => f.id).join(', ')}.\n` +
      '      Un gate informativo se ignora en dos semanas y estorba en la revision.\n' +
      '      Se permite solo como trinquete temporal, con excepcion escrita y vencimiento.',
  );
}

// --- Sustitucion de marcadores en los comandos ---------------------------------

// `replaceAll` exige Node >= 15 y estos guardas tienen que correr tambien en los repos
// con Node 14 (medido en dos repos reales). Se usa split/join, que corre en todos.
const reemplazarTodo = (texto, marca, valor) => texto.split(marca).join(valor);

function sustituir(comando) {
  let c = comando;
  if (c.includes('{{MUTAR}}')) {
    const cob = leerSalida(raiz, 'cobertura-diff.json');
    const rangos = cob?.mutar ?? [];
    if (rangos.length === 0) return { omitir: 'no hay lineas cubiertas del diff que mutar' };
    c = reemplazarTodo(c, '{{MUTAR}}', rangos.join(','));
  }
  if (c.includes('{{ARCHIVOS}}')) {
    const alc = leerSalida(raiz, 'alcance.json');
    const rutas = (alc?.archivos ?? []).map((a) => a.ruta);
    if (rutas.length === 0) return { omitir: 'no hay archivos en el alcance' };
    c = reemplazarTodo(c, '{{ARCHIVOS}}', rutas.join(' '));
  }
  if (c.includes('{{BASE}}')) {
    const alc = leerSalida(raiz, 'alcance.json');
    c = reemplazarTodo(c, '{{BASE}}', alc?.mergeBase ?? baseElegida);
  }
  return { comando: c };
}

/**
 * POR QUE LA BASE SE PROPAGA EXPLICITAMENTE (defecto encontrado auditando este archivo)
 * ------------------------------------------------------------------------------------
 * El bloque de uso documenta `--base origin/uat`, pero antes ese valor no llegaba a
 * ninguna parte: las fases `interno` se invocaban sin argumentos y `check-alcance-diff`
 * terminaba usando `cfg.base`. En repos donde la base es `origin/uat` y no `origin/main`,
 * eso significa que quien pasaba la base correcta obtenia el diff contra otra rama sin
 * ningun aviso. Se propaga por variable de entorno porque check-alcance-diff ya la lee
 * (MECHANICAL_REVIEW_BASE) y asi vale igual para las fases `comando` de terceros.
 */
const baseElegida = args.base !== undefined && args.base !== true ? String(args.base) : cfg.base;

function comandoDeFase(f) {
  if (f.interno) {
    const ruta = join(AQUI, f.interno);
    if (!existsSync(ruta)) return { error: `falta el script interno ${f.interno} en ${AQUI}` };
    const extra = f.args ? ` ${f.args}` : '';
    return { comando: `node "${ruta}"${extra}` };
  }
  if (f.comando) return sustituir(f.comando);
  return { error: 'la fase no declara "interno" ni "comando"' };
}

// --- Nivel del run --------------------------------------------------------------

// La fase de alcance tiene que correr primero para deducir el nivel. Si el usuario
// fuerza --nivel, solo puede forzar HACIA ARRIBA: bajar el nivel a mano seria la
// puerta trasera mas obvia del diseno.
let nivel = 0;
const resultados = [];
const t0 = Date.now();

console.log(`\nMECHANICAL-REVIEW v${VERSION_HERRAMIENTA} — ${raiz}`);
if (args.seco) console.log('(--seco: solo corre la fase de alcance, para saber el nivel real; el resto se lista)');

function ejecutar(f) {
  const inicio = Date.now();
  const { comando, error, omitir } = comandoDeFase(f);

  if (error) {
    resultados.push({ id: f.id, estado: 'ERROR-CONFIG', ms: 0, detalle: error });
    return { falla: true, aborta: true };
  }
  if (omitir) {
    resultados.push({ id: f.id, estado: 'OMITIDA', ms: 0, detalle: omitir });
    return { falla: false, aborta: false, omitida: true };
  }
  // La fase de alcance corre incluso en --seco: es de solo lectura, cuesta
  // milisegundos, y sin ella el nivel seria 0 y el ensayo mostraria todas las fases
  // como NO-APLICA. Un ensayo que miente sobre que se va a correr no sirve de nada.
  if (args.seco && f.id !== 'alcance') {
    resultados.push({ id: f.id, estado: 'SECO', ms: 0, detalle: comando });
    return { falla: false, aborta: false };
  }

  console.log(`\n▸ ${f.id}\n  ${comando}`);
  const r = correrShell(comando, { cwd: raiz, env: { MECHANICAL_REVIEW_BASE: baseElegida } });
  const ms = Date.now() - inicio;
  const ok = r.codigo === 0;
  resultados.push({
    id: f.id,
    estado: ok ? 'PASA' : f.bloquea === false ? 'FALLA-NO-BLOQUEA' : 'FALLA',
    ms,
    codigo: r.codigo,
  });
  // POR QUE EL DEFECTO ES **NO** ABORTAR: en una corrida local se quiere el cuadro
  // completo de las vallas baratas en un solo viaje, no arreglar de a una y volver a
  // esperar. Solo abortan las fases que PRODUCEN el insumo de las siguientes
  // (alcance, tests -> lcov, cobertura-diff -> alcance de mutacion) y el typecheck,
  // porque correr una suite que no compila no informa nada.
  return { falla: !ok && f.bloquea !== false, aborta: !ok && f.abortaCadena === true };
}

// --- Corrida --------------------------------------------------------------------

const soloFase = args.fase ? String(args.fase) : null;
let fallas = 0;
let abortado = null;

for (const f of fases) {
  if (soloFase && f.id !== soloFase && f.id !== 'alcance') continue;

  // El nivel se conoce recien despues de la fase de alcance.
  if (f.id !== 'alcance' && (f.nivelMinimo ?? 0) > nivel) {
    resultados.push({
      id: f.id,
      estado: 'NO-APLICA',
      ms: 0,
      detalle: `exige nivel ${f.nivelMinimo}, el diff es nivel ${nivel} (${NIVELES[nivel]})`,
    });
    continue;
  }

  const r = ejecutar(f);
  if (r.falla) fallas++;

  if (f.id === 'alcance') {
    const alc = leerSalida(raiz, 'alcance.json');
    if (!alc) {
      fallar('La fase de alcance no produjo alcance.json', [
        'Sin alcance no se puede acotar nada y el resto de la revision quedaria mirando\n' +
          '  todo o nada. Se aborta.',
      ]);
    }
    nivel = Math.max(alc.nivel, args.nivel !== undefined ? Number(args.nivel) : 0);
    if (args.nivel !== undefined && Number(args.nivel) < alc.nivel) {
      avisar(
        `--nivel ${args.nivel} es MENOR que el nivel deducido (${alc.nivel}). Se ignora:\n` +
          '      el nivel solo se puede forzar hacia arriba. Bajarlo a mano seria la puerta\n' +
          '      trasera mas obvia de todo el diseno.',
      );
    }
    console.log(`  nivel del run: ${nivel} (${NIVELES[nivel]})`);
  }

  if (r.aborta) {
    abortado = f.id;
    break;
  }
}

// --- Meta-aserciones del orquestador -------------------------------------------

const EJECUTADA = ['PASA', 'FALLA', 'FALLA-NO-BLOQUEA'];
const corridas = resultados.filter((r) => EJECUTADA.includes(r.estado));

/**
 * POR QUE SE EXCLUYE `alcance` DEL CONTEO (defecto encontrado auditando este archivo)
 * ----------------------------------------------------------------------------------
 * `alcance` corre SIEMPRE, incluso con --fase X y con --seco. Contarla hacia
 * `corridas.length === 0` volvia esa meta-asercion codigo muerto: nunca podia dispararse.
 * Se comprobo: `revision mecanica.mjs --fase mutacion` sobre un diff de zona critica, con la
 * fase omitida por falta de insumos, imprimia "✔ Revision completa: 1 fase(s)
 * ejecutada(s), 0 en rojo" y salia 0 sin haber verificado NADA. Es exactamente el
 * defecto que esta herramienta existe para eliminar, dentro del propio revision mecanica.
 */
const vallasCorridas = corridas.filter((r) => r.id !== 'alcance');
/**
 * POR QUE `--seco` QUEDA FUERA DE ESTA META-ASERCION (defecto medido)
 * ------------------------------------------------------------------
 * En `--seco` todas las fases salvo `alcance` quedan en estado SECO, que no esta en
 * EJECUTADA. Resultado comprobado: `revision mecanica.mjs --seco` fallaba SIEMPRE con "no ejecuto
 * NINGUNA valla" y salia 1, y la rama `aprobar('Ensayo (--seco) terminado...')` del final
 * era codigo inalcanzable. O sea: un modo documentado en el bloque `## Usage` que nunca
 * podia terminar bien, y una linea de codigo muerto justo en el mensaje que existe para
 * distinguir un ensayo de una verificacion. Un ensayo no verifica nada A PROPOSITO; lo que
 * tiene que hacer es decirlo, no salir en rojo.
 */
if (vallasCorridas.length === 0 && !args.seco) {
  fallar('La revision mecanica no ejecuto NINGUNA valla', [
    'Solo corrio el calculo de alcance. Todas las vallas quedaron omitidas o fuera de\n' +
      '  nivel, asi que este comando no puede afirmar nada y sale en rojo a proposito.\n' +
      '  Causas habituales: el diff quedo vacio, los patrones del config dejaron de\n' +
      '  calzar con la estructura de carpetas, o se pidio --fase de una fase que\n' +
      '  necesitaba el artefacto de otra que no se corrio.',
  ]);
}

if (nivel >= 2 && !args.seco) {
  /**
   * A nivel 2, una fase obligatoria que no termino en PASA es una FALLA, no una nota.
   *
   * POR QUE (defecto encontrado auditando este archivo): antes solo se contaba como
   * falla la fase AUSENTE del config, y OMITIDA / NO-APLICA se imprimian como
   * `nota:` informativa. Resultado comprobado: con la fase de mutacion OMITIDA por
   * falta de lineas que mutar, y un reporte de mutacion VIEJO en disco, el orquestador
   * imprimia "Revision completa, 0 en rojo" sobre un diff de zona critica donde
   * Stryker nunca corrio. Una fase obligatoria de nivel 2 que no se ejecuto deja el
   * cambio sin la valla que su nivel exige: si de verdad no aplica, va excepcion
   * escrita con vencimiento, no una linea de log.
   */
  /**
   * POR QUE SE DISTINGUE "NO CABLEADA" DE "NO ALCANZADA" (defecto medido)
   * --------------------------------------------------------------------
   * Antes, cualquier fase sin entrada en `resultados` se reportaba como "no esta cableada
   * en el config". Comprobado tres veces en corridas reales: con la cadena abortada en
   * `cobertura-diff`, y con `--fase aserciones`, el orquestador imprimia
   * "mutacion: no esta cableada en el config" sobre un config que SI la cableaba. El
   * diagnostico mandaba a editar el config —que estaba bien— en vez de a mirar la fase que
   * fallo o el `--fase` que se pidio. Un gate rojo con la causa equivocada cuesta el mismo
   * rato que un gate que no corre.
   */
  const problemas = [];
  for (const id of OBLIGATORIAS_NIVEL_2) {
    const r = resultados.find((x) => x.id === id);
    if (!r) {
      const estaEnConfig = fases.some((f) => f.id === id);
      if (!estaEnConfig) problemas.push(`${id}: no esta cableada en el config`);
      else if (soloFase) problemas.push(`${id}: cableada, pero no se pidio (--fase ${soloFase})`);
      else if (abortado) problemas.push(`${id}: cableada, no se alcanzo (cadena abortada en "${abortado}")`);
      else problemas.push(`${id}: cableada, y sin embargo no se ejecuto — revisar el orden de fases`);
    } else if (r.estado === 'OMITIDA') problemas.push(`${id}: OMITIDA — ${r.detalle}`);
    else if (r.estado === 'NO-APLICA') problemas.push(`${id}: NO-APLICA — ${r.detalle}`);
    else if (r.estado === 'SECO') problemas.push(`${id}: no se ejecuto (ensayo)`);
  }
  /**
   * LA SALIDA (b) TIENE QUE EXISTIR DE VERDAD (defecto medido)
   * ---------------------------------------------------------
   * El mensaje de abajo ofrece tres salidas legitimas y la (b) es "excepcion escrita con
   * vencimiento en .mechanical-review/excepciones.md". Comprobado: NADIE leia ese archivo aca.
   * `cubiertoPorExcepcion` solo lo consultaba check-mutantes, asi que quien escribia la
   * excepcion que el propio gate le pedia seguia con la revision mecanica en rojo, y la unica
   * salida que quedaba era editar `zonas.critica` o borrar la fase. Es decir: la friccion
   * empujaba exactamente al `|| true` que este diseno existe para impedir.
   *
   * La excepcion tiene que ser DIRIGIDA, no una amnistia: se exige que nombre la valla y
   * una ruta que calce con algun archivo de zona critica de este diff. Una excepcion
   * generica no cubre nada.
   */
  const excepcionesVivas = cargarExcepciones(raiz);
  const alcanceN2 = leerSalida(raiz, 'alcance.json');
  const rutasCriticas = alcanceN2?.zonasTocadas ?? [];
  const VALLA_DE_FASE = { mutantes: 'mutacion', mutacion: 'mutacion', 'cobertura-diff': 'cobertura-diff' };
  const dispensados = [];
  const pendientes = [];
  for (const p of problemas) {
    const id = p.split(':')[0];
    const valla = VALLA_DE_FASE[id] ?? id;
    const exc = rutasCriticas
      .map((ruta) => cubiertoPorExcepcion(excepcionesVivas, valla, ruta, null))
      .find(Boolean);
    if (exc) dispensados.push(`${p}   → cubierta por ${exc.id} (vence ${exc.vence}, ${exc.responsable})`);
    else pendientes.push(p);
  }
  if (dispensados.length > 0) {
    avisar(
      `${dispensados.length} valla(s) obligatoria(s) de nivel 2 no corrieron y estan cubiertas por\n` +
        '      una excepcion vigente. Eso NO es lo mismo que verificadas:\n' +
        dispensados.map((d) => `        · ${d}`).join('\n') +
        '\n      El vencimiento las vuelve obligatorias solas. check-excepciones.mjs lo hace fallar.',
    );
  }
  problemas.length = 0;
  problemas.push(...pendientes);

  // Si la cadena se aborto, las fases posteriores no corrieron por una falla ya
  // contabilizada: no se duplica el rojo, pero se dice en voz alta que quedaron sin correr.
  if (problemas.length > 0) {
    if (abortado) {
      console.log(
        `\n  Nivel 2 con la cadena abortada en "${abortado}": quedaron sin correr\n` +
          problemas.map((p) => `    · ${p}`).join('\n'),
      );
    } else {
      fallas++;
      resultados.push({
        id: '(meta)',
        estado: 'FALLA',
        ms: 0,
        detalle: `nivel 2 sin vallas obligatorias: ${problemas.length}`,
      });
      console.error(
        `\n✖ El diff es de nivel 2 (zona critica) y ${problemas.length} valla(s) obligatoria(s)\n` +
          '  no se ejecutaron:\n' +
          problemas.map((p) => `    · ${p}`).join('\n') +
          '\n  Un cambio en zona critica sin sus vallas no queda verificado. Salidas legitimas:\n' +
          '   a) cablear/arreglar la fase para que corra de verdad;\n' +
          '   b) excepcion escrita con vencimiento en .mechanical-review/excepciones.md;\n' +
          '   c) sacar la ruta de zonas.critica A MANO, dejando en el commit por que.',
      );
    }
  }
}

// --- Reporte final --------------------------------------------------------------

const total = Date.now() - t0;
console.log(`\n${'═'.repeat(72)}`);
console.log(`RESULTADO DE LA REVISION  ·  nivel ${nivel} (${NIVELES[nivel]})  ·  ${(total / 1000).toFixed(1)} s`);
console.log('═'.repeat(72));
for (const r of resultados) {
  const dur = r.ms ? `${(r.ms / 1000).toFixed(1)}s` : '';
  console.log(`  ${r.estado.padEnd(18)} ${r.id.padEnd(20)} ${dur.padStart(7)}  ${r.detalle ?? ''}`);
}
if (abortado) {
  console.log(
    `\n  Cadena abortada en "${abortado}": las fases siguientes dependen de sus artefactos\n` +
      '  (alcance, lcov, reporte de mutacion). Correrlas con datos viejos daria un verde\n' +
      '  que no corresponde.',
  );
}

escribirSalida(raiz, 'revision mecanica.json', {
  version: 1,
  herramienta: VERSION_HERRAMIENTA,
  fecha: new Date().toISOString(),
  nivel,
  ms: total,
  abortado,
  fallas,
  resultados,
});

if (fallas > 0) {
  console.error(`\n✖ Revision mecanica FALLIDO: ${fallas} fase(s) bloqueante(s) en rojo.\n`);
  console.error(
    '  Antes de tocar un umbral: leer el diagnostico de la fase que fallo. Cada gate\n' +
      '  imprime que hacer y en que orden. Si de verdad corresponde una excepcion, va en\n' +
      '  .mechanical-review/excepciones.md con motivo, responsable y vencimiento ≤30 dias.\n',
  );
  process.exit(1);
}

// POR QUE EL MENSAJE DISTINGUE CORRIDA PARCIAL DE COMPLETA: "Revision completa" sobre
// un `--fase X` o un `--seco` es una afirmacion falsa, y es la clase de afirmacion que
// despues alguien cita como evidencia de que el cambio estaba verificado.
if (soloFase) {
  aprobar(
    `Fase "${soloFase}": sin rojos (${(total / 1000).toFixed(1)} s).\n` +
      '  CORRIDA PARCIAL — esto NO es la revision mecanica completo y no habilita nada.\n' +
      '  Para el veredicto: node scripts/mechanical-review/orquestador.mjs (sin --fase).',
  );
} else if (args.seco) {
  aprobar(`Ensayo (--seco) terminado en ${(total / 1000).toFixed(1)} s. NO se verifico nada.`);
} else {
  aprobar(
    `Revision completa: ${vallasCorridas.length} valla(s) ejecutada(s), 0 en rojo, ` +
      `${(total / 1000).toFixed(1)} s.`,
  );
}
if (nivel < 2) {
  console.log(
    '\n  Recordatorio honesto: esta herramienta NO mira cuatro clases de defecto\n' +
      '  (especificacion equivocada, fuga de secretos y superficie de datos, concurrencia,\n' +
      '  autorizacion). Tres de los cuatro hallazgos mas graves de la sesion de cobro caen\n' +
      '  ahi y salieron de leer con lente adversarial. Ver references/limites.md.',
  );
}
