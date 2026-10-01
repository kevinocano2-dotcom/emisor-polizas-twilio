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


V6.3 - VEHÍCULO ESCRITO + EMBUDO DETALLADO + PRECIO MENSUAL
-----------------------------------------------------------
- La opción de escribir el vehículo es mucho más visible.
- El cliente puede continuar aunque no encuentre la versión exacta.
- El panel muestra "Dónde se están quedando" con conteo por último paso real.
- El panel muestra hasta 20 intentos incompletos recientes y el paso exacto donde se detuvieron.
- page_exit ya no se usa como punto de abandono; se deriva el último paso útil de los eventos.
- AXA muestra precio anual y equivalente aproximado mensual = anual / 12.
- ANA $2,700 muestra también ≈ $225/mes.
- No se agregaron columnas ni tablas nuevas en Supabase para esta versión.


V6.4 - PRIMERA PANTALLA OPTIMIZADA
----------------------------------
Objetivo: atacar el abandono antes de la primera interacción.

Cambios:
- Encabezado reducido para que el cotizador se vea de inmediato.
- Primera decisión: $2,700 a terceros o cobertura amplia AXA.
- Campo principal: "¿Qué auto tienes?" escrito libremente.
- Catálogo oculto y opcional; sólo se abre si el cliente quiere buscar.
- Segundo y último paso: WhatsApp obligatorio.
- Para ANA $2,700 sólo pide Sedán/Pickup.
- Edad y sexo sólo aparecen como opcionales para AXA.
- Se mide: primera interacción, selección de producto, vehículo escrito, catálogo abierto,
  permanencia 5/15/30 segundos y scroll 25/50/75%.
- Panel muestra interacción inicial y comportamiento de quienes entraron pero no llenaron.
- No requiere cambios nuevos en Supabase respecto a V6.3.


V6.5 - AUTO-AVANCE + TELÉFONO GUARDADO EN CUANTO ES VÁLIDO
-----------------------------------------------------------
- Elegir AXA o $2,700 avanza automáticamente, sin botón Continuar.
- AXA abre inmediatamente el catálogo Año > Marca > Modelo > Versión.
- Cada selección carga la siguiente; al elegir versión pasa automáticamente a WhatsApp.
- Si el auto no aparece, existe una opción visible para escribirlo manualmente.
- $2,700: Sedán/Pickup -> Mexicano/Americano -> WhatsApp, todo por selección y auto-avance.
- WhatsApp se guarda automáticamente en cuanto existen al menos 10 dígitos válidos.
- Guardados repetidos se consolidan por session_id para evitar prospectos duplicados.
- Botón visible "Elegir número guardado" usa Contact Picker cuando el navegador lo permite.
- Botón "Pegar número" intenta leer un teléfono del portapapeles.
- La web no puede leer silenciosamente el número del SIM; el usuario siempre debe autorizar/seleccionar.
- Panel separa Ruta AXA y Ruta $2,700 y conserva el último paso exacto de abandono.
- No requiere nuevas tablas o columnas en Supabase.


V6.6 - SIN PUNTOS MUERTOS / UNA TAREA POR PANTALLA
---------------------------------------------------
Motivo: algunos usuarios llegaban al paso 3 y la interfaz parecía no hacer nada.

Cambios:
- Paso 1: sólo elegir AXA o $2,700. Autoavance.
- AXA: una lista a la vez (Año -> Marca -> Modelo -> Versión). Cada elección cambia automáticamente a la siguiente lista.
- El catálogo AXA se muestra siempre; escribir vehículo queda como salida alternativa, no como ruta principal.
- ANA: Tipo -> Origen -> teléfono. Autoavance.
- Paso teléfono:
  * usa <form>, type=tel, name=tel y autocomplete=tel para mejorar el autocompletado del navegador;
  * acepta 10+ dígitos;
  * al detectar 10 dígitos guarda una copia local inmediatamente;
  * avanza a la siguiente pantalla sin esperar la red;
  * intenta guardar en el servidor/Supabase en segundo plano;
  * si el navegador se cierra antes de confirmar, pagehide usa sendBeacon y en la próxima visita vuelve a intentar.
- AXA con catálogo: después del teléfono muestra edad + sexo opcionales para ver precio ahora.
- Si edad + sexo son válidos, la cotización inicia automáticamente.
- Se conserva un botón "Ver mi precio AXA" como respaldo: nunca hay una pantalla sin acción.
- "Omitir y que me contacten" siempre disponible después de capturar teléfono.
- ANA y AXA manual muestran resultado/WhatsApp inmediatamente después de capturar teléfono.
- No requiere nuevas columnas/tablas de Supabase.


V6.7 - CONVERSION FIRST
-----------------------
Objetivo: capturar el WhatsApp antes de cualquier dato que pueda bloquear al cliente.

Principios aplicados:
- Message match: $2,700 y AXA son las dos decisiones visibles desde el inicio.
- Progressive disclosure: una decisión por pantalla.
- Microcompromisos: cada toque avanza sin botones innecesarios.
- Lead-first: en AXA el teléfono se pide después de Año + Marca + Modelo, ANTES de Versión/Edad/Sexo.
- Versión + Edad + Sexo quedan después de capturar el lead y sólo sirven para intentar el precio instantáneo.
- Autocomplete tel + selector de contacto + pegar número.
- Copia local del teléfono + reintento de red + sendBeacon al salir.
- Reaseguro de confianza: sin placa, CP, correo ni tarjeta; uso del número sólo para seguimiento de cotización.
- Rescate suave a los 7/12 segundos si no hay interacción, sin urgencia ni testimonios falsos.
- CTA de teléfono orientado al beneficio: "Recibir mi cotización por WhatsApp".
- Rastreo separado de la ruta AXA y $2,700.
- No requiere cambios de esquema en Supabase.


V6.8 - ESPERA CORRECTA PARA +52 / 52
------------------------------------
- Número nacional: al llegar a 10 dígitos se guarda y avanza automáticamente.
- Si el usuario empieza con "+" o con "52", el cotizador interpreta formato internacional de México.
- En ese caso NO avanza al llegar a 10 dígitos: espera 12 dígitos totales (52 + 10 nacionales).
- Después guarda únicamente los últimos 10 dígitos como número nacional.
- Ejemplos:
  6622434983        -> avanza con 10 dígitos.
  526622434983      -> espera los 12 y después avanza.
  +52 662 243 4983  -> espera el número completo y después avanza.
