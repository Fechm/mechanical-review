#!/usr/bin/env node
/**
 * DOCTOR — lo primero que hay que correr en un repo nuevo. Solo lectura.
 *
 * POR QUE EXISTE
 * --------------
 * La revision mecanica no se puede instalar igual en los dos ecosistemas destino, y no
 * por gusto: es una restriccion de `engines`. dependency-cruiser 18 exige Node
 * ^22||^24||>=26 y no entra en repos con Node 20; eslint-plugin-sonarjs 4
 * exige eslint>=8 y no entra en los repos con eslint 7; StrykerJS exige Node >=20.
 * Un plan que asuma un solo stack produce una revision que funciona en dos repos
 * y falla en veinticinco.
 *
 * Y ademas hay una trampa verificada que este script existe para cazar: en un repo real
 * coexisten `.eslintrc.js` y `eslint.config.cjs` con eslint 8 (gobierna el
 * eslintrc); en el webapp de referencia coexisten `.eslintrc.json` y `eslint.config.mjs` con
 * eslint 9 (gobierna el flat). Si las reglas de forma se escriben en el archivo
 * muerto, el resultado es exactamente el defecto que la revision mecanica busca eliminar:
 * un gate que parece proteger y nunca corre.
 *
 * NO MODIFICA NADA. Imprime un diagnostico y escribe .mechanical-review/out/doctor.json.
 *
 * USO
 *   node doctor.mjs [--repo <ruta>] [--estricto] [--sin-escribir]
 *
 * --sin-escribir: no deja doctor.json en el repo. Para diagnosticar repos ajenos
 * sin dejar rastro (por ejemplo antes de proponerle la revision mecanica a un equipo).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { correr, escribirSalida, parsearArgs, raizRepo, VERSION_HERRAMIENTA } from './lib/comun.mjs';

const args = parsearArgs(process.argv.slice(2));
const raiz = args.repo ? String(args.repo) : (raizRepo() ?? process.cwd());

const leer = (rel) => {
  const p = join(raiz, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};
const leerJson = (rel) => {
  const t = leer(rel);
  if (!t) return null;
  try {
    return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
  } catch {
    return null;
  }
};

const hallazgos = [];
const nota = (nivel, tema, mensaje, arreglo) => hallazgos.push({ nivel, tema, mensaje, arreglo });

// --- 1. Gestor de paquetes y dialecto de lockfile congelado ---------------------

const pkg = leerJson('package.json');
if (!pkg) {
  console.error(`No hay package.json en ${raiz}. El doctor necesita un repo Node.`);
  process.exit(1);
}

let gestor = 'desconocido';
let instalar = null;
if (existsSync(join(raiz, 'pnpm-lock.yaml'))) {
  gestor = 'pnpm';
  instalar = 'pnpm install --frozen-lockfile';
} else if (existsSync(join(raiz, 'yarn.lock'))) {
  const pm = pkg.packageManager ?? '';
  const berry = /^yarn@[4-9]/.test(pm) || existsSync(join(raiz, '.yarnrc.yml'));
  gestor = berry ? 'yarn-berry' : 'yarn-v1';
  instalar = berry ? 'yarn install --immutable' : 'yarn install --pure-lockfile';
} else if (existsSync(join(raiz, 'package-lock.json'))) {
  gestor = 'npm';
  instalar = 'npm ci';
}
if (!instalar) {
  nota('alto', 'gestor', 'No se detecto lockfile: no hay forma de instalar de manera reproducible.', 'Versionar el lockfile del gestor que se use.');
}

// --- 2. Version de Node declarada (la mas baja manda) --------------------------

/**
 * Quita comentarios YAML antes de buscar antipatrones o versiones.
 * POR QUE: sin esto, un pipeline que documenta "nunca usar || true" queda marcado
 * como si lo usara. Un gate con falsos positivos se desactiva igual de rapido que
 * uno que no corre.
 */
const sinComentariosYaml = (t) =>
  t
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');

