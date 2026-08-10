#!/usr/bin/env node
/**
 * FASE 1 — la especificacion humana existe, esta aprobada y NO cambio durante la
 * implementacion.
 *
 * POR QUE ESTA ES LA VALLA MAS IMPORTANTE DE TODAS
 * -----------------------------------------------------
 * El resumen que circulo por LinkedIn/X presenta la especificacion humana como
 * "paso 1" de un pipeline que despues corre solo. En la fuente primaria no es
 * eso: Martin dice que revisa las especificaciones derivadas, el Gherkin y los
 * procedimientos de QA. La lectura humana no se elimina, se MUEVE a la capa de
 * intencion. Ese lazo es el tapon del unico agujero que ninguna valla mecanica
 * puede tapar: si la especificacion esta equivocada, el agente la implementa, la
 * cubre al 100%, mata todos los mutantes y el pipeline queda verde.
 *
 * El paper de mutacion de Google lo dice literalmente: la mutacion sirve para
 * evaluar si un algoritmo esta implementado correctamente, no si es el algoritmo
 * correcto.
 *
 * Y hay una segunda razon, estructural: la CIRCULARIDAD. Mientras el mismo
 * agente escriba el codigo y los tests, un malentendido de requisitos se propaga
 * identico a los dos y la revision mecanica queda verde sobre la intencion equivocada.
 * La unica mitigacion conocida es separar autoria: la especificacion la aprueba
 * un humano y queda de SOLO LECTURA para quien implementa. Este script es lo que
 * convierte ese acuerdo en una valla: si el contenido de la especificacion cambio
 * y nadie la re-aprobo a mano, falla.
 *
 * El mecanismo es un espejo de hashes, igual que check-migration-registry.mjs de
 * el backend de referencia: un registro versionado con el sha256 de cada especificacion.
 * En CI nunca se pasa --aprobar. Re-aprobar es un acto humano que queda en el diff.
 *
 * USO
 *   node check-especificacion.mjs                 # verifica (esto corre en CI)
 *   node check-especificacion.mjs --aprobar       # re-registra hashes (acto humano)
 *   node check-especificacion.mjs --aprobar --por "nombre.apellido"
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  aprobar,
  calza,
  cargarConfig,
  fallar,
  hashNormalizado,
  parsearArgs,
  raizRepo,
  leerSalida,
  vinetasDe,
} from './lib/comun.mjs';

const SECCIONES_OBLIGATORIAS = [
  { titulo: '## Regla de negocio', por: 'la intencion en lenguaje natural, escrita por un humano' },
  { titulo: '## Desenlaces', por: 'la tabla de la que se derivan los tests; sin ella no hay como enumerar los casos' },
  { titulo: '## Invariantes', por: 'lo que debe ser verdad siempre, con su soporte mecanico declarado' },
  { titulo: '## Escenarios', por: 'Dado/Cuando/Entonces por desenlace, en lenguaje natural' },
];

const args = parsearArgs(process.argv.slice(2));
const raiz = raizRepo() ?? process.cwd();
const { cfg, error: errCfg } = cargarConfig(raiz);
if (errCfg) fallar('Configuracion invalida', [errCfg]);

const dirEspec = cfg.especificacion?.directorio ?? 'especificacion';
const rutaRegistro = join(raiz, cfg.especificacion?.registro ?? `${dirEspec}/registro.json`);

// --- Carga del registro ---------------------------------------------------------

if (!existsSync(rutaRegistro)) {
  if (args.aprobar) {
    mkdirSync(dirname(rutaRegistro), { recursive: true });
    writeFileSync(rutaRegistro, `${JSON.stringify({ version: 1, especificaciones: [] }, null, 2)}\n`, 'utf8');
  } else {
    fallar('No existe el registro de especificaciones', [
      `Se esperaba ${rutaRegistro}.\n` +
        `  Sin registro no hay forma mecanica de saber si la especificacion cambio\n` +
        `  mientras se implementaba, que es exactamente la circularidad que este gate\n` +
        `  existe para impedir.\n` +
        `  Arreglo: escribir la especificacion (ver plantilla del skill) y correr\n` +
        `  node scripts/mechanical-review/check-especificacion.mjs --aprobar --por "<quien>"`,
    ]);
  }
}

let registro;
try {
  registro = JSON.parse(readFileSync(rutaRegistro, 'utf8'));
} catch (e) {
  fallar('El registro de especificaciones no es JSON valido', [`${rutaRegistro}: ${e.message}`]);
}
// `??=` es sintaxis de Node >= 15 y estos guardas tienen que parsear en Node 14.
if (registro.especificaciones === undefined) registro.especificaciones = [];

// --- Validacion estructural de cada especificacion ------------------------------

/**
 * POR QUE SE VALIDA LA ESTRUCTURA Y NO SOLO LA EXISTENCIA
 * Una especificacion que es solo prosa no es insumo de nada: nadie puede derivar
 * de ella la lista de casos, y el agente la va a interpretar libremente. La tabla
 * de desenlaces es la pieza que hace que agregar un caso no compile hasta que
 * alguien escriba como producirlo — es la tecnica que ya funciono en el modulo de
 * cobro del proyecto de referencia (ESCENARIOS como Record<Desenlace, Escenario[]>).
 */
