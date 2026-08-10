# Perfil el proyecto de referencia — pnpm 11 + GitHub Actions + Node 24

Dos repos: el backend de referencia (NestJS 11, jest, 44 suites / 703 tests) y el webapp de referencia
(Next.js 16, `node:test` + `tsx`, 30 suites / 156 tests). Los dos con pnpm 11.1.1 invocado como
`corepack pnpm`, y con guardas propios que **ya corren antes de instalar** — ese orden es el que hay
que respetar al insertar la revisión mecánica.

## Lo que el `doctor` encontró en estos dos repos (medido)

| | el backend de referencia | el webapp de referencia |
| - | --------------- | -------------- |
| gestor | pnpm · `pnpm install --frozen-lockfile` | pnpm · `pnpm install --frozen-lockfile` |
| Node mínimo declarado | 24 (`.nvmrc`) | 24 (`.nvmrc`) |
| eslint | `^10.3.0`, gobierna `eslint.config.mjs` | `^9.18.0`, gobierna `eslint.config.mjs` |
| **hallazgo alto** | `tsconfig.json` sin `strict: true`; `noImplicitAny: false`, `noFallthroughCasesInSwitch: false` | **coexisten `eslint.config.mjs` y `.eslintrc.json`**: el segundo es letra muerta |
| **hallazgo alto** | el workflow no declara `fetch-depth: 0` | el workflow no declara `fetch-depth: 0` |
| reglas de forma | ninguna de las 5 declarada | ninguna de las 5 declarada |
| fronteras | no declaradas | no declaradas |

`fetch-depth: 0` es lo primero. Sin eso `git merge-base` no resuelve en CI y la revisión mecánica aborta;
es la razón por la que `check-alcance-diff.mjs` falla en voz alta en lugar de reportar «0 archivos».

## Orden dentro del pipeline

La revisión mecánica se inserta **después** de los guardas que ya existen y **antes** de nada que dependa
de la instalación:

1. `node scripts/check-dependency-pins.mjs` (ya existe, corre sin `node_modules`)
2. `node scripts/check-migration-registry.mjs` (solo backend, ya existe)
3. `node scripts/mechanical-review/check-alcance-diff.mjs` ← **nuevo, sin `node_modules`**
4. `node scripts/mechanical-review/check-excepciones.mjs` ← **nuevo, sin `node_modules`**
5. `corepack pnpm install --frozen-lockfile`
6. el resto de la revisión

## Fragmento para `.github/workflows/ci.yml`

```yaml
jobs:
  revisión mecánica:
    runs-on: ubuntu-latest
    steps:
      # OBLIGATORIO: sin historia completa, merge-base no resuelve y el gate de diff
      # no puede calcular nada. Un gate que no puede calcular el diff no aprueba nada.
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc

      # Los dos guardas de alcance corren ANTES de instalar: no tienen dependencias y
      # así un lockfile roto no impide diagnosticar el lockfile roto.
      - name: Alcance del cambio
        run: node scripts/mechanical-review/check-alcance-diff.mjs --base origin/${{ github.base_ref || 'main' }}

      - name: Excepciones vigentes
        run: node scripts/mechanical-review/check-excepciones.mjs

      - run: corepack enable
      - run: corepack pnpm install --frozen-lockfile

      # gitleaks: se instala explícito porque la fase `secretos` lo invoca por nombre y
      # si no está, la fase falla (a propósito: no aprueba por ausencia).
      - uses: gitleaks/gitleaks-action@v2
        with:
          args: detect --no-banner --redact --log-opts=origin/${{ github.base_ref || 'main' }}..HEAD

      - name: Revisión mecánica
        run: node scripts/mechanical-review/orquestador.mjs --base origin/${{ github.base_ref || 'main' }}
```

`--base origin/${{ github.base_ref }}` importa: en un push a `main` `base_ref` está vacío y el
fallback `main` deja el diff vacío, lo que hace **abortar** la revisión mecánica (correcto: no hay nada que
verificar y no se puede afirmar nada). Si se quiere que el pipeline de `main` pase igual, la forma
explícita es `check-alcance-diff.mjs --sin-cambios-ok`, nunca bajar el gate.

## Deuda a pagar antes de subir a nivel 2

En orden de costo creciente:

1. **`fetch-depth: 0`** en los dos workflows. Un renglón.
2. **`reports/mutation/`, `.stryker-tmp/` y `.mechanical-review/out/` al `.gitignore`.** Un reporte de
   mutación viejo versionado o cacheado es un falso verde; el gate ahora lo detecta por fecha, pero
   la causa se elimina no guardándolo.
3. **Borrar `.eslintrc.json` del webapp** en un commit aparte. Mientras exista, cualquier regla de
   forma escrita ahí no corre y da la impresión contraria.
4. **Reglas de forma en `eslint.config.mjs`**, con trinquete: medir el máximo real de hoy y fijar la
   regla en ese número. `pagos/cobro.service.ts` tiene ~2.500 líneas y es el archivo con más
   garantías del ecosistema; un umbral ideal convertiría al mejor código en el primer rojo.
5. **`strict: true` en el backend.** Deuda acotada y de una vez, pero deuda real:
   `noImplicitAny: false` y `strictBindCallApply: false` están puestos a propósito por el wiring de
   Nest. Empezar por `noFallthroughCasesInSwitch: true`, que es el flag que ataca directamente la
   clase de defecto que apareció seis veces y que casi no tiene deuda asociada.
6. **StrykerJS**, solo cuando lo anterior esté hecho. Ver `adopcion.md` y `costo.md`: en este
   backend la mutación cuesta minutos por archivo, no segundos.

## Zona crítica sugerida para el backend

```json
"zonas": {
  "critica": [
    "src/modules/payments/**",
    "src/common/crypto/**",
    "src/modules/auth/**"
  ],
  "negocio": ["src/**"]
}
```

Declararla es lo que enciende el nivel 2. Mientras esté vacía, la mutación nunca corre y el
revisión mecánica es el nivel 0/1: útil, barato, y muy por debajo de lo que promete.
