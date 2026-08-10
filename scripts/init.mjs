#!/usr/bin/env node
/**
 * INIT — instala la revision mecanica EN UN REPO, generando guardas locales.
 *
 * POR QUE VENDORIZA LOS SCRIPTS EN VEZ DE INVOCARLOS DESDE EL SKILL
 * ----------------------------------------------------------------
 * Un gate que solo existe en la maquina de quien tiene el skill instalado no es un
 * gate del repo: no corre en CI, nadie mas lo puede reproducir y desaparece el dia
 * que el skill cambia. Bitbucket Pipelines ademas no tiene workflows reutilizables,
 * asi que la unica forma de que 27 repos compartan la revision mecanica es que cada uno
 * tenga su copia versionada y el YAML solo la invoque.
 *
 * El costo de vendorizar es la deriva entre copias. Se paga con VERSION_HERRAMIENTA:
 * doctor.mjs imprime la version de la copia del repo y se compara con la del skill.
 *
 * QUE NO HACE ESTE SCRIPT
 * ----------------------
 * NO toca package.json, NO toca lockfiles, NO instala dependencias y NO edita el
 * YAML de CI. Imprime lo que hay que pegar. Esa frontera es deliberada: esos cuatro
 * archivos son los que rompen un repo ajeno, y quien los cambia tiene que verlo en
 * su propio diff.
 *
 * USO
 *   node init.mjs --repo <ruta-al-repo>            # escribe .mechanical-review/ y vendoriza
 *   node init.mjs --repo . --seco                   # solo muestra que haria
 *   node init.mjs --repo . --perfil pnpm-actions|yarn-bitbucket   # fuerza el perfil de fases
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsearArgs, VERSION_HERRAMIENTA } from './lib/comun.mjs';

/**
 * Quita el BOM sin escribir el caracter U+FEFF en el fuente.
 *
 * POR QUE ASI Y NO un regex con el caracter literal: escrito como caracter literal dentro del regex, ESLint lo
 * marca con no-irregular-whitespace (comprobado: 1 error por archivo en el backend de referencia), y
 * cualquier herramienta que normalice el fuente puede borrarlo en silencio, dejando el strip
 * de BOM sin efecto y el guarda cayendose con "Unexpected token" en un package.json con BOM.
 * Comparar el code point es equivalente y no depende de que el caracter sobreviva al viaje.
 */
const sinBom = (texto) => (texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto);

const AQUI = dirname(fileURLToPath(import.meta.url));
const SKILL = dirname(AQUI);
const args = parsearArgs(process.argv.slice(2));
const repo = args.repo ? String(args.repo) : process.cwd();
const seco = args.seco === true;

if (!existsSync(join(repo, 'package.json'))) {
  console.error(`No hay package.json en ${repo}. --repo debe apuntar a la raiz de un repo Node.`);
  process.exit(1);
}

const pkg = JSON.parse(sinBom(readFileSync(join(repo, 'package.json'), 'utf8')));
const dep = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

// --- Deteccion del stack --------------------------------------------------------

const sinLockfile =
  !existsSync(join(repo, 'pnpm-lock.yaml')) &&
  !existsSync(join(repo, 'yarn.lock')) &&
  !existsSync(join(repo, 'package-lock.json'));
if (sinLockfile) {
  console.error(
    '▲ No hay lockfile en este repo: el gestor se asume npm y los comandos generados\n' +
      '  pueden no ser los correctos. Revisar el bloque "fases" del config al terminar.',
  );
}

const gestor = existsSync(join(repo, 'pnpm-lock.yaml'))
  ? 'pnpm'
  : existsSync(join(repo, 'yarn.lock'))
    ? /^yarn@[4-9]/.test(pkg.packageManager ?? '') || existsSync(join(repo, '.yarnrc.yml'))
      ? 'yarn-berry'
      : 'yarn-v1'
    : 'npm';
