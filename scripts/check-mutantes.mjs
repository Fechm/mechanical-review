#!/usr/bin/env node
/**
 * FASE 7 — MUTACION ACOTADA AL DIFF. Lee el reporte de StrykerJS y aplica el gate.
 *
 * POR QUE EL GATE NO ES "MUTATION SCORE >= X"
 * -------------------------------------------
 * Papadakis et al. (ICSE 2018) mostraron que al CONTROLAR el tamano de la suite,
 * la correlacion entre mutation score y deteccion de fallos reales es debil: el
 * tamano de la suite es un confusor fuerte, porque una suite mas grande mata mas
 * mutantes Y detecta mas fallos simplemente por tener mas tests. Traduccion
 * practica: subir el score agregando tests puede estar comprando deteccion por
 * volumen, no por calidad. Fijar "score >= X" reproduce el mismo incentivo
 * perverso que la cobertura al 100%.
 *
 * El diseno correcto es el de Google: CERO MUTANTES VIVOS SIN JUSTIFICACION
 * ESCRITA en el diff, con el numero de mutantes acotado por construccion (diff +
 * lineas cubiertas + no aridas + uno por linea). Ellos reportan mediana de 2
 * mutantes vivos por diff y percentil 99 de 43. A esa escala, revisar cada
 * sobreviviente a mano es realista; a escala de repo completo no lo es.
 *
 * POR QUE ESTA VALLA JUSTIFICA SU COSTO
 * ------------------------------------
 * Es la unica valla mecanica que atrapa "el test tiene aserciones pero no sobre lo
 * que su nombre promete". La sexta auditoria del modulo de cobro hizo mutacion A
 * MANO: movio una fila de la tabla de desenlaces para que un desenlace sin prueba
 * escribiera un estado fuera del predicado critico, y `tsc` quedo COMPLETAMENTE
 * VERDE con solo un spec en rojo. Un mutante que sobrevivio. Y el respaldo externo
 * es el mas fuerte de las tres piezas de la revision: Google, sobre 1.502 bugs
 * reales de alta prioridad, habria reportado un mutante vivo acoplado al defecto en
 * el 70% de los casos — y cada uno de esos cambios YA ESTABA CUBIERTO por los tests.
 *
 * META-ASERCIONES QUE CIERRA
 * --------------------------
 *  1. Reporte ausente -> falla. Stryker con `thresholds.break: null` (el DEFECTO)
 *     imprime un score de 3% y sale con codigo 0. Un pipeline con Stryker y sin
 *     `break` es teatro; este script es el que pone el gate de verdad.
 *  2. Cero mutantes generados -> falla. Un `--mutate` que no calza ningun archivo
 *     corre cero mutantes y no hay nada que reportar: verde perfecto, cero trabajo.
 *  3. Todos los mutantes en estado CompileError -> falla. Sin typescript-checker
 *     bien configurado eso significa que no se probo nada.
 *  4. Reporte VIEJO -> falla. Es el agujero mas grave que tenia este guarda y se
 *     comprobo rompiendolo: con un `reports/mutation/mutation.json` de una corrida
 *     anterior en disco (cosa normal con `--incremental`, con `reports/` cacheado en
 *     CI o simplemente versionado), y la fase de mutacion OMITIDA por falta de lineas
 *     que mutar, este script leia el reporte viejo, reportaba "score 100%, 0 vivos" y
 *     el orquestador imprimia "Revision completa" sobre un diff de zona critica
 *     donde Stryker NUNCA CORRIO.
 *  5. Reporte que no habla del diff -> falla. Un reporte perfectamente valido de OTRO
 *     modulo tambien daba verde: nada comparaba los archivos del reporte contra el
 *     alcance calculado. Es el equivalente exacto del "100% de cobertura de otra cosa"
 *     que ya cierra check-cobertura-diff.mjs.
 *
 * USO
 *   node check-mutantes.mjs [--reporte reports/mutation/mutation.json]
 *                           [--sin-cruce]   # solo para barridos fuera del diff
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
import { cargarExcepciones, cubiertoPorExcepcion } from './lib/excepciones.mjs';

const args = parsearArgs(process.argv.slice(2));
const raiz = raizRepo() ?? process.cwd();
const { cfg, error: errCfg } = cargarConfig(raiz);
if (errCfg) fallar('Configuracion invalida', [errCfg]);

const rutaReporte = join(raiz, args.reporte ?? cfg.mutacion?.reporte ?? 'reports/mutation/mutation.json');

if (!existsSync(rutaReporte)) {
  fallar('No hay reporte de mutacion', [
    `Se esperaba ${rutaReporte}.\n` +
      `  Stryker escribe este archivo con reporters: ["json"] (o ["html","json"]).\n` +
      `  Si Stryker corrio y no lo escribio, revisar el reporter; si no corrio, la fase\n` +
      `  de mutacion no puede aprobar por ausencia.`,
  ]);
}

let reporte;
try {
  reporte = JSON.parse(readFileSync(rutaReporte, 'utf8'));
} catch (e) {
  fallar('El reporte de mutacion no es JSON valido', [`${rutaReporte}: ${e.message}`]);
}

// --- Meta-asercion 4: el reporte tiene que ser de ESTA corrida -------------------

const rutaCobertura = join(raiz, '.mechanical-review', 'out', 'cobertura-diff.json');
const rutaAlcance = join(raiz, '.mechanical-review', 'out', 'alcance.json');
const referencia = existsSync(rutaCobertura)
  ? { ruta: '.mechanical-review/out/cobertura-diff.json', ms: statSync(rutaCobertura).mtimeMs }
  : existsSync(rutaAlcance)
    ? { ruta: '.mechanical-review/out/alcance.json', ms: statSync(rutaAlcance).mtimeMs }
    : null;

if (!referencia) {
  fallar('No hay alcance calculado con el que comparar el reporte de mutacion', [
    'Falta .mechanical-review/out/cobertura-diff.json (o alcance.json).\n' +
      '  Sin ellos no se puede saber si este reporte corresponde al diff actual, y un\n' +
      '  reporte de otra corrida da verde sobre codigo que nunca se muto.\n' +
      '  Correr la revision mecanica completo: node scripts/mechanical-review/orquestador.mjs',
  ]);
}

const msReporte = statSync(rutaReporte).mtimeMs;
if (msReporte < referencia.ms) {
  const minutos = Math.round((referencia.ms - msReporte) / 60000);
  fallar('El reporte de mutacion es ANTERIOR al alcance de esta corrida', [
    `${rutaReporte} tiene ${minutos} minuto(s) menos que ${referencia.ruta}.\n` +
      `  O sea: Stryker no corrio en esta corrida y este archivo quedo de una anterior.\n` +
      `  Un gate que lee un reporte viejo aprueba codigo que nunca se muto — y con\n` +
      `  \`--incremental\`, con reports/ cacheado en CI o versionado, es el caso normal,\n` +
      `  no el excepcional.\n` +
      `  Que hacer:\n` +
      `   1. Confirmar que la fase de mutacion se ejecuto (no OMITIDA) y que escribio el\n` +
      `      reporte: reporters debe incluir "json".\n` +
      `   2. Borrar reports/mutation/ antes de la corrida y agregarlo a .gitignore.\n` +
      `   3. Si la fase se omitio porque no habia lineas que mutar, eso NO es un pase:\n` +
      `      va excepcion escrita con vencimiento, o el cambio no es de nivel 2.`,
  ]);
}

const archivos = reporte.files ?? {};
const mutantes = [];
for (const [ruta, datos] of Object.entries(archivos)) {
  for (const m of datos.mutants ?? []) {
    mutantes.push({
      archivo: ruta.replace(/\\/g, '/'),
      linea: m.location?.start?.line ?? null,
      mutador: m.mutatorName,
      reemplazo: m.replacement,
      estado: m.status,
    });
  }
}

if (mutantes.length === 0) {
  fallar('La corrida de mutacion genero CERO mutantes', [
    'Esto no es un resultado, es la ausencia de uno.\n' +
      '  Causa numero uno: el argumento --mutate no calzo ningun archivo. Es el mismo\n' +
      '  patron que ya se cerro en el runner de tests del webapp de referencia (un glob\n' +
      '  que no calza produce 0 tests y exit 0).\n' +
      '  Verificar el alcance con:\n' +
      '    node scripts/mechanical-review/check-cobertura-diff.mjs --formato stryker\n' +
      '  y confirmar que las rutas que imprime existen tal cual desde la raiz del repo.',
  ]);
}

// --- Meta-asercion 5: el reporte tiene que hablar DEL DIFF -----------------------

if (args['sin-cruce'] !== true) {
  const cobertura = leerSalida(raiz, 'cobertura-diff.json');
  const alcance = leerSalida(raiz, 'alcance.json');
  const esperados = new Set();
  for (const rango of cobertura?.mutar ?? []) esperados.add(String(rango).split(':')[0].replace(/\\/g, '/'));
  if (esperados.size === 0) {
    for (const a of alcance?.archivos ?? []) if (a.tipo === 'fuente') esperados.add(a.ruta.replace(/\\/g, '/'));
  }
  const enElReporte = new Set(mutantes.map((m) => m.archivo));
  const calzan = [...enElReporte].filter((r) =>
    [...esperados].some((e) => r === e || r.endsWith(`/${e}`) || e.endsWith(`/${r}`)),
  );
  if (esperados.size > 0 && calzan.length === 0) {
    fallar('El reporte de mutacion no habla de ningun archivo del diff', [
      `Se mutaron: ${[...enElReporte].slice(0, 5).join(', ')}${enElReporte.size > 5 ? ' …' : ''}\n` +
        `  El diff esperaba: ${[...esperados].slice(0, 5).join(', ')}${esperados.size > 5 ? ' …' : ''}\n` +
        `  Esto NO es "cero mutantes vivos": es cero mutantes SOBRE ESTE CAMBIO. Es el mismo\n` +
        `  agujero que check-cobertura-diff.mjs cierra para el lcov ("100% de otra cosa").\n` +
        `  Causas: el --mutate se genero desde un alcance viejo, Stryker corrio con otro cwd,\n` +
        `  o el reporte quedo de otra rama.\n` +
        `  Verificar el alcance real con:\n` +
        `    node scripts/mechanical-review/check-cobertura-diff.mjs --formato stryker`,
    ]);
  }
}

const porEstado = mutantes.reduce((a, m) => ({ ...a, [m.estado]: (a[m.estado] ?? 0) + 1 }), {});
const compilaron = mutantes.filter((m) => m.estado !== 'CompileError');
if (compilaron.length === 0) {
  fallar('Todos los mutantes fallaron a compilar', [
    `${mutantes.length} mutante(s), todos en CompileError. Ninguna prueba se ejercito.\n` +
      `  Revisar la interaccion entre \`disableTypeChecks\` (viene en true por defecto:\n` +
      `  Stryker inyecta // @ts-nocheck) y @stryker-mutator/typescript-checker.`,
  ]);
}

/**
 * Meta-asercion 7: UN MUTANTE SIN VEREDICTO NO ES UN MUTANTE APROBADO.
 *
 * MEDIDO, y es el agujero mas grave que tenia este guarda. Stryker tiene SEIS estados
 * y solo tres son un veredicto sobre la suite (`Killed`, `Timeout`, `Survived`). Los
 * otros tres —`CompileError`, `RuntimeError`, `Ignored`— significan "este mutante nunca
 * se evaluo". Antes este script solo miraba `CompileError`, y todo-o-nada. Consecuencia
 * comprobada rompiendolo a proposito con un reporte de 20 mutantes:
 *
 *     { RuntimeError: 20 }  -> "✔ Mutacion: 20 mutante(s), 0 matado(s), 0 vivo(s)"  exit 0
 *     { Ignored: 20 }       -> "✔ Mutacion: 20 mutante(s), 0 matado(s), 0 vivo(s)"  exit 0
 *
 * O sea: el gate estrella de la revision salia EN VERDE sobre una corrida donde ni un
 * mutante llego a ejecutar un test. Es exactamente el defecto que este skill existe para
 * eliminar, dentro del skill.
 *
 * Y no es hipotetico: la corrida real sobre `pagos/desenlaces.ts` del backend de
 * el proyecto de referencia dio `{ Killed: 12, Survived: 8, NoCoverage: 3, RuntimeError: 13 }` — 13 de 36
 * mutantes (36%) sin veredicto, y el reporte no decia una palabra al respecto.
 *
 * `Ignored` merece trato aparte porque no es un accidente de montaje: es lo que Stryker
 * reporta cuando alguien escribio `// Stryker disable` en el archivo o `excludedMutations`
 * en la configuracion. Sin esta valla, UNA LINEA de comentario apaga la mutacion y el gate
 * felicita. Un mutante silenciado es indistinguible de un mutante no verificado, asi que
 * pasa por el mismo criterio de excepcion que un sobreviviente.
 */
