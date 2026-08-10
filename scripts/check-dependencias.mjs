#!/usr/bin/env node
/**
 * FASE — PROCEDENCIA DE DEPENDENCIAS. La unica valla dirigida a un fallo que es
 * ESPECIFICO de la generacion por modelos de lenguaje.
 *
 * POR QUE ESTA VALLA EXISTE
 * -------------------------
 * Un modelo alucina nombres de paquetes que no existen. No es un error raro: es una
 * clase documentada, con nombre propio ("slopsquatting"), y con un vector de ataque
 * asociado — el atacante registra en el registro publico los nombres que los modelos
 * inventan con mas frecuencia y espera a que alguien instale.
 *
 * Lo grave es que NINGUNA de las otras vallas lo ve. El paquete se instala, el codigo
 * compila, los tipos pasan, los tests pasan, la cobertura sube y la mutacion mata todos
 * los mutantes de un modulo que importa una dependencia hostil. La revision mecanica
 * completa sale verde. Es un punto ciego, no una debilidad de grado.
 *
 * QUE COMPRUEBA, Y POR QUE OFFLINE
 * --------------------------------
 * Este guarda corre ANTES de instalar (como los otros dos de alcance), asi que no puede
 * depender de la red ni de node_modules. Lo que se puede comprobar sin red es
 * justamente lo que atrapa el caso:
 *
 *  1. Todo import de un archivo del diff resuelve a algo declarado: dependencia en el
 *     package.json, ruta relativa, builtin de node, o alias declarado en el config. Un
 *     paquete alucinado que alguien importo sin agregarlo NO resuelve, y aca se ve.
 *  2. Toda dependencia NUEVA del diff aparece en el lockfile. Agregada al package.json
 *     y ausente del lock significa que nadie la instalo nunca — el estado tipico de un
 *     nombre inventado que el agente escribio "porque deberia existir".
 *  3. Toda dependencia nueva se REPORTA aunque este bien. Agregar una dependencia es
 *     una decision de supply chain y merece que un humano la mire una vez.
 *
 * META-ASERCIONES (por que este guarda no puede aprobar por accidente)
 * -------------------------------------------------------------------
 *  - Sin package.json: falla. No se puede verificar procedencia sin manifiesto, y "no
 *    pude comprobar" nunca es "esta bien".
 *  - Sin alcance calculado: falla. Sin diff no se sabe que archivos mirar.
 *  - El diff toca fuente y no se parseo NINGUN import: avisa con el conteo. Un parser
 *    que no encuentra nada es indistinguible de un archivo sin imports, y esa
 *    ambiguedad no se resuelve sola en silencio.
 *  - Con `--registro`: si el registro no se puede consultar, FALLA. Pedir la
 *    comprobacion y aprobarla porque la red no respondio es el modo de falla exacto que
 *    esta herramienta persigue.
 *
 * USO
 *   node check-dependencias.mjs [--registro]   # --registro consulta el npm registry
 */

import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

import {
  aprobar,
  avisar,
  calza,
  cargarConfig,
  correr,
  fallar,
  leerSalida,
  parsearArgs,
  raizRepo,
} from './lib/comun.mjs';

const args = parsearArgs(process.argv.slice(2));
const raiz = raizRepo();
if (!raiz) fallar('No estoy dentro de un repositorio git.', ['Esta valla se acota al diff.']);

const { cfg, error: errCfg } = cargarConfig(raiz);
if (errCfg) fallar('Configuracion invalida', [errCfg]);

// --- Meta-asercion: sin alcance no hay que mirar --------------------------------

const alcance = leerSalida(raiz, 'alcance.json');
if (!alcance) {
  fallar('No hay alcance calculado', [
    'Falta .mechanical-review/out/alcance.json.\n' +
      '  Sin el diff no se sabe que archivos revisar, y revisar cero archivos no es\n' +
      '  aprobar: es no haber medido.\n' +
      '  Correr antes: node scripts/mechanical-review/check-alcance-diff.mjs',
  ]);
}

// --- Meta-asercion: sin manifiesto no se puede verificar procedencia -------------

const rutaPkg = join(raiz, 'package.json');
if (!existsSync(rutaPkg)) {
  fallar('No hay package.json', [
    'Sin manifiesto no hay contra que contrastar los imports, y un import que no se\n' +
      '  puede contrastar no esta verificado. Si este repo de verdad no tiene manifiesto,\n' +
      '  la fase no aplica y va excepcion escrita nombrando la valla.',
  ]);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(rutaPkg, 'utf8'));
} catch (e) {
  fallar('package.json no es JSON valido', [e.message]);
}

