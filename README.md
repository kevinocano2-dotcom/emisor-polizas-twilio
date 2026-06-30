# Emisor de Pólizas WhatsApp + Twilio + Firebase

Esta versión guarda usuarios, folios, sesiones e historial en Firebase Firestore.
Así no pierdes datos cuando Render se reinicia o hace redeploy.

## Variables necesarias en Render

```env
PUBLIC_BASE_URL=https://emisor-polizas-twilio.onrender.com
MEDIA_ROUTE_TOKEN=polizas_kevin_2026_seguro_839201
ADMIN_TOKEN=pon_un_token_admin
FOLIO_PREFIX=SANTM 2-
LAST_FOLIO_NUMBER=983
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

`ALLOWED_NUMBERS` ya no es obligatorio. Solo sirve para cargar números iniciales la primera vez.
Después se administran desde el panel web.

## Panel admin

Abre:

https://emisor-polizas-twilio.onrender.com

Usa tu `ADMIN_TOKEN` para entrar. Desde ahí puedes:
- dar de alta números
- bloquear o activar emisores
- ver cuántas pólizas emitió cada número
- ver folios emitidos por cada número
- marcar pólizas como pagadas
- liquidar pendientes
- ajustar último folio

## Webhook Twilio

Configura en Twilio:

https://emisor-polizas-twilio.onrender.com/twilio/webhook

Método: POST


## v8 fix pagadas

Se corrigió la función "Pagadas" del panel admin:
- ya no usa orderBy + limit en la consulta de Firestore
- evita requerir índice compuesto
- si ocurre error, responde JSON sin tumbar temporalmente el servicio


## v9 fix VIN y fecha/hora

- La fecha y hora de póliza ahora se calculan en zona horaria America/Hermosillo por defecto.
- Se puede cambiar con la variable POLICY_TIMEZONE si se ocupa otra zona.
- El VIN se limpia para dejar solo A-Z y 0-9.
- El VIN se dibuja caracter por caracter con separación fija para evitar caracteres encimados o poco legibles.


## v10 QR dinámico

Se corrigió el código QR de la póliza para que ya no muestre información fija/vieja.
Ahora el QR se genera con los datos reales de cada cliente en este formato:

?cl=NOMBRE DEL CLIENTE,pol=FOLIO,tt=TOTAL,vig=VIGENCIA,noser=SERIE

Ejemplo:
?cl=GILBERTO QUINTANA ANTELO,pol=SANTM 2-981,tt=575.0000,vig=26/03/2027,noser=1D7HU18N75S196937


## v11 alineacion y formato

Se ajusto la alineacion tomando como referencia el ejemplo ARIEL POLIZA.pdf sin cambiar los datos fijos del sistema:
- VIN con separacion fija mas cerrada para evitar caracteres encimados y verse mas natural.
- Pagina 2: se redibuja completo el punto 10 de CONDICIONES para que no quede cortado por EXCLUSIONES.
- EXCLUSIONES queda alineado debajo del punto 10, respetando el formato visual del ejemplo.
- Se conserva QR dinamico, fecha/hora Hermosillo, CANCELAR y correccion de Pagadas.

## v12 prueba y correcciones finales

Se corrigio:
- Export de normalizePolicyInput para que flow_twilio.js pueda importar correctamente.
- Redondeo del total QR a 575.0000, evitando 575.0004 por decimales JS.
- VIN con fuente regular para que letras como W se vean correctamente.
- Posicion del QR de pagina 1 para que no tape importes ni texto legal.
- QR dinamico verificado con formato: ?cl=NOMBRE,pol=FOLIO,tt=TOTAL,vig=VIGENCIA,noser=SERIE


## v13 Chat panel

Se agregó bandeja de mensajes WhatsApp dentro del panel web:
- guarda mensajes entrantes en Firestore
- guarda respuestas automáticas del bot
- muestra conversaciones por teléfono
- permite responder manualmente desde la página

Variables adicionales para respuesta manual:
```env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+5216623889875
```

El historial anterior de Twilio no se importa automáticamente; la bandeja empieza a guardar mensajes desde que se despliega esta versión.


## v14 Datos completos de póliza en Firebase y HTML

Ahora cada póliza confirmada por WhatsApp guarda en Firestore:
- teléfono emisor
- folio
- nombre del asegurado
- domicilio
- automóvil
- carrocería
- modelo
- serie/VIN
- vigencia, desde/hasta
- importes fijos/calculados
- archivo PDF
- QR payload
- estado de cobranza

El panel HTML ahora muestra esos datos en el historial de pólizas para rastrear y contactar clientes.
Las pólizas generadas antes de esta versión pueden aparecer con campos vacíos porque todavía no existían esos campos guardados.


## v16 fix VIN formato compacto

Se corrigió la impresión del VIN / No. de serie:
- ya no se imprime carácter por carácter
- ya no aparecen espacios entre caracteres
- se mantiene como texto compacto
- se usa tamaño ligeramente menor y negrita para evitar encimado visual
- se limita a 17 caracteres VIN


## v17 ajuste VIN a la derecha

Se movió el VIN / No. de serie ligeramente a la derecha:
- X anterior: 303.00
- X nuevo: 318.00
- Altura y tamaño se mantienen iguales
- Texto sigue compacto, sin espacios


## v18 fix QR página 2

Se corrigió el QR de la página 2:
- se tapa completamente el QR viejo/fijo de la plantilla
- se dibuja QR dinámico también en página 2
- usa el mismo payload correcto:
  ?cl=NOMBRE,pol=FOLIO,tt=TOTAL,vig=VIGENCIA,noser=SERIE
- se conserva el ajuste del VIN a la derecha


## v19 aviso de emisión y pendientes

Después de emitir una póliza:
- el bot responde al emisor con el folio y cuántas pólizas pendientes de pagar tiene ese usuario
- el sistema avisa por WhatsApp al administrador configurado
- el aviso incluye usuario/teléfono, folio, cliente, auto, serie y número de pendientes

Variable opcional:
```env
ADMIN_NOTIFY_NUMBERS=5216622434983
```

Puedes poner varios separados por coma:
```env
ADMIN_NOTIFY_NUMBERS=5216622434983,5216621989843
```

Requiere que ya estén configuradas estas variables para enviar WhatsApp desde el panel:
```env
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=whatsapp:+5216623889875
```


## v20 editar estatus de pólizas y UI mejorada

Cambios:
- cada póliza tiene botón para cambiar PENDIENTE ↔ PAGADA
- permite corregir una póliza marcada pagada por error
- el historial cambió de tabla a tarjetas para que no se oculten datos
- filtros por búsqueda, estatus y teléfono
- resumen de pendientes/pagadas según filtro


## v21 fix VIN sin encimar

Se corrigió el VIN / No. de serie sin cambiar el formato:
- misma posición X/Y
- mismo tamaño
- mismo estilo
- sin espacios visibles entre caracteres
- se agregó tracking mínimo interno para evitar que letras como W/E se encimen visualmente


## v22 fix VIN con fuente estándar

Se corrigió visualmente el VIN sin cambiar posición, tamaño ni separación:
- misma coordenada del VIN
- mismo tamaño
- sin espacios entre caracteres
- se usa Helvetica-Bold estándar únicamente para el VIN
- evita que la fuente incrustada de la plantilla dibuje mal letras como W


## v23 fuente estándar en campos capturados y serie completa

Cambios:
- No se corta la serie a 17 caracteres; imprime completa la entrada capturada.
- Se aplica fuente estándar Helvetica-Bold a los campos capturados por usuario:
  nombre, domicilio, automóvil, carrocería, modelo y serie.
- No se movieron coordenadas ni se cambiaron tamaños.
- El objetivo es evitar letras incompletas/encimadas como W en todos los campos editables.


## v24 Firestore quota fix

Se corrigió el problema donde el servidor se reiniciaba cuando Firestore respondía:
RESOURCE_EXHAUSTED: Quota exceeded.

Cambios:
- /health y /api/settings ahora regresan JSON aunque Firestore falle.
- /api/admin/summary tiene caché de 15 segundos para no leer Firestore en cada recarga.
- Mensajes se limitan desde Firestore.
- Pólizas se limitan desde Firestore.
- Pendientes por usuario se consultan por teléfono y no leyendo todas las pólizas.
- Se evita que una promesa no manejada tumbe Node/Render.

Nota: si Firestore ya agotó cuota del día, hay que esperar el reinicio diario de cuota o activar billing. Esta versión evita el crash y reduce lecturas, pero no puede saltarse una cuota ya agotada.


## v25 Firebase no-local fix

Corrección importante:
- Si Firebase está configurado, el sistema ya NO cambia a archivos locales cuando Firestore falla.
- Esto evita que parezca que se perdieron datos previos o que lo nuevo se guardó en otro lugar.
- Se corrigió la lectura de pólizas antiguas: ya no usa orderBy(createdAtMs), porque eso ocultaba documentos viejos que no tenían ese campo.
- Si Firestore está sin cuota, el panel mostrará error JSON en vez de guardar en local.


## v26 respaldo por WhatsApp si Firebase falla al emitir

Cuando ocurre un error al emitir/guardar en Firestore:
- el usuario recibe el error corto
- el sistema manda WhatsApp al número de administración configurado en ADMIN_NOTIFY_NUMBERS
- el aviso incluye los datos capturados para guardar después:
  cliente, domicilio, auto, carrocería, modelo, serie, folio si alcanzó a generarse, total y vigencia
- si el PDF alcanzó a generarse, también manda el enlace temporal

Esto evita perder la información capturada cuando Firestore está sin cuota o falla.
