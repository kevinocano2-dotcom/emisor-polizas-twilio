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

## v27 Afiliación MYR

Se agregó generación de hoja de afiliación usando la plantilla `templates/MYR-799-79.pdf`.

Comandos WhatsApp:
- `EMITIR AGS`: genera solo la póliza administrativa como antes.
- `/EMITIRYAFILIACION`: genera la póliza y la hoja MYR; pregunta placa/EXP, teléfono del cliente, nombres para afiliación y color.
- `/AFILIACION`: genera solo la hoja MYR.

Reglas de la hoja MYR:
- ESTADO siempre es `SONORA`.
- MUNICIPIO siempre es `HERMOSILLO`.
- EXP se llena con el número de placa capturado.
- FECHA usa la fecha del día en zona horaria `America/Hermosillo`.
- El teléfono del cliente se pregunta y se guarda en Firestore/local, pero no se imprime en el PDF.
- Los nombres se capturan separados por comas: el primero va en `NOMBRE 1`; máximo dos adicionales van en `NOMBRE 2`.
- Se eliminan campos rellenables, fondos azules de formulario y el botón `ENVIAR`; el PDF queda como documento fijo.

Nueva colección/base:
- Firestore: `affiliations`
- Local: `data/affiliations.json`

El panel admin ahora muestra el contador de afiliaciones y una sección de Afiliaciones MYR.

## v28 afiliaciones en HTML + comandos WhatsApp claros

Cambios:
- El panel HTML ahora tiene filtros y resumen para afiliaciones MYR: buscar por placa, cliente, teléfono, serie, color, tipo, emisor y póliza relacionada.
- Las tarjetas de afiliación muestran los datos completos solicitados: estado, municipio, fecha, EXP/placa, número del cliente/teléfono, nombres separados, marca/vehículo, tipo, modelo, serie, color, PDF y póliza relacionada si aplica.
- Se agregó una sección para generar afiliación MYR desde el portal HTML, guardarla en Firestore y abrir el PDF generado.
- WhatsApp ahora solo inicia formularios con los comandos definidos y ya no acepta alias como EMITIR, POLIZA, SEGURO, AFILIACION o MYR sin diagonal.
- Si el usuario escribe HOLA o un mensaje normal sin formulario iniciado, solo responde el saludo del asistente virtual, sin mostrar comandos.
- Si el usuario intenta un comando incorrecto, responde "Comando incorrecto. Escribe HELP para ver las opciones disponibles.".


## v29 comandos privados por HELP

Cambios:
- El comando para póliza cambió a `EMITIR AGS`.
- El comando combinado cambió a `/EMITIRYAFILIACION`.
- El comando solo afiliación cambió a `/AFILIACION`.
- `EMITIR`, `AFILIACION`, `EMITIRYAFILIACION`, `POLIZA`, `SEGURO` y `MYR` ya no inician formularios sin el formato correcto.
- El bot ya no muestra comandos en saludos ni en mensajes normales; solo muestra opciones cuando escriben `HELP`, `AYUDA`, `MENU` o `MENÚ`.
- En mensajes normales sin formulario activo responde: "Hola, soy su asistente virtual, ¿en qué le puedo apoyar?".


## v30 fix envío de afiliación WhatsApp

Se corrigió el envío por WhatsApp cuando se usa /EMITIRYAFILIACION:
- la póliza y la hoja MYR ahora salen como mensajes separados en TwiML;
- evita que WhatsApp/Twilio mande solo el primer PDF;
- se conserva mediaUrls para historial del panel.

Archivos de funcionamiento modificados: src/server.js y src/flow_twilio.js.


## v31 fix QR página 2 firma

Se corrigió el QR dinámico en la página 2 de la póliza:
- La firma de FUNCIONARIO AUTORIZADO ya no queda cortada.
- Se eliminó el rectángulo blanco grande que tapaba parte de la firma/texto.
- Ahora se limpia únicamente el área real del QR original y se redibuja el QR dinámico más alineado a la derecha.

Archivo funcional modificado:
```text
src/pdf_generator.js
```

## v33 modo emergencia cuando Firestore/Firebase no tiene cuota

