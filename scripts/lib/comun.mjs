#!/usr/bin/env node
/**
 * Biblioteca comun de la revision. CERO DEPENDENCIAS a proposito.
 *
 * POR QUE CERO DEPENDENCIAS
 * -------------------------
 * Estos guardas tienen que poder correr ANTES de instalar nada (es el orden que
 * ya usa el backend de referencia: check-dependency-pins y check-migration-registry
 * corren antes de `pnpm install`, porque un gate que depende de la instalacion
 * no puede diagnosticar una instalacion rota). Ademas tienen que correr igual en
 * GitHub Actions con pnpm 11, en Bitbucket Pipelines con yarn 1.22 y en
 * Bitbucket con yarn Berry 4.17. Lo unico que los tres tienen garantizado es
 * `node` y `git`.
 *
 * POR QUE ESPANOL EN LOS MENSAJES
 * -------------------------------
 * Un gate se lee cuando esta rojo y con prisa. El diagnostico tiene que estar en
 * el idioma en que se piensa el problema.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * 1.0.1 — `check-mutantes.mjs` dejo de contar `CompileError` como mutante sin cerrar en la
 * regla de "mas de la mitad sin veredicto". Lo cierra la fase `tipos`, que es bloqueante, y
 * un archivo de cableado tipado (composition root, barrel, ensamblador) produce mayoria de
 * `CompileError` por naturaleza: la version 1.0.0 ponia esos diffs en rojo con CERO
 * sobrevivientes. La regla ahora mira solo `RuntimeError` + `Ignored`, y verifica su premisa
 * (si `tipos` no bloquea, falla). Un repo cuyo `.mechanical-review/config.json` diga
 * `generadoPor: "revision mecanica 1.0.0"` tiene el guarda con el defecto: re-vendorizar.
 */
export const VERSION_HERRAMIENTA = '1.0.1';

// --- Ejecucion de procesos -----------------------------------------------------

/** Corre un comando sin shell y devuelve {codigo, salida, error}. */
export function correr(cmd, args, opciones = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opciones,
  });
  return {
    codigo: r.status === null ? 1 : r.status,
    salida: r.stdout ?? '',
    error: r.stderr ?? '',
    falloAlLanzar: r.error != null,
  };
}

/** Corre una linea de comando a traves del shell (para las fases del config). */
export function correrShell(linea, opciones = {}) {
  const r = spawnSync(linea, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: opciones.silencioso ? 'pipe' : 'inherit',
    cwd: opciones.cwd,
    env: { ...process.env, ...(opciones.env ?? {}) },
  });
  return {
    codigo: r.status === null ? 1 : r.status,
    salida: r.stdout ?? '',
    error: r.stderr ?? '',
  };
}

// --- Git ------------------------------------------------------------------------

