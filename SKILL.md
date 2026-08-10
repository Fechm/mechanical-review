---
name: mechanical-review
description: "Use when generating, reviewing or hardening code that must pass mechanical quality gates instead of a visual read — diff-scoped mutation testing, assertion floor, cyclomatic complexity, unidirectional dependencies, diff coverage, approved human specification. Portable across pnpm/GitHub Actions and yarn v1/Berry/Bitbucket+SonarCloud. Trigger: /mechanical-review"
---

# /mechanical-review

Convierte la revisión visual de código generado por un agente en **vallas mecánicas que se
ejecutan y bloquean**, acotadas al diff, con umbrales fundamentados y un criterio de excepción
que caduca.

## Usage

```
/mechanical-review doctor [--repo <ruta>]      # diagnostica un repo: qué se puede instalar y qué está apagado
/mechanical-review init --repo <ruta>          # genera .mechanical-review/ y vendoriza los guardas en el repo
/mechanical-review espec <slug>                # escribe la especificación humana antes de generar código
/mechanical-review correr [--base <ref>]       # corre la revisión mecánica sobre el diff (local)
/mechanical-review correr --seco               # qué se correría y con qué nivel, sin ejecutar
/mechanical-review correr --fase mutacion      # una sola fase
/mechanical-review interpretar                 # lee los reportes y explica cada hallazgo
/mechanical-review ci [--perfil pnpm-actions|yarn-bitbucket] # imprime el fragmento de CI para pegar
/mechanical-review costo                       # cuánto suma esto por cambio y por corrida de CI
```

## Lo que esta herramienta es, y lo que NO es

**Es** un amplificador de la lectura adversarial. Automatiza **una** clase de defecto: el guard
escrito a medias, el desenlace sin prueba, el mutante que sobrevive. Esa clase apareció **seis
veces** en una sola sesión sobre el módulo de cobro del proyecto de referencia, y es la que más cuesta ver
leyendo.

**No es** un reemplazo de la revisión humana, y quien lo venda así se va a equivocar en la
dirección más cara. Tres razones verificadas, no prudencia genérica:

1. **Las dos implementaciones industriales de referencia ponen la revisión mecánica DENTRO del code
   review, no en su lugar.** En Google los mutantes vivos se surfacean como findings dentro de
   Critique, y el paper de ICSE 2021 dice explícitamente que cuentan con los revisores para
   frenar tests escritos solo para matar mutantes. En Meta (ACH), el 73% de los tests generados
   fue **aceptado por ingenieros** — o sea que un 27% lo rechazaron humanos que los leyeron.
2. **Circularidad.** Si el mismo agente escribe el código y los tests, un malentendido de
   requisitos se propaga idéntico a los dos y el pipeline queda verde sobre la intención
   equivocada. La mutación no salva eso: mata mutantes contra la intención equivocada, con
   eficiencia.
3. **Cuatro clases de defecto quedan fuera por construcción** — especificación equivocada, fuga
   de secretos y superficie de datos, concurrencia, autorización. **Tres de los cuatro hallazgos
   más graves de la sesión de cobro caen ahí** (clave anónima que exponía hashes de contraseña,
   credenciales de pasarela filtrándose al log por la query string, ventana que permitía cobrar
   dos veces) y ninguno lo habría encontrado un test. Ver `references/limites.md`.

La formulación correcta internamente es: **«automatizo el defecto recurrente para liberar
atención humana hacia los cuatro que la máquina no ve por construcción»**. Es además la única
formulación que sobrevive a una auditoría posterior si algo falla en producción.

## La respuesta empírica: qué encontró la mutación sobre código auditado seis veces

Se corrió mutación real sobre dos archivos del módulo de cobro del proyecto de referencia — el módulo que
sobrevivió **seis auditorías adversariales** y tiene ~700 tests encima. Las dos corridas son
reproducibles con StrykerJS 9.6.1, jest-runner, `coverageAnalysis: perTest`, concurrencia 4 y el
grafo de tests acotado a las specs que cubren el archivo.

| archivo | líneas | mutantes | Killed | Survived | NoCoverage | RuntimeError | score total / cubierto | duración |
| ------- | ------ | -------- | ------ | -------- | ---------- | ------------ | ---------------------- | -------- |
| `pagos/identificadores.util.ts` | 99 | 52 | 34 | **12** | 6 | 0 | 65,4 % / 73,9 % | 59 s |
| `pagos/desenlaces.ts` | 486 | 36 | 12 | **8** | 3 | **13** | 52,2 % / 60,0 % | 7 min 1 s |

**20 sobrevivientes y 9 mutantes sin cobertura sobre el código con más garantías del ecosistema.**
La respuesta a «¿esto sirve?» es sí, y con esa evidencia no hace falta adornarla.

Los doce de `pagos/identificadores.util.ts` se concentran en tres cosas:

1. **Todo el bloque de validación de `buildBuyOrders` (89-96) se puede borrar y ningún test se
   entera.** Sobreviven `[parentBuyOrder, childBuyOrder] → []` (89), el cuerpo del `for → {}` (89),
   los dos `if` pasados a `false` (90, 93) y el límite `> → >=` (90). El buy order es la **llave de
   reconciliación** que se persiste y que sostiene `uq_platform_charges_parent_buy_order`: sus
   invariantes de forma no las verifica nada.