const fuentesNode = [];
if (pkg.engines?.node) fuentesNode.push({ de: 'package.json engines.node', valor: pkg.engines.node });
const nvmrc = leer('.nvmrc');
if (nvmrc) fuentesNode.push({ de: '.nvmrc', valor: nvmrc.trim() });
for (const yml of ['bitbucket-pipelines.yml', '.github/workflows/ci.yml']) {
  const bruto = leer(yml);
  if (!bruto) continue;
  /**
   * POR QUE SE LIMPIAN LOS COMENTARIOS TAMBIEN AQUI (defecto real medido)
   * --------------------------------------------------------------------
   * En el webapp de referencia el ci.yml trae el comentario
   *   # Con `node-version: 22` el CI pasaba SOLO porque setup-node resuelve la ...
   * y el doctor concluia nodeMin = 22 cuando el minimo declarado de verdad es 24
   * (.nvmrc). Con un comentario que mencione Node 14 la conclusion habria sido peor:
   * el doctor habria declarado "NO ENTRA" a StrykerJS y a dependency-cruiser en un
   * repo donde si entran, y el plan de adopcion se habria armado sobre eso.
   */
  const t = sinComentariosYaml(bruto);
  for (const m of t.matchAll(/node[:@-]v?(\d{2})(?:[.\-\w]*)/gi)) fuentesNode.push({ de: yml, valor: m[1] });
  for (const m of t.matchAll(/node-version(?:-file)?:\s*['"]?([^\s'"]+)/gi)) fuentesNode.push({ de: yml, valor: m[1] });
}
const majors = fuentesNode
  .map((f) => Number(String(f.valor).match(/(\d{2})/)?.[1]))
  .filter((n) => Number.isFinite(n));
const nodeMin = majors.length ? Math.min(...majors) : null;

// --- 3. Version de eslint ------------------------------------------------------

const depAll = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
const eslintRango = depAll.eslint ?? null;
const eslintMajor = eslintRango ? Number(String(eslintRango).match(/(\d+)/)?.[1]) : null;
const tsRango = depAll.typescript ?? null;

// --- 4. Cual config de ESLint gobierna -----------------------------------------

const flat = ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.cjs', 'eslint.config.ts'].filter((f) =>
  existsSync(join(raiz, f)),
);
const legado = ['.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc'].filter((f) =>
  existsSync(join(raiz, f)),
);
let configQueGobierna = null;
if (flat.length && legado.length) {
  // ESLint >=9: gana el flat. ESLint 8: gana el eslintrc salvo ESLINT_USE_FLAT_CONFIG=true.
  configQueGobierna = eslintMajor !== null && eslintMajor >= 9 ? flat[0] : legado[0];
  nota(
    'alto',
    'eslint',
    `Coexisten config plano (${flat.join(', ')}) y legado (${legado.join(', ')}) con eslint ${eslintRango ?? '?'}.\n` +
      `      Con esa version gobierna: ${configQueGobierna}. El otro archivo es LETRA MUERTA.`,
    'Escribir las reglas de forma SOLO en el que gobierna, y confirmarlo con\n' +
      `      \`npx eslint --print-config <un-archivo-real>\` (es la unica comprobacion definitiva).\n` +
      '      Mejor todavia: borrar el muerto en un commit aparte.',
  );
} else if (flat.length) configQueGobierna = flat[0];
else if (legado.length) configQueGobierna = legado[0];
else nota('alto', 'eslint', 'No hay ninguna configuracion de ESLint.', 'Sin ESLint no hay reglas de forma ni de fronteras: es la capa mas barata de la revision.');

// --- 5. Reglas de forma presentes ----------------------------------------------

const REGLAS_FORMA = ['complexity', 'max-depth', 'max-lines-per-function', 'max-params', 'max-nested-callbacks'];
const textoConfig = configQueGobierna ? (leer(configQueGobierna) ?? '') : '';
const formaFaltantes = REGLAS_FORMA.filter((r) => !new RegExp(`['"\`]${r}['"\`]`).test(textoConfig));
if (configQueGobierna && formaFaltantes.length > 0) {
  nota(
    'medio',
    'forma',
    `Faltan reglas de forma en ${configQueGobierna}: ${formaFaltantes.join(', ')}.`,
    'Son reglas del CORE de ESLint (no estan deprecadas y no son de formato), asi que\n' +
      '      corren en eslint 7 igual que en 10 — es la unica capa de la revision que viaja a\n' +
      '      todos los repos sin instalar nada. Arrancar con TRINQUETE: medir el maximo real\n' +
      '      hoy y fijar la regla en ese numero, no en el ideal.',
  );
}
if (/no-restricted-imports/.test(textoConfig)) {
  nota('info', 'fronteras', `${configQueGobierna} ya declara no-restricted-imports (fronteras por capa).`, null);
} else {
  nota('medio', 'fronteras', 'No hay dependencias unidireccionales declaradas.', 'Declarar el patron por capa (domain no importa application/\n      infrastructure/handlers), o usar dependency-cruiser segun la version de Node.');
}

// --- 6. tsconfig ---------------------------------------------------------------

const tsconfigRaw = leer('tsconfig.json');
if (!tsconfigRaw) nota('alto', 'tipos', 'No hay tsconfig.json.', null);
else {
  const sinComentarios = tsconfigRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const flag = (nombre) => {
    const m = sinComentarios.match(new RegExp(`"${nombre}"\\s*:\\s*(true|false)`));
    return m ? m[1] === 'true' : null;
  };
  const strict = flag('strict');
  const importantes = {
    strict,
    noImplicitAny: flag('noImplicitAny'),
    strictNullChecks: flag('strictNullChecks'),
    noFallthroughCasesInSwitch: flag('noFallthroughCasesInSwitch'),
    noUncheckedIndexedAccess: flag('noUncheckedIndexedAccess'),
  };
  if (strict !== true) {
    nota(
      'alto',
      'tipos',
      `tsconfig.json no declara strict: true (valores: ${JSON.stringify(importantes)}).`,
      'Es la valla mas barata de la revision: cero dependencias, cero minutos de CI y\n' +
        '      falla en el editor. En particular noFallthroughCasesInSwitch en false deja pasar\n' +
        '      el fall-through que produce "un desenlace sin prueba escribiendo un estado fuera\n' +
        '      del predicado", que es la clase de defecto que aparecio seis veces.',
    );
  }
  if (importantes.strictNullChecks === false) {
    nota(
      'alto',
      'tipos',
      'strictNullChecks: false.',
      'Con esto NO se puede replicar la tecnica de "hacer el estado invalido\n' +
        '      inexpresable" (uniones discriminadas + exhaustividad con never). Este repo no es\n' +
        '      candidato a nivel 2 hasta migrar.',
    );
  }
}

// --- 7. Antipatrones en scripts y CI -------------------------------------------

for (const [nombre, valor] of Object.entries(pkg.scripts ?? {})) {
  if (/--passWithNoTests/.test(valor)) {
    nota(
      'alto',
      'tests',
      `El script "${nombre}" usa --passWithNoTests: "${valor}".`,
      'Ese flag hace que 0 tests salga en VERDE. Es el modo de falla exacto que el\n' +
        '      runner del webapp de referencia existe para impedir. Quitarlo cuesta borrar el\n' +
        '      flag y es el primer arreglo de la revision en este repo.',
    );
  }
}

const ymlGha = leer('.github/workflows/ci.yml');
const ymlBb = leer('bitbucket-pipelines.yml');
const ghaLimpio = ymlGha ? sinComentariosYaml(ymlGha) : null;
const bbLimpio = ymlBb ? sinComentariosYaml(ymlBb) : null;
if (ymlGha) {
  if (!/fetch-depth:\s*0/.test(ghaLimpio)) {
    nota(
      'alto',
      'ci',
      'El workflow no declara fetch-depth: 0 en actions/checkout.',
      'Sin historia, `git merge-base` no resuelve y el gate de diff PASA POR FALTA DE\n' +
        '      DATOS. Es la falla mas silenciosa de todo el diseno.',
    );
  }
  if (/continue-on-error:\s*true|\|\|\s*true/.test(ghaLimpio)) {
    nota('alto', 'ci', 'El workflow tiene continue-on-error o `|| true`.', 'Un gate informativo se ignora en dos semanas. Bloqueante o no existe.');
  }
}
if (ymlBb) {
  if (!/clone:\s*[\s\S]{0,40}depth:\s*full/.test(bbLimpio)) {
    nota(
      'alto',
      'ci',
      'bitbucket-pipelines.yml no declara `clone: depth: full`.',
      'Queda con el default depth 50: el diff contra la base puede no resolver. Ojo\n' +
        '      ademas con que Atlassian documenta que el clone depth NO se aplica en pipelines\n' +
        '      de pull request.',
    );
  }
  if (/\|\|\s*true/.test(bbLimpio)) {
    nota('alto', 'ci', 'bitbucket-pipelines.yml neutraliza algun paso con `|| true`.', 'Localizarlo: ese paso no es un gate, es decoracion.');
  }
}
if (!ymlGha && !ymlBb) nota('medio', 'ci', 'No se encontro definicion de CI.', 'La revision mecanica local sirve, pero sin CI nada es bloqueante para el resto del equipo.');

// --- 8. Cobertura y Sonar ------------------------------------------------------

const jestCfg = leer('jest.config.js') ?? leer('jest.config.ts') ?? (pkg.jest ? JSON.stringify(pkg.jest) : null);
if (jestCfg && !/coverageThreshold/.test(jestCfg)) {
  nota('medio', 'cobertura', 'jest no declara coverageThreshold.', 'Mide cobertura y nada la exige localmente.');
}
const sonar = leer('sonar-project.properties');
if (sonar) {
  const excl = sonar
    .split(/\r?\n/)
    .filter((l) => /^sonar\.(coverage\.)?exclusions/.test(l))
    .join(' ');
  nota(
    excl ? 'alto' : 'info',
    'sonar',
    `SonarCloud configurado.${excl ? `\n      Exclusiones declaradas: ${excl.slice(0, 200)}` : ''}`,
    excl
      ? 'Las exclusiones de cobertura son la via de escape mas grande que existe: un\n' +
        '      cambio que toque solo esos paths pasa el gate de cobertura EN VERDE exigiendo\n' +
        '      cero tests. Auditarlas una por una antes de confiar en "coverage on new code".'
      : null,
  );
}

// --- 9. Herramientas de la revision: que se puede instalar aqui ----------------

const HERRAMIENTAS = [
  { nombre: '@stryker-mutator/core', version: '9.6.1', node: 20, eslint: null, para: 'mutacion' },
  { nombre: '@stryker-mutator/jest-runner', version: '9.6.1', node: 20, eslint: null, para: 'mutacion (jest)' },
  { nombre: '@stryker-mutator/tap-runner', version: '9.6.1', node: 14, eslint: null, para: 'mutacion (node:test)' },
  { nombre: '@stryker-mutator/typescript-checker', version: '9.6.1', node: 20, eslint: null, para: 'mutantes que no compilan' },
  { nombre: 'dependency-cruiser', version: '18.1.0', node: 22, eslint: null, para: 'fronteras (Node 22+)' },
  { nombre: 'dependency-cruiser', version: '16.10.4', node: 18, eslint: null, para: 'fronteras (Node 18-21)' },
  { nombre: 'eslint-plugin-boundaries', version: '7.1.0', node: 18, eslint: 6, para: 'fronteras en el editor' },
  { nombre: 'eslint-plugin-jest', version: '29.16.0', node: 18, eslint: 8, para: 'expect-expect (piso minimo)' },
  { nombre: 'typescript-eslint', version: '8.65.0', node: 18, eslint: 8, para: 'reglas tipadas' },
  { nombre: 'eslint-plugin-sonarjs', version: '4.2.0', node: 18, eslint: 8, para: 'complejidad cognitiva' },
  { nombre: 'fast-check', version: '4.9.0', node: 12, eslint: null, para: 'propiedades (caza NaN < MIN)' },
  { nombre: 'knip', version: '6.29.0', node: 20, eslint: null, para: 'codigo/exports muertos' },
];

const instalables = HERRAMIENTAS.map((h) => {
  const okNode = nodeMin === null ? null : nodeMin >= h.node;
  const okEslint = h.eslint === null ? true : eslintMajor === null ? null : eslintMajor >= h.eslint;
  return { ...h, viable: okNode !== false && okEslint !== false, okNode, okEslint };
});

// --- 10. Estado de la revision en este repo ------------------------------------

const tieneConfig = existsSync(join(raiz, '.mechanical-review/config.json'));
const tieneVendor = existsSync(join(raiz, 'scripts/mechanical-review'));

/**
 * Deriva del vendorizado: la version de la copia del repo vs la del skill.
 * SKILL.md e init.mjs prometian este chequeo y no existia. El costo de vendorizar es
 * justamente que las copias divergen, y una copia vieja es un gate viejo.
 */
let versionVendor = null;
if (tieneVendor) {
  const t = leer('scripts/mechanical-review/lib/comun.mjs') ?? '';
  versionVendor = t.match(/VERSION_HERRAMIENTA\s*=\s*'([^']+)'/)?.[1] ?? 'no declarada';
  if (versionVendor !== VERSION_HERRAMIENTA) {
    nota(
      'medio',
      'revision mecanica',
      `La copia vendorizada es ${versionVendor} y el skill es ${VERSION_HERRAMIENTA}.`,
      'Re-vendorizar: node <skill>/scripts/init.mjs --repo . (no sobreescribe el config\n' +
        '      del repo, solo los guardas). Una copia vieja es un gate viejo.',
    );
  }
}

/**
 * Las herramientas EXTERNAS que el config generado invoca tienen que existir. Sin esto
 * el primer `revision mecanica` en un repo nuevo falla en la fase de secretos con
 * "'gitleaks' no se reconoce como un comando", que es cierto pero no ayuda.
 */
const externas = [];
const hayEnPath = (cmd) => {
  const r = correr(process.platform === 'win32' ? 'where' : 'which', [cmd]);
  return r.codigo === 0 && !r.falloAlLanzar;
};
const strykerLocal =
  Boolean(depAll['@stryker-mutator/core']) || existsSync(join(raiz, 'node_modules/@stryker-mutator/core'));
externas.push({ nombre: 'gitleaks (fase secretos)', presente: hayEnPath('gitleaks') });
externas.push({ nombre: '@stryker-mutator/core (fase mutacion)', presente: strykerLocal });
for (const e of externas.filter((x) => !x.presente)) {
  nota(
    'medio',
    'herramientas',
    `Falta ${e.nombre}: la fase que la usa va a fallar en este repo.`,
    e.nombre.startsWith('gitleaks')
      ? 'Instalar gitleaks en la imagen de CI y en la maquina local, o declarar una\n' +
        '      excepcion con vencimiento para la valla "secretos" mientras se instala.'
      : 'Instalar como devDependency: @stryker-mutator/core@9 + @stryker-mutator/jest-runner@9\n' +
        '      (+ jest-environment-node si el gestor es pnpm, ver references/adopcion.md).\n' +
        '      NO invocar `npx stryker`: ese nombre resuelve al paquete abandonado\n' +
        '      `stryker@1.0.1` de 2019, lo baja de la red y explota con "Cannot find module rx".',
  );
}

// --- Reporte -------------------------------------------------------------------

const orden = { alto: 0, medio: 1, info: 2 };
hallazgos.sort((a, b) => orden[a.nivel] - orden[b.nivel]);

console.log(`\nDOCTOR DE MECHANICAL-REVIEW — ${raiz}`);
console.log('═'.repeat(76));
console.log(`  gestor:      ${gestor}   ·  instalar congelado: ${instalar ?? 'n/d'}`);
console.log(
  `  node:        ${nodeMin ?? '?'} (minimo declarado)  ·  fuentes: ` +
    (fuentesNode.map((f) => `${f.de}=${f.valor}`).join(' · ') || 'ninguna'),
);
console.log(`  eslint:      ${eslintRango ?? 'no declarado'}  ·  gobierna: ${configQueGobierna ?? 'n/d'}`);
console.log(`  typescript:  ${tsRango ?? 'no declarado'}`);
console.log(
  `  revision mecanica:  ${tieneConfig ? 'configurado' : 'NO configurado'} · vendorizado: ` +
    `${tieneVendor ? `si (v${versionVendor}, skill v${VERSION_HERRAMIENTA})` : 'no'}`,
);
console.log('═'.repeat(76));

for (const h of hallazgos) {
  const marca = h.nivel === 'alto' ? '✖' : h.nivel === 'medio' ? '▲' : '·';
  console.log(`\n${marca} [${h.tema}] ${h.mensaje}`);
  if (h.arreglo) console.log(`    → ${h.arreglo}`);
}

console.log(`\n${'─'.repeat(76)}\nHerramientas de la revision en ESTE repo (por engines declarados):`);
for (const h of instalables) {
  const estado = h.viable ? 'instalable ' : 'NO ENTRA   ';
  const motivo = h.viable
    ? ''
    : `  (exige node>=${h.node}${h.eslint ? ` y eslint>=${h.eslint}` : ''})`;
  console.log(`  ${estado} ${h.nombre}@${h.version}  — ${h.para}${motivo}`);
}
console.log(
  '  siempre disponibles: reglas del core de ESLint (complexity, max-depth,\n' +
    '  max-lines-per-function, max-params) y los guardas .mjs de este skill (solo node+git).',
);

const diagnostico = {
  version: 1,
  raiz,
  gestor,
  instalar,
  nodeMin,
  fuentesNode,
  eslint: eslintRango,
  eslintMajor,
  typescript: tsRango,
  configQueGobierna,
  configsMuertas: flat.length && legado.length ? [...flat, ...legado].filter((c) => c !== configQueGobierna) : [],
  hallazgos,
  instalables,
  tieneConfig,
};
if (args['sin-escribir'] !== true) escribirSalida(raiz, 'doctor.json', diagnostico);

const altos = hallazgos.filter((h) => h.nivel === 'alto').length;
console.log(
  `\n${altos} hallazgo(s) de nivel alto.` +
    (args['sin-escribir'] === true ? ' (--sin-escribir: no se guardo doctor.json)' : ' Diagnostico en .mechanical-review/out/doctor.json'),
);
if (args.estricto && altos > 0) process.exit(1);