const SIN_VEREDICTO = ['CompileError', 'RuntimeError', 'Ignored'];
const conVeredicto = mutantes.filter((m) => ['Killed', 'Timeout', 'Survived'].includes(m.estado));
const sinVeredicto = mutantes.filter((m) => SIN_VEREDICTO.includes(m.estado));
const ignorados = mutantes.filter((m) => m.estado === 'Ignored');

if (conVeredicto.length === 0) {
  fallar('Ningun mutante llego a ser evaluado por un test', [
    `${mutantes.length} mutante(s) y CERO con veredicto.\n` +
      `  Estados: ${Object.entries(porEstado)
        .map(([e, n]) => `${e}=${n}`)
        .join(' ')}\n` +
      `  Solo Killed / Timeout / Survived son un veredicto sobre la suite. CompileError,\n` +
      `  RuntimeError e Ignored significan "este mutante nunca se evaluo", y una corrida\n` +
      `  entera sin veredicto NO es "cero mutantes vivos": es cero medicion.\n` +
      `  Que hacer segun el estado dominante:\n` +
      `   · RuntimeError  -> el mutante rompe el arranque del modulo o del runner. Correr la\n` +
      `                      suite acotada a mano y mirar el error real antes de tocar nada.\n` +
      `   · CompileError  -> revisar disableTypeChecks vs @stryker-mutator/typescript-checker.\n` +
      `   · Ignored       -> hay \`// Stryker disable\` en el archivo o \`excludedMutations\` en\n` +
      `                      la configuracion. Quitarlo, o justificarlo como excepcion.`,
  ]);
}