2. **El formato del identificador persistido no está afirmado en ninguna parte.** Sobreviven
   `padStart(4, '0') → padStart(4, '')` (43), `padStart(13, '0') → padStart(13, '')` (83) y
   `.toUpperCase() → .toLowerCase()` (80). El último es el más caro: cambiaría **todos** los buy
   orders futuros y rompería en silencio la reconciliación con los cobros ya emitidos.
3. **Los dos anclas del charset del proveedor sobran** (18): `/^[…]+$/ → /[…]+$/` y `→ /^[…]+/` los
   dos sobreviven. Un charset sin anclar acepta un buy order con caracteres prohibidos siempre que
   *alguna* parte calce, o sea que la validación local que el comentario del archivo promete
   («se valida en local para no descubrirlo con un 422 en producción») no está verificada.

Y en `pagos/desenlaces.ts`, la tabla de desenlaces: `estaEnCandado` con el comparador
invertido (79), tres `BooleanLiteral → false` (177, 359, 416), `every → some` en
`esJustificacionDebil` (181) y en `ESTADOS_QUE_ADMITEN_DESENLACE` (485). Ese último invierte el
criterio de qué estados admiten desenlace y pasa con las 4 specs del candado en verde.

### El experimento que aísla la premisa

Se plantó a propósito, en zona crítica, exactamente el defecto que la revisión mecánica dice atrapar: una
rama con **100 % de cobertura del diff**, con un test que **sí tiene aserciones**, y cuyo efecto
nadie observa (`expect(() => esRevocable('PENDING')).not.toThrow()`).

Resultado medido: **`tsc` verde, las 44 suites verdes (706 tests), el piso de aserciones verde, la
cobertura del diff 100 %** — y la mutación acotada al diff lo marca sin ambigüedad:

```
[Survived] BooleanLiteral  pagos/identificadores.util.ts:108:36
-     if (estado === 'PENDING') return true;
+     if (estado === 'PENDING') return false;
Tests ran:  esRevocable — acepta PENDING sin lanzar
```

Es el caso de la pasarela reproducido en laboratorio: **de las diez vallas, la única que lo ve es la
mutación.** Eso es el argumento entero de la revisión, y ahora está medido y no argumentado.

### Tres advertencias medidas que no hay que ocultar

- **La mutación que encontró la sexta auditoría a mano, StrykerJS no la genera.** Cambiar
  `status: PlatformChargeStatus.UNKNOWN` por `FAILED` en una fila de la tabla de desenlaces no está
  en sus mutadores (no muta referencias a miembros de enum). Eso sigue siendo trabajo manual, y lo
  que de verdad lo cierra es la técnica de tipos que ese archivo ya usa.
- **El montaje puede fabricar un resultado falso.** Con el grafo de tests sin acotar, una corrida
  de este mismo archivo dio 42 timeouts, **0 matados** y un score de **87,5 %** en verde. Y la
  corrida real de `pagos/desenlaces.ts` dejó **13 de 36 mutantes en `RuntimeError`** — 36 %
  de la medición sin veredicto. Las dos las cierra `check-mutantes.mjs`; ver la tabla de
  meta-aserciones.
- **Las cifras que este archivo citaba antes no reproducían.** Decían «122 líneas, 52 mutantes, 32
  matados, 10 sobrevivientes, 6 sin cobertura, 66,7 % / 76,2 %»: el archivo tiene 99 líneas, y
  32+10+6 = 48 ≠ 52, o sea que el conteo y el score venían de corridas distintas. Se reemplazaron
  por las de la tabla de arriba, que son autoconsistentes. La regla que faltó aplicar es la que ya
  está escrita más abajo: **antes de prometer números, medir** — y volver a medir antes de citarlos.

## Corrección de la premisa (importa, cambia el diseño)

El resumen que circuló por LinkedIn/X distorsiona el enfoque en tres puntos, y los tres son
justamente los que sostienen la valla:

| El resumen dice | La fuente primaria dice |
| --------------- | ----------------------- |
| «No lee código». La especificación humana es el **paso 1** de un pipeline que después corre solo. | Martin **sí lee**: revisa las especificaciones derivadas, el Gherkin y los procedimientos de QA. Lo que no lee es el código de producción y los tests unitarios. La revisión humana **permanece** en toda la capa de intención. Es el tapón del agujero, no un preámbulo. |
| La revisión mecánica completo es obligatorio: unitarias + Gherkin + QA + mutación + cobertura. | El 02-jul-2026 él mismo escribió que se sobrecargó de tests, que **poder hacerlo no implica deberlo**, y que muchas veces usa solo tests unitarios y CRAP. Es un **dial**, no un dogma. De ahí los tres niveles de abajo. |
| «Cobertura de líneas modificadas al 100%». | **No tiene ninguna fuente primaria.** No está en sus hilos, ni en sus repos, ni en su Acceptance-Pipeline-Specification (que omite deliberadamente umbrales cuantitativos). Es el ítem más caro de imponer, el que más incentiva tests de adorno, y el peor respaldado. **Aquí se degrada a precondición del gate de mutación.** |

Lo que el resumen se quedó corto: el único umbral numérico que Martin publicó está en su propio
código. `crap4java` implementa `CRAP = CC²·(1−cobertura)³ + CC` y falla con score > 8.0. Con
cobertura completa, `CRAP = CC`, así que **el gate real es complejidad ciclomática ≤ 8 por
método**. Ese número sí tiene respaldo primario y es más estricto que el 10-15 clásico de Sonar.

## El dial: tres niveles, y el nivel no lo elige quien corre el comando

