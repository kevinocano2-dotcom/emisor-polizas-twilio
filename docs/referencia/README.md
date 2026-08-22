# CarteraPro + Emisor Twilio — versión RTDB

Esta versión unifica el emisor administrativo y CarteraPro en el mismo servicio Render y el mismo número Twilio.

## Persistencia

El backend usa **exclusivamente Firebase Realtime Database** para usuarios, sesiones, pólizas, conversaciones, mensajes, prospectos y onboarding. No hay llamadas de aplicación a Cloud Firestore. `firebase-admin` puede incluir dependencias internas que no se utilizan por CarteraPro.

Si `FIREBASE_DATABASE_URL` no está definida, el servidor la deriva automáticamente del `project_id` incluido en `FIREBASE_SERVICE_ACCOUNT_JSON`.

## Mensajes confiables

- Los chats se guardan en `chat_messages/{telefono}/{messageId}`.
- Los SID de Twilio se usan para deduplicar mensajes.
- Las respuestas TwiML se enlazan después con su SID de Twilio para evitar duplicados.
- El Inbox sincroniza los Message Logs de Twilio al abrirse y tiene botón **↻ Twilio**.
- El chat completo sincroniza también el historial del teléfono seleccionado.
- Si un mensaje existe en Twilio pero faltó en Realtime Database, la sincronización lo vuelve a guardar.
- Un error aislado de Realtime Database no desactiva Firebase durante todo el proceso; se vuelve a intentar en la siguiente operación.
- Existe respaldo local temporal solo como contingencia final.

## Alertas

Los mensajes entrantes generan aviso administrativo con límite de una alerta por cliente cada dos minutos para evitar saturar WhatsApp. El aviso incluye enlace directo para responder y enlace al Inbox.

## Rutas principales

- `POST /twilio/webhook`
- `GET /health`
- `GET /carterapro-inbox.html`
- `GET /carterapro-chat.html`
- `POST /api/admin/carterapro/sync-twilio`
- `GET /carterapro/demo-whatsapp`

## Variables principales

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- `ADMIN_NOTIFY_NUMBERS`
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `ADMIN_TOKEN`
- `PUBLIC_BASE_URL`

Opcionales:
- `FIREBASE_DATABASE_URL`
- `FIREBASE_STORAGE_BUCKET`
- `CARTERAPRO_DEMO_PDF_MAX_MB`