function validarEstructura(rutaAbs) {
  const problemas = [];
  const texto = readFileSync(rutaAbs, 'utf8');

  for (const s of SECCIONES_OBLIGATORIAS) {
    if (!texto.includes(s.titulo)) {
      problemas.push(`falta la seccion "${s.titulo}" (${s.por})`);
    }
  }

  // La tabla de desenlaces tiene que tener al menos una fila de datos.
  const bloque = texto.split('## Desenlaces')[1]?.split(/\n## /)[0] ?? '';
  const filas = bloque
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|') && !/^\s*\|[\s|:-]+\|\s*$/.test(l));
  // la primera fila con pipes es el encabezado
  if (filas.length < 2) {
    problemas.push(
      'la tabla de "## Desenlaces" no tiene ninguna fila de datos: sin desenlaces ' +
        'declarados no hay como enumerar los casos ni como saber cual quedo sin prueba',
    );
  }

  // Cada invariante declarada tiene que decir COMO se sostiene mecanicamente.
  const invBloque = texto.split('## Invariantes')[1]?.split(/\n## /)[0] ?? '';
  const invLineas = vinetasDe(invBloque);
  if (invLineas.length === 0) {
    problemas.push('no declara ninguna invariante en "## Invariantes"');
  } else {
    const sinSosten = invLineas.filter((l) => !/sost[eé]n\s*:/i.test(l));
    if (sinSosten.length > 0) {
      problemas.push(
        `${sinSosten.length} invariante(s) sin "sosten:" — cada invariante debe declarar\n` +
          `      que la sostiene (tipo, constraint de BD, test, o invariante monitoreada en\n` +
          `      produccion). Una invariante sin soporte mecanico es un comentario.\n` +
          `      Primera: ${sinSosten[0].slice(0, 90)}`,
      );
    }
  }

  return problemas;
}

// --- Verificacion / aprobacion --------------------------------------------------

const errores = [];
const avisos = [];
const alcance = leerSalida(raiz, 'alcance.json');

for (const entrada of registro.especificaciones) {
  const rutaAbs = join(raiz, entrada.archivo);
  if (!existsSync(rutaAbs)) {
    errores.push(
      `El registro declara "${entrada.archivo}" y el archivo no existe.\n` +
        `  Una especificacion registrada que desaparecio deja su zona sin intencion\n` +
        `  aprobada. Recuperarla del historial o quitar la entrada a mano.`,
    );
    continue;
  }

  const problemas = validarEstructura(rutaAbs);
  if (problemas.length > 0) {
    errores.push(
      `"${entrada.archivo}" no cumple el formato de especificacion:\n` +
        problemas.map((p) => `    - ${p}`).join('\n'),
    );
    continue;
  }

  const hash = hashNormalizado(rutaAbs);
  if (args.aprobar) {
    if (entrada.sha256 !== hash) {
      entrada.sha256 = hash;
      entrada.aprobadaPor = args.por ?? entrada.aprobadaPor ?? process.env.USERNAME ?? 'desconocido';
      entrada.fecha = new Date().toISOString().slice(0, 10);
      avisos.push(`re-aprobada: ${entrada.archivo} (${entrada.aprobadaPor})`);
    }
  } else if (entrada.sha256 !== hash) {
    errores.push(
      `"${entrada.archivo}" cambio despues de ser aprobada.\n` +
        `    registrado: ${String(entrada.sha256).slice(0, 16)}…\n` +
        `    en disco:   ${hash.slice(0, 16)}…\n` +
        `  La especificacion es de SOLO LECTURA mientras se implementa. Si cambio\n` +
        `  durante la implementacion, la intencion se movio para calzar con el codigo\n` +
        `  — es la circularidad autor/verificador, y con la revision mecanica verde.\n` +
        `  Arreglo correcto: leerla, decidir a mano si el cambio de intencion es el que\n` +
        `  se queria, y re-aprobar con\n` +
        `      node scripts/mechanical-review/check-especificacion.mjs --aprobar --por "<quien>"\n` +
        `  El diff del registro deja constancia de quien lo hizo.`,
    );
  }

  if (!entrada.aprobadaPor) {
    errores.push(`"${entrada.archivo}" no declara aprobadaPor. Una especificacion sin humano detras no es una especificacion aprobada.`);
  }
}

// --- Toda zona critica necesita al menos una especificacion que la cubra --------

const cubiertas = registro.especificaciones.flatMap((e) => e.cubre ?? []);
for (const zona of cfg.zonas.critica) {
  const tieneEspec = registro.especificaciones.some((e) => (e.cubre ?? []).includes(zona));
  if (!tieneEspec) {
    errores.push(
      `La zona critica "${zona}" no tiene ninguna especificacion registrada que la cubra.\n` +
        `  Es el agujero mas caro de la revision: sin intencion aprobada, todo lo demas\n` +
        `  verifica con eficiencia una intencion que nadie leyo.\n` +
        `  Arreglo: crear ${dirEspec}/<slug>.md con "cubre": ["${zona}"] y aprobarla.`,
    );
  }
}

// --- Si el diff toca zona critica, la especificacion de esa zona debe existir ---

if (alcance && alcance.nivel === 2) {
  for (const ruta of alcance.zonasTocadas ?? []) {
    const cubre = registro.especificaciones.some((e) => calza(ruta, e.cubre ?? []));
    if (!cubre) {
      errores.push(
        `El diff toca "${ruta}" (zona critica) y ninguna especificacion registrada la cubre.`,
      );
    }
  }
}

// --- Resultado ------------------------------------------------------------------

if (errores.length > 0) {
  // Igual que --sync de check-migration-registry: si algo falla, NO se escribe
  // nada. Un espejo a medias es peor que uno viejo.
  fallar('Revision de especificaciones FALLIDA', errores);
}

if (args.aprobar) {
  writeFileSync(rutaRegistro, `${JSON.stringify(registro, null, 2)}\n`, 'utf8');
  avisos.forEach((a) => console.log(`  · ${a}`));
  aprobar(
    `Registro de especificaciones actualizado (${registro.especificaciones.length} entrada(s)).\n` +
      '  Versionar el registro en el mismo commit: el diff es la constancia de la aprobacion.',
  );
} else {
  if (registro.especificaciones.length === 0) {
    fallar('El registro de especificaciones esta VACIO', [
      'Cero especificaciones registradas.\n' +
        '  Este es el modo de falla del guarda de pines de dependencias que ya se\n' +
        '  corrigio en el backend de referencia: un chequeo que aprueba porque no encontro nada\n' +
        '  que revisar no es un chequeo. Si este repo de verdad no necesita\n' +
        '  especificacion aprobada, declarar zonas.critica = [] a mano y explicar por que.',
    ]);
  }
  aprobar(
    `Especificaciones aprobadas e intactas: ${registro.especificaciones.length} ` +
      `(cubren ${new Set(cubiertas).size} zona(s)).`,
  );
}
