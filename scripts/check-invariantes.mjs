#!/usr/bin/env node
/**
 * FASE 9 — cada INVARIANTE declarada tiene soporte MECANICO, y ese soporte existe.
 *
 * POR QUE ESTA FASE NO ES PARTE DEL CONJUNTO ORIGINAL DE MARTIN Y AQUI SI
 * ---------------------------------------------------------------
 * La ventana de concurrencia que permitia cobrar dos veces en el modulo de cobro no
 * la ve un test unitario de un solo hilo, ni la ve la mutacion (los mutantes se
 * evaluan con la MISMA suite secuencial), ni la ve la complejidad ciclomatica. La
 * unica valla mecanica real contra el doble cobro es una restriccion en la base:
 * un indice unico parcial, o un lock. Eso no es codigo: es esquema.
 *
 * Y hay un precedente directo: el propio modulo cerro el circulo con un spec que
 * LEE el `CREATE UNIQUE INDEX` de las migraciones y lo compara contra el arreglo de
 * estados en candado, porque —en palabras de esa auditoria— un derivado puede
 * mentir si el arreglo del que se deriva miente. Esta fase generaliza ese patron.
 *
 * CUATRO CLASES DE SOSTEN ADMITIDAS
 * ---------------------------------
 *   sosten: constraint `nombre`        -> el identificador debe aparecer en el SQL versionado
 *   sosten: indice unico `nombre`      -> idem
 *   sosten: tipo `Identificador`       -> debe aparecer en el codigo fuente
 *   sosten: test `ruta/al/spec.ts`     -> el archivo debe existir
 *   sosten: produccion `nombre`        -> debe estar declarada en
 *                                         .mechanical-review/invariantes-produccion.md
 *
 * La cuarta clase existe porque hay invariantes que NO se pueden verificar en CI:
 * "nunca dos cargos exitosos para el mismo usuario y periodo" es un chequeo sobre
 * los datos, no un test. Obligar a declararla en un archivo aparte hace visible
 * cuantas invariantes del sistema viven fuera del pipeline — que es informacion que
 * normalmente nadie tiene.
 *
 * USO
 *   node check-invariantes.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { aprobar, avisar, cargarConfig, escribirSalida, fallar, raizRepo, vinetasDe } from './lib/comun.mjs';

const raiz = raizRepo() ?? process.cwd();
const { cfg, error: errCfg } = cargarConfig(raiz);
if (errCfg) fallar('Configuracion invalida', [errCfg]);

const dirEspec = cfg.especificacion?.directorio ?? 'especificacion';
const rutaRegistro = join(raiz, cfg.especificacion?.registro ?? `${dirEspec}/registro.json`);
if (!existsSync(rutaRegistro)) {
  fallar('No hay registro de especificaciones', [
    'Las invariantes se leen de las especificaciones aprobadas. Correr primero\n' +
      '  check-especificacion.mjs.',
  ]);
}

const registro = JSON.parse(readFileSync(rutaRegistro, 'utf8'));

// --- Corpus donde se busca cada tipo de sosten ----------------------------------

function juntar(dirs, extensiones) {
  let texto = '';
  const vistos = [];
  for (const d of dirs) {
    const abs = join(raiz, d);
    if (!existsSync(abs)) continue;
    const pila = [abs];
    while (pila.length) {
      const actual = pila.pop();
      if (statSync(actual).isDirectory()) {
        for (const e of readdirSync(actual)) {
          if (e === 'node_modules' || e === '.git') continue;
          pila.push(join(actual, e));
        }
      } else if (extensiones.some((x) => actual.toLowerCase().endsWith(x))) {
        texto += `\n${readFileSync(actual, 'utf8')}`;
        vistos.push(relative(raiz, actual).replace(/\\/g, '/'));
      }
    }
  }
  return { texto, vistos };
}

const dirsEsquema = cfg.esquema?.directorios ?? ['supabase/migrations', 'migrations', 'db/migrations'];
const esquema = juntar(dirsEsquema, ['.sql']);
const fuente = juntar(cfg.esquema?.fuente ?? ['src'], ['.ts', '.tsx', '.js', '.mjs']);

const rutaProd = join(raiz, '.mechanical-review/invariantes-produccion.md');
const textoProd = existsSync(rutaProd) ? readFileSync(rutaProd, 'utf8') : '';

// --- Extraccion de invariantes --------------------------------------------------

const invariantes = [];
for (const entrada of registro.especificaciones ?? []) {
  const abs = join(raiz, entrada.archivo);
  if (!existsSync(abs)) continue;
  const bloque = readFileSync(abs, 'utf8').split('## Invariantes')[1]?.split(/\n## /)[0] ?? '';
  for (const l of vinetasDe(bloque)) {
    const m = l.match(/sost[eé]n\s*:\s*(.+)$/i);
    invariantes.push({
      especificacion: entrada.archivo,
      texto: l.replace(/^\s*[-*]\s+/, '').split(/sost[eé]n\s*:/i)[0].trim(),
      sosten: m ? m[1].trim() : null,
    });
  }
}

if (invariantes.length === 0) {
  fallar('Ninguna especificacion declara invariantes', [
    'Cero invariantes declaradas en las especificaciones registradas.\n' +
      '  Un sistema que mueve dinero sin ninguna invariante escrita no es un sistema sin\n' +
      '  invariantes: es un sistema cuyas invariantes solo existen en la cabeza de\n' +
      '  alguien. Declararlas es lo que permite verificarlas.',
  ]);
}

// --- Verificacion del sosten ----------------------------------------------------

const errores = [];
const avisos = [];
const verificadas = [];

for (const inv of invariantes) {
  if (!inv.sosten) {
    errores.push(
      `${inv.especificacion}: la invariante "${inv.texto.slice(0, 70)}" no declara sosten.\n` +
        `  Una invariante sin soporte mecanico es un comentario con aspiraciones.`,
    );
    continue;
  }

  const idents = [...inv.sosten.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const clase = /constraint|indice|índice|unique|unico|único/i.test(inv.sosten)
    ? 'esquema'
    : /\btest\b|spec/i.test(inv.sosten)
      ? 'test'
      : /\btipo\b|type\b/i.test(inv.sosten)
        ? 'tipo'
        : /produccion|producción|monitor|observabilidad/i.test(inv.sosten)
          ? 'produccion'
          : 'desconocida';

  if (clase === 'desconocida') {
    errores.push(
      `${inv.especificacion}: sosten "${inv.sosten.slice(0, 70)}" no calza con ninguna clase\n` +
        `  conocida (constraint / indice unico / tipo / test / produccion). Se falla en vez\n` +
        `  de ignorar: un sosten que el gate no entiende es un sosten que no verifica nada.`,
    );
    continue;
  }
  if (idents.length === 0) {
    errores.push(
      `${inv.especificacion}: el sosten de clase "${clase}" no nombra ningun identificador\n` +
        `  entre \`comillas invertidas\`. Sin nombre no hay nada que buscar.`,
    );
    continue;
  }

  for (const id of idents) {
    let encontrado = false;
    let donde = '';
    if (clase === 'esquema') {
      encontrado = esquema.texto.includes(id);
      donde = `SQL versionado (${dirsEsquema.join(', ')} · ${esquema.vistos.length} archivo(s))`;
    } else if (clase === 'tipo') {
      encontrado = fuente.texto.includes(id);
      donde = 'codigo fuente';
    } else if (clase === 'test') {
      encontrado = existsSync(join(raiz, id));
      donde = 'ruta de archivo';
    } else if (clase === 'produccion') {
      encontrado = textoProd.includes(id);
      donde = '.mechanical-review/invariantes-produccion.md';
    }

    if (!encontrado) {
      errores.push(
        `${inv.especificacion}: la invariante "${inv.texto.slice(0, 60)}"\n` +
          `  declara sosten de clase ${clase} en \`${id}\` y NO se encontro en ${donde}.\n` +
          `  ${
            clase === 'esquema'
              ? 'Sin la restriccion en la base, la invariante depende de que todos los caminos\n' +
                '  de escritura se acuerden de comprobarla. La sesion de cobro demostro que ese\n' +
                '  es exactamente el lugar donde la oportunidad de olvidarse se toma.'
              : clase === 'produccion'
                ? 'Declararla ahi es lo que hace visible que esta invariante NO la verifica CI y\n' +
                  '  necesita un chequeo sobre los datos reales.'
                : 'Crear el soporte, o corregir el nombre en la especificacion.'
          }`,
      );
    } else {
      verificadas.push({ especificacion: inv.especificacion, clase, identificador: id });
      if (clase === 'produccion') {
        avisos.push(
          `${id}: invariante declarada como verificada EN PRODUCCION, no en CI.\n` +
            '      Confirmar que el chequeo existe y alerta de verdad; este gate solo verifica\n' +
            '      que esta declarada.',
        );
      }
    }
  }
}

escribirSalida(raiz, 'invariantes.json', {
  version: 1,
  total: invariantes.length,
  verificadas,
  errores: errores.length,
});

avisos.forEach((a) => avisar(a));
if (errores.length > 0) fallar('Invariantes sin soporte mecanico', errores);

const porClase = verificadas.reduce((a, v) => ({ ...a, [v.clase]: (a[v.clase] ?? 0) + 1 }), {});
aprobar(
  `Invariantes: ${invariantes.length} declarada(s), todas con soporte verificado ` +
    `(${Object.entries(porClase)
      .map(([c, n]) => `${c}=${n}`)
      .join(' ')}).`,
);
