# Interpretar un gate en rojo

Los artefactos quedan en `.mechanical-review/out/`: `alcance.json`, `aserciones.json`,
`cobertura-diff.json`, `mutantes.json`, `invariantes.json`, `excepciones.json`,
`revisión mecánica.json`, `doctor.json`.

La regla general, y no es negociable: **antes de proponer un umbral distinto, leer el diagnóstico de
la fase que falló.** Cada guarda imprime qué hacer y en qué orden. El camino nunca es bajar el
umbral: es arreglar, borrar el código inalcanzable, o excepción escrita con vencimiento.

## Los dos casos ejemplares (reales, del módulo de cobro)

### Caso 1 — el test sin `expect` que pasaba en verde

Un test titulado *«revoca la tarjeta anterior… y la da de baja en la pasarela»* no tenía **ni un
`expect`** sobre esa llamada. Cobertura de línea completa, cero verificación. Lo encontró un agente
auditor leyendo, no la suite.

Qué gate lo marca hoy y cómo se lee:

```
✖ Piso de aserciones FALLIDO — 1 caso(s) que no verifican

1. [sin-asercion] test/cobro.test.js:10
    "revoca la tarjeta anterior y la da de baja en el proveedor"
      no contiene NINGUNA asercion. Pasa siempre que no lance, afirmando una
      cobertura que no verifica nada.
```

**Arreglo:** se arregla o se borra. No hay tercera opción y no admite excepción. Y el arreglo
correcto no es agregar cualquier `expect`: es afirmar el **estado persistido** del desenlace y la
llamada externa que el nombre del test promete.

El caso hermano —el test **sí** tiene `expect`s pero no sobre la colaboración que su nombre
anuncia— lo marca la regla heurística `adorno`, que en zona crítica bloquea:

```
▲ src/x.spec.ts:120  "revoca y da de baja"
      usa pasarelaMock y ninguna asercion los menciona.
      HEURISTICA: la valla real para esto es la mutacion.
```

Dice «heurística» a propósito. Ninguna regla de lint puede decidir en general si las aserciones
observan lo que el nombre promete; `jest/expect-expect` no lo atrapa. La valla real es la mutación.

### Caso 2 — la mutación de tabla que dejó `tsc` completamente verde

La sexta auditoría movió una fila de la tabla de desenlaces para que un desenlace sin prueba
escribiera un estado fuera del predicado crítico. Resultado: `tsc` verde, **un solo spec en rojo**.
Un mutante que sobrevivió a todo lo demás.

**Aviso importante y medido:** ese mutante **StrykerJS no lo genera**. Sus mutadores no incluyen
«cambiar una referencia a un miembro de enum por otro miembro». Se comprobó: el archivo de la tabla
puede mutarse con Stryker y ese mutante en particular no aparece en la lista. Ver `limites.md`.

Lo que sí cierra ese caso, y es más fuerte que un test, es la técnica de tipos que el propio módulo
ya usa: derivar el mapa inverso de la tabla y comprobar su inyectividad **al cargar el módulo**, más
un `Exclude<>` que no compila si alguien agrega un estado sin desenlace. Cuando esa comprobación
existe, la mutación de la tabla no produce un spec en rojo: produce **13 suites en rojo al importar**,
que es exactamente lo que se quiere.

## Cómo leer cada gate

### `alcance` — «No se pudo resolver la base de comparación»

Checkout superficial. `fetch-depth: 0` en GitHub Actions, `clone: depth: full` en Bitbucket (y en
pipelines de PR, un `git fetch origin <base>` explícito, porque ahí el clone depth no se aplica).
**No** es un caso para `--sin-cambios-ok`: eso es para un pipeline que corre sobre la rama base sin
cambios propios, y hay que escribirlo en el comando para que la decisión quede visible.

### `aserciones` — `sin-casos`

«El archivo parece un archivo de test y no declara NINGÚN caso.» Dos causas: es un helper que quedó
dentro del patrón de tests (sacarlo del patrón), o el archivo de verdad no tiene casos y el runner
lo cuenta como verde.

### `cobertura-diff` — «Ningún archivo del diff aparece en el reporte de cobertura»

**Esto no es 100 % de cobertura: es cobertura de otra cosa.** Causas verificadas:
`collectCoverageFrom` no incluye esas rutas, `coveragePathIgnorePatterns` o
`sonar.coverage.exclusions` las excluye, o la suite corrió desde otro `cwd`. El gate imprime las
rutas de los dos lados justamente para poder comparar prefijos.

### `cobertura-diff` — «CERO líneas ejecutables en el diff»

Aprueba, y lo dice con esas palabras a propósito: no es 100 %, es un denominador vacío. **Ojo:** eso
deja `mutar` vacío y por lo tanto la fase de mutación se omite. A nivel 2 el orquestador ahora lo
trata como falla, no como nota — si de verdad el cambio en zona crítica es solo declarativo, va
excepción escrita.

### `mutantes` — «El reporte de mutación es ANTERIOR al alcance de esta corrida»

