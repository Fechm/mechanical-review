#!/usr/bin/env node
/**
 * FASE 4 — PISO DE ASERCIONES. La valla mas rentable de todo la revision mecanica.
 *
 * POR QUE EXISTE
 * --------------
 * Un agente auditor encontro en el modulo de cobro un test llamado
 * "revoca la tarjeta anterior ... y la da de baja en la pasarela" que no tenia NI UN
 * `expect` sobre esa llamada: pasaba en verde afirmando una cobertura que no
 * ejercitaba nada. Cobertura de linea completa, cero verificacion.
 *
 * Eso tiene respaldo academico exacto: Inozemtseva & Holmes (ICSE 2014) mostraron
 * que al controlar el numero de tests la correlacion entre cobertura y efectividad
 * es baja; Zhang & Mesbah (FSE 2015) mostraron que lo que SI correlaciona fuerte
 * es el numero y la cobertura de ASERCIONES. O sea: el eje correcto no es cuantas
 * lineas se ejecutaron, es cuantas cosas se observaron.
 *
 * QUE ATRAPA Y QUE NO — HAY QUE DECIRLO EN VOZ ALTA
 * -------------------------------------------------
 * Las reglas A y B (test sin aserciones, aserciones tautologicas, `expect` sin
 * matcher) son deterministas y bloquean.
 *
 * La regla C ("usa un doble de prueba y no lo afirma") es HEURISTICA. Es la que
 * habria marcado el test de la pasarela, porque ese test si tenia `expect`s — lo que
 * faltaba era el `expect` SOBRE LA LLAMADA. Ninguna regla de lint puede decidir
 * eso en general: `jest/expect-expect` no lo habria atrapado. La unica valla
 * mecanica para "tiene aserciones pero no sobre lo que dice el nombre del test" es
 * la MUTACION: se muta la llamada, el mutante sobrevive, y el reporte senala la
 * linea. La regla C es un cedazo barato que corre en milisegundos; la mutacion es
 * la valla. Por eso la C bloquea solo en zona critica.
 *
 * Sin dependencias: el escaner enmascara comentarios y literales de cadena antes
 * de buscar, para no contar un `expect(` que esta dentro de un string.
 *
 * USO
 *   node check-aserciones.mjs                 # solo los tests del diff (usa alcance.json)
 *   node check-aserciones.mjs --todos         # todo el repo (barrido inicial)
 *   node check-aserciones.mjs --nivel 2       # forzar nivel (por defecto sale del alcance)
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  aprobar,
  avisar,
  calza,
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

const PATRONES_ASERCION = cfg.umbrales.patronesAsercion ?? [
  'expect\\s*\\(',
  'expect\\s*\\.\\s*(assertions|hasAssertions)',
  '\\bassert\\s*[.(]',
  '\\.should\\b',
];
/**
 * A PARTIR DE QUE NIVEL LA REGLA C ("adorno") BLOQUEA. Por defecto: NUNCA.
 *
 * Antes el defecto era 2, o sea que encender la zona critica la volvia bloqueante. Se
 * midio sobre las 44 specs del backend de referencia (527 casos) con las dos
 * calibraciones posibles, y las dos fallan en dos digitos:
 *
 *   · exigiendo asercion sobre TODO doble de metodo  -> 78 avisos, la mayoria en
 *     pasarela.client.spec.ts (24), donde el doble es el SDK que alimenta la respuesta y
 *     lo que el test afirma es el resultado mapeado. Falsos positivos.
 *   · exonerando los dobles con comportamiento       -> 0 avisos, pero tambien deja de
 *     ver el caso real de la pasarela (comprobado con fixture: el doble tenia
 *     `mockResolvedValue`). Falsos negativos, y del unico caso que importa.
 *
 * No hay tercera calibracion evidente, asi que la decision honesta es la que la propia
 * doctrina de este skill exige: una regla heuristica que bloquea con esa tasa de error se
 * apaga a la primera friccion, y una regla apagada es peor que una informativa. Queda
 * como SENAL para la lectura adversarial, y la valla de verdad para este defecto es la
 * mutacion, que si lo detecta sin ambiguedad.
 *
 * Para encenderla en un repo concreto, deliberadamente y despues de triar los avisos:
 *   .mechanical-review/config.json -> umbrales.nivelMinimoAdorno = 2
 */