export function raizRepo(cwd = process.cwd()) {
  const r = correr('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (r.codigo !== 0) return null;
  return r.salida.trim().replace(/\//g, sep);
}

/**
 * Resuelve la base de comparacion.
 *
 * POR QUE ESTO FALLA RUIDOSO Y NO EN SILENCIO
 * -------------------------------------------
 * `actions/checkout@v4` clona con fetch-depth: 1 y Bitbucket con depth 50. En
 * los dos casos `git merge-base origin/main HEAD` no tiene historia suficiente y
 * devuelve vacio. Si el guarda tratara eso como "no hay cambios", el gate
 * pasaria en verde POR FALTA DE DATOS, que es exactamente el modo de falla que
 * esta herramienta existe para impedir. Asi que se aborta con el arreglo escrito.
 */
export function resolverBase(base, cwd) {
  const existe = correr('git', ['rev-parse', '--verify', '--quiet', base], { cwd });
  if (existe.codigo !== 0) {
    return {
      error:
        `La referencia base "${base}" no existe en este clon.\n` +
        `  Causa habitual: el checkout es superficial. El diff no se puede calcular\n` +
        `  y un gate que no puede calcular el diff NO puede aprobar nada.\n` +
        `  Arreglo en GitHub Actions:  actions/checkout con  fetch-depth: 0\n` +
        `  Arreglo en Bitbucket:       agregar al inicio del pipeline:\n` +
        `                                clone:\n` +
        `                                  depth: full\n` +
        `  Arreglo local:              git fetch origin ${base.replace(/^origin\//, '')}\n` +
        `  Si la base correcta es otra rama, pasarla: --base <ref> (o cambiar "base" en\n` +
        `  .mechanical-review/config.json).`,
    };
  }
  const mb = correr('git', ['merge-base', base, 'HEAD'], { cwd });
  if (mb.codigo !== 0 || !mb.salida.trim()) {
    return {
      error:
        `No hay antecesor comun entre "${base}" y HEAD.\n` +
        `  Con un clon superficial esto es lo esperable. Ver fetch-depth / clone depth.`,
    };
  }
  return { base, mergeBase: mb.salida.trim() };
}

/**
 * Rangos de lineas AGREGADAS por el diff, por archivo.
 *
 * Se compara el arbol de trabajo contra el merge-base (no HEAD contra base): en
 * local eso incluye lo que todavia no esta commiteado, que es justo lo que el
 * desarrollador quiere verificar antes de hacer push. En CI el arbol de trabajo
 * es igual a HEAD, asi que el resultado es el mismo.
 *
 * Se usa --unified=0 porque con contexto los hunks incluyen lineas que no
 * cambiaron y el alcance de mutacion/cobertura quedaria inflado.
 */
export function rangosAgregados(mergeBase, cwd, { indexado = false } = {}) {
  const args = ['diff', '--unified=0', '--no-color', '--no-renames', '--diff-filter=ACMR'];
  if (indexado) args.push('--cached');
  args.push(mergeBase);
  const r = correr('git', args, { cwd });
  if (r.codigo !== 0) return { error: r.error.trim() || 'git diff fallo' };

  const porArchivo = new Map();
  let actual = null;
  for (const linea of r.salida.split(/\r?\n/)) {
    if (linea.startsWith('+++ ')) {
      const crudo = linea.slice(4).trim();
      actual = crudo === '/dev/null' ? null : desprefijar(crudo);
      if (actual && !porArchivo.has(actual)) porArchivo.set(actual, []);
      continue;
    }
    if (!actual || !linea.startsWith('@@')) continue;
    const m = linea.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const inicio = Number(m[1]);
    const cuantas = m[2] === undefined ? 1 : Number(m[2]);
    if (cuantas === 0) continue; // hunk de borrado puro: no agrega lineas
    porArchivo.get(actual).push([inicio, inicio + cuantas - 1]);
  }
  return { porArchivo };
}

function desprefijar(ruta) {
  let r = ruta;
  if (r.startsWith('"') && r.endsWith('"')) {
    try {
      r = JSON.parse(r);
    } catch {
      r = r.slice(1, -1);
    }
  }
  if (r.startsWith('b/') || r.startsWith('a/')) r = r.slice(2);
  return r.replace(/\\/g, '/');
}

// --- Globs (minimos, sin dependencias) -----------------------------------------

/**
 * Convierte un glob estilo `src/**\/*.ts` a RegExp.
 * Soporta `**`, `*`, `?` y `{a,b}`. Suficiente para clasificar rutas; no
 * pretende ser minimatch.
 */
export function globARegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` consume cero o mas segmentos; `**` suelto consume cualquier cosa
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const cierre = glob.indexOf('}', i);
      if (cierre === -1) re += '\\{';
      else {
        re += `(?:${glob
          .slice(i + 1, cierre)
          .split(',')
          .map((o) => o.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
          .join('|')})`;
        i = cierre;
      }
    } else if ('.+^$()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function calza(ruta, globs) {
  const r = ruta.replace(/\\/g, '/');
  return (globs ?? []).some((g) => globARegex(g).test(r));
}

// --- Config del repo ------------------------------------------------------------

export const RUTA_CONFIG = '.mechanical-review/config.json';

export function cargarConfig(raiz) {
  const ruta = join(raiz, RUTA_CONFIG);
  if (!existsSync(ruta)) {
    return {
      error:
        `Falta ${RUTA_CONFIG}.\n` +
        `  Sin config, la revision mecanica no sabe cuales rutas son zona critica, y un\n` +
        `  revision mecanica que no sabe que es critico aplica el nivel mas debil a todo.\n` +
        `  Arreglo: node scripts/mechanical-review/init.mjs --repo .`,
    };
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(ruta, 'utf8'));
  } catch (e) {
    return { error: `${RUTA_CONFIG} no es JSON valido: ${e.message}` };
  }
  if (!cfg.zonas || !Array.isArray(cfg.zonas.critica)) {
    return {
      error:
        `${RUTA_CONFIG} no declara zonas.critica (arreglo de globs).\n` +
        `  Si de verdad este repo no tiene zona critica, declararlo vacio A MANO y\n` +
        `  explicar por que en el mismo commit. No se llega ahi por omision.`,
    };
  }
  // POR QUE NO SE USA `??=` NI `replaceAll` EN NINGUN GUARDA
  // -------------------------------------------------------
  // Los dos exigen Node >= 15 y son SINTAXIS (el `??=`), asi que en un repo con Node 14
  // el script no llega a ejecutarse: falla al parsear. Y hay repos con Node 14.15
  // (medido en dos repos reales). La promesa de "solo node y git" solo se sostiene
  // escribiendo para el Node mas viejo del parque, no para el de esta maquina.
  if (cfg.patrones === undefined) cfg.patrones = {};
  if (cfg.patrones.fuente === undefined) {
    cfg.patrones.fuente = ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.js', 'src/**/*.mjs'];
  }
  if (cfg.patrones.test === undefined) {
    cfg.patrones.test = [
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/*.spec.tsx',
      '**/*.test.tsx',
      'test/**/*.ts',
      'tests/**/*.ts',
      '**/__test__/**/*.ts',
      '**/__tests__/**/*.ts',
    ];
  }
  if (cfg.patrones.ignorar === undefined) {
    cfg.patrones.ignorar = ['dist/**', 'coverage/**', 'node_modules/**', '**/*.snap'];
  }
  if (cfg.base === undefined) cfg.base = 'origin/main';
  if (cfg.umbrales === undefined) cfg.umbrales = {};
  return { cfg };
}

// --- Clasificacion de nivel -----------------------------------------------------

export const NIVELES = {
  0: 'periferico',
  1: 'negocio',
  2: 'critico',
};

/** Nivel de una ruta: 2 si esta en zona critica, 1 si es fuente, 0 si no. */
export function nivelDeRuta(ruta, cfg) {
  if (calza(ruta, cfg.zonas.critica)) return 2;
  if (calza(ruta, cfg.zonas.negocio ?? cfg.patrones.fuente)) return 1;
  return 0;
}

export function tipoDeRuta(ruta, cfg) {
  if (calza(ruta, cfg.patrones.test)) return 'test';
  if (calza(ruta, cfg.patrones.fuente)) return 'fuente';
  if (/\.(md|txt|adoc)$/i.test(ruta)) return 'doc';
  return 'otro';
}

/**
 * Vinetas de un bloque markdown, uniendo las lineas de continuacion.
 *
 * POR QUE: una invariante escrita en dos lineas (lo normal cuando el texto pasa los
 * 100 caracteres) tenia su `sosten:` en la segunda linea, y un analisis linea a
 * linea la reportaba como "sin sosten". Un gate que obliga a escribir todo en una
 * linea larga se pelea con prettier y pierde.
 */
export function vinetasDe(bloque) {
  const vinetas = [];
  for (const l of (bloque ?? '').split(/\r?\n/)) {
    if (/^\s*[-*]\s+/.test(l)) vinetas.push(l.trim());
    else if (vinetas.length > 0 && l.trim() !== '' && /^\s+\S/.test(l)) {
      vinetas[vinetas.length - 1] += ` ${l.trim()}`;
    } else if (l.trim() === '') {
      // una linea en blanco cierra la vineta en curso
      if (vinetas.length > 0) vinetas.push('');
    }
  }
  return vinetas.filter((v) => v !== '');
}

// --- Hash con normalizacion de fin de linea ------------------------------------

/**
 * sha256 del contenido con CRLF normalizado a LF.
 *
 * POR QUE NORMALIZAR: un guardarrail que falla por el sistema operativo de quien
 * lo corre se desactiva en una semana. En este entorno el falso positivo por CRLF
 * ya se documento en un `code:check` real.
 */
export function hashNormalizado(ruta) {
  const bruto = readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(bruto, 'utf8').digest('hex');
}

// --- Salida ---------------------------------------------------------------------

export function escribirSalida(raiz, nombre, datos) {
  const dir = join(raiz, '.mechanical-review', 'out');
  mkdirSync(dir, { recursive: true });
  const ruta = join(dir, nombre);
  writeFileSync(ruta, `${JSON.stringify(datos, null, 2)}\n`, 'utf8');
  return ruta;
}

export function leerSalida(raiz, nombre) {
  const ruta = join(raiz, '.mechanical-review', 'out', nombre);
  if (!existsSync(ruta)) return null;
  try {
    return JSON.parse(readFileSync(ruta, 'utf8'));
  } catch {
    return null;
  }
}

export function fallar(titulo, detalles = []) {
  console.error(`\n✖ ${titulo}\n`);
  detalles.forEach((d, i) => console.error(`${i + 1}. ${d}\n`));
  process.exit(1);
}

export function aprobar(mensaje) {
  console.log(`✔ ${mensaje}`);
}

export function avisar(mensaje) {
  console.log(`▲ ${mensaje}`);
}

// --- Argumentos -----------------------------------------------------------------

export function parsearArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [clave, valorInline] = a.slice(2).split('=');
      if (valorInline !== undefined) args[clave] = valorInline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[clave] = argv[++i];
      else args[clave] = true;
    } else args._.push(a);
  }
  return args;
}

export function rutaRelativa(raiz, absoluta) {
  const a = resolve(absoluta).replace(/\\/g, '/');
  const r = resolve(raiz).replace(/\\/g, '/');
  return a.startsWith(`${r}/`) ? a.slice(r.length + 1) : a;
}

export { dirname, join, existsSync, readFileSync };
