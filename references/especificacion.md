# La especificación humana: formato, y por qué Gherkin no va como runner

## Por qué esta es la valla que no se puede recortar

El resumen que circuló presenta la especificación humana como el paso 1 de un pipeline que después
corre solo. En la fuente primaria no es eso. El 01-jun-2026 Martin describe su flujo así: parte de
especificaciones muy informales escritas a mano por él; un agente las convierte en
especificaciones más duras subdivididas en tareas — **y sobre esas dice que las revisa**; recién
entonces esas tareas alimentan al agente `specifier` que las convierte a Gherkin. Y en julio
aclara la división: los tests unitarios los escriben sus agentes y esos **no** los revisa; los
tests de aceptación Gherkin y los procedimientos de QA también los escriben agentes, pero esos
**sí** los revisa.

O sea: no es «no leo nada». Es **«moví mi lectura desde el código hacia la especificación y la
capa de aceptación»**. Si se replica la revisión mecánica sin ese lazo humano, se replica el titular del
agregador, que es un sistema distinto y estrictamente peor.

Hay dos agujeros que solo esta valla tapa:

1. **Especificación equivocada.** Si el Gherkin dice lo que no corresponde, el agente lo
   implementa, lo cubre al 100%, mata todos los mutantes y el pipeline queda verde. El paper de
   mutación de Google lo dice literalmente: la mutación evalúa si un algoritmo está implementado
   correctamente, **no** si es el algoritmo correcto.
2. **Circularidad autor/verificador.** Mientras el mismo agente escriba código y tests, un
   malentendido de requisitos se propaga idéntico a los dos. En el hilo de Hacker News sobre el
   tweet hay un reporte concreto: un agente implementó una feature completamente al revés y pasó
   todos los tests porque también escribió los tests.

## El mecanismo: hash registrado + re-aprobación explícita

`check-especificacion.mjs` mantiene un espejo de hashes en `especificacion/registro.json`, igual
que `check-migration-registry.mjs` del backend de referencia mantiene el espejo de migraciones. Si el
contenido de una especificación cambió y nadie la re-aprobó, **falla**.

```bash
# acto humano, deja constancia en el diff del registro
node scripts/mechanical-review/check-especificacion.mjs --aprobar --por "nombre.apellido"

# en CI, siempre sin --aprobar
node scripts/mechanical-review/check-especificacion.mjs
```

Eso es lo que hace la especificación **de solo lectura durante la implementación** sin depender de
que alguien se acuerde. Y el hash se calcula con CRLF normalizado a LF, porque un guardarraíl que
falla por el sistema operativo de quien lo corre se desactiva en una semana.

El validador también rechaza una especificación que sea **solo prosa**: exige las cuatro secciones
por nombre, al menos una fila de datos en la tabla de desenlaces, y que cada invariante declare su
`sosten:`. Una especificación de la que nadie puede derivar la lista de casos no es insumo de
nada; el agente la va a interpretar libremente.

## Las cuatro secciones, y qué hace cada una

### `## Regla de negocio`

Lenguaje natural, escrita por una persona, **sin nombres de clases, métodos ni tablas**. Si tiene
artefactos de código, la especificación ya se acopló a una implementación y perdió la capacidad de
detectar que esa implementación está equivocada.

### `## Desenlaces` — la pieza central

Una fila por desenlace, con estas columnas:

| desenlace | precondición | disparador | estado persistido | efecto externo | reintentable |
| --------- | ------------ | ---------- | ----------------- | -------------- | ------------ |

Dos columnas son obligatorias por una razón concreta:

- **`estado persistido`** es lo que el test tiene que afirmar. Un test que solo comprueba que la
  función no lanzó no verifica el desenlace. Fue exactamente el hueco que dejó vivo el mutante de
  la sexta auditoría: se movió una fila de la tabla para que un desenlace sin prueba escribiera un
  estado fuera del predicado crítico, y `tsc` quedó completamente verde.
- **`efecto externo`** lista lo que se le pide a terceros. Todo lo que esté ahí tiene que aparecer
  **dentro de una aserción**, no solo en el arrange. Esta columna existe por el test titulado
  «revoca la tarjeta anterior… y la da de baja en la pasarela» que no tenía ni un `expect` sobre esa
  llamada.

De la tabla se derivan los tests. La técnica que ya funcionó: los escenarios son un
`Record<Desenlace, Escenario[]>`, así que **agregar una fila no compila** hasta que alguien
escriba cómo producirla. Eso convierte «faltó probar un caso» en un error de compilación en vez de
un hallazgo de auditoría.

Regla de higiene: si un desenlace no se puede producir en un test, no es un desenlace — es una
suposición. Se saca, o se explica cómo se produce.

