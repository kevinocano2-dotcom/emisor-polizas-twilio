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