Cambios:
- Si Firestore marca `Quota exceeded`, WhatsApp ya no se detiene.
- Las sesiones del formulario usan respaldo local temporal para seguir preguntando datos.
- El folio usa contador local temporal si Firestore no permite leer/escribir el contador.
- El PDF de póliza y/o afiliación se genera y se manda aunque Firebase no guarde.
- Si Firebase no guardó, se manda un WhatsApp a `ADMIN_NOTIFY_NUMBERS` con todos los datos capturados y enlaces temporales de los PDF.
- Se agregó `EMERGENCY_ALLOWED_NUMBERS` para permitir que números autorizados sigan usando el bot aunque no se puedan leer usuarios en Firestore.

Variables recomendadas en Render:
```env
ADMIN_NOTIFY_NUMBERS=5216622434983
EMERGENCY_ALLOWED_NUMBERS=5216622434983
EMERGENCY_ALLOW_ALL_WHATSAPP=false
```

Nota: el respaldo local de Render es temporal. Sirve para no detener la emisión, pero después hay que capturar/revisar en Firebase cuando la cuota se recupere o se active billing.

## v34 modo emergencia Firestore circuit breaker

Corrección para el error `8 RESOURCE_EXHAUSTED: Quota exceeded` en el webhook de Twilio.

Cambios:
- Si Firestore se queda sin cuota, el servidor desactiva Firebase durante ese arranque y continúa en modo local de emergencia.
- El bot sigue preguntando datos por WhatsApp y guardando la sesión en `data/sessions.json`.
- Sigue generando póliza y/o afiliación.
- Los PDF se siguen enviando al usuario.
- Si Firestore no guardó, manda respaldo por WhatsApp a `ADMIN_NOTIFY_NUMBERS`.
- `recordMessage` ya no puede tumbar el webhook por cuota; si falla Firebase, guarda el mensaje en respaldo local.

Nota: al reiniciar Render, si Firebase ya recuperó cuota, vuelve a conectar normal.

## v35 soporte Firebase Realtime Database

Se agregó opción para guardar datos en Firebase Realtime Database en vez de Cloud Firestore.
Esto ayuda a evitar el problema de `Quota exceeded` por lecturas/escrituras diarias de Firestore.