El nivel se **deduce** del diff contra `zonas.critica` de `.mechanical-review/config.json`. Se puede
forzar hacia arriba (`--nivel 2`), nunca hacia abajo: bajarlo a mano sería la puerta trasera más
obvia del diseño. Y si el diff toca `config.json`, la revisión mecánica lo dice en voz alta, porque
sacar una ruta de la zona crítica es la forma más barata de saltarse la mitad de las vallas.

| Nivel | Qué toca el diff | Vallas | Costo por corrida (**medido**) |
| ----- | ---------------- | ------ | ----------------------------- |
| **0 · periférico** | docs, config, UI sin lógica | alcance, excepciones, tipos, forma, piso de aserciones, tests | + **5-7 s** sobre lo que ya tarda el CI |
| **1 · negocio** | lógica de negocio fuera de la zona crítica | + especificación aprobada, cobertura del diff, código muerto | + **6-9 s** (+27 s si se deja `muerto`) |
| **2 · crítico** | dinero, autorización, datos personales | + mutación acotada, escaneo de secretos, invariantes de esquema, lectura adversarial firmada | + **1,4 s por mutante del diff** (≈10 s en un diff de 10 líneas, ≈5 min en uno de 500) |

Los tres números están medidos sobre el backend de referencia. El de nivel 2 depende de **acotar el grafo
de tests de la corrida de mutación**: sin acotarlo, el mismo archivo pasó de 1 min 12 s a **19 min
36 s** y el resultado quedó inválido. Detalle completo en `references/costo.md`.

## Las vallas, con su umbral, su fundamento y qué hacer cuando no se alcanza

Un umbral sin criterio de excepción se convierte en `|| true` a la primera fricción. Cada fila
trae las tres cosas.

| # | Valla | Umbral | Por qué ese umbral | Cuando no se alcanza |
| - | ----- | ------ | ------------------ | -------------------- |
| 1 | **Especificación aprobada** (`check-especificacion.mjs`) | existe, tiene las 4 secciones, su sha256 está registrado y **no cambió** | Es la única valla contra «especificación equivocada» y contra la circularidad. Martin la mantiene activa todo el ciclo; el resumen la degradó a paso 1. Costo casi cero, retorno el más alto. | **No hay excepción posible.** Se lee la especificación, se decide a mano si el cambio de intención es el que se quería, y se re-aprueba con `--aprobar --por "<quien>"`. El diff del registro es la constancia. |
| 2 | **Tipos** | `strict: true` + `noFallthroughCasesInSwitch` + `noUncheckedIndexedAccess`; 0 errores | Cero dependencias, cero minutos de CI, falla en el editor. `noFallthroughCasesInSwitch: false` deja pasar exactamente el fall-through que produce «un desenlace sin prueba escribiendo un estado fuera del predicado». | Encender los flags produce deuda **acotada y de una vez**; el gate por PR se paga para siempre. Si un repo tiene `strictNullChecks: false` (medido en un repo real), **no es candidato a nivel 2** hasta migrar: la técnica de «hacer el estado inválido inexpresable» no funciona sin eso. |
| 3 | **Piso de aserciones** (`check-aserciones.mjs`) | 0 tests sin aserción · 0 `expect()` sin matcher · 0 tests solo-tautológicos · 0 archivos de test sin casos. La regla «usa un doble y no lo afirma» es **informativa por defecto** (ver abajo) | La valla más rentable del análisis. Respaldo directo: Zhang & Mesbah (FSE 2015) — el número y la cobertura de **aserciones** correlaciona fuerte con efectividad; la cobertura de línea, no (Inozemtseva & Holmes, ICSE 2014). Medido: barre 527 casos en 44 specs en **1 s**. | Un test sin aserción **se arregla o se borra**; no hay tercera opción y no admite excepción. |
| 4 | **Forma** (ESLint core) | `complexity: 8` en código nuevo · `max-depth: 3` · `max-lines-per-function: 60` · `max-params: 4` | El 8 sale del propio `crap4java` de Martin (CRAP > 8 con cobertura completa ⇒ CC ≤ 8). **Defenderlo por testeabilidad y mantenibilidad, NO como escudo antibugs:** la CC correlaciona con LOC hasta el punto de que hay trabajo negándole poder explicativo propio. Vendida como predictor de defectos, la afirmación no sobrevive al primer incidente en una función con CC baja. | **Trinquete, no umbral aspiracional.** Medir el máximo real de hoy y fijar la regla ahí. `pagos/cobro.service.ts` tiene 2.037 líneas y es el archivo con más garantías del ecosistema: un umbral ideal convertiría al mejor código en el primer rojo. |
| 5 | **Dependencias unidireccionales** — *configuración, no script* | 0 violaciones, severidad `error` | Fronteras por capa: `domain` no importa `application`/`infrastructure`/`handlers` ni el SDK de la nube. Medido: un solo repo de un parque de 27 las tenía. | Severidad `warn` **no** rompe el build: una regla nacida en `warn` «para ir migrando» es una regla que nunca frena nada. Si hay deuda, se usa el mecanismo de baseline y se revisa cada vez que se regenera. |
| 6 | **Cobertura del diff** (`check-cobertura-diff.mjs`) | **precondición**, no gate terminal. Bloquea al 100% solo en zona crítica | Garantiza una sola cosa: que la línea fue **ejecutada**. No dice nada sobre si algo fue **observado** — el test de la pasarela tenía cobertura completa y cero verificación. Su función real aquí es **decidir dónde mutar**. | En orden: (1) escribir el test que afirma el **estado persistido** del desenlace; (2) si es inalcanzable, **borrar el código** (un `try/catch` alrededor de algo que nunca lanza es código muerto, y ya apareció); (3) recién entonces, excepción escrita. **Nunca bajar el umbral.** |
| 7 | **Mutación acotada** (`check-mutantes.mjs`) | **cero mutantes vivos sin justificación escrita** en el diff. NO un porcentaje | Papadakis et al. (ICSE 2018): al controlar el tamaño de la suite, la correlación del mutation score con fallos reales es **débil** — el score puede subir por volumen de tests y no por calidad. Fijar «score ≥ X» reproduce el incentivo perverso de la cobertura. El gate de Google es cero sobrevivientes con el número acotado por construcción (diff + cubiertas + no áridas + uno por línea), con mediana de 2 vivos por diff. | Tres lecturas, en orden: (1) **falta una aserción** — el caso frecuente y el que buscamos; (2) **falta un desenlace en la especificación**; (3) **mutante equivalente o irrelevante** → recién ahí, excepción escrita. Lo que **no** corresponde: escribir un test cuyo único propósito sea matar el mutante. Si hace falta negociar un número con alguien, 60-80% en módulos de alto riesgo, dejando constancia de que perseguir el 100% es gasto negativo (mutantes equivalentes). |
| 8 | **Secretos** (gitleaks/trufflehog) | 0 hallazgos nuevos en el diff | Cierra una de las cuatro clases invisibles. La mutación **suprime a propósito** los nodos áridos (logging), que es justo donde se fue la credencial de pasarela por la query string. | Un secreto detectado se **rota**, no se justifica. La excepción solo aplica a falsos positivos de patrón, con el patrón nombrado. |
| 9 | **Invariantes de esquema** (`check-invariantes.mjs`) | cada invariante declarada tiene soporte mecánico verificado (constraint, tipo, test o invariante declarada en producción) | El doble cobro **no lo cierra ningún test, ningún linter y ningún mutante** (los mutantes se evalúan con la misma suite secuencial). Lo cierra un índice único parcial. El precedente ya existe: un spec del módulo de cobro **lee** el `CREATE UNIQUE INDEX` de las migraciones y lo compara con el arreglo de estados en candado, «porque un derivado puede mentir si el arreglo del que se deriva miente». | Si la invariante no se puede sostener en el esquema, se declara como verificada **en producción** en `.mechanical-review/invariantes-produccion.md`, con dónde corre el chequeo y qué hace al fallar. Eso hace visible cuántas invariantes viven fuera del pipeline. |
| 10 | **Lectura adversarial** (humano) — *no mecanizada* | firmada en el PR, obligatoria en nivel 2 | Es la valla de las cuatro clases invisibles. No es opcional en zona crítica y no es automatizable. Checklist en `references/limites.md`. | No admite excepción en nivel 2. Si no hay quien la haga, el cambio no es de nivel 2 o no sale. |

