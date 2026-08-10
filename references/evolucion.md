# Evolución: cómo esta herramienta se adapta al repo y se corrige a sí misma

Esta herramienta nació midiendo dos ecosistemas concretos. **Tu repo casi seguro no es ninguno de
los dos**, y eso es lo esperable: la herramienta está diseñada para derivar lo que le falta, no para
exigir que el repo se le parezca.

## El principio

> **Todo defecto que aparezca USANDO la herramienta se corrige EN la herramienta, no solo en el repo
> donde apareció.**

Un guarda que dio un falso positivo en tu repo lo va a dar en el siguiente. Un mensaje de error que
no se entendió la primera vez no se va a entender la segunda. Arreglar solo el síntoma local
garantiza volver a pagarlo.

Corolario incómodo pero necesario: **si la herramienta se equivocó, el arreglo es un cambio a la
herramienta, con su verificación**. No un `|| true`, no una excepción eterna, no bajar el umbral.

---

## Forma 1 — derivar un perfil para tu ecosistema

Es lo más frecuente y lo más simple. Un perfil es un conjunto de decisiones que dependen del
ecosistema, no de la filosofía.

### El contrato: qué tiene que definir un perfil

| Decisión | Por qué está en el perfil | Cómo se averigua |
| --- | --- | --- |
| **Gestor e instalación congelada** | `npm ci`, `pnpm i --frozen-lockfile`, `yarn --immutable`… un gate que muta el lockfile no es un gate | `doctor` lo detecta del lockfile |
| **Runner de CI y garantía de diff completo** | `fetch-depth: 0`, `clone: depth: full`, o el equivalente. **Sin esto todo aprueba sin revisar nada** | `doctor` lo marca como hallazgo alto si falta |
| **Runner de tests y patrón de archivos** | `*.spec.ts`, `*.test.ts`, `__test__/*`, `test/**`… el piso de aserciones necesita encontrarlos | `doctor` los cuenta; si da 0, el patrón está mal |
| **Node mínimo del parque** | decide **qué herramientas siquiera instalan** (ver tabla abajo) | `engines`, Dockerfile, imagen de CI |
| **Rama base de integración** | `main`, `master`, `develop`, `uat`… el diff se calcula contra ella | preguntar; no adivinar |
| **Exclusiones existentes** | Sonar u otro con `coverage.exclusions` es una vía de escape que hay que auditar antes de confiar en nada | `doctor` las lista |

### El paso que decide todo

Ninguna de esas seis importa tanto como **declarar `zonas.critica`** en la configuración. Mientras
esté vacía, todo el diff es nivel 0/1 y la mutación **nunca corre**: la herramienta queda instalada,
en verde, y sin verificar lo que dice verificar. Si el repo no tiene zona crítica de verdad, decirlo
en voz alta es mejor que instalar un gate decorativo.

### Restricciones de versión conocidas (medidas)

| Herramienta | Exige | Alternativa si no entra |
| --- | --- | --- |
| `@stryker-mutator/core` 9 | Node ≥ 20 | `tap-runner` 9 (Node ≥14, solo con `node:test`) |
| `dependency-cruiser` 18 | Node ^22 \|\| ^24 \|\| ≥26 | 16.10.4 |
| `eslint-plugin-sonarjs` 4, `typescript-eslint` 8 | ESLint ≥ 8 | reglas del core de ESLint |
| StrykerJS + `typescript` 7.x | **incompatible** | fijar `typescript` en 5.x |

Lo que viaja a cualquier repo sin instalar nada: las reglas del core de ESLint y los guardas `.mjs`
(escritos para Node 14 a propósito).

### Procedimiento

1. `doctor --repo <ruta> --sin-escribir` y **leer el diagnóstico completo**.
2. Llenar el contrato de arriba con lo que el doctor encontró. Lo que no encontró, preguntarlo.
3. Escribir `references/perfil-<nombre>.md` copiando la estructura de uno existente.
4. Registrarlo en `init.mjs` (detección automática + defaults).
5. **Medirlo en un repo real antes de documentarlo como perfil.** Un perfil imaginado es una
   configuración que nadie probó, y falla el primer día — que es cuando se decide si la herramienta
   se queda o se apaga.

---

## Forma 2 — calibrar un umbral (trinquete, no aspiración)

La regla es asimétrica y conviene entenderla bien:

