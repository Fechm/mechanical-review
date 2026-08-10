#!/usr/bin/env node
/**
 * EL MECANISMO ANTI-`|| true`.
 *
 * POR QUE EXISTE
 * --------------
 * Un umbral sin criterio de excepcion se convierte en `|| true` a la primera
 * friccion. Ya paso en estos repos: `yarn audit --groups dependencies || true` en
 * un repo real neutraliza el gate de vulnerabilidades sin que nadie lo note en el
 * YAML, y las reglas en `warn` de un webapp real no rompen nada.
 *
 * La respuesta no es prohibir las excepciones: es hacer que la excepcion cueste
 * mas que arreglarlo, sea VISIBLE y CADUQUE. De ahi las tres reglas:
 *   1. Una excepcion vencida vuelve a hacer fallar el gate. No es una amnistia.
 *   2. Una excepcion no puede vencer mas alla de N dias (por defecto 30), asi que
 *      `vence: 2099-01-01` no compila. Sin este limite, el archivo de excepciones
 *      ES el `|| true`, solo mas prolijo.
 *   3. Hay un maximo de excepciones vivas. Si hace falta pasarlo, el umbral esta
 *      mal calibrado, no el codigo — y eso se discute, no se acumula.
 *
 * FORMATO (en .mechanical-review/excepciones.md)
 * ---------------------------------------
 *   ## EXC-003
 *   - valla: mutacion
 *   - ruta: src/modules/pagos/pagos/cobro.service.ts:1482-1495
 *   - motivo: mutante equivalente; el operador cambia un log de telemetria que no
 *     participa del predicado del candado.
 *   - vence: 2026-08-20
 *   - responsable: nombre.apellido
 *
 * USO
 *   node check-excepciones.mjs [--max-dias 30] [--max 10]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aprobar, avisar, cargarConfig, escribirSalida, fallar, parsearArgs, raizRepo } from './lib/comun.mjs';
import { parsearExcepciones } from './lib/excepciones.mjs';

const VALLAS_CONOCIDAS = [
  'especificacion',
  'tipos',
  'forma',
  'fronteras',
  'aserciones',
  'cobertura-diff',
  'mutacion',
  'secretos',
  'invariantes',
  'muerto',
  'lectura-adversarial',
];

const args = parsearArgs(process.argv.slice(2));
const raiz = raizRepo() ?? process.cwd();
const { cfg, error: errCfg } = cargarConfig(raiz);
if (errCfg) fallar('Configuracion invalida', [errCfg]);

const maxDias = Number(args['max-dias'] ?? cfg.umbrales.maxDiasExcepcion ?? 30);
const maxVivas = Number(args.max ?? cfg.umbrales.maxExcepciones ?? 10);
const ruta = join(raiz, '.mechanical-review/excepciones.md');

if (!existsSync(ruta)) {
  aprobar('No hay archivo de excepciones: cero excepciones vivas. Es el estado deseable.');
  escribirSalida(raiz, 'excepciones.json', { version: 1, vivas: [], total: 0 });
  process.exit(0);
}

const excepciones = parsearExcepciones(readFileSync(ruta, 'utf8'));
const hoy = new Date(new Date().toISOString().slice(0, 10));
const errores = [];
const vivas = [];

for (const e of excepciones) {
  const faltantes = ['valla', 'ruta', 'motivo', 'vence', 'responsable'].filter((c) => !e[c]);
  if (faltantes.length > 0) {
    errores.push(
      `${e.id}: falta(n) ${faltantes.join(', ')}.\n` +
        `  Una excepcion sin responsable y sin vencimiento es una regla apagada en\n` +
        `  silencio. El formato completo esta en la cabecera de este script.`,
    );
    continue;
  }
  if (!VALLAS_CONOCIDAS.includes(e.valla)) {
    errores.push(
      `${e.id}: valla "${e.valla}" desconocida. Validas: ${VALLAS_CONOCIDAS.join(', ')}.\n` +
        `  Se falla en vez de ignorar: una excepcion mal escrita hace creer al autor que\n` +
        `  esta exento cuando el gate sigue rojo, y el rato perdido se lo lleva otro.`,
    );
    continue;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.vence)) {
    errores.push(`${e.id}: "vence" debe ser AAAA-MM-DD, dice "${e.vence}".`);
    continue;
  }
  const vence = new Date(e.vence);
  const dias = Math.round((vence - hoy) / 86400000);
  if (dias < 0) {
    errores.push(
      `${e.id}: VENCIDA hace ${-dias} dia(s) (vencio ${e.vence}, responsable ${e.responsable}).\n` +
        `  El gate "${e.valla}" volvio a ser obligatorio sobre ${e.ruta}.\n` +
        `  Opciones: arreglarlo, o renovar la excepcion a mano explicando por que sigue\n` +
        `  siendo necesaria. Renovar es un acto que queda en el diff; caducar sola es lo\n` +
        `  que impide que el archivo se convierta en un basurero permanente.`,
    );
    continue;
  }
  if (dias > maxDias) {
    errores.push(
      `${e.id}: vence en ${dias} dias, el maximo es ${maxDias}.\n` +
        `  Una excepcion de vencimiento largo es un \`|| true\` con mejor letra.`,
    );
    continue;
  }
  if (e.motivo.length < 25) {
    errores.push(
      `${e.id}: el motivo tiene ${e.motivo.length} caracteres. Se exige una explicacion\n` +
        `  de verdad: quien lea el gate rojo en tres meses necesita entender la decision,\n` +
        `  no leer "no aplica".`,
    );
    continue;
  }
  vivas.push({ ...e, diasRestantes: dias });
}

escribirSalida(raiz, 'excepciones.json', { version: 1, total: excepciones.length, vivas });

if (errores.length > 0) fallar('Excepciones de la revision invalidas o vencidas', errores);

if (vivas.length > maxVivas) {
  fallar('Demasiadas excepciones vivas', [
    `${vivas.length} excepciones activas, el maximo es ${maxVivas}.\n` +
      `  Cuando hacen falta mas de ${maxVivas} excepciones, el umbral esta mal calibrado o el\n` +
      `  modulo necesita trabajo estructural. Las dos cosas se discuten; acumular\n` +
      `  excepciones no es ninguna de las dos.\n` +
      `  Por valla: ${Object.entries(
        vivas.reduce((a, e) => ({ ...a, [e.valla]: (a[e.valla] ?? 0) + 1 }), {}),
      )
        .map(([v, n]) => `${v}=${n}`)
        .join(' ')}`,
  ]);
}

for (const e of vivas.filter((v) => v.diasRestantes <= 7)) {
  avisar(`${e.id} (${e.valla}) vence en ${e.diasRestantes} dia(s) — ${e.responsable}`);
}

aprobar(
  vivas.length === 0
    ? 'Cero excepciones vivas.'
    : `${vivas.length} excepcion(es) viva(s), todas con motivo, responsable y vencimiento ≤ ${maxDias} dias.`,
);
