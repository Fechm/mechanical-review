# Restricciones de diseño para el agente

Es el punto 3 del enfoque: no basta verificar después, hay que **limitar de antemano la forma** de lo
que el agente puede escribir. Todo lo de aquí es configuración, no prosa: se pega en el repo y falla.

## 1. Forma (reglas del core de ESLint)

Es la única capa de la revisión que viaja a los 27 repos sin instalar nada: son reglas del core, no
están deprecadas y no son de formato, así que corren en eslint 7 igual que en 10.

```js
// eslint.config.mjs  (o .eslintrc.* — pero SOLO en el que gobierna: ver el doctor)
rules: {
  complexity: ['error', 8],
  'max-depth': ['error', 3],
  'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
  'max-params': ['error', 4],
  'max-nested-callbacks': ['error', 3],
}
```

**El 8 no es un número redondo elegido a gusto.** Sale del propio `crap4java` de Martin, que
implementa `CRAP = CC²·(1−cobertura)³ + CC` y falla con score > 8.0. Con cobertura completa,
`CRAP = CC`, así que el gate real es **complejidad ciclomática ≤ 8 por método**. Es el único umbral
numérico con fuente primaria en todo este enfoque, y es más estricto que el 10-15 clásico de Sonar.

**Cómo defenderlo, y cómo no.** Defenderlo por **testeabilidad y mantenibilidad**: una función con CC
8 necesita al menos 8 casos para cubrir sus caminos, y eso es un límite útil. **No** defenderlo como
predictor de defectos: la CC correlaciona con LOC hasta el punto de que hay trabajo publicado
negándole poder explicativo propio, y esa afirmación no sobrevive al primer incidente en una función
con CC baja.

**Arrancar con trinquete, no con el ideal.** Medir el máximo real de hoy y fijar la regla en ese
número:

```bash
npx eslint . --rule '{"complexity":["error",1]}' --format json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s).flatMap(f=>f.messages).map(x=>+(/complexity of (\d+)/.exec(x.message)||[])[1]).filter(Boolean);console.log('maximo real:',Math.max(...m))})"
```

Si el máximo real es 19, la regla arranca en 19 y baja de a uno. `pagos/cobro.service.ts` tiene
~2.500 líneas y es el archivo con más garantías del ecosistema: un umbral ideal convertiría al mejor
código en el primer rojo, y ese es el camino más corto a que alguien apague la regla.

`max-lines-per-function: 60` es el que más fricción produce en NestJS y en tests con `describe`
largos. Excluir los archivos de test del `max-lines-per-function` es legítimo y hay que escribirlo;
excluirlos de `complexity` no.

## 2. Fronteras unidireccionales

`domain` no importa `application`, `infrastructure`, `handlers`, ni el SDK de la nube. La versión que
no necesita instalar nada:

```js
{
  files: ['src/**/domain/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['**/application/**', '**/infrastructure/**', '**/handlers/**'],
          message: 'domain no puede depender de las capas de afuera: invertir la dependencia con un puerto.' },
        { group: ['@aws-sdk/*', 'aws-sdk', '@supabase/*', 'sequelize', '@nestjs/*'],
          message: 'domain no puede conocer la infraestructura ni el framework.' },
      ],
    }],
  },
}
```

Dos reglas de higiene, las dos por experiencia y no por gusto:

- **Severidad `error`, nunca `warn`.** Una regla nacida en `warn` «para ir migrando» es una regla que
  nunca frena nada. Si hay deuda, se usa un baseline explícito y se revisa cada vez que se regenera.
- **El patrón ya funciona en un repo de referencia**, que es el único de los 27 repos que las tiene. No
  hay que inventarlo.

Con `dependency-cruiser` se puede además prohibir ciclos y huérfanos, pero **ojo con la versión**: la
18 exige Node ^22 || ^24 || ≥26 y no entra en los repos con Node 20; ahí va la 16.10.4.

## 3. Hacer el estado inválido inexpresable

Es la restricción con más retorno de todas y **no la mide ningún gate**: se consigue escribiendo los
tipos de cierta forma. Tres piezas, las tres ya probadas en el módulo de cobro:

**a) La tabla de desenlaces como única fuente, y el inverso derivado.**

```ts
const DESENLACES = { cobrado: { status: 'charged', ... }, ... } as const;

// El inverso se DERIVA. Escribir las dos listas a mano es como nacen las que se
// desincronizan. Y la inyectividad se comprueba al CARGAR el módulo: dos desenlaces con
// el mismo estado harían del inverso una elección arbitraria.
const DESENLACE_POR_ESTADO = (() => {
  const mapa = new Map();
  for (const d of DESENLACES_CONOCIDOS) {
    const { status } = DESENLACES[d];
    if (mapa.has(status)) throw new Error(`La tabla no es invertible: '${mapa.get(status)}' y '${d}' escriben '${status}'.`);
    mapa.set(status, d);
  }
  return mapa;
})();
```

Esto es más fuerte que cualquier test, y es lo que convierte «mutar una fila de la tabla» —el mutante
que sobrevivió a la sexta auditoría— en **13 suites en rojo al importar el módulo**, en vez de un
solo spec en rojo. Comprobado: es el comportamiento real de `pagos/desenlaces.ts` cuando se
le cambia una fila.

**b) Cobertura del enum comprobada por tipos.**

```ts
type EstadosSinDesenlace = Exclude<Estado, EstadosDeLaTabla | Estado.PENDING>;
const _COBERTURA: [EstadosSinDesenlace] extends [never] ? true : EstadosSinDesenlace = true;
```

Si alguien agrega un estado sin darle desenlace, **no compila**, y el error nombra el estado que
falta. La versión débil de esto es un `never` en el `default` de un switch: ese avisa al leerlo, este
avisa al agregarlo.

**c) Los escenarios como `Record<Desenlace, Escenario[]>`.** Agregar una fila a la tabla **no
compila** hasta que alguien escriba cómo producirla. Convierte «faltó probar un caso» en un error de
compilación en vez de un hallazgo de auditoría.

## 4. Parsear en el borde, no validar

`zod` (o equivalente) para **parsear** en los bordes, de modo que la regla de negocio quede en el
tipo. Además es lo único que caza el `NaN < MIN` que dejaba pasar justo lo que debía frenar: por
tipos, `NaN < MIN` es un `boolean` perfectamente legítimo y **ninguna regla de lint lo va a marcar**.
Lo que lo caza es que `NaN` nunca llegue al guard (`Number.isFinite` obligatorio en el constructor
del value object) o un generador de propiedades que produzca `NaN` sin que nadie lo haya pensado
(`fast-check`).

## 5. Los flags de `tsconfig` que son parte de esta capa

```jsonc
{
  "strict": true,
  "noFallthroughCasesInSwitch": true, // el que ataca el desenlace sin prueba
  "noUncheckedIndexedAccess": true    // el que obliga a tratar el índice que no existe
}
```

`noFallthroughCasesInSwitch: false` deja pasar exactamente el fall-through que produce «un desenlace
sin prueba escribiendo un estado fuera del predicado». Es cero dependencias, cero minutos de CI, y
falla en el editor: la valla más barata que existe en todo la revisión mecánica.

## Lo que NO es una restricción de diseño

- **Cobertura al 100 %.** Garantiza que la línea se ejecutó, no que algo se observó.
- **Un mutation score objetivo.** Reproduce el mismo incentivo perverso.
- **Gherkin ejecutable.** Agrega un lugar más donde un step vacío se lee bien en el reporte. Ver
  `especificacion.md`.