### `## Invariantes`

Cada invariante declara `sosten:` — qué la sostiene mecánicamente. `check-invariantes.mjs`
verifica que ese soporte exista de verdad. Cuatro clases:

| Sostén | Se verifica contra | Cuándo usarlo |
| ------ | ------------------ | ------------- |
| `sosten: indice unico \`nombre\`` / `constraint` | el SQL versionado | **la única valla real contra el doble cobro.** No la cierra ningún test, ningún linter y ningún mutante: los mutantes se evalúan con la misma suite secuencial |
| `sosten: tipo \`Identificador\`` | el código fuente | el sostén más fuerte: falla en `tsc`, no en un `expect`. Uniones discriminadas, `satisfies`, exhaustividad con `never` |
| `sosten: test \`ruta/spec.ts\`` | existencia del archivo | cuando la invariante sí es comprobable con una suite |
| `sosten: produccion \`nombre\`` | `.mechanical-review/invariantes-produccion.md` | para lo que CI no puede comprobar |

La cuarta clase es la que Martin no tiene y aquí sí, y viene del argumento de Charity Majors: los
sistemas no deterministas exigen más disciplina de ingeniería, y parte del desplazamiento correcto
va hacia **observabilidad y verificación en producción**. «Nunca dos cargos exitosos para el mismo
profesional y período» es un chequeo sobre los datos, no un test unitario. Obligar a declararlo en
un archivo aparte hace visible cuántas invariantes del sistema viven fuera del pipeline —
información que normalmente nadie tiene.

### `## Escenarios`

Dado / Cuando / Entonces, en lenguaje natural, uno por desenlace, **sin artefactos a nivel de
código**. La restricción es del 07-mar-2026: el Gherkin debe permanecer en lenguaje natural y el
parser debe traducirlo a tests que accedan a la aplicación a través de una API de testing
dedicada. Sin esa restricción, el Gherkin degenera en tests acoplados a la implementación.

## Por qué Gherkin como insumo y NO como runner

Tres razones, en orden de fuerza.

**1. La decisiva, y viene de la evidencia interna, no de los blogs.** Los seis defectos que
encontraron las auditorías **no fueron escenarios faltantes, fueron aserciones faltantes**. Un
test llamado «revoca la tarjeta… y la da de baja en la pasarela» sin un solo `expect` sobre esa
llamada no se arregla agregando una capa de escenarios: Gherkin no pone ninguna valla ahí, y
agrega un lugar más donde un step vacío se lee bien en el reporte. Lo que cierra ese defecto es la
mutación, que necesita morder el artefacto ejecutable.

**2. `@cucumber/cucumber` 13 declara `engines: node 22 || 24 || >=26`.** En el parque donde se midió
esto, seis servicios corrían Node 20 y ninguno lo admitía. Antes de discutir filosofía, comprobar si
la herramienta siquiera instala: en un parque heterogéneo eso suele decidir la pregunta.

**3. Costo de mantenimiento documentado:** doble mantenimiento (feature + step definitions),
acoplamiento por regex de los steps, y casos reportados de 3x esfuerzo antes de abandonarlo.

Dónde queda entonces el artefacto ejecutable: en jest y `node:test`, donde ya hay 678 tests entre
los dos repos de referencia, donde hay cobertura, y donde StrykerJS puede morder.

Complemento liviano con valor real en el mismo lugar: `zod` para **parsear** (no validar) en los
bordes, de modo que la regla de negocio quede en el tipo. Eso además es lo único que caza el
`NaN < MIN` que dejaba pasar justo lo que debía frenar: por tipos, `NaN < MIN` es un `boolean`
perfectamente legítimo y ninguna regla de lint lo va a marcar. Lo que lo caza es que NaN nunca
llegue al guard (parseo en el borde, `Number.isFinite` obligatorio en el constructor del value
object) o un generador de propiedades que produzca NaN sin que nadie lo haya pensado
(`fast-check`).

## Separación de autoría: el requisito organizativo

La única mitigación conocida de la circularidad no es herramental:

- **Quien escribe los tests de aceptación no puede ser el mismo agente/contexto que implementa.**
- La especificación viene aprobada por un humano y queda **read-only** para el agente que codea.
- El auditor adversarial corre en **otro contexto**.

Está validado en el propio historial: los seis defectos los encontró un agente auditor, no el
implementador. Y es lo que hace `swarm-forge` con roles separados (`specifier`, `coder`,
`cleaner`, `architect`, `hardender`, `QA`) y git worktrees — o sea que incluso en la
implementación real de Martin **la revisión de código no se elimina: se delega a otro agente con
otro encuadre**, más aprobación humana de la especificación.