### Qué se ejecuta y qué no: leer esto antes de prometerle algo a alguien

Ocho de las diez vallas **se ejecutan y bloquean**. Dos no son scripts, y decirlo es parte del diseño:

| Valla | Cómo se ejecuta | ¿Bloquea? |
| ----- | --------------- | --------- |
| 1 especificación · 3 aserciones · 6 cobertura · 7 mutación · 9 invariantes | guardas `.mjs` de este skill, verificados corriendo **y rompiéndolos a propósito** | sí, `exit 1` |
| 2 tipos · 4 forma | `tsc` / `eslint` del propio repo, cableados como fases del orquestador | sí |
| 8 secretos | `gitleaks` externo; si no está instalado la fase **falla**, no aprueba por ausencia | sí |
| **5 dependencias unidireccionales** | **configuración de ESLint que hay que pegar** (`references/restricciones-diseno.md`). No hay guarda propio | sí una vez pegada — pero **la revisión mecánica no verifica que lo esté** |
| **10 lectura adversarial** | **humano**, con el checklist de `references/limites.md`. Nada exige la firma | **no.** Es un acuerdo, no un gate |

Esas dos últimas son el límite honesto del skill: la 5 depende de que alguien copie una configuración
y la 10 de que alguien lea. Presentarlas como cubiertas sería el mismo defecto que la revisión mecánica
persigue.

### El criterio de excepción, y por qué caduca

Una excepción vive en `.mechanical-review/excepciones.md` con **cinco campos obligatorios**: `valla`,
`ruta`, `motivo` (≥25 caracteres de explicación real), `vence` y `responsable`.
`check-excepciones.mjs` la valida y:

- **falla cuando una excepción vence** → el gate vuelve a ser obligatorio solo, sin que nadie
  tenga que acordarse;
- **rechaza vencimientos de más de 30 días** → sin ese límite, el archivo de excepciones **es**
  el `|| true`, solo con mejor letra;
- **falla si hay más de 10 excepciones vivas** → cuando hacen falta más, el umbral está mal
  calibrado o el módulo necesita trabajo estructural; las dos cosas se discuten, acumular no es
  ninguna de las dos.

Renovar una excepción es un acto humano que queda en el diff. Eso es la diferencia entre un
criterio y una amnistía.

## Qué hacer cuando se invoca esta skill

Si el usuario pasó `--help`/`-h` sin nada más: imprimir el bloque `## Usage` verbatim y parar.