- **Nunca bajar un umbral para que pase un cambio.** El camino es arreglar, borrar el código
  inalcanzable, o excepción escrita con vencimiento.
- **Sí calibrar el umbral al instalar**, midiendo el máximo real de hoy y fijando la regla ahí.

No es contradicción: lo primero es ceder ante un cambio concreto; lo segundo es reconocer el punto de
partida. Un umbral ideal impuesto sobre un repo real convierte al mejor código existente en el primer
rojo, y una herramienta que arranca acusando a todo el mundo se apaga en una semana.

Al calibrar, **dejar escrita la medición** («máximo actual: complejidad 14 en `x.ts`; regla en 14, a
bajar a 8 en el trimestre»). Sin ese registro, el trinquete se olvida y el umbral flojo se vuelve
permanente.

---

## Forma 3 — corregir o agregar un guarda

Cuando un guarda se equivoca. Los tres síntomas y qué significan:

| Síntoma | Qué es | Gravedad |
| --- | --- | --- |
| Marca algo correcto como error | falso positivo | alta: enseña a ignorar la herramienta |
| Aprueba algo que debía frenar | **falso negativo** | **crítica: es la promesa rota** |
| El mensaje no dice qué hacer | fricción | alta: empuja al `\|\| true` |

### Procedimiento

1. **Registrar el síntoma con la medición**, no con la impresión. «Falla» no sirve; «marcó 101
   archivos que no existían antes, todos bajo `scripts/`» sí.
2. **Diagnosticar la causa**, no el síntoma.
3. **Corregir en el guarda**, y si el defecto vino del código a verificar, preferir que el código no
   pueda tener el defecto antes que agregar una comprobación.
4. **Verificar rompiendo a propósito.** Este paso no es opcional: hay que comprobar que el guarda
   **falla cuando debe**, no solo que pasa cuando debe. Un guarda que nunca se vio en rojo no está
   verificado — se ve correcto, que es distinto.
5. **Si el modo de falla era "verde sin verificar", agregar su meta-aserción.** Toda valla nueva o
   corregida tiene que traer la suya (ver la tabla en `SKILL.md`).
6. **Dejar la lección escrita junto al código que la explica**, con el formato de abajo.

### Formato de una lección

```
SÍNTOMA:      qué se observó, con números
MEDICIÓN:     cómo se comprobó (comando, salida)
CAUSA:        por qué pasaba
CAMBIO:       qué se modificó
VERIFICACIÓN: cómo se comprobó que ahora falla cuando debe
```

Las lecciones viven **en el archivo que explican** —comentario de cabecera del guarda, o la tabla de
meta-aserciones de `SKILL.md`—, no en un changelog aparte. Un registro separado se desincroniza del
código; un comentario arriba de la función que lo causó, no.

---

## Qué NO se cambia

Estas cuatro no son configuración: son la razón de que la herramienta signifique algo.

1. **El criterio de excepción** (cinco campos, vencimiento ≤30 días, máximo 10 vivas). Sin
   vencimiento, el archivo de excepciones *es* el `|| true` con mejor letra.
2. **El gate de mutación es cero sobrevivientes, nunca un porcentaje.** Un score sube agregando
   tests mediocres; fijar «≥80%» reproduce exactamente el incentivo perverso de la cobertura.
3. **Las meta-aserciones.** Quitar una es volver a habilitar un modo de aprobar sin verificar.
4. **Las reglas de honestidad**, y en particular: nunca decir que esta herramienta reemplaza la
   revisión humana. Es lo único que la hace defendible si algo falla en producción.

Si tu caso parece exigir cambiar una de estas cuatro, es señal de que el umbral está mal calibrado o
el módulo necesita trabajo estructural. Las dos cosas se discuten; acumular excepciones no es
ninguna de las dos.

---

## Cuándo la herramienta tiene que decir que no

Instalarla igual y dejarla en verde es peor que no instalarla, porque produce una garantía falsa.
Casos en que corresponde decirlo explícitamente:

- **`strictNullChecks: false`** → la técnica de hacer inexpresable el estado inválido no funciona. No
  es candidato a nivel 2 hasta migrar.
- **Sin zona crítica real** → nivel 2 sería decorativo. Instalar 0/1 y decirlo.
- **Sin cobertura de partida** → la mutación no tiene dónde morder. Primero tests, después mutación.
- **Node por debajo de lo que exigen las herramientas** → instalar lo que sí entra, nombrar lo que no,
  y no prometer las vallas ausentes.