const NIVEL_ADORNO = cfg.umbrales.nivelMinimoAdorno ?? 99;

// --- Enmascarado: comentarios y contenido de cadenas -> espacios ----------------

/**
 * Devuelve { mascara, cadenas, regex } donde `mascara` tiene la misma longitud que
 * el fuente pero con el interior de comentarios, literales de cadena Y LITERALES DE
 * EXPRESION REGULAR reemplazado por espacios (los saltos de linea se preservan para
 * que los numeros de linea sigan siendo validos).
 *
 * POR QUE LOS REGEX IMPORTAN (bug real encontrado al probar este script contra 43
 * specs reales del backend de referencia): la linea
 *     value.replace(/'/g, '')
 * tiene una comilla simple DENTRO de un literal de expresion regular. Sin tratar el
 * regex como literal, el enmascarador la lee como apertura de cadena, consume hasta
 * la siguiente comilla y desde ahi todo el archivo queda corrido. El sintoma fue
 * exactamente el que esta herramienta persigue: dos specs reales, con 5 y 11 casos
 * cada uno, reportados como "archivo de test sin ningun caso" — un falso positivo
 * que habria hecho que alguien desactivara el gate en una semana.
 *
 * La distincion entre `/` de division y `/` de regex se hace por el token anterior,
 * que es la heuristica estandar; ademas se exige que el regex cierre en la MISMA
 * linea (los literales de regex no pueden abarcar varias), asi que una clasificacion
 * equivocada no puede comerse el resto del archivo.
 */
function enmascarar(src) {
  const m = src.split('');
  const cadenas = [];
  const regex = [];
  let i = 0;
  const n = src.length;
  const blanquear = (desde, hasta) => {
    for (let k = desde; k < hasta && k < n; k++) if (m[k] !== '\n') m[k] = ' ';
  };

  const PALABRAS_ANTES_DE_REGEX = /(return|typeof|instanceof|case|in|of|new|delete|void|throw|do|else|yield|await)$/;
  function esInicioDeRegex(pos) {
    let k = pos - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    if (k < 0) return true;
    const c = src[k];
    if ('(,=:[!&|?{};+-*%~^<>'.includes(c)) return true;
    const antes = src.slice(Math.max(0, k - 12), k + 1);
    return PALABRAS_ANTES_DE_REGEX.test(antes);
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const fin = src.indexOf('\n', i);
      blanquear(i, fin === -1 ? n : fin);
      i = fin === -1 ? n : fin;
      continue;
    }
    if (c === '/' && d === '*') {
      const fin = src.indexOf('*/', i + 2);
      blanquear(i, fin === -1 ? n : fin + 2);
      i = fin === -1 ? n : fin + 2;
      continue;
    }
    if (c === '/' && esInicioDeRegex(i)) {
      let j = i + 1;
      let enClase = false;
      let cerro = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') enClase = true;
        else if (src[j] === ']') enClase = false;
        else if (src[j] === '/' && !enClase) {
          cerro = true;
          break;
        }
        j++;
      }
      if (cerro) {
        regex.push({ ini: i, fin: j });
        blanquear(i + 1, j);
        i = j + 1;
        continue;
      }
      // no cerro en la linea: no era un regex, se sigue como caracter normal
    }
    if (c === '"' || c === "'" || c === '`') {
      const cierre = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === cierre) break;
        // interpolacion de template: se enmascara igual, no se analiza
        j++;
      }
      cadenas.push({ ini: i, fin: Math.min(j, n) });
      blanquear(i + 1, Math.min(j, n));
      i = Math.min(j, n) + 1;
      continue;
    }
    i++;
  }
  return { mascara: m.join(''), cadenas, regex };
}