`SKILL_DIR="$HOME/.claude/skills/revisión mecánica"`. Todos los guardas son `.mjs` **sin dependencias**:
solo necesitan `node` y `git`, que es lo único garantizado en GitHub Actions, en Bitbucket
Pipelines, con pnpm 11, con yarn 1.22 y con yarn Berry 4.17.

### `doctor` — siempre primero en un repo nuevo

```bash
node "$SKILL_DIR/scripts/doctor.mjs" --repo <ruta> [--sin-escribir]
```

Solo lectura. Reporta: gestor y dialecto de lockfile congelado, versión mínima de Node declarada
(y de dónde sale), **cuál configuración de ESLint gobierna y cuál es letra muerta**, flags de
`tsconfig`, `--passWithNoTests` en los scripts, `coverageThreshold`, `fetch-depth`/`clone depth`,
`|| true`/`continue-on-error`, exclusiones de SonarCloud, y **qué herramientas de la revisión
pueden instalarse en ese repo según sus `engines`**.

Ese último punto no es cosmético: `dependency-cruiser` 18 exige Node ^22||^24||>=26 y no entra en
repos con Node 20; `eslint-plugin-sonarjs` 4 y `typescript-eslint` 8 exigen eslint ≥8 y
no entran en un repo con eslint 7; StrykerJS exige Node ≥20. Presentar el diagnóstico y
**no** proponer un plan de instalación que el repo no admite.

### `init` — instalar la revisión mecánica en un repo

```bash
node "$SKILL_DIR/scripts/init.mjs" --repo <ruta> [--seco] [--perfil pnpm-actions|yarn-bitbucket]
```

Escribe `.mechanical-review/{config.json,excepciones.md,invariantes-produccion.md}`,
`especificacion/{PLANTILLA.md,registro.json}` y **vendoriza** los guardas en
`<repo>/scripts/mechanical-review/`.

Vendoriza a propósito: un gate que solo existe en la máquina de quien tiene el skill instalado no
es un gate del repo — no corre en CI y nadie más lo puede reproducir. Bitbucket Pipelines además
no tiene workflows reutilizables, así que la única forma de que 27 repos compartan la revisión mecánica
es que cada uno tenga su copia versionada y el YAML solo la invoque.

**No toca `package.json`, ni lockfiles, ni el YAML de CI.** Imprime lo que hay que pegar. Después
de correrlo hay que hacer tres cosas a mano, y la primera es la que decide todo: **declarar
`zonas.critica`**. Mientras esté vacía, todo el diff es nivel 0/1 y la mutación nunca corre.

### `espec` — la especificación humana, antes de generar código

Copiar `assets/especificacion.plantilla.md` a `especificacion/<slug>.md`, llenarla **con el
usuario** y aprobarla. Las cuatro secciones son obligatorias y el validador las exige por nombre.

La pieza central es la **tabla de desenlaces**: una fila por desenlace, con `estado persistido` y
`efecto externo` como columnas obligatorias. De esa tabla se derivan los tests — en el módulo de
cobro los escenarios son un `Record<Desenlace, Escenario[]>`, así que agregar una fila **no
compila** hasta que alguien escriba cómo producirla. Eso convierte «faltó probar un caso» en un
error de compilación.

**Gherkin como insumo, NO como runner.** Los escenarios van en Dado/Cuando/Entonces, en lenguaje
natural y sin artefactos de código (restricción de Martin, y es la que impide que la capa
degenere en tests acoplados a la implementación). Pero el artefacto ejecutable queda en jest o
`node:test`. Razones en `references/especificacion.md`; la decisiva: los seis defectos reales
**no fueron escenarios faltantes, fueron aserciones faltantes**, y Gherkin ejecutable no pone
ninguna valla ahí — agrega una capa más donde un step vacío se lee bien en el reporte.

Aprobar es un acto humano explícito:

```bash
node scripts/mechanical-review/check-especificacion.mjs --aprobar --por "<quien>"
```

En CI **nunca** se pasa `--aprobar`.

### `correr` — la revisión mecánica sobre el diff

```bash
node scripts/mechanical-review/orquestador.mjs [--base origin/main] [--seco] [--fase <id>] [--nivel 2]
```

Corre las fases en orden **barato primero**, deduce el nivel del alcance, sustituye `{{MUTAR}}`
con los rangos de líneas cubiertas del diff, imprime una tabla con PASA/FALLA/OMITIDA/NO-APLICA y
la duración de cada fase, y sale con código 1 si alguna fase bloqueante quedó en rojo.

Antes de proponer un umbral distinto: **leer el diagnóstico de la fase que falló**. Cada guarda
imprime qué hacer y en qué orden.

### `interpretar` — leer los reportes

Los artefactos quedan en `.mechanical-review/out/`: `alcance.json`, `aserciones.json`,
`cobertura-diff.json`, `mutantes.json`, `invariantes.json`, `revisión mecánica.json`, `doctor.json`.
Para explicar un hallazgo, usar `references/interpretacion.md`, que trae los dos casos ejemplares
reales: el test sin `expect` que pasaba en verde, y la mutación de tabla que dejó `tsc`
completamente verde con solo un spec en rojo.

### `ci` — cablearlo

Pegar el fragmento del perfil que corresponda: `references/perfil-pnpm-actions.md` (pnpm, GitHub
Actions, jest + `node:test`, Node 24) o `references/perfil-yarn-bitbucket.md` (yarn v1/Berry, Bitbucket
Pipelines, SonarCloud ya instalado, Node 20-24). Los dos existen porque los ecosistemas difieren en
qué herramientas siquiera pueden instalarse, no por gusto.