/**
 * CORRECCION DE CLASIFICACION, medida en este repo y no deducida.
 *
 * La regla del 50% metia `CompileError` en la misma bolsa que `RuntimeError` e
 * `Ignored`. Los tres significan "la suite no lo evaluo", pero NO significan lo mismo
 * sobre si el mutante quedo cerrado:
 *
 *  · `RuntimeError` -> el mutante rompe el arranque. Nadie lo cierra: es una linea del
 *    diff sobre la que no se afirma nada.
 *  · `Ignored`      -> alguien lo silencio con `// Stryker disable` o `excludedMutations`.
 *    Nadie lo cierra, y encima por decision de una persona.
 *  · `CompileError` -> el mutante NO TYPECHEQUEA, o sea que no puede existir en el codigo
 *    entregado. Lo cierra el sistema de tipos, que en esta herramienta es la fase `tipos`
 *    y es BLOQUEANTE. Eso no es medicion faltante: es una garantia mas fuerte que un test,
 *    porque no depende de que alguien haya escrito el caso.
 *
 * El caso que lo destapo: `src/metrics/index.ts`, el ensamblador del informe, dio
 * `{ Killed: 2, CompileError: 7 }` sobre 9 mutantes. La fase fallaba por 7 > 4,5 pese a
 * tener CERO sobrevivientes y CERO mutantes sin cerrar. Es el primer archivo del proyecto
 * donde casi todo el diff es cableado tipado en vez de logica, y por eso es el primero
 * que lo muestra: vaciar el cuerpo de la funcion, vaciar el objeto devuelto, vaciar el
 * objeto de opciones, devolver `undefined` desde un comparador, cambiar `??` por `&&` o
 * quitar el encadenamiento opcional son todas cosas que `tsc --noEmit --strict` rechaza.
 *
 * Y el dato que descarta "el montaje esta roto", que era la hipotesis que la regla del 50%
 * queria atrapar: DOS mutantes obtuvieron veredicto. Un `typescript-checker` mal
 * configurado no habria compilado ninguno; habria dado los 9 en `CompileError`, y ese caso
 * lo sigue atrapando la meta-asercion de arriba (`conVeredicto === 0`).
 *
 * Por eso la regla del 50% pasa a mirar solo `RuntimeError` + `Ignored`, y `CompileError`
 * queda como aviso con su conteo. Para que el razonamiento quede EXIGIDO y no supuesto, se
 * agrega la verificacion de su premisa: si hay `CompileError` y la fase `tipos` no existe o
 * no bloquea, entonces el sistema de tipos NO esta cerrando nada y la fase falla.
 */
