COTIZADOR V3 - REEMPLAZAR EN GITHUB
===================================

TODO ESTÁ EN ESTA SOLA CARPETA.

ANTES DE SUBIR
--------------
1. Abre config.js.
2. La URL de Supabase ya está puesta.
3. En SUPABASE_SERVICE_ROLE_KEY pega la MISMA clave sb_secret_... que tienes en tu versión actual.
4. Guarda config.js.

SUPABASE
--------
En Supabase > SQL Editor vuelve a ejecutar TODO el archivo:
setup_supabase.sql

Puedes ejecutarlo aunque ya tengas la tabla leads.
NO borra tus prospectos.
Agrega app_settings para poder actualizar la contraseña AARCO desde el panel.

GITHUB
------
Puedes borrar los archivos viejos del repositorio y subir TODOS los archivos
de esta carpeta directamente a la raíz del repositorio.

RENDER
------
Build Command:
npm install

Start Command:
node server.js

No necesitas cambiar otras opciones.

CAMBIOS DE ESTA VERSIÓN
-----------------------
- AXA se muestra en cuanto responde, sin esperar a las demás compañías.
- Las demás aseguradoras continúan y se guardan en segundo plano.
- Barra de progreso para el cliente.
- Botón grande "Sí, me interesa esta cotización AXA" inmediatamente después del precio.
- Montos de cobertura AXA visibles.
- Panel sin PIN.
- Cambio de contraseña AARCO desde /panel.
- El panel recibe la contraseña normal, la cifra como Cotizamático y prueba el acceso.
- La contraseña cifrada queda guardada en Supabase.
- Proyecto completo en una sola carpeta.

PÁGINAS
-------
Cliente:
/

Panel:
/panel

PRUEBA LOCAL
------------
Ejecuta iniciar_local.bat
y abre http://localhost:3000


COMENTARIOS Y MENSAJES
----------------------
En /panel > Detalle de cada prospecto ahora puedes:
- escribir comentarios de seguimiento;
- marcar Cotización AXA enviada;
- marcar ANA $2,700 enviada;
- marcar Otras opciones enviadas;
- marcar Seguimiento enviado.

Los checks guardan también la fecha/hora cuando se marcan.
Antes de subir esta versión, ejecuta nuevamente setup_supabase.sql en Supabase.
No borra prospectos existentes; sólo agrega las columnas nuevas.


V5 - TELÉFONO PRIMERO
---------------------
- El único dato obligatorio es WhatsApp.
- Se guarda el prospecto inmediatamente al capturar el número.
- Origen, tipo de auto, catálogo, edad y sexo son opcionales.
- Se eliminó la ubicación del formulario; AARCO usa internamente CP 83296 Hermosillo.
- Se agregó "¿No aparece tu automóvil o tienes dudas? Escríbelo aquí".
- Si no hay datos suficientes para AARCO, la solicitud se guarda para atención manual.
- Se registra el embudo por session_id para saber exactamente dónde abandona la gente.
- Si Supabase falla, las operaciones quedan en cola local y el servidor intenta sincronizarlas cada minuto.
- El panel muestra pendientes por sincronizar y etapas del embudo.

IMPORTANTE:
Ejecuta nuevamente setup_supabase.sql en Supabase antes de publicar esta versión.
No borra los prospectos existentes.


V6 - VEHÍCULO PRIMERO
---------------------
- El formulario aparece casi inmediatamente debajo del encabezado.
- Paso 1: vehículo. Se puede usar catálogo o escribir el auto libremente.
- Paso 2: WhatsApp obligatorio; edad y sexo opcionales.
- WhatsApp ya no se pide antes de que el cliente haya empezado.
- El embudo ahora mide específicamente:
  visita -> origen -> tipo -> vehículo/descripción -> WhatsApp -> cotización -> AXA -> WhatsApp final.
- La ubicación sigue siendo fija en Hermosillo y no se pregunta al cliente.


V6.1 - BOTONES WHATSAPP CORREGIDOS
----------------------------------
- "Cotizar esta opción" de $2,700 ahora inicia el flujo económico.
- Pagos a meses AXA siempre abre WhatsApp, incluso si no se pudo calcular AXA.
- Modificar coberturas siempre abre WhatsApp.
- ANA $2,700 abre WhatsApp para Sedán/Pickup mexicano o americano.


V6.2 - TELÉFONO FLEXIBLE
------------------------
- El campo acepta números con espacios, guiones, paréntesis y +52.
- Son válidos 10 o más dígitos.
- Internamente se conservan los últimos 10 dígitos como número mexicano.
- Ejemplos equivalentes:
  6621989843
  662 198 9843
  +52 662 198 9843
  (662) 198-9843