const correr = gestor === 'npm' ? 'npm run' : gestor === 'pnpm' ? 'pnpm' : 'yarn';
const usaJest = Boolean(dep.jest) || existsSync(join(repo, 'jest.config.js')) || Boolean(pkg.jest);
const perfil = args.perfil ?? (existsSync(join(repo, 'bitbucket-pipelines.yml')) ? 'yarn-bitbucket' : 'pnpm-actions');

const guion = (nombre, alternativas) => {
  for (const a of alternativas) if (pkg.scripts?.[a]) return `${correr} ${a}`;
  return nombre;
};

// --- Fases por defecto ----------------------------------------------------------

const fases = [
  { id: 'alcance', interno: 'check-alcance-diff.mjs', nivelMinimo: 0, bloquea: true, abortaCadena: true },
  { id: 'excepciones', interno: 'check-excepciones.mjs', nivelMinimo: 0, bloquea: true },
  {
    id: 'tipos',
    comando: guion('npx tsc --noEmit', ['typecheck', 'typecheck:build', 'ts-lint']),
    nivelMinimo: 0,
    bloquea: true,
    abortaCadena: true,
  },
  { id: 'forma', comando: guion('npx eslint .', ['lint:check', 'code:check', 'lint']), nivelMinimo: 0, bloquea: true },
  { id: 'aserciones', interno: 'check-aserciones.mjs', nivelMinimo: 0, bloquea: true },
  { id: 'especificacion', interno: 'check-especificacion.mjs', nivelMinimo: 1, bloquea: true },
  {
    id: 'tests',
    // El `mkdirSync` NO es adorno: `--test-reporter-destination=coverage/lcov.info` NO crea
    // el directorio, y `node --test` muere con ENOENT antes de correr un solo test. Medido
    // aqui: la fase de tests fallaba en un repo recien inicializado, o sea la revision mecanica
    // no arrancaba nunca en un repo con node:test.
    comando: usaJest
      ? guion('npx jest --coverage --coverageReporters=lcov', ['test:cov', 'test:coverage'])
      : 'node -e "require(\'node:fs\').mkdirSync(\'coverage\',{recursive:true})" && ' +
        'node --test --experimental-test-coverage --test-reporter=lcov ' +
        '--test-reporter-destination=coverage/lcov.info',
    nivelMinimo: 0,
    bloquea: true,
    abortaCadena: true,
  },
  { id: 'cobertura-diff', interno: 'check-cobertura-diff.mjs', nivelMinimo: 1, bloquea: true, abortaCadena: true },
  { id: 'muerto', comando: 'npx knip --no-exit-code', nivelMinimo: 1, bloquea: false, abortaCadena: false },
  {
    id: 'secretos',
    comando: 'gitleaks detect --no-banner --redact --log-opts "{{BASE}}..HEAD"',
    nivelMinimo: 2,
    bloquea: true,
    abortaCadena: false,
  },
  { id: 'invariantes', interno: 'check-invariantes.mjs', nivelMinimo: 2, bloquea: true, abortaCadena: false },
  {
    id: 'mutacion',
    /**
     * POR QUE **NO** `npx stryker run` (medido, no teorico)
     * ----------------------------------------------------
     * `npx stryker` NO resuelve a @stryker-mutator/core: resuelve al paquete `stryker`
     * del registro, que es la version abandonada 1.0.1 de 2019. Si no esta instalado
     * localmente, npx lo BAJA DE LA RED y explota con "Cannot find module 'rx'". Se
     * comprobo en un repo limpio: 58 segundos gastados en descargar un paquete
     * equivocado. Invocar el bin del paquete instalado falla en seco y sin red.
     *
     * POR QUE SE BORRA EL REPORTE ANTES
     * ---------------------------------
     * check-mutantes.mjs ahora exige que el reporte sea posterior al alcance, porque un
     * reporte viejo en disco daba verde sin que Stryker corriera. Borrarlo antes vuelve
     * imposible el falso verde incluso si la fase se omite.
     */
    comando:
      'node -e "require(\'node:fs\').rmSync(\'reports/mutation\',{recursive:true,force:true})" && ' +
      'node node_modules/@stryker-mutator/core/bin/stryker.js run ' +
      '--mutate "{{MUTAR}}" --reporters json,clear-text',
    nivelMinimo: 2,
    bloquea: true,
    abortaCadena: false,
  },
  { id: 'mutantes', interno: 'check-mutantes.mjs', nivelMinimo: 2, bloquea: true },
];