function cerrarParen(mascara, aperturaIdx) {
  let profundidad = 0;
  for (let i = aperturaIdx; i < mascara.length; i++) {
    const c = mascara[i];
    if (c === '(' || c === '[' || c === '{') profundidad++;
    else if (c === ')' || c === ']' || c === '}') {
      profundidad--;
      if (profundidad === 0) return i;
    }
  }
  return -1;
}

function lineaDe(src, idx) {
  let l = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') l++;
  return l;
}

// --- Deteccion de casos de test -------------------------------------------------

const RE_DECL = /\b(it|test)\b/g;

function casosDeTest(src, mascara, cadenas, noCodigo) {
  const casos = [];
  RE_DECL.lastIndex = 0;
  let m;
  while ((m = RE_DECL.exec(mascara)) !== null) {
    const inicioId = m.index;
    // No es declaracion si viene precedido de `.` (p.ej. `foo.test`) o es parte
    // de un identificador mas largo.
    const antes = mascara.slice(Math.max(0, inicioId - 1), inicioId);
    if (antes === '.') continue;
    if (noCodigo.some((c) => inicioId > c.ini && inicioId < c.fin)) continue;

    // consumir modificadores: .only .skip .each(...) .concurrent .failing
    let i = inicioId + m[1].length;
    for (;;) {
      while (i < mascara.length && /\s/.test(mascara[i])) i++;
      if (mascara[i] === '.') {
        i++;
        while (i < mascara.length && /[\w$]/.test(mascara[i])) i++;
        continue;
      }
      break;
    }
    while (i < mascara.length && /\s/.test(mascara[i])) i++;
    if (mascara[i] !== '(') continue;

    // `it.each([...])('titulo', fn)` — el primer grupo puede ser el de each
    let apertura = i;
    let cierre = cerrarParen(mascara, apertura);
    if (cierre === -1) continue;
    let k = cierre + 1;
    while (k < mascara.length && /\s/.test(mascara[k])) k++;
    if (mascara[k] === '(') {
      apertura = k;
      cierre = cerrarParen(mascara, apertura);
      if (cierre === -1) continue;
    }

    // titulo: primer literal dentro de la llamada
    const spanTitulo = cadenas.find((c) => c.ini > apertura && c.fin < cierre);
    const titulo = spanTitulo ? src.slice(spanTitulo.ini + 1, spanTitulo.fin) : '(sin titulo)';

    // cuerpo: desde la primera coma de nivel 1 hasta el cierre
    let prof = 0;
    let comaCuerpo = -1;
    for (let p = apertura; p <= cierre; p++) {
      const c = mascara[p];
      if (c === '(' || c === '[' || c === '{') prof++;
      else if (c === ')' || c === ']' || c === '}') prof--;
      else if (c === ',' && prof === 1) {
        comaCuerpo = p;
        break;
      }
    }
    const iniCuerpo = comaCuerpo === -1 ? apertura : comaCuerpo + 1;

    // `it.todo('x')` y `it('x')` sin cuerpo no son casos que verifiquen nada, pero
    // tampoco son tests rotos: se reportan aparte.
    const sinCuerpo = comaCuerpo === -1;

    casos.push({
      titulo,
      linea: lineaDe(src, inicioId),
      ini: iniCuerpo,
      fin: cierre,
      sinCuerpo,
      pendiente: /\.\s*todo\b/.test(mascara.slice(inicioId, apertura)),
    });
    RE_DECL.lastIndex = cierre;
  }
  return casos;
}

// --- Analisis de un archivo de test ---------------------------------------------

