# Los límites: qué NO atrapa la revisión mecánica

Este archivo es la parte más importante del skill y la que hay que leer antes de prometerle algo a
alguien. Todo lo demás describe lo que las vallas hacen; esto describe lo que **no pueden hacer por
construcción**, y por lo tanto sigue exigiendo lectura adversarial humana.

La evidencia no es prudencia genérica. En la sesión de auditoría del módulo de cobro del proyecto de referencia,
los cuatro hallazgos más graves fueron:

| Hallazgo | ¿Lo habría encontrado la revisión mecánica? |
| -------- | ------------------------------------ |
| La clave anónima de Supabase exponía hashes de contraseña de la tabla `users` | **No.** Ningún test falla, ningún mutante sobrevive, la complejidad es 1. Es una política de acceso, no una rama de código. |
| Credenciales de la pasarela filtrándose al log por la query string | **No, y peor: la mutación las oculta a propósito.** StrykerJS suprime los nodos áridos (logging, telemetría) para no generar mutantes irrelevantes. El defecto vivía exactamente ahí. |
| Ventana de concurrencia que permitía cobrar dos veces | **No.** Los mutantes se evalúan con la misma suite secuencial de un solo hilo. Lo cierra un índice único parcial en la base — por eso existe `check-invariantes.mjs`, que es lo más cerca que llega la revisión mecánica, y lo único que verifica es que la restricción **esté declarada y exista**. |
| Un desenlace sin prueba escribiendo un estado fuera del predicado crítico | **Sí.** Este es el que la mutación encuentra, y es el único de los cuatro. |

Uno de cuatro. Esa es la proporción honesta, y es la razón por la que la formulación correcta es
«automatizo el defecto recurrente para liberar atención humana hacia los que la máquina no ve», no
«reemplacé la revisión».

## Las cuatro clases invisibles

### 1. Especificación equivocada

Si la intención está mal escrita, el agente la implementa, la cubre al 100 %, mata todos los
mutantes y el pipeline queda verde. El paper de mutación de Google lo dice literalmente: la
mutación evalúa si un algoritmo está implementado correctamente, **no si es el algoritmo correcto**.

Lo más cerca que llega la revisión mecánica: `check-especificacion.mjs` obliga a que exista una
especificación aprobada por un humano, con las cuatro secciones, y **falla si su contenido cambió
sin re-aprobación**. Eso cierra la *circularidad* (que la intención se mueva para calzar con el
código durante la implementación). No cierra que la intención estuviera mal desde el principio.
Para eso solo hay una persona leyendo.

### 2. Fuga de secretos y superficie de datos

Políticas de acceso (RLS, IAM, claves anónimas), lo que un endpoint devuelve de más, lo que un log
imprime. Nada de esto tiene la forma de una rama que un mutante pueda invertir.

Lo más cerca: la fase `secretos` (gitleaks) sobre el diff, que detecta **literales con forma de
credencial**. No detecta que una credencial legítima viaje por un canal equivocado, que es lo que
pasó.

### 3. Concurrencia

Dos procesos, dos réplicas, dos reintentos del mismo webhook. La suite corre en un hilo; el mutante
también.

Lo más cerca: `check-invariantes.mjs` exige que cada invariante declarada nombre su sostén mecánico
y que ese sostén exista (un `CREATE UNIQUE INDEX` en el SQL versionado, un tipo, un test, o una
declaración explícita de que se verifica en producción). Es un gate sobre la **declaración**, no
sobre el comportamiento concurrente.

### 4. Autorización

Que el usuario B pueda leer el recurso de A. La ruta feliz está cubierta, el test pasa, no hay
mutante que hable de eso porque no hay rama que invertir: falta una comprobación que nadie escribió.

Lo más cerca: nada mecánico en esta herramienta. Un test de autorización por endpoint es la
respuesta, y esa es una decisión de especificación, no de verificación.

## Además: qué mutadores NO existen

Importa porque cambia lo que se puede esperar de la fase más cara.

