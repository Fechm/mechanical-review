# Adopción por fases, primer sujeto, y qué instalar con versión exacta

## La regla que ordena todo

Cada valla se adopta en el orden **costo creciente / probabilidad de rojo decreciente**, y una valla
nueva no entra hasta que la anterior esté en verde y **alguien la haya visto fallar a propósito**.
Ese último paso no es opcional, y es exactamente el que faltó en los cinco guardarraíles inútiles que
originaron esta herramienta: pasaron todos por «se ve correcto» y ninguno se vio nunca en rojo.

Auditar este propio skill encontró cinco falsos verdes en sus guardas, incluido uno que aprobaba en
verde leyendo un reporte de mutación de otra corrida. Todos aparecieron rompiendo la condición a
mano. Ninguno aparecía leyendo el código.

## Fase 0 — el doctor, antes de instalar nada

```bash
node <skill>/scripts/doctor.mjs --repo <ruta> --sin-escribir
```

`--sin-escribir` para diagnosticar sin dejar rastro. Lo que hay que mirar primero, en este orden:

1. **`fetch-depth: 0` / `clone: depth: full`.** Sin eso nada de la revisión funciona en CI, y falla
   por falta de datos, que es el peor modo de falla.
2. **Cuál configuración de ESLint gobierna.** Si coexisten plano y legado, una de las dos es letra
   muerta y una regla escrita ahí no corre nunca. Confirmarlo con
   `npx eslint --print-config <un-archivo-real>`, que es la única comprobación definitiva.
3. **`--passWithNoTests`** en algún script: ese flag hace que 0 tests salga en verde.
4. **Exclusiones de SonarCloud**: un cambio que toque solo esos paths pasa «coverage on new code»
   exigiendo cero tests.
5. **Qué herramientas admite el repo** según sus `engines`.

## Fase 1 — lo que cuesta cero y viaja a todos los repos

Sin instalar nada, sin minutos de CI extra:

- **Reglas de forma del core de ESLint**, con **trinquete**: medir el máximo real de hoy y fijar la
  regla ahí. `complexity`, `max-depth`, `max-lines-per-function`, `max-params`,
  `max-nested-callbacks`. Corren en eslint 7 igual que en 10.
- **`check-alcance-diff.mjs` + `check-excepciones.mjs`** en el pipeline, antes de instalar. Medido:
  ~1,5 s los dos juntos.
- **`check-aserciones.mjs --todos`** como barrido inicial, para saber qué hay. Si dice que no
  encontró ningún archivo de test, el patrón está mal o el repo no tiene tests: eso es el hallazgo,
  y ninguna otra valla significa nada hasta resolverlo.

## Fase 2 — tipos y fronteras

- **`noFallthroughCasesInSwitch: true`** primero: es el flag con más retorno y casi sin deuda
  asociada, y ataca directamente la clase de defecto que apareció seis veces.
- **`strict: true`** después. Deuda acotada y de una vez.
- **Un repo con `strictNullChecks: false` no es candidato a nivel 2** hasta migrar: sin eso no
  funciona la técnica de «hacer el estado inválido inexpresable», que es la que de verdad cierra los
  desenlaces sin prueba.
- **Fronteras por capa** con `no-restricted-imports`, severidad `error`. Nunca `warn`: una regla
  nacida en `warn` «para ir migrando» es una regla que nunca frena nada.

## Fase 3 — especificación y cobertura del diff

- `check-especificacion.mjs` con la primera especificación de verdad, aprobada a mano.
- `check-cobertura-diff.mjs`, que **no es un gate terminal**: su función real es decidir dónde mutar.

## Fase 4 — mutación, y solo en un módulo

No antes de que las tres fases anteriores estén en verde. Y no sobre el repo completo: sobre el diff,
o sobre un módulo. Ver `costo.md` para los números medidos, que son incómodos.

## Qué instalar, con versión exacta

```bash
# mutación (Node >= 20)
<gestor> add -D @stryker-mutator/core@9.6.1 @stryker-mutator/jest-runner@9.6.1
# con pnpm, ADEMAS y explícito:
<gestor> add -D jest-environment-node
# mutación con node:test en vez de jest (única vía en Node 14):
<gestor> add -D @stryker-mutator/tap-runner@9.6.1
# mutantes que no compilan
<gestor> add -D @stryker-mutator/typescript-checker@9.6.1
# OBLIGATORIO fijar typescript en 5.x: ver trampa 5
<gestor> add -D typescript@5.9.3

# fronteras
<gestor> add -D dependency-cruiser@18.1.0      # Node ^22 || ^24 || >=26
<gestor> add -D dependency-cruiser@16.10.4     # Node 18-21
<gestor> add -D eslint-plugin-boundaries@7.1.0 # eslint >= 6

# piso de aserciones en el editor (complemento, no reemplazo)
<gestor> add -D eslint-plugin-jest@29.16.0     # eslint >= 8
# complejidad cognitiva
<gestor> add -D eslint-plugin-sonarjs@4.2.0    # eslint >= 8
# propiedades (caza el NaN < MIN que ninguna regla de lint marca)
<gestor> add -D fast-check@4.9.0
# código y exports muertos
<gestor> add -D knip@6.29.0                    # Node >= 20
```

