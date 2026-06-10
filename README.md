# Emisor administrativo por WhatsApp con Twilio

Este paquete usa Twilio WhatsApp para recibir la palabra clave `EMITIR_ADMINISTRATIVO`, preguntar los datos uno por uno y regresar la póliza PDF ya generada.

## Flujo de WhatsApp

```text
Usuario: EMITIR_ADMINISTRATIVO
Bot: Nombre completo del asegurado:
Usuario: NUBIA LUZ NAVARRO ROMERO
Bot: Domicilio del asegurado:
...
Bot: Responde CONFIRMAR para emitir o CANCELAR para salir.
Usuario: CONFIRMAR
Bot: envía el PDF y sube el folio +1
```

## Campos fijos

- Cobertura: `RC ECONOMICA M2`
- Servicio: `COMERCIAL`
- Ciudad/Estado: `SON`
- CP: `00000`
- Oficina: `MOCHIS`
- Reporte de siniestros: `668 144 0988`

## Requisitos

- Node.js 20 o superior en el servidor.
- Cuenta Twilio con WhatsApp activo o Sandbox para pruebas.
- URL pública HTTPS, por ejemplo Render, Railway, Replit o VPS.

## Instalación local

```bash
npm install
cp .env.example .env
npm run test:pdf
npm start
```

Abre el portal:

```text
http://localhost:8080
```

## Variables de entorno

Edita `.env`:

```env
PORT=8080
FOLIO_PREFIX=SANTM 2-
LAST_FOLIO_NUMBER=981
ALLOWED_NUMBERS=526621989843
PUBLIC_BASE_URL=https://tu-app.onrender.com
MEDIA_ROUTE_TOKEN=pon_un_token_largo_privado
```

### Folio

Si el último emitido fue `SANTM 2-981`, deja:

```env
LAST_FOLIO_NUMBER=981
```

El sistema emitirá `SANTM 2-982` y guardará el contador en `data/counter.json`.

## Configurar Twilio

En Twilio, configura el webhook del número de WhatsApp o Sandbox así:

```text
When a message comes in:
https://TU-DOMINIO/twilio/webhook
HTTP POST
```

También puedes usar:

```text
https://TU-DOMINIO/webhook
```

## Cómo envía el PDF

El servidor genera el PDF en `generated/` y responde a Twilio con TwiML que incluye un `<Media>` con URL pública al PDF. Twilio descarga ese PDF y lo manda por WhatsApp.

## Seguridad mínima incluida

- `ALLOWED_NUMBERS` limita qué teléfonos pueden emitir.
- `MEDIA_ROUTE_TOKEN` evita que los PDFs queden en una ruta fácil de adivinar.
- `CANCELAR` limpia la sesión del usuario.

## Subir a Render

1. Crea un nuevo Web Service.
2. Conecta el repo o sube estos archivos.
3. Build command:

```bash
npm install
```

4. Start command:

```bash
npm start
```

5. Agrega las variables de entorno.
6. Copia la URL pública y ponla en Twilio como webhook.


## v2 - Correccion de plantilla
- Se conserva el encabezado original de EXCLUSIONES del PDF para evitar que el cuadro tape el punto 10.
- No se agrega fondo extra en esa zona.
