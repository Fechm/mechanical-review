# Perfil yarn-bitbucket — yarn v1 / Berry + Bitbucket Pipelines + SonarCloud

Este perfil existe porque un parque corporativo con yarn y Bitbucket difiere del perfil
`pnpm-actions` en cosas que cambian **qué herramientas siquiera pueden instalarse**, no solo en la
sintaxis del YAML: Node más viejo, ESLint más viejo, y SonarCloud ya presente con sus propias
exclusiones. Está medido sobre un parque real de 27 repositorios.

Antes de proponer nada, correr el doctor en el repo concreto:

```bash
node <skill>/scripts/doctor.mjs --repo <ruta-al-repo> --sin-escribir
```

## Las cuatro restricciones que manda el parque

### 1. Dos dialectos de yarn en el mismo parque

| | comando de instalación congelada |
| - | -------------------------------- |
| yarn 1.22 | `yarn install --pure-lockfile` |
| yarn Berry 4.x | `yarn install --immutable` |

`init.mjs` los detecta (`.yarnrc.yml` o `packageManager: yarn@4+` ⇒ Berry) y genera el correcto. En
Berry con `nodeLinker: node-modules` todo lo demás funciona igual; con PnP, StrykerJS **no**: su
sandbox copia el proyecto y resuelve módulos por ruta.

### 2. `yarn audit` de v1 está muerto (410) y la revisión mecánica no lo toca

La revisión mecánica no incluye ninguna fase de vulnerabilidades: eso ya vive en el pipeline de cada repo.
Lo único que importa aquí es no repetir el patrón que ya existe:
`yarn audit --groups dependencies || true` neutraliza el gate sin que se note en el YAML. La fase
`muerto` que `init.mjs` genera como no bloqueante es el mismo riesgo con mejor letra y el
orquestador lo avisa en cada corrida a propósito.

### 3. Node 14 a 24 en el mismo parque

Los guardas `.mjs` de este skill están escritos para **Node 14**: no usan `??=` ni
`String.replaceAll`, que son de Node 15 y —el primero— sintaxis, o sea que en Node 14 el script no
llega a ejecutarse, falla al parsear. Si se agrega un guarda nuevo, mantener esa restricción o el
la revisión mecánica deja de correr en dos de los repos medidos.

Las herramientas externas **no** viajan igual, y el doctor lo dice repo por repo:

| Herramienta | Exige | No entra en |
| ----------- | ----- | ----------- |
| `@stryker-mutator/core` 9 | Node ≥ 20 | los repos con Node 14 |
| `@stryker-mutator/tap-runner` 9 | Node ≥ 14 | — (es la única vía de mutación en Node 14, y solo con `node:test`) |
| `dependency-cruiser` 18 | Node ^22 \|\| ^24 \|\| ≥26 | los repos con Node 20 → usar 16.10.4 |
| `eslint-plugin-sonarjs` 4, `typescript-eslint` 8 | eslint ≥ 8 | un repo con eslint 7 |
| `@cucumber/cucumber` 13 | Node 22 \|\| 24 \|\| ≥26 | seis repos con Node 20 — otra razón para no usar Gherkin como runner |

Lo que **sí** viaja a los 27 repos sin instalar nada: las reglas del core de ESLint (`complexity`,
`max-depth`, `max-lines-per-function`, `max-params`) y los guardas `.mjs` de este skill.

### 4. Bitbucket no tiene workflows reutilizables

Por eso `init.mjs` **vendoriza**: cada repo lleva su copia versionada en
`scripts/mechanical-review/` y el YAML solo la invoca. El costo es la deriva entre copias, y se paga con
`VERSION_HERRAMIENTA`: el doctor imprime la versión de la copia y la del skill, y avisa si difieren.

## Fragmento para `bitbucket-pipelines.yml`

```yaml
# OBLIGATORIO y va al inicio del archivo, fuera de los steps.
# Sin esto queda el default depth 50 y `git merge-base origin/uat HEAD` puede no resolver.
# OJO: Atlassian documenta que el clone depth NO se aplica en pipelines de pull request,
# así que en PR hay que hacer el fetch explícito (ver el step).
clone:
  depth: full

definitions:
  steps:
    - step: &revision-mecanica
        name: Revisión mecánica
        image: node:20
        caches:
          - node
        script:
          # El fetch explícito cubre el caso de los pipelines de PR.
          - git fetch origin uat:refs/remotes/origin/uat || true
          # Los dos guardas de alcance corren SIN node_modules, a propósito.
          - node scripts/mechanical-review/check-alcance-diff.mjs --base origin/uat
          - node scripts/mechanical-review/check-excepciones.mjs
          - yarn install --pure-lockfile      # Berry: yarn install --immutable
          - node scripts/mechanical-review/orquestador.mjs --base origin/uat

pipelines:
  pull-requests:
    '**':
      - step: *revision-mecanica
```

La base por defecto de este perfil es `origin/uat`, no `origin/main`: `init.mjs --perfil yarn-bitbucket` la
escribe así en el config. **El `--base` del orquestador ahora sí se propaga** a las fases internas
(antes se ignoraba en silencio y el diff se calculaba contra `cfg.base`, que en un repo mal
configurado es otra rama).

## SonarCloud: la interacción que hay que mirar

SonarCloud ya está instalado en varios repos y **es la vía de escape más grande que existe**:

```properties
sonar.coverage.exclusions=...
```

Un cambio que toque solo esos paths pasa «coverage on new code» en verde **exigiendo cero tests**.
El doctor marca las exclusiones como hallazgo alto cuando existen, con el texto de la exclusión, y
hay que auditarlas una por una antes de confiar en el quality gate.

Dos consecuencias de diseño:

- **La cobertura del diff de la revisión NO usa Sonar**: lee el `lcov` directamente y cruza línea a
  línea con el diff. Es la única forma de que las exclusiones de Sonar no lo afecten.
- **No duplicar el gate de complejidad.** Si el repo ya tiene `sonarjs`, la complejidad cognitiva la
  mide Sonar; las reglas del core de ESLint (`complexity: 8`) se ponen igual porque corren en el
  editor y en repos con eslint 7, donde `sonarjs` no entra.

## Camino de adopción en un parque grande

No todos los repos a la vez, y no empezando por mutación. Este orden salió de aplicarlo sobre un
parque de 27:

1. **Todos**: reglas de forma del core de ESLint con trinquete (medir el máximo real de hoy y fijar
   la regla ahí), y `clone: depth: full` — sin eso el diff sale vacío y todo aprueba sin revisar nada.
2. **Los que tengan eslint ≥ 8**: fronteras por capa con `no-restricted-imports`, severidad `error`.
   En el parque medido, un solo repo las tenía; el patrón se copia bien desde ahí.
3. **Un solo repo, el mejor candidato**: el que ya tenga cobertura alta y fronteras puestas. Ahí:
   alcance + excepciones + aserciones + cobertura del diff. Todavía sin mutación.
4. **Nivel 2 solo donde haya zona crítica de verdad y alguien que firme la lectura adversarial.**
   Un repo con `strictNullChecks: false` y eslint 7 **no es candidato** hasta migrar: ni la técnica
   de tipos ni la mitad de las reglas están disponibles, y sin ellas el nivel 2 es decorativo.
