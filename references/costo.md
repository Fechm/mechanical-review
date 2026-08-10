# Cuánto suma esto por cambio y por corrida de CI

Todo lo marcado **medido aquí** salió de correrlo en esta máquina (Windows 11, Node 24.15.0, pnpm
11.1.1) sobre el backend de referencia en el commit `7b411b8`. Lo que no lo diga es estimación o de
terceros, y está marcado.

## 1. Los guardas propios: prácticamente gratis

Los ocho `.mjs` no tienen dependencias y corren sin `node_modules`. **Medido aquí:**

| Guarda | Sujeto | Tiempo |
| ------ | ------ | ------ |
| `check-alcance-diff.mjs` | diff de 19 archivos | 1,0 – 1,6 s |
| `check-excepciones.mjs` | 4 excepciones | 0,5 – 0,7 s |
| `check-aserciones.mjs` (diff) | 1 archivo de test | 0,5 – 0,7 s |
| `check-aserciones.mjs --todos` | **44 specs / 527 casos del backend** | **0,77 – 1,08 s** |
| `check-especificacion.mjs` | 1 especificación | 0,5 – 0,7 s |
| `check-cobertura-diff.mjs` | lcov + diff | 0,5 – 0,6 s |
| `check-invariantes.mjs` | 2 invariantes + SQL | 0,5 – 0,6 s |
| `check-mutantes.mjs` | reporte de 52 mutantes | 0,4 – 0,7 s |
| `doctor.mjs` | repo completo | ≈ 2 s |

**Total de los ocho: 5 – 7 segundos.** Casi todo es el arranque de Node (≈0,4 s × 8), no trabajo: el
barrido de 527 casos de test tarda menos que arrancar el proceso dos veces.

Las fases `tipos`, `forma` y `tests` **no las agrega la revisión mecánica**: son las que el repo ya paga.
La revisión mecánica solo las ordena y exige que sean bloqueantes.

## 2. Lo que sí cuesta

### `muerto` (knip) — 26,6 s **medido aquí**, y descargando de la red

Esa primera corrida fue `npx knip`, que baja el paquete. Instalado como devDependency baja mucho,
pero sigue siendo la fase no bloqueante más cara. Es la primera candidata a sacar si hay que recortar.

### `secretos` (gitleaks) — no medido

No está instalado en esta máquina, así que la fase falla en seco (correcto: no aprueba por ausencia).
Referencias de terceros la ponen en segundos sobre un diff; no está medido aquí.

### Mutación — el número que decide todo

**Sujeto medido:** `src/modules/pagos/pagos/identificadores.util.ts`, **99 líneas**,
**52 mutantes** generados. Backend con 44 suites / 705 tests.

| Montaje | Arranque del runner | Corrida completa | Por mutante | Resultado |
| ------- | ------------------- | ---------------- | ----------- | --------- |
| grafo de tests **sin acotar** (13 suites de Nest, 317 tests) | **75,2 s** (674 ms netos de test → **99,1 % de overhead**) | **19 min 36 s** | 22,6 s | **INVÁLIDO**: 42 Timeout, 0 Killed, score 87,5 % |
| grafo **acotado** a la spec que cubre el archivo (1 suite, 13 tests) | **4,3 s** | **59 s** de Stryker / 71 s de reloj | **1,1 s** | válido: 34 Killed, **12 Survived**, 6 NoCoverage, 0 Timeout |

**Segundo sujeto medido**, para no extrapolar de un solo archivo:
`pagos/desenlaces.ts`, 486 líneas, **36 mutantes**, grafo acotado a 4 specs.
**7 min 1 s**, 83 tests por mutante en promedio. Resultado: 12 Killed, **8 Survived**, 3 NoCoverage
y **13 RuntimeError** — 36 % de la corrida sin veredicto.

Ese 36 % es un dato de costo, no solo de calidad: se pagaron 7 minutos y un tercio del resultado no
dice nada. Antes ni se reportaba; ahora `check-mutantes.mjs` lo imprime y falla si pasa la mitad.

**La densidad de mutantes por línea NO es transferible entre archivos.** Medido: 0,53 mutantes/línea
en `pagos/identificadores.util.ts` y **0,074** en `pagos/desenlaces.ts` — un factor de 7.
La diferencia es qué tiene el archivo: lógica con operadores y literales genera mutantes, y las
declaraciones de tipos, tablas y uniones discriminadas casi ninguno. Consecuencia práctica: las
extrapolaciones de más abajo son **órdenes de magnitud, no presupuestos**. Para un módulo concreto,
la forma barata de saber cuánto va a costar es `--dryRunOnly` y contar los mutantes generados.

Tres conclusiones, y las tres cambian cómo se cablea esto:

1. **Acotar el grafo de tests vale 16x.** No es una optimización: es la diferencia entre 20 minutos
   y un minuto por archivo.
2. **El costo de la mutación en un backend de Nest es el arranque del runner, no los tests.** 674 ms
   de tests contra 75 s de arranque. Cualquier cosa que reduzca el arranque (acotar el grafo,
   `isolatedModules`, `swc` en lugar de `ts-jest`) rinde más que subir la concurrencia.
3. **El montaje malo no da un resultado peor: da un resultado falso.** Los 42 Timeout se contaron
   como matados y el score subió a 87,5 % con **cero** mutantes matados por un test, escondiendo doce
   mutantes vivos. Por eso `check-mutantes.mjs` ahora falla si no hubo ni un `Killed`, y también si
   ningún mutante llegó a tener veredicto (`RuntimeError` / `Ignored` incluidos).