const declaradas = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
]);

const BUILTINS = new Set(builtinModules);

// --- Lockfiles: el que exista ----------------------------------------------------

const LOCKS = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];
const lockPresente = LOCKS.filter((l) => existsSync(join(raiz, l)));
const textoLock = lockPresente
  .map((l) => readFileSync(join(raiz, l), 'utf8'))
  .join('\n');

// --- Que import es "externo" ------------------------------------------------------

/**
 * Nombre del paquete de un especificador. `@scope/pkg/sub` -> `@scope/pkg`.
 * Devuelve null si no es un paquete externo (relativo, absoluto, builtin, protocolo).
 */
function paqueteDe(especificador) {
  if (especificador.charAt(0) === '.' || especificador.charAt(0) === '/') return null;
  if (especificador.indexOf(':') !== -1) {
    // node:fs, data:, http: — los `node:` son builtins, el resto no es un paquete npm
    const sinPrefijo = especificador.replace(/^node:/, '');
    return BUILTINS.has(sinPrefijo) ? null : null;
  }
  if (BUILTINS.has(especificador)) return null;
  const partes = especificador.split('/');
  if (especificador.charAt(0) === '@') return partes.slice(0, 2).join('/');
  return partes[0];
}

/**
 * Imports de un archivo. Regex y no AST a proposito: este guarda corre sin instalar
 * nada, asi que no hay parser disponible. El costo es que puede ver un import dentro de
 * un comentario o un string; el beneficio es que corre en cualquier repo, incluido uno
 * con las dependencias rotas — que es justamente cuando mas hace falta.
 */
function importsDe(texto) {
  const encontrados = [];
  const patrones = [
    /\bimport\s+(?:[\w*{}\n\r\t, ]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[\w*{}\n\r\t, ]+\s+)?from\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patrones) {
    let m = re.exec(texto);
    while (m !== null) {
      encontrados.push(m[1]);
      m = re.exec(texto);
    }
  }
  return encontrados;
}

// --- 1. Imports del diff que no resuelven a nada declarado -----------------------

const alias = Object.keys((cfg.dependencias && cfg.dependencias.alias) || {});
const ignorar = (cfg.dependencias && cfg.dependencias.ignorar) || [];

// El alcance lista TODOS los archivos con su `tipo`; `resumen.fuente` es solo un
// conteo. Leer el conteo como si fuera la lista dejaba el arreglo vacio, cero imports
// revisados y la fase en VERDE — el falso negativo exacto que esta valla no puede
// permitirse. Lo cazaron los casos de bloqueo de la suite.
const archivosFuente = (alcance.archivos || [])
  .filter((a) => a.tipo === 'fuente')
  .map((a) => a.ruta);
const huerfanos = [];
let importsVistos = 0;

for (const ruta of archivosFuente) {
  const abs = join(raiz, ruta);
  if (!existsSync(abs)) continue; // archivo borrado en el diff
  const texto = readFileSync(abs, 'utf8');
  for (const esp of importsDe(texto)) {
    const paquete = paqueteDe(esp);
    if (paquete === null) continue;
    importsVistos += 1;
    if (declaradas.has(paquete)) continue;
    if (alias.some((a) => paquete === a || paquete.indexOf(`${a}/`) === 0)) continue;
    if (calza(paquete, ignorar)) continue;
    huerfanos.push({ ruta, especificador: esp, paquete });
  }
}

if (huerfanos.length > 0) {
  fallar(
    `${huerfanos.length} import(s) a paquetes NO declarados`,
    huerfanos.slice(0, 25).map(
      (h) =>
        `${h.ruta}  ->  "${h.especificador}"  (paquete: ${h.paquete})\n` +
        `  Ese paquete no esta en package.json. Las tres lecturas, en orden:\n` +
        `   1. EL PAQUETE NO EXISTE. Es el caso que esta valla busca: un modelo lo\n` +
        `      invento porque "deberia existir". Comprobarlo antes de instalarlo —\n` +
        `      si alguien registro ese nombre, instalarlo es ejecutar su codigo.\n` +
        `   2. Falto agregarlo al manifiesto. Agregarlo con version fijada e instalar.\n` +
        `   3. Es un alias de rutas (tsconfig paths, imports de workspace). Declararlo\n` +
        `      en .mechanical-review/config.json bajo dependencias.alias para que el\n` +
        `      guarda lo reconozca; asi el alias queda escrito y no supuesto.`,
    ),
  );
}