**Si el repo no calza con ninguno —lo habitual fuera de esos dos parques— se DERIVA un perfil nuevo**
siguiendo el contrato de `references/evolucion.md`: seis decisiones, todas averiguables con `doctor`.
Lo que no se hace es forzar un perfil ajeno ni inventar uno sin medirlo en un repo real: un perfil
imaginado falla el primer día, que es justo cuando se decide si la herramienta se queda o se apaga.

### `evolucionar` — corregir la herramienta desde el uso

**Todo defecto que aparezca USANDO esta herramienta se corrige EN esta herramienta, no solo en el
repo donde apareció.** Un guarda que dio un falso positivo aquí lo dará en el siguiente repo; un
mensaje que no se entendió no se va a entender la próxima vez.

Los tres síntomas y su gravedad: marcar algo correcto (falso positivo → enseña a ignorar la
herramienta), aprobar algo que debía frenar (**falso negativo → la promesa rota**), y un mensaje que
no dice qué hacer (fricción → empuja al `|| true`).

El procedimiento completo está en `references/evolucion.md`. El paso que no es opcional: **verificar
rompiendo a propósito**. Un guarda que nunca se vio en rojo no está verificado — se ve correcto, que
es distinto, y así pasaron los cinco guardarraíles inútiles que originaron esta herramienta.

Las cuatro cosas que NO se tocan al evolucionar: el criterio de excepción con vencimiento, el gate de
mutación como cero sobrevivientes (nunca un porcentaje), las meta-aserciones, y las reglas de
honestidad.

## Las meta-aserciones: por qué estos gates no pueden pasar en verde sin verificar

Es el modo de falla que más veces se repitió en estos repos, así que cada guarda tiene una razón
por la que no puede caer en él. Si se agrega una valla nueva, **tiene que traer la suya**.