const config = {
  $comentario: [
    'Configuracion de la revision de este repo. La doctrina vive en el skill;',
    'esto es el cableado local, que es lo unico que no puede ser comun a 27 repos.',
    'zonas.critica manda: tocar esas rutas eleva el diff a nivel 2 y hace obligatorias',
    'las fases de mutacion, secretos, invariantes y cobertura del diff.',
  ],
  version: 1,
  generadoPor: `revision mecanica ${VERSION_HERRAMIENTA}`,
  base: perfil === 'yarn-bitbucket' ? 'origin/uat' : 'origin/main',
  gestor,
  zonas: {
    critica: [],
    negocio: ['src/**'],
  },
  patrones: {
    fuente: ['src/**/*.ts', 'src/**/*.tsx'],
    test: ['**/*.spec.ts', '**/*.test.ts', 'test/**/*.ts'],
    ignorar: ['dist/**', 'coverage/**', 'node_modules/**', '**/*.snap', '**/*.d.ts'],
  },
  especificacion: { directorio: 'especificacion', registro: 'especificacion/registro.json' },
  cobertura: { lcov: 'coverage/lcov.info' },
  mutacion: { reporte: 'reports/mutation/mutation.json' },
  esquema: { directorios: ['supabase/migrations', 'migrations', 'db/migrations'], fuente: ['src'] },
  umbrales: {
    coberturaDiff: { 0: 0, 1: 0, 2: 100 },
    complejidadCiclomatica: 8,
    profundidad: 3,
    lineasPorFuncion: 60,
    parametros: 4,
    maxDiasExcepcion: 30,
    maxExcepciones: 10,
    // 99 = la regla heuristica "usa un doble y no lo afirma" NUNCA bloquea. Medido: con
    // cualquiera de sus dos calibraciones posibles falla en dos digitos sobre 527 casos
    // reales. Queda como senal para la lectura adversarial; la valla de verdad es la
    // mutacion. Bajarlo a 2 es una decision deliberada por repo, despues de triar.
    nivelMinimoAdorno: 99,
  },
  fases,
};

const EXCEPCIONES_CABECERA = `# Excepciones de la revision

Cada excepcion apaga UNA valla sobre UNA ruta por un tiempo LIMITADO. El validador
(\`check-excepciones.mjs\`) exige los cinco campos, rechaza vencimientos de mas de
30 dias y falla cuando una excepcion caduca. Ese vencimiento es lo unico que impide
que este archivo se convierta en un \`|| true\` con mejor letra.

Formato:

\`\`\`
## EXC-001
- valla: mutacion
- ruta: src/algo.ts:120-135
- motivo: explicacion real de por que el gate no aplica aca (minimo 25 caracteres)
- vence: AAAA-MM-DD
- responsable: usuario
\`\`\`

Vallas validas: especificacion, tipos, forma, fronteras, aserciones, cobertura-diff,
mutacion, secretos, invariantes, muerto, lectura-adversarial.

<!-- No hay excepciones vivas. Ese es el estado deseable. -->
`;

const INVARIANTES_PROD = `# Invariantes verificadas en produccion, no en CI

Hay invariantes que ninguna suite puede comprobar: "nunca dos cargos exitosos para
el mismo usuario y periodo" es un chequeo sobre los datos reales, no un test
unitario. Este archivo existe para que sea VISIBLE cuantas invariantes del sistema
viven fuera del pipeline — informacion que normalmente nadie tiene.

Cada entrada declara el identificador que la especificacion cita en su \`sosten:\`,
donde corre el chequeo y que hace cuando falla.

| identificador | donde corre | frecuencia | que hace al fallar |
| ------------- | ----------- | ---------- | ------------------ |
|               |             |            |                    |
`;

