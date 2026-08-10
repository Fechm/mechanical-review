# Especificacion: <nombre del comportamiento>

> Esta plantilla NO es documentacion. Es el insumo del que se derivan los tests y el
> unico artefacto de la revisión que escribe un humano de punta a punta. Se aprueba
> con `check-especificacion.mjs --aprobar`, queda con su hash en el registro y es de
> SOLO LECTURA mientras se implementa.
>
> Las cuatro secciones son obligatorias y el validador las exige por nombre. Borra
> estos parrafos guia al escribir la tuya.

## Regla de negocio

Escrita por una persona, en lenguaje natural, sin artefactos de codigo. Que tiene que
pasar y por que. Si aca hay nombres de clases, metodos o tablas, la especificacion ya
se acoplo a una implementacion y dejo de servir para detectar que la implementacion
esta equivocada.

Ejemplo del tono correcto:

> Un profesional se cobra una sola vez por periodo. Si el cargo queda en un estado no
> definitivo, ningun otro proceso puede iniciar un cargo nuevo para ese profesional y
> ese periodo hasta que el primero se resuelva. Un cargo rechazado por la pasarela se
> puede reintentar; uno aprobado, no.

## Desenlaces

**La tabla es la pieza central.** Una fila por desenlace posible. De ella se derivan
los tests: en el modulo de cobro los escenarios son un `Record<Desenlace, Escenario[]>`,
asi que agregar una fila NO COMPILA hasta que alguien escriba como producirla. Ese es
el mecanismo que convierte "faltó probar un caso" en un error de compilacion.

Reglas al llenarla:

- Un desenlace por fila, con nombre estable (se usa como clave en el codigo).
- La columna **estado persistido** es obligatoria: es lo que el test tiene que
  afirmar. Un test que solo comprueba que la funcion no lanzo no verifica el desenlace.
- La columna **efecto externo** lista lo que se le pide a terceros. Todo lo que este
  ahi tiene que aparecer dentro de una asercion en el test, no solo en el arrange.
  El defecto que motivo esta columna es un test titulado "revoca la tarjeta anterior y
  la da de baja en la pasarela" que no tenia ni un `expect` sobre esa llamada.
- Si un desenlace no se puede producir en un test, no es un desenlace: es una
  suposicion. Sacarlo o explicar como se produce.

| desenlace | precondicion | disparador | estado persistido | efecto externo | reintentable |
| --------- | ------------ | ---------- | ----------------- | -------------- | ------------ |
| `<nombre>` |             |            |                   |                | si / no      |

## Invariantes

Lo que debe ser verdad SIEMPRE, sin importar el orden ni la concurrencia. Cada
invariante declara su `sosten:` — que la sostiene mecanicamente. El validador
`check-invariantes.mjs` verifica que ese sosten exista de verdad.

Cuatro clases de sosten admitidas:

- `sosten: constraint` o `sosten: indice unico \`nombre\`` → el identificador tiene que
  aparecer en el SQL versionado. **Es la unica valla real contra el doble cobro:** no
  la cierra ningun test, ningun linter y ningun mutante, porque los mutantes se
  evaluan con la misma suite secuencial.
- `sosten: tipo \`Identificador\`` → tiene que aparecer en el codigo fuente. Sirve
  cuando la invariante se sostiene por construccion (union discriminada, `satisfies`,
  exhaustividad con `never`), que es el sosten mas fuerte de todos porque falla en
  `tsc` y no en un `expect`.
- `sosten: test \`ruta/al/spec.ts\`` → el archivo tiene que existir.
- `sosten: produccion \`nombre\`` → tiene que estar declarada en
  `.mechanical-review/invariantes-produccion.md`. Para lo que CI no puede comprobar.

Ejemplos:

- Nunca dos cargos en estado no definitivo para el mismo profesional y periodo.
  sosten: indice unico `ux_cargos_periodo_candado`
- Todo desenlace que libera el candado escribe un estado definitivo.
  sosten: tipo `EstadoEnCandado`
- Nunca dos cargos exitosos para el mismo profesional y periodo (verificacion sobre
  los datos, no en CI). sosten: produccion `dos-cargos-exitosos`

## Escenarios

Dado / Cuando / Entonces, en lenguaje natural, uno por desenlace de la tabla. **Sin
artefactos a nivel de codigo**: la restriccion es de Martin y es la que impide que
esta capa degenere en tests acoplados a la implementacion.

Estos escenarios NO se ejecutan con Cucumber. Son el insumo del que se escriben los
tests en el runner que ya tiene el repo (jest o `node:test`), donde ademas la mutacion
puede morder. La razon esta escrita en `references/especificacion.md`: los defectos
reales no fueron escenarios faltantes, fueron aserciones faltantes, y Gherkin
ejecutable no pone ninguna valla ahi — agrega una capa mas donde un step vacio se lee
bien en el reporte.

### `<nombre del desenlace>`

- **Dado** …
- **Cuando** …
- **Entonces** el estado persistido queda en … y se le pidio a … que …

---

## Aprobacion

| campo | valor |
| ----- | ----- |
| aprobada por | |
| fecha | |
| cubre (globs) | |

Al terminar: `node scripts/mechanical-review/check-especificacion.mjs --aprobar --por "<quien>"`
y versionar `especificacion/registro.json` en el mismo commit. El diff del registro es
la constancia de la aprobacion; sin eso, cualquiera puede mover la intencion para que
calce con el codigo y la revisión mecánica quedaria verde sobre la intencion cambiada.
