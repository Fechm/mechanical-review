# mechanical-review

**Vallas mecánicas para código generado por agentes.** Convierte la revisión visual de un diff en
comprobaciones que se ejecutan, bloquean, y traen escrito qué hacer cuando fallan.

No reemplaza la revisión humana. Automatiza **una** clase de defecto —el guard escrito a medias, el
desenlace sin prueba, el test que ejecuta código sin verificar nada— para liberar atención hacia las
que ninguna máquina ve. La sección [Qué NO hace](#qué-no-hace) es parte del diseño, no un descargo.

---

## El problema

Un agente escribe 400 líneas y 20 tests. Todo pasa en verde. La cobertura dice 100%. ¿Está bien?

La cobertura solo garantiza que la línea **se ejecutó**, no que alguien haya **mirado el resultado**.
Este test da 100% de cobertura, tiene una aserción, y no verifica nada:

```js
expect(() => esRevocable('PENDING')).not.toThrow();
```

Comprueba que la función no explote. Si mañana alguien cambia `return true` por `return false`, el
test sigue verde y el bug llega a producción.

Ese defecto apareció **seis veces en una sola sesión** sobre un módulo de cobro con ~700 tests
encima. Es difícil de ver leyendo y trivial de detectar mecánicamente. De ahí esta herramienta.

---

## Glosario

Si vienes de un pipeline clásico (lint + tests + cobertura), estos términos son los nuevos.

### Mutación y mutantes

**Mutación (mutation testing)** — la técnica central. La herramienta toma tu código y **lo rompe a
propósito**, un cambio pequeño a la vez: cambia un `>` por `>=`, un `true` por `false`, borra el
cuerpo de una función, invierte un `&&`. Luego corre tus tests contra cada versión rota.

**Mutante** — cada una de esas versiones rotas. Un archivo de 100 líneas puede generar 200 mutantes.

**Mutante matado** (*killed*) — algún test falló al enfrentarlo. **Esto es lo bueno**: significa que
tus tests sí detectan ese error.

**Mutante vivo** (*survived*) — todos los tests pasaron con el código roto. **Esto es lo malo**: esa
línea podría estar equivocada en producción y tu suite no se enteraría. El gate de esta herramienta
es **cero mutantes vivos sin justificación escrita** en el código que tocaste.

> **La confusión más común:** "vivo" suena a bueno y "matado" a malo. Es al revés. Piensa en los
> mutantes como bugs que tú mismo plantaste: quieres que **todos** mueran atrapados por un test. Uno
> que sobrevive es un bug que tu suite dejaría pasar.

**Los seis estados de un mutante.** Stryker (el motor de mutación en JS/TS) reporta seis, y **solo
tres son un veredicto sobre tu suite**:

| Estado | ¿Qué significa? | ¿Cierra el mutante? |
| --- | --- | --- |
| `Killed` | Un test lo atrapó | ✅ Sí, por un test |
| `Timeout` | El mutante colgó la ejecución (típicamente un bucle infinito) | ✅ Sí, cuenta como detectado |
| `Survived` | Ningún test falló | ❌ **No. Este es el hallazgo** |
| `CompileError` | El mutante no compila | ✅ Sí, **lo cierra el sistema de tipos** |
| `RuntimeError` | La corrida murió por un problema del montaje | ❌ No: nunca se evaluó |
| `Ignored` | Alguien lo silenció con `// Stryker disable` | ❌ No: es un mutante vivo con permiso |

`CompileError` merece explicación porque parece un fallo y no lo es: si el mutante **no compila**, no
puede existir en el código que entregas. Eso es una garantía *más fuerte* que un test, porque no
depende de que alguien se acordara de escribir el caso. Por eso los reportes dicen cosas como
*"242 Killed, 0 Survived, 80 CompileError"* y eso es un resultado limpio. (Un archivo de cableado
tipado —composition root, barrel, ensamblador— produce mayoría de `CompileError` por naturaleza.)

**Mutation score** — el porcentaje de mutantes detectados. **Esta herramienta NO lo usa como
umbral**, a propósito: el score sube agregando tests mediocres, así que fijar "score ≥ 80%" reproduce
el incentivo perverso de la cobertura. El gate es cero sobrevivientes sobre un conjunto acotado.

**Mutante equivalente** — un mutante que cambia el código sin cambiar su comportamiento observable
(p. ej. `i++` por `++i` en un contexto donde da igual). Es imposible matarlo con un test, y perseguir
el 100% de score es gastar dinero en estos. Van a excepción escrita, o —mejor— se reescribe el código
para que el mutante no exista.

### Cobertura

**Cobertura de líneas** — qué porcentaje de líneas ejecutó la suite. Dice poco: no distingue entre un
test que verifica y uno que solo pasa por ahí.

**Cobertura del diff** — lo mismo, pero solo sobre las líneas que **tu cambio** agregó o modificó.
Aquí no es un gate final: su función real es **decidir dónde mutar** (no tiene sentido mutar una
línea que ningún test ejecuta).

### Las otras vallas

**Piso de aserciones** — la comprobación de que no existan tests sin `expect`, `expect()` sin matcher,
tests tautológicos (`expect(true).toBe(true)`), ni archivos de test sin casos. Barato y muy rentable:
la evidencia dice que el número de aserciones correlaciona con detectar bugs reales, y la cobertura
de línea no.

**Complejidad ciclomática** — cuántos caminos distintos puede tomar una función. El umbral acá es 8.
**Se defiende por testeabilidad y mantenibilidad, no como predictor de bugs** — esa segunda
afirmación no sobrevive al primer incidente en una función simple.

**Zona crítica** — las rutas del repo que tú declaras como sensibles (dinero, autorización, datos
personales). Es lo que decide el nivel de exigencia. **Mientras esté vacía, la mutación nunca corre.**

**Excepción con vencimiento** — la salida cuando una valla no se puede cumplir. Exige motivo real,
responsable y fecha de vencimiento ≤30 días; al vencer, el gate vuelve a ser obligatorio solo. Sin
vencimiento, el archivo de excepciones *es* un `|| true` con mejor letra.

**Meta-aserción** — el concepto más distintivo de esta herramienta: **cada valla trae una comprobación
de que no puede aprobar por accidente**. Ejemplos reales que se midieron rompiéndolos a propósito:

- Un checkout superficial en CI deja el diff vacío → todo verde sin revisar nada.
- Un `--mutate` que no calza ningún archivo → 0 mutantes → exit 0 → "aprobado".
- Un reporte de mutación de **otra corrida** en disco → "0 vivos" sobre código que nunca se mutó.
- 42 timeouts, 0 matados, score 87,5%, exit 0 — con diez mutantes vivos escondidos detrás.

Cada uno de esos casos hace **fallar** el guarda correspondiente. Si agregas una valla nueva, tiene
que traer la suya.

---

## Las diez vallas

| # | Valla | Gate | ¿Se ejecuta? |
| - | ----- | ---- | ------------ |
| 1 | Especificación aprobada | existe, completa, su hash no cambió sin re-aprobar | ✅ bloquea |
| 2 | Tipos | `strict` + `noFallthroughCasesInSwitch` + `noUncheckedIndexedAccess`, 0 errores | ✅ bloquea |
| 3 | Piso de aserciones | 0 tests sin aserción, sin matcher o tautológicos | ✅ bloquea |
| 4 | Forma | complejidad ≤8, ≤60 líneas/función, profundidad ≤3, ≤4 params | ✅ bloquea |
| 5 | Dependencias unidireccionales | 0 violaciones de capa | ⚠️ **configuración que hay que pegar** |
| 6 | Cobertura del diff | precondición de la mutación; 100% en zona crítica | ✅ bloquea |
| 7 | **Mutación acotada** | **cero mutantes vivos sin justificación** | ✅ bloquea |
| 8 | Secretos | 0 hallazgos nuevos en el diff (gitleaks) | ✅ bloquea |
| 9 | Invariantes de esquema | cada invariante declarada tiene soporte mecánico | ✅ bloquea |
| 10 | Lectura adversarial | firmada por un humano en zona crítica | ❌ **es un acuerdo, no un gate** |

Ocho se ejecutan y bloquean. **Las vallas 5 y 10 no**, y decirlo es parte del diseño: la 5 depende de
que alguien copie una configuración de ESLint y nada verifica que esté pegada; la 10 depende de que
alguien lea. Presentarlas como cubiertas sería el mismo defecto que la herramienta persigue.

## Los tres niveles

El nivel **no lo elige quien corre el comando**: se deduce del diff contra la zona crítica declarada.
Se puede forzar hacia arriba, nunca hacia abajo.

| Nivel | Qué toca el diff | Vallas | Costo por corrida |
| ----- | ---------------- | ------ | ----------------- |
| **0 · periférico** | docs, config, UI sin lógica | alcance, excepciones, tipos, forma, aserciones, tests | +5-7 s |
| **1 · negocio** | lógica fuera de la zona crítica | + especificación, cobertura del diff, código muerto | +6-9 s |
| **2 · crítico** | dinero, autorización, datos personales | + mutación, secretos, invariantes, lectura adversarial | +1,4 s por mutante |

Los tiempos son **medidos**, no estimados. El de nivel 2 depende de acotar el grafo de tests de la
corrida de mutación: sin acotarlo, un mismo archivo pasó de 1 min 12 s a **19 min 36 s** y el
resultado quedó inválido.

---

## Instalación

### Como skill de Claude Code

```bash
git clone https://github.com/<usuario>/mechanical-review ~/.claude/skills/mechanical-review
```

A partir de ahí se invoca con `/mechanical-review`, y el agente la carga sola cuando el trabajo lo
pide. También funciona sin Claude Code: los scripts son Node puro y se corren a mano (ver abajo).

### En un repositorio

Requisitos: **Node y git** para los guardas (escritos para el Node más viejo del parque, sin
`??=` ni `replaceAll`). Para la valla de mutación, StrykerJS; para secretos, gitleaks.

```bash
# 1. Diagnosticar el repo: qué se puede instalar y qué está apagado
node scripts/doctor.mjs --repo /ruta/al/repo

# 2. Instalar (vendoriza los guardas en <repo>/scripts/mechanical-review/)
node scripts/init.mjs --repo /ruta/al/repo --perfil pnpm-actions|yarn-bitbucket

# 3. Correr sobre el diff
node scripts/mechanical-review/orquestador.mjs --base origin/main
```

`init` **no toca** `package.json`, lockfiles ni el YAML de CI: imprime lo que hay que pegar. Después
quedan tres cosas a mano, y **la primera decide todo**: declarar `zonas.critica` en
`.mechanical-review/config.json`. Mientras esté vacía, todo el diff es nivel 0/1 y la mutación nunca corre.

Los guardas se **vendorizan** dentro del repo a propósito: un gate que solo existe en la máquina de
quien tiene la herramienta instalada no es un gate del repo — no corre en CI y nadie más lo puede
reproducir.

### Perfiles

Vienen dos, porque los ecosistemas difieren en qué herramientas siquiera pueden instalarse
(`dependency-cruiser` 18 exige Node ≥22; `typescript-eslint` 8 exige ESLint ≥8; StrykerJS exige
Node ≥20):

- **`pnpm-actions`** — pnpm + GitHub Actions + jest/`node:test` + Node 24
- **`yarn-bitbucket`** — yarn v1/Berry + Bitbucket Pipelines + SonarCloud + Node 20-24

**¿Y si tu repo no calza con ninguno?** Es lo esperable, y no hay que forzarlo: `doctor` diagnostica
el repo y la herramienta **deriva un perfil nuevo** siguiendo el contrato documentado en
[`references/evolucion.md`](references/evolucion.md). Los dos que vienen son puntos de partida
medidos, no las únicas opciones válidas.

---

## Qué NO hace

Cuatro clases de defecto quedan fuera **por construcción**, y ningún test las habría encontrado:

1. **Especificación equivocada** — si el mismo agente escribe el código y los tests, un malentendido
   de requisitos se propaga idéntico a ambos, y el pipeline queda verde sobre la intención errónea.
   La mutación no salva eso: mata mutantes contra la intención equivocada, con eficiencia.
2. **Fuga de secretos y superficie de datos** — una clave mal configurada que expone hashes de
   contraseña; credenciales que se van al log por la query string. La mutación **suprime a propósito**
   los nodos de logging, que es justo donde pasó.
3. **Concurrencia** — una ventana que permite cobrar dos veces no la cierra ningún test, ningún
   linter y ningún mutante (se evalúan con la misma suite secuencial). La cierra un índice único.
4. **Autorización** — quién puede hacer qué.

**Tres de los cuatro hallazgos más graves** de la sesión que originó esta herramienta caen ahí.

La formulación honesta es: *automatizo el defecto recurrente para liberar atención humana hacia los
que la máquina no ve por construcción*. Es además la única que sobrevive a una auditoría posterior si
algo falla en producción.

Las dos implementaciones industriales de referencia hacen lo mismo: en Google los mutantes vivos
aparecen como comentarios **dentro** del code review, no en su lugar; en Meta, el 27% de los tests
generados fue **rechazado por ingenieros que los leyeron**.

---

## Estructura

```
SKILL.md                      instrucciones para el agente (el contrato completo)
README.md                     este archivo
assets/especificacion.plantilla.md
references/
  especificacion.md           cómo escribir la especificación; por qué Gherkin no va como runner
  restricciones-diseno.md     configuración real de ESLint y fronteras entre capas
  interpretacion.md           un gate está rojo: qué significa (con dos casos reales)
  limites.md                  las cuatro clases invisibles + checklist de lectura adversarial
  perfil-pnpm-actions.md          cablear en pnpm + GitHub Actions
  perfil-yarn-bitbucket.md              cablear en yarn + Bitbucket + SonarCloud
  adopcion.md                 plan por fases y qué instalar con versión exacta
  costo.md                    cuánto suma por cambio y por corrida de CI
scripts/                      los guardas (solo node + git)
```

## Trampas conocidas

Medidas, no supuestas. Están completas en `SKILL.md`; las cuatro que más tiempo cuestan:

- **`npx stryker` no es StrykerJS.** Resuelve a un paquete abandonado de 2019 y explota con
  `Cannot find module 'rx'`. Va `node node_modules/@stryker-mutator/core/bin/stryker.js run`.
- **`--since` no existe en StrykerJS** (es de Stryker.NET). Los blogs que lo citan mezclan productos.
  El acotamiento al diff se hace con `--mutate 'archivo:ini-fin'`.
- **StrykerJS necesita `typescript` 5.x.** Con 7.x muere antes de generar un solo mutante, y el stack
  no menciona TypeScript por ninguna parte.
- **Excluye `scripts/mechanical-review/**` del lint y del formateador antes de instalar**, o el primer día
  aparecen ~100 errores de ESLint que no existían y el reflejo es apagar la herramienta.

## Reglas de honestidad

Las que gobiernan cualquier cambio a esta herramienta:

- Nunca decir que reemplaza la revisión humana.
- Nunca proponer un umbral sin su criterio de excepción, ni un gate sin su meta-aserción.
- Nunca bajar un umbral para que pase un cambio: se arregla, se borra el código inalcanzable, o va
  excepción escrita con vencimiento.
- Antes de prometer números, medirlos — y volver a medirlos antes de citarlos.
- Al agregar un gate: que corra en local con un comando, que sea bloqueante o no exista, y
  **comprobar que falla cuando debe** rompiendo la condición a propósito.