Stryker no corrió en esta corrida y el `reports/mutation/mutation.json` quedó de otra. Con
`--incremental`, con `reports/` cacheado en CI o versionado, es el caso **normal**, no el
excepcional. Borrar `reports/mutation/` antes de la corrida y agregarlo al `.gitignore`.

### `mutantes` — «El reporte no habla de ningún archivo del diff»

El equivalente exacto de «100 % de otra cosa», pero para mutación: el reporte es válido y es de otro
módulo. Verificar el alcance real con
`node scripts/mechanical-review/check-cobertura-diff.mjs --formato stryker`.

### `mutantes` — «N mutantes SOBREVIVIERON sin justificación»

Las tres lecturas, en este orden:

1. **Falta una aserción.** El caso frecuente y el que se busca: el test ejecuta la línea pero no
   observa su efecto. Arreglo: afirmar el estado persistido, no que la función no lanzó.
2. **Falta un desenlace en la especificación.** Si nadie sabe qué debería pasar con esa línea, el
   hueco está en la tabla de desenlaces, no en el test.
3. **Mutante equivalente o irrelevante.** Semánticamente idéntico al original, o toca un nodo árido.
   Recién aquí corresponde excepción escrita con vencimiento.

Lo que **no** corresponde: escribir un test cuyo único propósito sea matar el mutante. Google, con
seis años de datos, cuenta con los revisores para frenar exactamente eso.

### `mutantes` — «Más de la mitad de los mutantes no llegó a ser evaluado»

Cuenta solo `RuntimeError` + `Ignored`, que son los estados donde **nadie** cierra al mutante.
Con esa proporción el número dice más del montaje que de la suite, así que no hay que
interpretarlo: hay que arreglar el montaje y volver a correr.

- `RuntimeError` → el mutante rompe el arranque del módulo o del runner. Correr la suite acotada
  a mano y mirar el error real antes de tocar nada. La causa habitual es el grafo de tests sin
  acotar o un `timeoutMS` demasiado corto.
- `Ignored` → hay un `// Stryker disable` en el archivo o `mutator.excludedMutations` en la
  configuración. Quitarlo, o justificarlo como excepción: un mutante silenciado garantiza lo
  mismo que un mutante vivo.

`CompileError` **no** entra en esta cuenta, por lo que dice la sección siguiente.

### `mutantes` — «N de M mutante(s) sin veredicto (CompileError=N)» (aviso, no falla)

No es una falla y no hay nada que arreglar. Un mutante que no typechequea **está cerrado**: no
puede existir en el código entregado, y eso es más fuerte que un test porque no depende de que
alguien escribiera el caso. Lo cierra la fase `tipos`.

Es esperable —y a veces mayoritario— en archivos de **cableado tipado**: composition roots,
barrels, ensambladores. Ahí los mutadores de Stryker producen sobre todo cosas que
`tsc --strict` rechaza: vaciar el cuerpo de una función con tipo de retorno, vaciar un objeto
literal que satisface una interfaz, devolver `undefined` desde un comparador, cambiar `??` por
`&&` donde eso filtra un `undefined`, quitar un encadenamiento opcional sobre un valor
posiblemente ausente.

Medido en otro repo TypeScript con `strict`: el ensamblador del informe de métricas dio `{ Killed: 2, CompileError: 7 }`
sobre 9 mutantes, con cero sobrevivientes. Antes de esta corrección la fase fallaba por
proporción, y ese es el peor rojo posible para la valla —correcta la suite, correcto el diff,
rojo el gate—, porque el reflejo inmediato es sacar la mutación del pipeline.

**Lo que sí hay que mirar:** que la fase `tipos` siga bloqueando. Si no, el guarda falla con
«Hay mutantes en CompileError y la fase de tipos no los cierra», y tiene razón: sin `tipos`
bloqueante nada rechaza a ese mutante y la garantía desaparece. El arreglo es encender
`bloquea: true`, no silenciar el aviso.

### `invariantes` — «declara sostén de clase esquema en `X` y NO se encontró»

La invariante depende de que todos los caminos de escritura se acuerden de comprobarla. Si no se
puede sostener en el esquema, se declara como verificada **en producción** en
`.mechanical-review/invariantes-produccion.md`, con dónde corre el chequeo y qué hace al fallar. Eso hace
visible cuántas invariantes viven fuera del pipeline.

### `especificacion` — «cambió después de ser aprobada»

Es la circularidad autor/verificador: la intención se movió para calzar con el código. **No hay
excepción posible.** Se lee, se decide a mano si el cambio de intención es el que se quería, y se
re-aprueba con `--aprobar --por "<quien>"`. El diff del registro es la constancia. En CI nunca se
pasa `--aprobar`.

## Y cuando la revisión mecánica dice que pasó

Leer qué dice exactamente:

- `Revisión completa: N valla(s) ejecutada(s), 0 en rojo` → veredicto real.
- `Fase "X": sin rojos … CORRIDA PARCIAL` → **no** habilita nada. Una fase suelta no es el
  revisión mecánica.
- `Ensayo (--seco) terminado … NO se verifico nada` → tampoco.

La distinción existe porque antes las tres imprimían la primera, y una corrida de una sola fase
sobre un diff de zona crítica salía como «Revisión completa».