Y **gitleaks** en el PATH de la máquina y de la imagen de CI. No es un paquete de npm.

## Las siete trampas que se pagaron con tiempo real aquí

1. **`npx stryker` NO es StrykerJS.** Resuelve al paquete `stryker` del registro, que es la versión
   abandonada 1.0.1 de 2019: npx lo baja de la red y explota con `Cannot find module 'rx'`. Medido:
   58 s tirados. Invocar siempre
   `node node_modules/@stryker-mutator/core/bin/stryker.js run`.
2. **Con pnpm, el jest-runner de Stryker no encuentra `jest-environment-node`.** El `node_modules`
   aislado no lo expone y la corrida muere en `Cannot find module 'jest-environment-node'`. Arreglo:
   instalarlo como devDependency directa (probado), o `node-linker=hoisted` en `.npmrc`.
3. **Con pnpm, el autodescubrimiento de plugins de Stryker falla.** Hay que declararlos a mano:
   `"plugins": ["@stryker-mutator/jest-runner"]`. Sin eso: `Cannot find TestRunner plugin "jest". In
   fact, no TestRunner plugins were loaded.`
4. **`pnpm exec` aborta si el `node_modules` se movió** (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`).
   En CI, `CI=true`; en local, invocar el bin directamente.
5. **`typescript@7` mata a Stryker antes del primer mutante.** TS 7 quitó
   `ts.parseConfigFileTextToJson`, que es lo que llama el `TSConfigPreprocessor` del sandbox de
   Stryker 9.6.1 para reescribir el `tsconfig`. Síntoma medido:
   `TypeError: ts.parseConfigFileTextToJson is not a function`, con un stack que no menciona
   TypeScript en ninguna línea. Y se llega solo: `@stryker-mutator/typescript-checker` declara
   `typescript` con un rango amplio, así que una instalación limpia hoy resuelve a 7.x. Fijar
   `typescript@5.9.3` (o cualquier 5.x). Si el repo ya tiene TS 5 como devDependency directa no
   pasa, porque Stryker resuelve el del proyecto.
6. **Vendorizar los guardas rompe el lint del repo el primer día.** Los scripts de
   el backend de referencia son `eslint "{src,test,scripts}/**/*.{ts,mjs}"` y
   `prettier --check "{src,test,scripts}/**"`: `scripts/mechanical-review/*.mjs` entra en los dos.
   Medido: **101 errores de ESLint** que no existían, y la fase `forma` de la revisión en rojo por
   su propio código vendorizado. Excluirlos antes de la primera corrida — son código copiado de
   otra herramienta, se tratan como `node_modules`:
   ESLint `{ ignores: ['scripts/mechanical-review/**'] }` y `scripts/mechanical-review/` en `.prettierignore`.
   `init.mjs` detecta el caso y lo avisa, pero el arreglo es manual.
7. **`pnpm <script>` dentro de una fase puede disparar un `install`.** Desde pnpm 10,
   `verify-deps-before-run` corre un chequeo de estado de dependencias antes del script y, si no le
   cuadra, ejecuta `pnpm install`. Medido: la fase `tipos` (`pnpm typecheck`) intentó instalar. Un
   gate que puede tocar el lockfile no es un gate. Salidas: `verify-deps-before-run=false` en
   `.npmrc`, o cablear las fases al binario directo
   (`node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit`).

## Primer sujeto recomendado

**No** el módulo con más garantías. El módulo con más garantías es el peor primer sujeto: da pocos
hallazgos, cuesta lo mismo, y deja la impresión de que la revisión mecánica no sirve.

El buen primer sujeto tiene: lógica de negocio con desenlaces enumerables, una suite propia que ya
pasa, y sospecha de tests de adorno. En el proyecto de referencia eso es un módulo de negocio nuevo antes de que
alguien lo audite a mano; el módulo de cobro sirve como **calibración** (para saber qué encuentra el
revisión mecánica en código que ya sobrevivió seis auditorías), no como piloto.