const noCerrados = mutantes.filter((m) => ['RuntimeError', 'Ignored'].includes(m.estado));
const conErrorDeCompilacion = mutantes.filter((m) => m.estado === 'CompileError');

if (conErrorDeCompilacion.length > 0) {
  const faseTipos = (cfg.fases ?? []).find((f) => f.id === 'tipos');
  if (!faseTipos || faseTipos.bloquea !== true) {
    fallar('Hay mutantes en CompileError y la fase de tipos no los cierra', [
      `${conErrorDeCompilacion.length} de ${mutantes.length} mutante(s) en CompileError.\n` +
        `  Contarlos como cerrados solo es valido si el sistema de tipos los rechaza de\n` +
        `  verdad en el codigo entregado, y eso lo garantiza la fase \`tipos\` BLOQUEANTE.\n` +
        `  Aca esa fase ${faseTipos ? 'existe pero no bloquea' : 'no esta en la configuracion'},\n` +
        `  asi que un mutante que no compila no esta cerrado por nada: es medicion faltante.\n` +
        `  Encender \`bloquea: true\` en la fase \`tipos\`, o tratar estos mutantes a mano.`,
    ]);
  }
}

if (noCerrados.length > mutantes.length / 2) {
  fallar('Mas de la mitad de los mutantes no llego a ser evaluado', [
    `${noCerrados.length} de ${mutantes.length} mutante(s) sin veredicto y sin cerrar ` +
      `(${Object.entries(porEstado)
        .filter(([e]) => ['RuntimeError', 'Ignored'].includes(e))
        .map(([e, n]) => `${e}=${n}`)
        .join(' ')}).\n` +
      `  Con esa proporcion el resultado dice mas del montaje que de la suite, igual que\n` +
      `  una corrida con timeouts masivos. El score se calcula sobre los ${conVeredicto.length}\n` +
      `  que si se evaluaron, asi que un "0 vivos" aca cubre una fraccion chica del cambio.\n` +
      `  Arreglar el montaje y volver a correr; no interpretar este numero.`,
  ]);
} else if (sinVeredicto.length > 0) {
  avisar(
    `${sinVeredicto.length} de ${mutantes.length} mutante(s) sin veredicto ` +
      `(${Object.entries(porEstado)
        .filter(([e]) => SIN_VEREDICTO.includes(e))
        .map(([e, n]) => `${e}=${n}`)
        .join(' ')}).\n` +
      '      No cuentan ni como matados ni como vivos. Leerlos por separado: los CompileError\n' +
      '      los cierra la fase `tipos` (el mutante no compila, no puede llegar a produccion);\n' +
      '      los RuntimeError e Ignored no los cierra nadie y son lineas del diff sobre las que\n' +
      '      esta corrida no afirma nada. Si hay de estos ultimos en zona critica, mirarlos a mano.',
  );
}

