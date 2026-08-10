/**
 * Lectura de .mechanical-review/excepciones.md — compartida por el validador de
 * excepciones y por los gates que las consultan (mutacion, cobertura, secretos).
 *
 * Vive aparte para que importarla no ejecute el validador: un modulo que corre
 * process.exit() al ser importado es una trampa para el siguiente que lo reutilice.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parsearExcepciones(texto) {
  // Se quitan los bloques de codigo cercados ANTES de parsear: la cabecera del
  // archivo documenta el formato con un ejemplo `## EXC-001`, y sin esto el propio
  // ejemplo se leia como una excepcion real (con "vence: AAAA-MM-DD") y el gate
  // fallaba en un repo recien inicializado. Un gate que falla al instalarse se
  // desinstala.
  const sinEjemplos = texto.replace(/^```[\s\S]*?^```/gm, '');
  const bloques = sinEjemplos.split(/^##\s+/m).slice(1);
  return bloques.map((b) => {
    const lineas = b.split(/\r?\n/);
    const id = lineas[0].trim();
    const campos = {};
    let claveActual = null;
    for (const l of lineas.slice(1)) {
      const m = l.match(/^\s*[-*]\s*([\wáéíóúñ-]+)\s*:\s*(.*)$/i);
      if (m) {
        claveActual = m[1].toLowerCase();
        campos[claveActual] = m[2].trim();
      } else if (claveActual && /^\s{2,}\S/.test(l)) {
        campos[claveActual] += ` ${l.trim()}`;
      }
    }
    return { id, ...campos };
  });
}

export function cargarExcepciones(raiz) {
  const ruta = join(raiz, '.mechanical-review/excepciones.md');
  if (!existsSync(ruta)) return [];
  return parsearExcepciones(readFileSync(ruta, 'utf8'));
}

/**
 * ¿Hay una excepcion viva que cubra esta valla, este archivo y esta linea?
 * El campo `ruta` admite `archivo` o `archivo:ini-fin`.
 */
export function cubiertoPorExcepcion(excepciones, valla, archivo, linea) {
  const hoy = new Date(new Date().toISOString().slice(0, 10));
  return excepciones.find((e) => {
    if (e.valla !== valla) return false;
    if (!e.vence || new Date(e.vence) < hoy) return false; // vencida: no cubre nada
    const [arch, rango] = String(e.ruta).split(':');
    const a = arch.replace(/\\/g, '/');
    const objetivo = String(archivo).replace(/\\/g, '/');
    if (!(objetivo === a || objetivo.endsWith(`/${a}`) || a.endsWith(`/${objetivo}`))) return false;
    if (!rango || linea == null) return true;
    const [ini, fin] = rango.split('-').map(Number);
    return linea >= ini && linea <= (Number.isFinite(fin) ? fin : ini);
  });
}