Variables nuevas para Render:
```env
FIREBASE_DATA_BACKEND=realtime
FIREBASE_DATABASE_URL=https://TU-PROYECTO-default-rtdb.firebaseio.com
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

Con `FIREBASE_DATA_BACKEND=realtime`, el sistema guarda en Realtime Database:
- settings/counter
- sessions
- users
- policies
- messages
- affiliations

Si prefieres seguir usando Firestore, deja:
```env
FIREBASE_DATA_BACKEND=firestore
```

o elimina `FIREBASE_DATA_BACKEND`, ya que Firestore sigue siendo el modo por defecto.

Archivos funcionales modificados:
```text
src/state.js
```

Notas:
- No se usa Firebase Storage para la base de datos. Storage sirve para archivos grandes, pero para sesiones, usuarios, pólizas y afiliaciones conviene Realtime Database.
- El modo emergencia local sigue activo si Firebase falla.


## v27 CarteraPro Ventas integrado — un solo Render

Este proyecto ahora ejecuta en el mismo Web Service:
- Emisor administrativo existente.
- CarteraPro Ventas automático.
- Demo automática.
- Plan Básico $499 y Plus $698.
- Flujo `YA PAGUÉ` para carga inicial.
- Carga por acceso temporal al portal mediante formulario cifrado.
- Carga por ZIP con PDFs de los últimos 12 meses.

### Enrutamiento WhatsApp

El emisor ya NO responde mensajes normales ni saludos.
Solo entra cuando:
- `EMITIR AGS`
- `/EMITIRYAFILIACION`
- `/AFILIACION`
- existe un formulario de emisión en proceso
- `HELP EMISOR`

`HELP` muestra opciones de CarteraPro y los comandos del emisor.
Todo otro mensaje nuevo entra a CarteraPro Ventas.

### Variables nuevas

Ver `CARTERAPRO_ENV_NUEVAS.txt`.

`CARTERAPRO_ONBOARDING_SECRET` es obligatoria si quieres aceptar acceso temporal al portal. Debe ser un secreto largo y aleatorio configurado directamente en Render.

`FIREBASE_STORAGE_BUCKET` es opcional, pero muy recomendable para los ZIP. Si no está configurado, el ZIP queda en disco temporal de Render y puede perderse en un reinicio/deploy.

### Panel ventas

En el panel principal del emisor aparece el botón `CarteraPro ventas`.
También puedes abrir:

`/carterapro/admin?token=ADMIN_TOKEN`

Ahí aparecen prospectos y onboarding; si un cliente eligió acceso temporal podrás abrir los datos cifrados, y si eligió ZIP podrás descargarlo.


## Alertas CarteraPro

CARTERAPRO - ALERTAS ADMINISTRATIVAS

Todas las alertas se envían a los mismos números configurados actualmente en:
ADMIN_NOTIFY_NUMBERS

Puedes poner uno o varios separados por coma.

ALERTAS AUTOMÁTICAS:
1. Nuevo prospecto CarteraPro.
2. Demo enviada.
3. Cliente reporta "YA PAGUÉ" / compra.
4. Nuevo registro post-pago en activacion_499.html o activacion_698.html.
5. Cliente inicia carga inicial y elige Portal o ZIP.
6. Credenciales temporales recibidas.
7. ZIP de pólizas recibido.

IMPORTANTE:
- "YA PAGUÉ" es una declaración del cliente, no una confirmación bancaria.
- El registro post-pago confirma que completó el formulario, no que Mercado Pago haya aprobado el pago.
- Los Links de pago creados desde el panel de Mercado Pago no permiten Webhooks de pago.
- Para alerta 100% confirmada por Mercado Pago habría que migrar el cobro a Checkout Pro/API con Webhooks.

Variable opcional:
CARTERAPRO_ALLOWED_ORIGINS=https://carteraproautos.netlify.app

No es necesario crear otro Render.


## Inbox CarteraPro PRO

Se agregó un inbox dedicado en:

`/carterapro-inbox.html?token=ADMIN_TOKEN`

Mejoras:
- Índice permanente por número en colección `conversations`.
- Un chat ya no desaparece porque existan muchos mensajes globales.
- Contador de no leídos.
- Búsqueda por nombre, teléfono, compañía y último mensaje.
- Filtros CarteraPro / No leídos / Por cerrar / Todos / Emisor.
- Etapa comercial visible: Prospecto, Demo, Pago reportado, Registro pendiente, Carga inicial, Acceso recibido, ZIP recibido.
- Perfil del prospecto junto al chat.
- Respuestas manuales desde el mismo panel.
- Respuestas rápidas: demo, Básico, Plus y carga inicial.
- Exportación TXT de cada conversación.
- Botón para reconstruir el índice histórico usando hasta 5000 mensajes previos.
- El panel viejo del emisor sigue disponible.

Después del primer deploy:
1. Entra al Inbox.
2. Presiona `Reconstruir índice histórico` una sola vez.
3. A partir de ahí cada mensaje actualiza automáticamente el índice de su conversación.

Los mensajes continúan almacenados en la colección `messages`; el índice `conversations`
es solo un resumen para navegar rápido y no sustituye el historial.


INBOX V4 - SOLUCION PARA CONVERSACIONES LARGAS

El Inbox queda como bandeja rápida y ya solo solicita los últimos 80 mensajes.

Para una conversación larga usa el botón:
↗ Conversación completa

y se abre:
/carterapro-chat.html?phone=TELEFONO&token=ADMIN_TOKEN&v=4

La vista completa:
- no tiene columnas laterales;
- header fijado directamente al viewport;
- historial fijado directamente entre header y compositor;
- compositor fijado directamente al fondo del viewport;
- inicialmente renderiza solo los 40 mensajes más recientes;
- botón "Cargar mensajes anteriores" agrega 40 por vez sin perder posición;
- puede recuperar hasta 2000 mensajes del chat;
- respuesta manual siempre visible;
- botón "Último mensaje";
- exportación TXT completa;
- actualización automática solo cuando estás al final.

Esto evita renderizar cientos de burbujas al mismo tiempo y elimina la dependencia del layout de tres columnas para responder.