/**
 * Meta-asercion 6: TIMEOUT MASIVO NO ES DETECCION.
 *
 * MEDIDO, no teorico. Corrida real sobre pagos/identificadores.util.ts del backend de
 * el proyecto de referencia, con el grafo de tests sin acotar (13 suites de Nest, arranque de ts-jest de
 * 75 s) y `timeoutMS: 60000`:
 *
 *     { NoCoverage: 6, Ignored: 4, Timeout: 42, Killed: 0, Survived: 0 }
 *     mutation score: 87.50%   ·   exit 0
 *
 * Ni un mutante matado por un test, y sin embargo 87,5% y verde: Stryker cuenta los
 * Timeout como matados (correcto en general: un mutante que cuelga la suite ESTA
 * detectado), pero cuando el timeout lo produce el arranque del propio runner, "matado"
 * es una mentira aritmetica. La misma corrida con el grafo acotado dio
 * `Killed: 32, Survived: 10, Timeout: 0` — o sea, DIEZ mutantes vivos escondidos detras
 * de un 87,5%.
 *
 * Es exactamente la clase de defecto que esta herramienta existe para eliminar, y estaba
 * dentro de la revision. Regla: si no hubo NI UN mutante matado por un test, o si los
 * timeouts son mas de la mitad, la corrida no es un resultado; es un problema de montaje.
 */