// --- 2. Dependencias nuevas del diff ---------------------------------------------

/** Version del package.json en la base, para saber que dependencias son nuevas. */
function declaradasEnBase() {
  const r = correr('git', ['show', `${alcance.mergeBase}:package.json`], { cwd: raiz });
  if (r.codigo !== 0) return null;
  try {
    const base = JSON.parse(r.salida);
    return new Set([
      ...Object.keys(base.dependencies || {}),
      ...Object.keys(base.devDependencies || {}),
      ...Object.keys(base.peerDependencies || {}),
      ...Object.keys(base.optionalDependencies || {}),
    ]);
  } catch {
    return null;
  }
}

const enBase = declaradasEnBase();
const nuevas = enBase === null ? [] : [...declaradas].filter((d) => !enBase.has(d));

// Una dependencia declarada y ausente del lockfile no se instalo nunca: es el estado
// tipico de un nombre inventado que se agrego "porque el import lo pedia".
const sinLock = lockPresente.length === 0 ? [] : nuevas.filter((d) => textoLock.indexOf(d) === -1);

if (sinLock.length > 0) {
  fallar(
    `${sinLock.length} dependencia(s) nueva(s) ausentes del lockfile`,
    sinLock.map(
      (d) =>
        `"${d}" esta en package.json y NO aparece en ${lockPresente.join(' / ')}.\n` +
        `  Nadie la instalo. Si el nombre esta bien, correr la instalacion congelada y\n` +
        `  versionar el lock. Si no resuelve en el registro, el nombre es inventado:\n` +
        `  quitarlo y buscar el paquete real.`,
    ),
  );
}

// --- 3. El registro, solo si se pide explicitamente -------------------------------

if (args.registro && nuevas.length > 0) {
  const noResuelven = [];
  let consultadas = 0;
  for (const d of nuevas) {
    const r = correr('npm', ['view', d, 'name', '--json'], { cwd: raiz });
    if (r.falloAlLanzar) {
      fallar('Se pidio --registro y no se pudo consultar el registro', [
        'No se pudo ejecutar `npm view`. Un gate que aprueba porque la comprobacion\n' +
          '  que le pidieron no se pudo hacer es exactamente el modo de falla que esta\n' +
          '  herramienta existe para impedir.\n' +
          '  Arreglo: correr con npm disponible, o quitar --registro y verificar a mano.',
      ]);
    }
    consultadas += 1;
    if (r.codigo !== 0) noResuelven.push(d);
  }
  if (noResuelven.length > 0) {
    fallar(
      `${noResuelven.length} dependencia(s) nueva(s) NO existen en el registro`,
      noResuelven.map(
        (d) =>
          `"${d}" no resuelve en el registro publico.\n` +
          `  Es el caso central de esta valla: un nombre alucinado. NO instalarlo para\n` +
          `  "ver si funciona": si alguien lo registro despues de que el modelo lo\n` +
          `  invento, instalarlo ejecuta su codigo con tus permisos.`,
      ),
    );
  }
  avisar(`${consultadas} dependencia(s) nueva(s) verificadas contra el registro.`);
}

// --- Avisos ----------------------------------------------------------------------

if (nuevas.length > 0) {
  avisar(
    `${nuevas.length} dependencia(s) nueva(s) en este diff: ${nuevas.join(', ')}\n` +
      '      Agregar una dependencia es una decision de cadena de suministro. Mirarla una\n' +
      '      vez: quien la mantiene, hace cuanto existe, cuantas dependencias arrastra.',
  );
}

if (enBase === null) {
  avisar(
    'No se pudo leer el package.json de la base: no se comprobo que dependencias son\n' +
      '      nuevas. Los imports SI se verificaron.',
  );
}

// Meta-asercion: parseo que no encuentra nada es indistinguible de un archivo limpio.
if (archivosFuente.length > 0 && importsVistos === 0) {
  avisar(
    `Se revisaron ${archivosFuente.length} archivo(s) de fuente y no se encontro NINGUN\n` +
      '      import externo. Puede ser correcto, o puede ser que el parseo no calce con la\n' +
      '      sintaxis de este repo. Si es lo segundo, la valla no esta protegiendo nada.',
  );
}

aprobar(
  `Procedencia de dependencias OK — ${importsVistos} import(s) externo(s) contrastados ` +
    `contra ${declaradas.size} dependencia(s) declarada(s)` +
    (nuevas.length > 0 ? `, ${nuevas.length} nueva(s)` : '') +
    '.',
);
