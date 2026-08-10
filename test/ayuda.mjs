/**
 * Arnes de pruebas de los guardas. CERO DEPENDENCIAS, igual que los guardas.
 *
 * POR QUE SE PRUEBAN COMO PROCESOS Y NO IMPORTANDO FUNCIONES
 * ---------------------------------------------------------
 * El contrato de un guarda no es "devuelve un objeto": es **sale con codigo 1 cuando
 * tiene que bloquear**. Un test que importa una funcion interna y le mira el retorno
 * puede quedar en verde mientras el guarda real aprueba, porque el `process.exit` esta
 * en otra rama. Asi que cada test corre el guarda como el CI lo corre —proceso, cwd, y
 * codigo de salida— y afirma sobre eso.
 *
 * POR QUE CADA CASO ARMA UN REPO GIT DE VERDAD
 * -------------------------------------------
 * Los guardas resuelven la base con `git merge-base` y clasifican el diff con
 * `git diff`. Un doble de git probaria el doble, no el guarda. Los repos temporales
 * viven en el tmp del sistema y se borran solos.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS = join(AQUI, '..', 'scripts');

const creados = [];

/** Borra los repos temporales. Se engancha al final de la suite. */
export function limpiar() {
  for (const d of creados) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* en Windows un handle abierto puede impedirlo; no es motivo para fallar la suite */
    }
  }
  creados.length = 0;
}

function git(repo, ...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} fallo en ${repo}:\n${r.stderr}`);
  }
  return r.stdout;
}

/** Escribe un archivo creando los directorios que falten. */
export function escribir(repo, ruta, contenido) {
  const destino = join(repo, ruta);
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, contenido, 'utf8');
  return destino;
}

/**
 * Repo git nuevo con un commit inicial y una rama `origin/main` simulada.
 *
 * La rama base se crea como una ref local `refs/remotes/origin/main` porque los guardas
 * resuelven `origin/main` con `git rev-parse`, que no distingue si detras hay un remoto
 * de verdad. Asi el arnes no necesita red.
 */
export function repoTemporal() {
  const repo = mkdtempSync(join(tmpdir(), 'mr-test-'));
  creados.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  escribir(repo, 'README.md', '# base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

/** Commitea lo que haya en el working tree. */
export function commitear(repo, mensaje = 'cambio') {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', mensaje);
}

/** Config minima valida. `extra` se mezcla encima. */
export function config(repo, extra = {}) {
  const base = {
    base: 'origin/main',
    zonas: { critica: ['src/critico/**'] },
    fases: [{ id: 'tipos', bloquea: true }],
    ...extra,
  };
  escribir(repo, '.mechanical-review/config.json', `${JSON.stringify(base, null, 2)}\n`);
  return base;
}

/**
 * Corre un guarda como lo corre el CI. Devuelve {codigo, salida} con stdout y stderr
 * juntos: los guardas escriben el diagnostico en los dos y el test afirma sobre el texto.
 */
export function correrGuarda(repo, guarda, args = []) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, guarda), ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
  return {
    codigo: r.status === null ? 1 : r.status,
    salida: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

/**
 * Reporte de mutacion en el formato de StrykerJS.
 * `mutantes` es [{archivo, estado, linea}] y se agrupa por archivo.
 */
export function reporteMutacion(repo, mutantes, opciones = {}) {
  const files = {};
  for (const [i, m] of mutantes.entries()) {
    const ruta = m.archivo ?? 'src/critico/cobro.ts';
    if (files[ruta] === undefined) files[ruta] = { language: 'typescript', source: '', mutants: [] };
    files[ruta].mutants.push({
      id: String(i),
      mutatorName: m.mutador ?? 'BooleanLiteral',
      status: m.estado,
      location: { start: { line: m.linea ?? 1, column: 1 }, end: { line: m.linea ?? 1, column: 9 } },
    });
  }
  const ruta = escribir(
    repo,
    'reports/mutation/mutation.json',
    `${JSON.stringify({ schemaVersion: '1.0', files }, null, 2)}\n`,
  );
  // Un reporte tiene que ser POSTERIOR al alcance para que el guarda lo acepte; el
  // caso "reporte viejo" se fuerza a proposito pasando `antiguedadMin`.
  if (opciones.antiguedadMin) {
    const cuando = Date.now() / 1000 - opciones.antiguedadMin * 60;
    utimesSync(ruta, cuando, cuando);
  }
  return ruta;
}

/** Prepara alcance.json corriendo el guarda real de alcance (no un doble). */
export function calcularAlcance(repo) {
  return correrGuarda(repo, 'check-alcance-diff.mjs');
}