const timeouts = mutantes.filter((m) => m.estado === 'Timeout');
const matadosPorTest = mutantes.filter((m) => m.estado === 'Killed');
const evaluados = mutantes.filter((m) => ['Killed', 'Timeout', 'Survived'].includes(m.estado));
if (evaluados.length > 0 && matadosPorTest.length === 0 && timeouts.length > 0) {
  fallar('Ningun mutante fue matado por un test: TODOS fueron timeout', [
    `${timeouts.length} timeout(s), 0 matado(s), ${mutantes.filter((m) => m.estado === 'Survived').length} vivo(s).\n` +
      `  Stryker cuenta los timeout como matados, asi que esta corrida IMPRIME UN SCORE ALTO\n` +
      `  sin haber detectado nada. Pasa cuando el arranque del runner supera timeoutMS: el\n` +
      `  mutante nunca llega a ejecutar un test.\n` +
      `  Medido en este backend: 42 timeout / 87,5% de score / 0 matados con el grafo de\n` +
      `  tests sin acotar; la misma corrida acotada dio 32 matados y 10 VIVOS.\n` +
      `  Que hacer, en este orden:\n` +
      `   1. Medir el arranque real del runner:  <gestor> jest -c <config-de-stryker> \n` +
      `      Si tarda mas que timeoutMS, no hay timeoutMS que arregle esto.\n` +
      `   2. ACOTAR el grafo de tests de la corrida de mutacion a las specs que cubren el\n` +
      `      archivo mutado. Medido: 82 s -> 4,5 s de arranque, y la medicion pasa a ser valida.\n` +
      `   3. Solo despues, subir timeoutMS / timeoutFactor.`,
  ]);
}
if (evaluados.length > 0 && timeouts.length > evaluados.length / 2) {
  avisar(
    `${timeouts.length} de ${evaluados.length} mutantes evaluados terminaron en TIMEOUT.\n` +
      '      Stryker los cuenta como matados. Con esa proporcion, el score dice mas del\n' +
      '      montaje que de la suite: revisar el arranque del runner antes de creerle.',
  );
}

const excepciones = cargarExcepciones(raiz);
const vivos = mutantes.filter((m) => m.estado === 'Survived');
const sinCobertura = mutantes.filter((m) => m.estado === 'NoCoverage');
const matados = mutantes.filter((m) => m.estado === 'Killed' || m.estado === 'Timeout');

const justificados = [];
const injustificados = [];
for (const m of vivos) {
  const exc = cubiertoPorExcepcion(excepciones, 'mutacion', m.archivo, m.linea);
  if (exc) justificados.push({ ...m, excepcion: exc.id });
  else injustificados.push(m);
}

/**
 * `Ignored` pasa por el MISMO criterio de excepcion que un sobreviviente.
 *
 * POR QUE: `Ignored` no es un accidente, es una supresion deliberada — `// Stryker disable`
 * en el archivo, o `mutator.excludedMutations` en la configuracion. Sin esta valla, una
 * linea de comentario apaga la mutacion sobre el codigo que mas importa y el gate imprime
 * un visto bueno. Un mutante silenciado y un mutante no verificado son la misma cosa desde
 * el punto de vista de lo que la suite garantiza, asi que se exige lo mismo: excepcion
 * escrita, con motivo, responsable y vencimiento.
 */
const ignoradosSinJustificar = ignorados.filter(
  (m) => !cubiertoPorExcepcion(excepciones, 'mutacion', m.archivo, m.linea),
);

const score =
  matados.length + vivos.length === 0
    ? null
    : Math.round((matados.length / (matados.length + vivos.length)) * 1000) / 10;

escribirSalida(raiz, 'mutantes.json', {
  version: 1,
  reporte: args.reporte ?? cfg.mutacion?.reporte ?? 'reports/mutation/mutation.json',
  total: mutantes.length,
  porEstado,
  score,
  conVeredicto: conVeredicto.length,
  sinVeredicto: sinVeredicto.length,
  vivos: vivos.length,
  ignorados: ignorados.length,
  ignoradosSinJustificar: ignoradosSinJustificar.length,
  justificados,
  injustificados,
});

console.log(`\nMutacion — ${mutantes.length} mutante(s) en el alcance del diff`);
console.log('─'.repeat(72));
console.log(
  `  ${Object.entries(porEstado)
    .map(([e, n]) => `${e}=${n}`)
    .join('  ')}`,
);
console.log(
  `  score informativo: ${score === null ? 'n/a' : `${score}%`}  ` +
    '(informativo A PROPOSITO: el gate es cero sobrevivientes sin justificar,\n' +
    '   no un porcentaje. Perseguir el porcentaje compra deteccion por volumen.)',
);