// --- Escritura ------------------------------------------------------------------

const acciones = [];

function escribir(rel, contenido, sobreescribir = false) {
  const destino = join(repo, rel);
  if (existsSync(destino) && !sobreescribir) {
    acciones.push(`= ya existe, no se toca: ${rel}`);
    return;
  }
  acciones.push(`+ ${existsSync(destino) ? 'reemplaza' : 'crea'}: ${rel}`);
  if (seco) return;
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, contenido, 'utf8');
}

escribir('.mechanical-review/config.json', `${JSON.stringify(config, null, 2)}\n`);
escribir('.mechanical-review/excepciones.md', EXCEPCIONES_CABECERA);
escribir('.mechanical-review/invariantes-produccion.md', INVARIANTES_PROD);
escribir('especificacion/registro.json', `${JSON.stringify({ version: 1, especificaciones: [] }, null, 2)}\n`);

const plantilla = join(SKILL, 'assets', 'especificacion.plantilla.md');
if (existsSync(plantilla)) escribir('especificacion/PLANTILLA.md', readFileSync(plantilla, 'utf8'));

// vendorizado de los scripts
function copiarArbol(desde, hacia, prefijo = '') {
  for (const e of readdirSync(desde, { withFileTypes: true })) {
    const o = join(desde, e.name);
    const d = join(hacia, e.name);
    if (e.isDirectory()) {
      if (!seco) mkdirSync(d, { recursive: true });
      copiarArbol(o, d, `${prefijo}${e.name}/`);
    } else if (e.name.endsWith('.mjs')) {
      acciones.push(`+ vendoriza: scripts/mechanical-review/${prefijo}${e.name}`);
      if (!seco) {
        mkdirSync(dirname(d), { recursive: true });
        copyFileSync(o, d);
      }
    }
  }
}
const destinoScripts = join(repo, 'scripts', 'revision mecanica');
if (!seco) mkdirSync(destinoScripts, { recursive: true });
copiarArbol(AQUI, destinoScripts);

// --- Reporte y lo que queda a mano ---------------------------------------------

console.log(`\nMECHANICAL-REVIEW ${VERSION_HERRAMIENTA} → ${repo}`);
console.log(`  perfil: ${perfil}   gestor: ${gestor}   runner: ${usaJest ? 'jest' : 'node:test'}`);
console.log('─'.repeat(72));
acciones.forEach((a) => console.log(`  ${a}`));
console.log('─'.repeat(72));

/**
 * LOS GUARDAS VENDORIZADOS CAEN DENTRO DEL GLOB DE LINT DEL REPO (defecto medido)
 * ------------------------------------------------------------------------------
 * Se comprobo instalando la revision mecanica en el backend de referencia: sus scripts de lint y formato
 * son `eslint "{src,test,scripts}/**\/*.{ts,mjs}"` y `prettier --check "{src,test,scripts}/**"`,
 * asi que `scripts/mechanical-review/*.mjs` entra en los dos. Resultado el primer dia: 101 errores
 * de ESLint que no existian antes de instalar la revision mecanica, y la fase `forma` del propio
 * revision mecanica en rojo por su propio codigo vendorizado.
 *
 * Es el peor arranque posible para una herramienta cuyo argumento es "gate bloqueante o no
 * existe": el primer reflejo de quien lo vive es apagar la fase. Asi que se detecta y se
 * dice antes, con el arreglo escrito.
 */
const globsQueTocanScripts = Object.entries(pkg.scripts ?? {})
  .filter(([, v]) => /\bscripts\b/.test(v) && /(eslint|prettier)/.test(v))
  .map(([k]) => k);
