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