const RE_MOCKS = [
  /(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:jest|vi)\s*\.\s*(?:fn|spyOn)\s*\(/g,
  /(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*mock\s*\.\s*(?:fn|method)\s*\(/g,
  /(?:const|let|var)\s+([\w$]+(?:Mock|Spy|Fake|Stub|Doble))\s*[:=]/g,
];

/**
 * LA REGLA C DETECTABA LA FORMA EQUIVOCADA. Medido, y es el hallazgo mas util de auditar
 * este guarda.
 *
 * Sobre las 44 specs del backend de referencia marcaba 25 casos, 23 en `payments/`. El
 * primero inspeccionado, `pagos/cobro.spec.ts:1208`, es un test con DIEZ aserciones
 * sobre el estado persistido: falso positivo. Y al probarla contra el caso que dice
 * perseguir —el objeto colaborador `const pasarela = { deleteInscription: jest.fn() }`
 * usado y nunca afirmado, que es la forma REAL del test de la pasarela— **no lo marcaba**,
 * porque sus patrones solo reconocen `const x = jest.fn(...)` o nombres terminados en
 * Mock/Spy/Fake/Stub. O sea: ruido en la forma que no importa, ciega en la que si.
 *
 * La distincion que de verdad importa no es como se declara el doble, es que papel juega:
 *
 *  · **Doble de METODO** (`const obj = { metodo: jest.fn() }`, `obj.metodo = jest.fn()`):
 *    es una COLABORACION. El sujeto le pide algo a un tercero. Si ninguna asercion lo
 *    menciona, esa colaboracion no esta verificada — pase lo que pase con el valor de
 *    retorno. Por eso aca NO vale la excusa de "es un stub, devuelve un valor": el test
 *    de la pasarela tambien devolvia un valor.
 *
 *  · **Doble de FUNCION SUELTA** (`const statusImpl = jest.fn().mockResolvedValue(x)`):
 *    normalmente ALIMENTA al sujeto, y su efecto se observa en el estado resultante, no
 *    en el doble. Si tiene comportamiento declarado, es una entrada: no se exige afirmarlo.
 *
 * Los objetos literales pasados EN LINEA como argumento (`revocar(tb, { save: jest.fn() })`)
 * no se rastrean: sin nombre, nadie penso en referenciarlos, y exigir aserciones sobre
 * ellos es la fabrica de falsos positivos.
 */
const RE_COMPORTAMIENTO =
  /\.\s*mock(?:Implementation|ImplementationOnce|ResolvedValue|ResolvedValueOnce|ReturnValue|ReturnValueOnce|RejectedValue|RejectedValueOnce)\b/;

/** ¿Este doble de funcion suelta trae comportamiento declarado (o sea, es una entrada)? */
function esStubDeEntrada(nombre, mascara) {
  const decl = new RegExp(
    `(?:const|let|var)\\s+${nombre}\\b[^=\\n]*=\\s*(?:jest|vi|mock)\\s*\\.\\s*(?:fn|spyOn|method)\\s*\\(([^)]*)`,
  ).exec(mascara);
  if (decl && decl[1].trim() !== '' && !/^['"`]/.test(decl[1].trim())) return true;
  const usos = new RegExp(`\\b${nombre}\\b`, 'g');
  let m;
  while ((m = usos.exec(mascara)) !== null) {
    if (RE_COMPORTAMIENTO.test(mascara.slice(m.index, m.index + 200))) return true;
  }
  return false;
}

/**
 * Dobles de metodo declarados en objetos CON NOMBRE. Devuelve los nombres de metodo, que
 * es lo que una asercion tiene que mencionar (`expect(pasarela.deleteInscription)`).
 */
function metodosDobles(mascara) {
  const salida = new Set();
  // a) const obj = { metodo: jest.fn(...) , ... }
  const reObj = /(?:const|let|var)\s+[\w$]+\s*(?::[^=]*)?=\s*\{/g;
  let m;
  while ((m = reObj.exec(mascara)) !== null) {
    const abre = mascara.indexOf('{', m.index);
    const cierra = cerrarParen(mascara, abre);
    if (cierra === -1) continue;
    const cuerpo = mascara.slice(abre, cierra);
    for (const p of cuerpo.matchAll(/([\w$]+)\s*:\s*(?:jest|vi)\s*\.\s*fn\s*\(/g)) salida.add(p[1]);
    reObj.lastIndex = abre + 1; // permite objetos anidados
  }
  // b) obj.metodo = jest.fn(...)
  for (const p of mascara.matchAll(/[\w$]+\s*\.\s*([\w$]+)\s*=\s*(?:jest|vi)\s*\.\s*fn\s*\(/g)) {
    salida.add(p[1]);
  }
  return salida;
}

const RE_TAUTOLOGIAS = [
  {
    re: /expect\s*\(\s*(true|false|null|undefined|-?\d+(?:\.\d+)?|'[^'\n]*'|"[^"\n]*")\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/g,
    que: 'literal comparado consigo mismo',
  },
  { re: /expect\s*\(\s*true\s*\)\s*\.\s*toBeTruthy\s*\(\s*\)/g, que: 'expect(true).toBeTruthy()' },
  { re: /expect\s*\(\s*false\s*\)\s*\.\s*toBeFalsy\s*\(\s*\)/g, que: 'expect(false).toBeFalsy()' },
  {
    re: /expect\s*\(\s*(?:true|false|null|-?\d+|'[^'\n]*'|"[^"\n]*")\s*\)\s*\.\s*toBeDefined\s*\(\s*\)/g,
    que: 'toBeDefined() sobre un literal',
  },
  { re: /\bassert\s*(?:\.\s*ok\s*)?\(\s*true\s*\)/g, que: 'assert(true)' },
  { re: /\bassert\s*\.\s*(?:equal|strictEqual|deepStrictEqual)\s*\(\s*(\S+)\s*,\s*\1\s*\)/g, que: 'assert.equal(x, x)' },
];

function analizar(rutaRel, src) {
  const { mascara, cadenas, regex } = enmascarar(src);
  const noCodigo = [...cadenas, ...regex];
  const casos = casosDeTest(src, mascara, cadenas, noCodigo);
  const hallazgos = [];

  if (casos.length === 0) {
    hallazgos.push({
      regla: 'sin-casos',
      grave: true,
      linea: 1,
      titulo: '(archivo)',
      mensaje:
        'el archivo parece un archivo de test y no declara NINGUN caso `it`/`test`.\n' +
        '      Un archivo de test sin casos es un archivo que el runner cuenta como verde.\n' +
        '      Si es un helper, sacarlo del patron de tests del config.',
    });
    return { casos: 0, hallazgos };
  }

  // Dobles del PREAMBULO (todo lo anterior al primer caso: ahi vive el beforeEach):
  // metodos de colaboradores con nombre + funciones sueltas que no son entradas.
  const preambulo = mascara.slice(0, casos[0].ini);
  const mocks = new Set(metodosDobles(preambulo));
  for (const re of RE_MOCKS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(preambulo)) !== null) {
      if (!esStubDeEntrada(m[1], mascara)) mocks.add(m[1]);
    }
  }

  const reAsercion = new RegExp(PATRONES_ASERCION.join('|'), 'g');

  for (const caso of casos) {
    if (caso.pendiente) continue; // it.todo declara deuda a proposito

    if (caso.sinCuerpo) {
      hallazgos.push({
        regla: 'sin-cuerpo',
        grave: true,
        linea: caso.linea,
        titulo: caso.titulo,
        mensaje: 'declara un caso sin funcion de cuerpo: no ejecuta nada y suma como verde.',
      });
      continue;
    }

    const cuerpoMask = mascara.slice(caso.ini, caso.fin);
    const cuerpoSrc = src.slice(caso.ini, caso.fin);

    reAsercion.lastIndex = 0;
    const aserciones = cuerpoMask.match(reAsercion) ?? [];

    if (aserciones.length === 0) {
      hallazgos.push({
        regla: 'sin-asercion',
        grave: true,
        linea: caso.linea,
        titulo: caso.titulo,
        mensaje:
          'no contiene NINGUNA asercion. Pasa siempre que no lance, afirmando una\n' +
          '      cobertura que no verifica nada. Es el caso exacto del test de la pasarela.',
      });
      continue;
    }

    // `expect(x)` sin matcher no afirma nada
    let idx = cuerpoMask.indexOf('expect');
    const sinMatcher = [];
    while (idx !== -1) {
      const ap = cuerpoMask.indexOf('(', idx);
      if (ap !== -1 && /^expect\s*$/.test(cuerpoMask.slice(idx, ap))) {
        const ci = cerrarParen(cuerpoMask, ap);
        if (ci !== -1) {
          let p = ci + 1;
          while (p < cuerpoMask.length && /\s/.test(cuerpoMask[p])) p++;
          if (cuerpoMask[p] !== '.') sinMatcher.push(lineaDe(src, caso.ini + idx));
        }
      }
      idx = cuerpoMask.indexOf('expect', idx + 6);
    }
    if (sinMatcher.length > 0) {
      hallazgos.push({
        regla: 'expect-sin-matcher',
        grave: true,
        linea: sinMatcher[0],
        titulo: caso.titulo,
        mensaje:
          `${sinMatcher.length} llamada(s) a expect(...) sin matcher encadenado.\n` +
          '      `expect(x);` no afirma nada: construye el objeto y lo descarta.',
      });
    }

    // tautologias — sobre el fuente real, saltando lo que esta dentro de literales
    const taut = [];
    for (const { re, que } of RE_TAUTOLOGIAS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(cuerpoSrc)) !== null) {
        const abs = caso.ini + m.index;
        if (noCodigo.some((c) => abs > c.ini && abs < c.fin)) continue;
        taut.push({ que, linea: lineaDe(src, abs) });
      }
    }
    if (taut.length > 0 && taut.length >= aserciones.length) {
      hallazgos.push({
        regla: 'tautologia',
        grave: true,
        linea: taut[0].linea,
        titulo: caso.titulo,
        mensaje:
          `todas sus aserciones son tautologicas (${taut.map((t) => t.que).join(', ')}).\n` +
          '      Una asercion que no puede fallar es decoracion con forma de verificacion.',
      });
    } else if (taut.length > 0) {
      hallazgos.push({
        regla: 'tautologia-parcial',
        grave: false,
        linea: taut[0].linea,
        titulo: caso.titulo,
        mensaje: `contiene ${taut.length} asercion(es) tautologica(s): ${taut.map((t) => t.que).join(', ')}.`,
      });
    }

    /**
     * regla C (heuristica): usa un doble de colaborador y no lo afirma.
     *
     * ALCANCE, que es lo que decide los falsos positivos:
     *  · Los dobles declarados DENTRO del caso cuentan como usados por su sola
     *    declaracion. En el caso de la pasarela el metodo se declara y no se vuelve a
     *    mencionar: lo llama el sujeto. Exigir una segunda aparicion textual haria a la
     *    regla ciega justo en el caso que persigue (comprobado con un fixture).
     *  · Los dobles del PREAMBULO (beforeEach) cuentan solo si el caso los menciona; si
     *    no, cada caso arrastraria todos los colaboradores del archivo.
     *  · Los objetos literales pasados en linea no se rastrean (ver metodosDobles).
     */
    const localesDelCaso = metodosDobles(cuerpoMask);
    const usados = [
      ...new Set([
        ...localesDelCaso,
        ...[...mocks].filter((mk) => new RegExp(`\\b${mk}\\b`).test(cuerpoMask)),
      ]),
    ];
    if (usados.length > 0) {
      // texto de las sentencias de asercion
      const sentencias = [];
      const reA2 = new RegExp(PATRONES_ASERCION.join('|'), 'g');
      let ma;
      while ((ma = reA2.exec(cuerpoMask)) !== null) {
        const finSent = cuerpoMask.indexOf(';', ma.index);
        sentencias.push(cuerpoMask.slice(ma.index, finSent === -1 ? ma.index + 400 : finSent));
      }
      const textoAserciones = sentencias.join('\n');

      /**
       * Un doble tambien esta observado cuando el test extrae sus llamadas a una
       * variable y afirma sobre ESA variable:
       *     const [patch, options] = appointmentUpdate.mock.calls[0];
       *     expect(patch.status).toBe(...);
       * Sin esta parte, la heuristica marcaba como "adorno" 50 casos reales de
       * el backend de referencia que si verifican — y un gate con ese ruido se apaga solo.
       */
      const alias = (mk) => {
        const salida = new Set([mk]);
        const re = /(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[\w$]+)\s*=\s*([^;\n]{0,300})/g;
        let ma2;
        while ((ma2 = re.exec(cuerpoMask)) !== null) {
          if (!new RegExp(`\\b${mk}\\b`).test(ma2[2])) continue;
          for (const id of ma2[1].matchAll(/[\w$]+/g)) salida.add(id[0]);
        }
        return [...salida];
      };
      const noAfirmados = usados.filter(
        (mk) => !alias(mk).some((nombre) => new RegExp(`\\b${nombre}\\b`).test(textoAserciones)),
      );
      if (noAfirmados.length > 0) {
        hallazgos.push({
          regla: 'adorno',
          grave: false, // se eleva a grave en zona critica, ver abajo
          linea: caso.linea,
          titulo: caso.titulo,
          mensaje:
            `usa ${noAfirmados.join(', ')} y ninguna asercion los menciona.\n` +
            '      Es la firma del test que dice verificar una colaboracion y no la observa\n' +
            '      (caso "revoca la tarjeta ... y la da de baja en la pasarela"). HEURISTICA:\n' +
            '      la valla real para esto es la mutacion.',
        });
      }
    }
  }

  return { casos: casos.length, hallazgos };
}

// --- Seleccion de archivos ------------------------------------------------------

/**
 * Directorios que nunca son fuente del repo. La lista fija existe para no bajar por
 * arboles enormes; `patrones.ignorar` del config se aplica ADEMAS, sobre cada ruta.
 *
 * POR QUE `.stryker-tmp` (defecto medido): sin excluirlo, `--todos` sobre el backend
 * del proyecto de referencia recorria tambien el sandbox de Stryker y reportaba 264 archivos y 3.162
 * casos donde hay 44 specs — cada hallazgo duplicado, con rutas que no existen en el
 * repo. Un gate que reporta el doble de hallazgos con rutas inventadas se desactiva en
 * una semana, y con razon.
 */
const DIRS_FUERA = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.stryker-tmp',
  '.next',
  '.turbo',
  'build',
  'out',
  '.mechanical-review',
]);

function recorrer(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (DIRS_FUERA.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) recorrer(p, acc);
    else acc.push(relative(raiz, p).replace(/\\/g, '/'));
  }
  return acc;
}

let objetivos = [];
let nivel = args.nivel !== undefined ? Number(args.nivel) : 0;

if (args.todos) {
  objetivos = recorrer(raiz).filter(
    (r) => calza(r, cfg.patrones.test) && !calza(r, cfg.patrones.ignorar),
  );
  nivel = args.nivel !== undefined ? Number(args.nivel) : 2;
} else {
  const alcance = leerSalida(raiz, 'alcance.json');
  if (!alcance) {
    fallar('No hay alcance calculado', [
      'Falta .mechanical-review/out/alcance.json.\n' +
        '  Correr primero: node scripts/mechanical-review/check-alcance-diff.mjs\n' +
        '  O usar --todos para barrer el repo completo.',
    ]);
  }
  objetivos = alcance.archivos.filter((a) => a.tipo === 'test').map((a) => a.ruta);
  if (args.nivel === undefined) nivel = alcance.nivel;
  // Los tests que cubren zona critica importan aunque el test mismo no este en la
  // zona: el nivel del run manda.
}

if (objetivos.length === 0) {
  escribirSalida(raiz, 'aserciones.json', { version: 1, archivos: 0, casos: 0, hallazgos: [] });
  /**
   * POR QUE `--todos` CON CERO ARCHIVOS ES UN ROJO Y NO UN VERDE
   * -----------------------------------------------------------
   * Defecto encontrado auditando este guarda: `--todos` sobre un repo entero sin
   * encontrar ni un archivo de test imprimia el visto bueno y salia 0. Pero `--todos`
   * es el barrido inicial, el que se corre para decidir si el repo es candidato: cero
   * archivos ahi significa una de dos cosas, y las dos son hallazgos —
   * `patrones.test` no calza con la convencion del repo (hay repos que usan `__test__/*.test.ts`
   * en varios), o el repo no tiene tests. Aprobar por no haber encontrado nada que
   * revisar es literalmente el defecto que esta herramienta existe para eliminar; el
   * mismo que ya se corrigio en el guarda de pines de dependencias del backend de referencia.
   *
   * En el modo diff (sin --todos) es distinto y SI se aprueba: que un diff no toque
   * tests es legitimo (un refactor puro), y quien decide ahi es la cobertura del diff
   * y la mutacion, no este gate.
   */
  if (args.todos) {
    fallar('El barrido no encontro NINGUN archivo de test en el repo', [
      `Patrones usados (config → patrones.test): ${(cfg.patrones.test ?? []).join(', ')}\n` +
        `  Un barrido que no encontro nada que revisar no es un barrido en verde: es un\n` +
        `  patron que no calza o un repo sin tests, y las dos cosas hay que verlas.\n` +
        `  Que hacer:\n` +
        `   1. Confirmar la convencion real del repo (hay repos que usan __test__/*.test.ts en\n` +
        `      varios; Next usa *.test.tsx) y ajustar patrones.test en\n` +
        `      .mechanical-review/config.json.\n` +
        `   2. Si el repo de verdad no tiene tests, eso es el hallazgo, y ninguna otra\n` +
        `      valla de la revision significa nada hasta que existan.`,
    ]);
  }
  aprobar(
    'Ningun archivo de test en el alcance del diff: piso de aserciones no aplica.\n' +
      '  (Si el diff cambio comportamiento y no toco tests, eso lo decide la cobertura\n' +
      '  del diff y la mutacion, no este gate.)',
  );
  process.exit(0);
}

// --- Ejecucion ------------------------------------------------------------------

const todos = [];
let totalCasos = 0;
for (const rel of objetivos) {
  let src;
  try {
    src = readFileSync(join(raiz, rel), 'utf8');
  } catch {
    continue; // borrado en el diff
  }
  const { casos, hallazgos } = analizar(rel, src);
  totalCasos += casos;
  for (const h of hallazgos) {
    if (h.regla === 'adorno' && nivel >= NIVEL_ADORNO) h.grave = true;
    todos.push({ archivo: rel, ...h });
  }
}

escribirSalida(raiz, 'aserciones.json', {
  version: 1,
  nivel,
  archivos: objetivos.length,
  casos: totalCasos,
  hallazgos: todos,
});

const graves = todos.filter((h) => h.grave);
const leves = todos.filter((h) => !h.grave);

for (const h of leves) {
  avisar(`${h.archivo}:${h.linea}  "${h.titulo}"\n      ${h.mensaje}`);
}

if (graves.length > 0) {
  fallar(
    `Piso de aserciones FALLIDO — ${graves.length} caso(s) que no verifican`,
    graves.map(
      (h) => `[${h.regla}] ${h.archivo}:${h.linea}\n    "${h.titulo}"\n      ${h.mensaje}`,
    ),
  );
}

aprobar(
  `Piso de aserciones: ${totalCasos} caso(s) en ${objetivos.length} archivo(s), ` +
    `0 sin asercion, 0 tautologicos${leves.length ? `, ${leves.length} aviso(s)` : ''} (nivel ${nivel}).`,
);