### La revisión mecánica completo de nivel 2, punta a punta — **medido aquí**

Corrida real sobre un diff de zona crítica (1 archivo de fuente + 1 spec, 11 líneas agregadas):

| Fase | Tiempo |
| ---- | ------ |
| alcance | 1,6 s |
| excepciones | 0,5 s |
| tipos (`tsc` × 2 proyectos) | 88 s |
| forma (eslint + prettier del repo) | 104 s |
| aserciones | 0,6 s |
| especificación | 0,6 s |
| tests (44 suites, 706 tests, con cobertura) | 104 – 137 s |
| cobertura del diff | 0,6 s |
| secretos | 0,1 s |
| invariantes | 2,1 s |
| mutación acotada (11 mutantes sobre 4 líneas) | 46 s |
| mutantes | 0,6 s |
| **total de reloj** | **≈ 5 – 6 min** |

Lo que hay que leer de esa tabla: **de los ~5 minutos, 3,5 son `tipos` + `forma` + `tests`, que el
repo ya paga hoy**. Lo que la revisión mecánica agrega de verdad son los ~7 s de guardas más los 46 s de
mutación. El titular honesto es «+1 minuto en un diff chico de zona crítica», no «+5 minutos».

**Estimación, NO medida:** `pagos/cobro.service.ts` tiene ~2.500 líneas. A la densidad medida
(0,43 mutantes por línea) serían ~1.075 mutantes; a 1,4 s cada uno, ~25 minutos con el grafo acotado
— y no terminaría nunca sin acotar. Esa es la razón de fondo de acotar al diff y no al módulo.

### Instalación (una vez por repo) — **medido aquí**

| | |
| - | - |
| `pnpm install --frozen-lockfile` del backend | 42,8 s (store caliente) / 89,6 s |
| `@stryker-mutator/core` + `jest-runner` | 17,3 s |
| `jest-environment-node` (obligatorio con pnpm) | 8,1 s |

## 3. Costo por cambio, que es la pregunta real

| Nivel | Qué corre | Suma sobre lo que el CI ya tarda |
| ----- | --------- | -------------------------------- |
| **0 · periférico** | alcance, excepciones, aserciones, tipos, forma, tests | **+5 – 7 s** |
| **1 · negocio** | + especificación, cobertura del diff, (muerto) | **+6 – 9 s**, o +33 s si se deja `muerto` |
| **2 · crítico** | + mutación acotada al diff, secretos, invariantes | **+1,4 s por mutante del diff** |

Para el nivel 2, la cuenta que importa es **cuántos mutantes genera un diff**, no el repo. Con la
densidad medida (0,43 mutantes por línea de fuente) y el acotamiento de la revisión (solo líneas
**agregadas** y solo las **cubiertas**):

| Líneas cubiertas en el diff | Mutantes ≈ | Mutación ≈ |
| --------------------------- | ---------- | ---------- |
| 10 | 4 | 6 s |
| 50 | 21 | 30 s |
| 150 | 64 | 1,5 min |
| 500 | 215 | 5 min |

Más el arranque de la corrida de Stryker (dry run: 4,5 s acotado, 76 s sin acotar), que se paga una
vez por corrida y **domina** en los diffs chicos. Es decir: en un diff de 10 líneas, la mutación
cuesta unos 10 s en total; en uno de 500, unos 5 minutos.

Google reporta mediana de **2 mutantes vivos por diff** y percentil 99 de 43 — o sea que el trabajo
humano de revisar sobrevivientes también está acotado, y es lo que hace realista el gate de «cero
sobrevivientes sin justificar».

## 4. El costo humano, que nadie cuenta y es el más caro

**Medido en esta sesión:** clasificar los 12 sobrevivientes de un archivo de 99 líneas —leer el
código, decidir si falta una aserción, si falta un desenlace o si el mutante es equivalente— tomó del
orden de **20 minutos**. Por archivo pequeño, la primera vez. Y los 20 sobrevivientes de los dos
archivos medidos son 20 decisiones humanas que hoy nadie está tomando.

Eso es el número a poner sobre la mesa: la mutación no cuesta minutos de CI, cuesta **atención
humana por sobreviviente**. Y es exactamente el gasto que se quiere, porque es lectura dirigida a
un lugar concreto en vez de lectura de todo el diff. Pero hay que decirlo antes, no después.

Y la lectura adversarial de nivel 2 (`limites.md`) es otro rato humano que la revisión mecánica **no
reemplaza**: es la valla de las tres clases de defecto más graves que aparecieron en la auditoría del
módulo de cobro.

## 5. Dónde recortar si hay que recortar, en orden

1. **`muerto` (knip).** No bloquea, cuesta 27 s. Sacarla o correrla nocturna.
2. **La mutación fuera del PR**, en un job nocturno sobre el diff acumulado del día. Se pierde el
   bloqueo, se conserva la señal. Es un trinquete, y como todo trinquete necesita excepción escrita
   con vencimiento.
3. **`--incremental` de Stryker**, con `incrementalFile` fuera de `reports/`. Ojo: reduce tiempo y
   **aumenta** el riesgo de reporte viejo. El guarda ahora lo detecta por fecha, pero la combinación
   pide disciplina de `.gitignore`.
4. **Nunca**: bajar el umbral de cobertura del diff, ni pasar una fase a `bloquea: false`, ni
   `|| true`. Eso no recorta costo, recorta la valla.