if (globsQueTocanScripts.length > 0) {
  console.log(
    `\n▲ ATENCION — los guardas vendorizados quedan DENTRO del glob de lint/formato de este repo.\n` +
      `  Scripts afectados: ${globsQueTocanScripts.join(', ')}\n` +
      `  Sin excluirlos, instalar la revision mecanica agrega errores de lint que no existian y la\n` +
      `  fase "forma" falla por el codigo del propio revision mecanica. Los guardas son codigo\n` +
      `  VENDORIZADO (copia versionada de otra herramienta): se excluyen igual que node_modules,\n` +
      `  no se reformatean.\n` +
      `  Arreglo, en el archivo de ESLint que gobierna (confirmarlo con el doctor):\n` +
      `      { ignores: ['scripts/mechanical-review/**'] }\n` +
      `  y en .prettierignore:\n` +
      `      scripts/mechanical-review/\n`,
  );
}

console.log(`
FALTA A MANO (init no toca package.json, lockfiles ni el YAML de CI a proposito):

1) Declarar la zona critica en .mechanical-review/config.json → zonas.critica
   Mientras este vacia, todo el diff es nivel 0/1 y la mutacion nunca corre.
   Ejemplo:  "critica": ["src/modules/payments/**"]

2) Agregar a package.json (copiar tal cual):

  "revision mecanica": "node scripts/mechanical-review/orquestador.mjs",
  "revision mecanica:doctor": "node scripts/mechanical-review/doctor.mjs",
  "revision mecanica:espec": "node scripts/mechanical-review/check-especificacion.mjs",
  "revision mecanica:espec:aprobar": "node scripts/mechanical-review/check-especificacion.mjs --aprobar",
  "revision mecanica:aserciones": "node scripts/mechanical-review/check-aserciones.mjs --todos"

3) Excluir los guardas vendorizados del lint y del formateador (son codigo de
   terceros, copiado; se tratan como node_modules):

  ESLint (el que gobierna):   { ignores: ['scripts/mechanical-review/**'] }
  .prettierignore:            scripts/mechanical-review/

4) Ignorar la salida efimera (.gitignore):

  .mechanical-review/out/
  reports/mutation/
  .stryker-tmp/

   Los tres son OBLIGATORIOS, no higiene: un reports/mutation/ versionado o cacheado
   en CI es un reporte de mutacion viejo que el gate podria leer como si fuera de
   esta corrida. Es el falso verde mas caro que tiene este diseno.

5) Escribir la primera especificacion:
   cp especificacion/PLANTILLA.md especificacion/<slug>.md
   ${correr} revision mecanica:espec:aprobar

6) Cablearlo en CI. Los dos fragmentos exactos estan en el skill:
   ${perfil === 'yarn-bitbucket' ? 'references/perfil-yarn-bitbucket.md' : 'references/perfil-pnpm-actions.md'}

7) Correr el diagnostico ANTES de instalar nada:
   node scripts/mechanical-review/doctor.mjs

8) Herramientas externas que las fases de nivel 2 necesitan. Mientras falten, esas
   fases fallan (a proposito: no aprueban por ausencia). Verificarlas con el doctor.

   · gitleaks           en el PATH de la maquina y de la imagen de CI.
   · StrykerJS 9        como devDependency, NUNCA por npx:
                          ${correr === 'npm run' ? 'npm i -D' : `${gestor.startsWith('yarn') ? 'yarn add -D' : 'pnpm add -D'}`} @stryker-mutator/core@9 @stryker-mutator/jest-runner@9${
                            gestor === 'pnpm' ? ' jest-environment-node' : ''
                          }
${
  gestor === 'pnpm'
    ? '                        jest-environment-node va explicito porque con el node_modules\n' +
      '                        aislado de pnpm el jest-runner de Stryker no lo resuelve y la\n' +
      '                        corrida muere en "Cannot find module jest-environment-node".\n'
    : ''
}   · stryker.conf.json  con "plugins": ["@stryker-mutator/jest-runner"] declarado a mano:
                        el autodescubrimiento de plugins no encuentra los symlinks de pnpm.
`);
if (seco) console.log('(--seco: no se escribio ningun archivo)');