| Modo de falla silenciosa | Quién lo cierra |
| ------------------------ | --------------- |
| checkout superficial → `merge-base` vacío → diff vacío → todo verde | `check-alcance-diff.mjs` aborta con el arreglo escrito (`fetch-depth: 0` / `clone: depth: full`) |
| diff vacío tratado como «nada que objetar» | aborta salvo `--sin-cambios-ok` **explícito** |
| config sin `zonas.critica` → todo nivel 0 en silencio | `cargarConfig` aborta |
| repo con zona crítica declarada y sin cablear las fases de nivel 2 | el orquestador falla en la **configuración**, el primer día |
| `--mutate` que no calza nada → 0 mutantes → exit 0 | `check-mutantes.mjs` falla con 0 mutantes |
| Stryker con `thresholds.break: null` (el **defecto**) imprime score 3% y sale 0 | el gate real lo pone `check-mutantes.mjs`, y el orquestador exige **la fase `mutantes`**, no solo la fase `mutacion` |
| todos los mutantes en `CompileError` → no se probó nada | `check-mutantes.mjs` falla |
| **mutantes en `RuntimeError` o `Ignored` contados como «no hay vivos»**: Stryker tiene seis estados y solo tres son un veredicto. Medido rompiéndolo: un reporte de 20 mutantes todos en `RuntimeError` (o todos en `Ignored`) imprimía «✔ 0 vivos» y salía **0**. Y no es hipotético: la corrida real de `pagos/desenlaces.ts` dejó 13 de 36 en `RuntimeError` | `check-mutantes.mjs` falla si **ningún** mutante tuvo veredicto, falla si los **no cerrados** (`RuntimeError` + `Ignored`) pasan la mitad, y avisa siempre con el desglose. El mensaje final dice «N de M con veredicto», no M |
| **la regla de la mitad contando `CompileError` como si nadie cerrara el mutante**, que ponía en rojo un archivo de cableado tipado con CERO sobrevivientes. Medido en otro repo TypeScript con `strict`: el ensamblador del informe dio `{ Killed: 2, CompileError: 7 }` sobre 9 mutantes y la fase fallaba por 7 > 4,5. Un composition root, un barrel o un ensamblador produce mayoría de `CompileError` **por naturaleza** —vaciar el cuerpo, vaciar el objeto devuelto, vaciar las opciones, devolver `undefined` desde un comparador, cambiar `??` por `&&`, quitar el encadenamiento opcional son todos rechazos de `tsc --strict`—, así que el primer repo con uno lee «la mutación falla» y la saca del pipeline | la regla de la mitad mira solo `RuntimeError` + `Ignored`. Un `CompileError` **sí está cerrado**: lo cierra la fase `tipos`, y un mutante que no typechequea no puede llegar al código entregado, que es una garantía más fuerte que un test porque no depende de que alguien escribiera el caso. La hipótesis de «montaje roto» que la regla quería atrapar la sigue atrapando `conVeredicto === 0`: un `typescript-checker` mal configurado no compila **ninguno** |
| **el razonamiento anterior supuesto en vez de exigido**: contar los `CompileError` como cerrados solo vale si el sistema de tipos los rechaza de verdad en el código entregado, y eso depende de que la fase `tipos` **bloquee**. Con `bloquea: false` el guarda estaría regalando mutantes | si hay `CompileError` y la fase `tipos` no está en el config o no bloquea, `check-mutantes.mjs` **falla** y manda a encenderla. Verificado rompiéndolo en seis direcciones: 2 matados + 7 sin compilar aprueba; los mismos 7 como `RuntimeError` bloquean; como `Ignored` bloquean; 9 de 9 sin compilar bloquea; un sobreviviente bloquea; y 2 matados + 7 sin compilar con `tipos` no bloqueante bloquea |
| **`// Stryker disable` como interruptor del gate**: una línea de comentario en el archivo (o `mutator.excludedMutations`) pone todos los mutantes en `Ignored` y el gate felicitaba | los `Ignored` pasan por el **mismo criterio de excepción** que un sobreviviente: un mutante silenciado garantiza lo mismo que un mutante vivo |
| **fase obligatoria reportada como «no está cableada en el config» cuando sí lo está** — pasaba con `--fase X` y con la cadena abortada, y mandaba a editar un config que estaba bien | el orquestador distingue no-cableada / no-pedida (`--fase`) / no-alcanzada (cadena abortada) |
| **la salida «excepción escrita» que el propio mensaje ofrecía y que nadie leía**: `cubiertoPorExcepcion` solo lo consultaba `check-mutantes.mjs`, así que quien escribía la excepción que el gate le pedía seguía en rojo, y la única salida real era editar `zonas.critica` o borrar la fase — o sea la fricción empujaba al `\|\| true` | el orquestador lee `.mechanical-review/excepciones.md` para las obligatorias de nivel 2 que **no corrieron**, exige que la excepción nombre la valla y una ruta de la zona crítica del diff, y lo imprime como «cubierta por EXC-N, NO verificada» |
| **`--seco` que nunca podía terminar bien**: en el ensayo todas las fases quedan en estado `SECO`, así que la meta-aserción «no ejecutó ninguna valla» disparaba siempre y la rama `aprobar('Ensayo…')` era **código inalcanzable** | `--seco` queda fuera de esa meta-aserción: un ensayo no verifica nada a propósito, y lo que tiene que hacer es decirlo, no salir en rojo |
| **reporte de mutación de otra corrida** en disco (con `--incremental`, con `reports/` cacheado en CI o versionado) → «0 vivos» sobre código que nunca se mutó | `check-mutantes.mjs` exige que el reporte sea **posterior** al alcance, y la fase de mutación **borra** `reports/mutation/` antes de correr |
| reporte válido **de otro módulo** → «0 vivos» de otra cosa | `check-mutantes.mjs` cruza los archivos del reporte contra el alcance del diff |
| **timeout masivo contado como detección**: si el arranque del runner supera `timeoutMS`, todos los mutantes salen `Timeout`, Stryker los cuenta como matados e imprime un score alto con **cero** mutantes matados por un test | `check-mutantes.mjs` falla si `Killed == 0` y hay timeouts, y avisa si los timeouts pasan la mitad |
| fase obligatoria de nivel 2 **omitida** («no hay líneas que mutar») tratada como nota informativa → «Revisión completa» | el orquestador la cuenta como **falla**; si de verdad no aplica, va excepción escrita |
| `--fase X` o `--seco` reportados como «Revisión completa» | el mensaje final distingue corrida parcial / ensayo / completa, y una corrida donde solo se calculó el alcance sale en **rojo** |
| barrido `--todos` que no encuentra ningún archivo de test → verde | `check-aserciones.mjs --todos` falla y nombra los patrones usados |
| lcov ausente o sin los archivos del diff → «100% de nada» | `check-cobertura-diff.mjs` falla y muestra las rutas de ambos lados |
| denominador cero reportado como 100% | se reporta como «0 líneas ejecutables», que es distinto |
| `--passWithNoTests` → 0 tests en verde | `doctor.mjs` lo marca como hallazgo alto |
| archivo de test sin ningún caso → el runner lo cuenta como verde | `check-aserciones.mjs` falla |
| regla de lint escrita en la config de ESLint que **no gobierna** | `doctor.mjs` detecta la coexistencia y dice cuál manda |
| excepción eterna | vencimiento ≤30 días, y vencer hace fallar |
| todas las fases omitidas → «revisión mecánica completo» | el orquestador falla si no ejecutó ninguna |

## Índice de referencias

| Archivo | Cuándo leerlo |
| ------- | ------------- |
| `references/especificacion.md` | escribir la especificación; por qué Gherkin no va como runner |
| `references/restricciones-diseno.md` | configuración real de ESLint, fronteras y límites de forma (punto 3 del enfoque) |
| `references/interpretacion.md` | un gate está rojo y hay que decidir qué significa; los dos casos ejemplares |
| `references/limites.md` | las cuatro clases invisibles + checklist de lectura adversarial |
| `references/perfil-pnpm-actions.md` | cablear en pnpm + GitHub Actions |
| `references/perfil-yarn-bitbucket.md` | cablear en yarn v1/Berry + Bitbucket + SonarCloud |
| `references/adopcion.md` | plan por fases, primer sujeto, y qué instalar con versión exacta |
| `references/evolucion.md` | el repo no calza con ningún perfil; un guarda se equivocó; calibrar un umbral |
| `test/` | 35 meta-aserciones ejecutables; correr `npm test` antes y después de tocar un guarda |
| `references/costo.md` | cuánto suma por cambio y por corrida de CI |

## Reglas de honestidad

- **Nunca decir que esta herramienta reemplaza la revisión humana.** Decir qué clase de defecto automatiza
  y nombrar las cuatro que no. Prometer más le cuesta plata al dueño.
- **Nunca escribir `--since` en una invocación de StrykerJS.** Esa opción **no existe** en
  StrykerJS (es de Stryker.NET). Los blogs de 2026 que la citan están mezclando productos, y
  copiar ese comando produce una corrida que muta el subconjunto equivocado, en verde. El
  acotamiento al diff se hace con `--mutate 'archivo:ini-fin'` generado desde `git diff`.