- **StrykerJS no muta referencias a miembros de enum ni entradas de una tabla de constantes.** La
  mutación que la sexta auditoría hizo **a mano** —cambiar `status: PlatformChargeStatus.UNKNOWN`
  por `FAILED` en una fila de la tabla de desenlaces— **no la genera Stryker**. Sus mutadores son
  operadores, literales, condicionales, strings, arreglos, opcionales. Un `Identifier` que apunta a
  otro miembro del enum no está en la lista.
  → Consecuencia práctica: **la mutación de tablas de configuración sigue siendo trabajo manual.**
  La técnica que sí es mecánica ahí es la de tipos: derivar el inverso de la tabla y comprobar su
  inyectividad al cargar el módulo, como ya hace `pagos/desenlaces.ts`.
- **Los nodos áridos se suprimen a propósito** (logging, telemetría, constructores triviales). Ver
  clase 2.
- **`ignoreStatic: true`**, que en la práctica hace falta para que la corrida termine (ver
  `costo.md`), **descarta los mutantes en código de nivel de módulo**: tablas, constantes,
  decoradores, wiring de Nest. Es decir: la configuración que hace viable la mutación es la que
  apaga los mutantes de la zona donde vivía el defecto de la sexta auditoría. Hay que decirlo en voz
  alta.

## Y una clase que la revisión mecánica tampoco cubre: él mismo

Auditar este skill contra su propia doctrina encontró cinco falsos verdes en sus propios guardas —
entre ellos un gate que leía un reporte de mutación de otra corrida y aprobaba en verde. Ninguno lo
habría detectado la revisión mecánica: lo detectó romper cada guarda a propósito y comprobar que fallaba.

**Eso es el procedimiento, no una anécdota.** Al agregar un gate nuevo: correrlo en local con un
comando, romper la condición a propósito, y confirmar que sale en rojo. Un gate que nadie vio
fallar no es un gate.

## Checklist de lectura adversarial (nivel 2)

No es automatizable y no admite excepción en zona crítica. Es la valla de las cuatro clases de
arriba. Se firma en el PR nombrando qué se leyó.

**Superficie de datos**

- [ ] ¿Qué devuelve cada endpoint nuevo o modificado, campo por campo? ¿Hay alguno que el cliente
      no necesita?
- [ ] ¿Qué tablas alcanza el rol anónimo / el rol autenticado? ¿Alguna tiene columnas de
      credenciales, hashes o datos personales?
- [ ] ¿Alguna política nueva es `PERMISSIVE` donde debía ser `RESTRICTIVE`?

**Secretos en tránsito**

- [ ] ¿Algún dato sensible viaja por query string, por URL de redirección o por header propio?
- [ ] ¿Qué imprime cada `logger.*` nuevo? Seguir los objetos completos, no solo los strings.
- [ ] ¿Hay un objeto de error de un SDK que se logea entero y trae el request adentro?

**Concurrencia**

- [ ] ¿Qué pasa si esto corre dos veces al mismo tiempo? ¿Y si el webhook llega duplicado?
- [ ] Entre el `SELECT` que decide y el `UPDATE` que escribe, ¿hay una ventana? ¿Quién la cierra:
      una restricción de la base, un `UPDATE ... WHERE estado = <esperado>`, o nada?
- [ ] ¿Hay un `pending` que se escribe antes de la llamada externa y nadie limpia si el proceso
      muere ahí?

**Autorización**

- [ ] Por cada operación: ¿quién puede llamarla y dónde está comprobado? Nombrar el archivo y la
      línea.
- [ ] ¿El identificador del recurso viene del cliente? ¿Se comprueba que le pertenece, o solo que
      existe?
- [ ] ¿Hay una operación de administración accesible con el token de un usuario normal?

**Intención**

- [ ] Leer la tabla de desenlaces contra el código: ¿hay algún camino de escritura que no
      corresponda a ninguna fila?
- [ ] ¿Algún desenlace de la tabla no tiene forma de producirse en un test? Entonces no es un
      desenlace, es una suposición.
- [ ] ¿Los tests afirman el **estado persistido**, o solo que la función no lanzó?