if (sinCobertura.length > 0) {
  avisar(
    `${sinCobertura.length} mutante(s) en estado NoCoverage.\n` +
      '      No deberian existir: el alcance se calcula sobre lineas CUBIERTAS. Si aparecen,\n' +
      '      el lcov y la corrida de Stryker se hicieron con suites distintas.',
  );
}

if (justificados.length > 0) {
  console.log(`\n  ${justificados.length} sobreviviente(s) con excepcion vigente:`);
  for (const m of justificados) console.log(`    · ${m.archivo}:${m.linea} ${m.mutador} → ${m.excepcion}`);
}

if (ignoradosSinJustificar.length > 0) {
  fallar(
    `${ignoradosSinJustificar.length} mutante(s) SILENCIADOS sin justificacion`,
    ignoradosSinJustificar.slice(0, 25).map(
      (m) =>
        `${m.archivo}:${m.linea}  [${m.mutador}]  estado Ignored\n` +
        `  Ese mutante no se evaluo porque alguien lo suprimio: hay un \`// Stryker disable\`\n` +
        `  en el archivo o \`mutator.excludedMutations\` en la configuracion de Stryker.\n` +
        `  Un mutante silenciado garantiza lo mismo que un mutante vivo: nada. Opciones:\n` +
        `   1. Quitar la supresion y dejar que el mutante se evalue.\n` +
        `   2. Si de verdad corresponde suprimirlo (nodo arido, mutante equivalente), va\n` +
        `      excepcion escrita en .mechanical-review/excepciones.md (valla: mutacion), con\n` +
        `      responsable y vencimiento — igual que cualquier otra valla apagada.\n` +
        `  Lo que NO corresponde: ampliar la supresion para que el gate deje de hablar.`,
    ),
  );
}

if (injustificados.length > 0) {
  fallar(
    `${injustificados.length} mutante(s) SOBREVIVIERON sin justificacion`,
    injustificados.slice(0, 25).map(
      (m) =>
        `${m.archivo}:${m.linea}  [${m.mutador}]  reemplazo: ${String(m.reemplazo).replace(/\s+/g, ' ').slice(0, 80)}\n` +
        `  Se cambio esa linea y NINGUN test se dio cuenta. Las tres lecturas posibles,\n` +
        `  en el orden en que hay que probarlas:\n` +
        `   1. FALTA UNA ASERCION. Es el caso mas frecuente y el que buscamos: el test\n` +
        `      ejecuta la linea pero no observa su efecto. Arreglo: afirmar el ESTADO\n` +
        `      PERSISTIDO del desenlace, no que la funcion no lanzo.\n` +
        `   2. FALTA UN DESENLACE EN LA ESPECIFICACION. Si nadie sabe que deberia pasar\n` +
        `      con esa linea, el hueco esta en la tabla de desenlaces, no en el test.\n` +
        `   3. MUTANTE EQUIVALENTE O IRRELEVANTE. El mutante es semanticamente identico\n` +
        `      al original, o toca un nodo arido (log, telemetria, constructor trivial).\n` +
        `      Solo en este caso corresponde una excepcion escrita con vencimiento en\n` +
        `      .mechanical-review/excepciones.md (valla: mutacion).\n` +
        `  Lo que NO corresponde: escribir un test cuyo unico proposito sea matar este\n` +
        `  mutante. Google, con seis anos de datos, cuenta con los revisores para frenar\n` +
        `  exactamente eso.`,
    ),
  );
}

// El mensaje dice cuantos mutantes tuvieron VEREDICTO, no cuantos se generaron: la
// diferencia entre los dos numeros es justamente lo que esta corrida no verifico, y
// esconderla fue el agujero que este guarda tenia.
aprobar(
  `Mutacion: ${conVeredicto.length} de ${mutantes.length} mutante(s) con veredicto, ` +
    `${matados.length} matado(s), ${vivos.length} vivo(s) ` +
    `(${justificados.length} con excepcion vigente, 0 sin justificar)` +
    (sinVeredicto.length > 0 ? `, ${sinVeredicto.length} sin evaluar` : '') +
    '.',
);