- **Nunca invocar `npx stryker`.** Ese nombre **no** es StrykerJS: resuelve al paquete `stryker` del
  registro, que es la versión abandonada 1.0.1 de 2019. npx la baja de la red y explota con
  `Cannot find module 'rx'` (comprobado: 58 s tirados). Va siempre
  `node node_modules/@stryker-mutator/core/bin/stryker.js run`.
- **Nunca creer un mutation score sin mirar `Killed` y `Timeout` por separado.** Medido aquí: 42
  timeouts, 0 matados, score 87,5 %, exit 0 — y diez mutantes vivos escondidos detrás. Un score alto
  con `Killed == 0` es un problema de montaje disfrazado de resultado.
- **Nunca leer «0 mutantes vivos» sin mirar cuántos tuvieron veredicto.** Stryker tiene **seis**
  estados y solo `Killed`, `Timeout` y `Survived` dicen algo de la suite. `CompileError`,
  `RuntimeError` e `Ignored` significan «este mutante nunca se evaluó», y sumados pueden ser la
  mayoría de la corrida: medido, 13 de 36 en un archivo real de este backend. El número que
  importa es **N con veredicto de M generados**, no M.
- **Pero «no se evaluó» no es lo mismo que «no está cerrado», y confundirlos cuesta la valla.**
  A un `RuntimeError` no lo cierra nadie, y a un `Ignored` lo silenció una persona. A un
  `CompileError` lo cierra el **sistema de tipos**: el mutante no compila, así que no puede
  existir en el código entregado, y eso es más fuerte que un test porque no depende de que
  alguien escribiera el caso. La consecuencia práctica es la que importa: **un archivo de
  cableado tipado produce mayoría de `CompileError` por naturaleza** —composition root, barrel,
  ensamblador— y tratarlos como medición faltante pone en rojo un diff con cero sobrevivientes.
  Medido en otro repo TypeScript con `strict`: `{ Killed: 2, CompileError: 7 }`, cero vivos, fase en rojo. La premisa
  de esto es que la fase `tipos` **bloquee**, y el guarda ahora la verifica en vez de suponerla.
- **Nunca instalar la revisión mecánica sin excluir `scripts/mechanical-review/**` del lint y del formateador.**
  Medido en el backend de referencia: sus scripts son `eslint "{src,test,scripts}/**/*.{ts,mjs}"` y
  `prettier --check "{src,test,scripts}/**"`, así que vendorizar mete los guardas en los dos y el
  primer día aparecen **101 errores de ESLint que no existían**, con la fase `forma` del propio
  revisión mecánica en rojo por su propio código. Peor arranque imposible para una herramienta cuyo
  argumento es «bloqueante o no existe»: el primer reflejo es apagarla. `init.mjs` ahora lo detecta
  y lo dice, pero hay que hacerlo a mano.
- **Nunca instalar StrykerJS sin fijar `typescript` en 5.x.** Medido: `typescript@7.0.2` quitó
  `ts.parseConfigFileTextToJson`, que es lo que usa el `TSConfigPreprocessor` del sandbox de
  Stryker 9.6.1. La corrida muere con `TypeError: ts.parseConfigFileTextToJson is not a function`
  **antes de generar un solo mutante**, y el stack no menciona TypeScript por ninguna parte.
- **Nunca cablear las fases como `pnpm <script>` sin pensarlo.** Desde pnpm 10 un `pnpm <script>`
  dispara `verify-deps-before-run` y puede correr `pnpm install` **dentro del gate**. Medido aquí:
  la fase `tipos` intentó instalar. En un repo cuya regla es no instalar sin `--frozen-lockfile`,
  eso es un gate que puede tocar el lockfile. Salidas: `verify-deps-before-run=false` en `.npmrc`,
  o invocar el binario directo (`node node_modules/typescript/bin/tsc …`).
- **Nunca escribir `??=` ni `String.replaceAll` en un guarda.** Los dos exigen Node ≥ 15 y el primero
  es **sintaxis**: en un repo con Node 14 el script no llega a ejecutarse, falla al parsear. Hay repos
  con Node 14.15, y la promesa de «solo node y git» se sostiene escribiendo para el Node más
  viejo del parque.
- **Nunca decir que la revisión mecánica cubre las vallas 5 y 10.** La 5 es una configuración que alguien
  tiene que pegar y nadie verifica que esté pegada; la 10 es un humano leyendo.
- **Nunca defender la complejidad ciclomática como predictor de defectos.** Defenderla por
  testeabilidad y mantenibilidad. La otra afirmación no sobrevive al primer incidente.
- **Nunca proponer un umbral sin su criterio de excepción**, ni un gate sin su meta-aserción.
- **Nunca bajar un umbral para que pase un cambio.** El camino es: arreglar, borrar el código
  inalcanzable, o excepción escrita con vencimiento.
- **Antes de prometer tiempos de mutación, medir.** Todas las cifras de `references/costo.md` que
  no dicen «medido aquí» son de terceros.
- Al agregar un gate nuevo, seguir el procedimiento de `references/evolucion.md`: que corra en local
  con un comando, que sea bloqueante o no exista, y **comprobar que falla cuando debe** rompiendo la
  condición a propósito. Ese paso no es opcional: los cinco guardarraíles inútiles que originaron
  esta herramienta pasaron todos por «se ve correcto».
