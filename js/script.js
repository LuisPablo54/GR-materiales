/*
  script.js — Cotizador de Losas (Automation Onyx)
  ---------------------------------------------------
  Flujo:
  1. Usuario sube/arrastra la imagen del plano  -> dropzone
  2. Al dar "Analizar plano" se manda la imagen a un webhook de n8n
     (NUNCA directo a la API de IA, para no exponer credenciales en el navegador)
  3. n8n regresa las medidas detectadas -> se pintan y son editables
  4. Con esas medidas se calcula vigueta/bovedilla aquí mismo (determinístico,
     no depende de IA) y se costea con la tabla de precios de abajo
*/

(() => {
  'use strict';

  /* =========================================================
     CONFIGURACIÓN — AQUÍ VAN TUS DATOS
     ========================================================= */

  const CONFIG = {
    // URL del webhook de n8n que recibe la imagen y regresa las medidas.
    // Reemplaza esto por la URL real de tu workflow (nodo "Webhook" en n8n).
    // Ejemplo: 'https://tu-instancia.app.n8n.cloud/webhook/interpretar-plano'
    N8N_WEBHOOK_URL: 'https://grmateriales54.app.n8n.cloud/webhook/Interpretar_plano',

    // (Opcional) Webhook para solicitar la cotización formal, si quieres que
    // el botón "Solicitar cotización formal" también dispare un workflow
    // (por ejemplo, para mandar un correo o guardar el lead).
    // Déjalo en null si por ahora solo quieres mostrar un mensaje.
    N8N_LEAD_WEBHOOK_URL: null,

    // Tamaño máximo de archivo permitido (en MB)
    MAX_FILE_SIZE_MB: 10,

    /* --- Parámetros del sistema constructivo ---
       Ajusta estos valores según el tipo de vigueta/bovedilla que maneje
       tu empresa. Son los que definen cuántas piezas salen por losa. */
    SEPARACION_EJES_VIGUETA_M: 0.61,   // separación típica entre ejes de vigueta (61cm u 70cm)
    BOVEDILLAS_POR_M2: 2.7,            // piezas de bovedilla por m² de losa (según tamaño de pieza)

    /* --- Precios unitarios — AQUÍ VAN TUS DATOS DE COSTOS ---
       precioViguetaPorMetro: costo por metro lineal de vigueta (MXN)
       precioBovedillaPorPieza: costo por pieza de bovedilla (MXN) */
    PRECIOS: {
      precioViguetaPorMetro: 190,   // TODO: poner precio real por metro lineal
      precioBovedillaPorPieza: 26, // TODO: poner precio real por pieza
    },

    MONEDA: 'MXN',
  };

  /* =========================================================
     ESTADO
     ========================================================= */

  const state = {
    file: null,
    specs: null,  // { largoM, anchoM, sentido }
    quote: null,  // { numViguetas, numBovedillas, subtotalVigueta, subtotalBovedilla, total }
  };

  /* =========================================================
     REFERENCIAS AL DOM
     ========================================================= */

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const dropzoneEmpty = document.querySelector('[data-dropzone-empty]');
  const dropzonePreview = document.querySelector('[data-dropzone-preview]');
  const previewImage = document.getElementById('preview-image');
  const previewFilename = document.getElementById('preview-filename');
  const removeFileBtn = document.getElementById('remove-file-btn');

  const analyzeBtn = document.getElementById('analyze-btn');
  const loadingIndicator = document.getElementById('loading-indicator');
  const loadingMessage = document.getElementById('loading-message');
  const errorMessage = document.getElementById('error-message');
  const errorText = document.querySelector('[data-error-text]');

  const resultsSection = document.getElementById('resultados');
  let specLargo = document.getElementById('spec-largo');
  let specAncho = document.getElementById('spec-ancho');
  const specArea = document.getElementById('spec-area');
  const specSentido = document.getElementById('spec-sentido');
  const editSpecsBtn = document.getElementById('edit-specs-btn');

  const qtyVigueta = document.getElementById('qty-vigueta');
  const priceVigueta = document.getElementById('price-vigueta');
  const subtotalVigueta = document.getElementById('subtotal-vigueta');
  const qtyBovedilla = document.getElementById('qty-bovedilla');
  const priceBovedilla = document.getElementById('price-bovedilla');
  const subtotalBovedilla = document.getElementById('subtotal-bovedilla');
  const totalCost = document.getElementById('total-cost');

  const requestQuoteBtn = document.getElementById('request-quote-btn');
  const newQuoteBtn = document.getElementById('new-quote-btn');
  const titleBlockStatus = document.querySelector('[data-title-block-status]');
  const currentYearEl = document.getElementById('current-year');

  /* =========================================================
     INIT
     ========================================================= */

  document.addEventListener('DOMContentLoaded', () => {
    if (currentYearEl) currentYearEl.textContent = new Date().getFullYear();
    bindDropzoneEvents();
    bindActionEvents();
  });

  /* =========================================================
     1. DROPZONE — subir / arrastrar / quitar archivo
     ========================================================= */

  function bindDropzoneEvents() {
    // Click en cualquier parte vacía del dropzone abre el explorador de archivos
    dropZone.addEventListener('click', (e) => {
      if (dropZone.dataset.state === 'empty' && e.target.tagName !== 'LABEL') {
        fileInput.click();
      }
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (file) handleFileSelected(file);
    });

    // Drag & drop
    ['dragenter', 'dragover'].forEach((evt) => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.dataset.state = 'dragover';
      });
    });

    ['dragleave', 'drop'].forEach((evt) => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dropZone.dataset.state === 'dragover') {
          dropZone.dataset.state = state.file ? 'filled' : 'empty';
        }
      });
    });

    dropZone.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelected(file);
    });

    removeFileBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetFile();
    });
  }

  function handleFileSelected(file) {
    hideError();

    const validTypes = ['image/png', 'image/jpeg', 'application/pdf'];
    if (!validTypes.includes(file.type)) {
      showError('Formato no soportado. Sube una imagen JPG/PNG o un PDF de una sola página.');
      return;
    }

    const maxBytes = CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024;
    if (file.size > maxBytes) {
      showError(`El archivo pesa más de ${CONFIG.MAX_FILE_SIZE_MB}MB. Comprímelo o sube una foto más ligera.`);
      return;
    }

    state.file = file;
    dropZone.dataset.state = 'filled';
    dropzoneEmpty.hidden = true;
    dropzonePreview.hidden = false;
    previewFilename.textContent = file.name;

    if (file.type === 'application/pdf') {
      previewImage.removeAttribute('src');
      previewImage.alt = 'Archivo PDF cargado: ' + file.name;
    } else {
      const reader = new FileReader();
      reader.onload = (e) => { previewImage.src = e.target.result; };
      reader.readAsDataURL(file);
    }

    analyzeBtn.disabled = false;
  }

  function resetFile() {
    state.file = null;
    fileInput.value = '';
    dropZone.dataset.state = 'empty';
    dropzoneEmpty.hidden = false;
    dropzonePreview.hidden = true;
    previewImage.removeAttribute('src');
    analyzeBtn.disabled = true;
  }

  /* =========================================================
     2. ACCIONES PRINCIPALES
     ========================================================= */

  function bindActionEvents() {
    analyzeBtn.addEventListener('click', handleAnalyzeClick);
    editSpecsBtn.addEventListener('click', handleEditSpecsClick);
    requestQuoteBtn.addEventListener('click', handleRequestQuoteClick);
    newQuoteBtn.addEventListener('click', handleNewQuoteClick);
  }

  async function handleAnalyzeClick() {
    if (!state.file) return;
    hideError();
    setLoading(true, 'Interpretando tu plano…');
    analyzeBtn.disabled = true;

    try {
      const detected = await interpretarPlano(state.file);
      state.specs = normalizarSpecs(detected);
      renderSpecs(state.specs);
      recalcularYRenderizarCotizacion();
      resultsSection.hidden = false;
      resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (titleBlockStatus) titleBlockStatus.textContent = 'Cotización generada';
    } catch (err) {
      console.error(err);
      showError(err.message || 'No pudimos leer las medidas de tu plano. Intenta con una foto más clara o de mayor resolución.');
    } finally {
      setLoading(false);
      analyzeBtn.disabled = false;
    }
  }

  // Convierte el archivo a base64 y lo manda al webhook de n8n.
  // n8n es quien realmente llama a la API de visión (Claude/GPT-4V) con la
  // credencial guardada del lado del servidor — la key nunca toca el navegador.
  async function interpretarPlano(file) {
    if (!CONFIG.N8N_WEBHOOK_URL || CONFIG.N8N_WEBHOOK_URL === 'PON_AQUI_TU_URL_DE_WEBHOOK_N8N') {
      throw new Error('Falta configurar la URL del webhook de n8n en CONFIG.N8N_WEBHOOK_URL.');
    }

    const base64 = await fileToBase64(file);

    const response = await fetch(CONFIG.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type,
        // Se manda solo el contenido base64 (sin el prefijo "data:...;base64,")
        fileBase64: base64.split(',')[1],
      }),
    });

    if (!response.ok) {
      throw new Error('El servidor no pudo procesar el plano (código ' + response.status + ').');
    }

    const data = await response.json();

    // Contrato esperado de la respuesta del workflow de n8n:
    // { ok: true,  data: { largoM: 6.0, anchoM: 4.5, sentido: "..." } }
    // { ok: false, error: "mensaje legible para el usuario" }
    if (!data.ok) {
      throw new Error(data.error || 'No se detectaron medidas confiables en el plano.');
    }

    return data.data;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function normalizarSpecs(raw) {
    return {
      largoM: Number(raw.largoM) || 0,
      anchoM: Number(raw.anchoM) || 0,
      sentido: raw.sentido || 'Perpendicular al claro menor',
    };
  }

  /* =========================================================
     3. RENDER DE MEDIDAS DETECTADAS (+ edición manual)
     ========================================================= */

  function renderSpecs(specs) {
    specLargo.textContent = specs.largoM.toFixed(2);
    specAncho.textContent = specs.anchoM.toFixed(2);
    specArea.textContent = (specs.largoM * specs.anchoM).toFixed(2);
    specSentido.textContent = specs.sentido;
  }

  function handleEditSpecsClick() {
    const isEditing = editSpecsBtn.dataset.editing === 'true';

    if (!isEditing) {
      // Entrar a modo edición: cambiar los <span> por <input>
      specLargo = convertirSpecAInput(specLargo, state.specs.largoM);
      specAncho = convertirSpecAInput(specAncho, state.specs.anchoM);
      editSpecsBtn.textContent = 'Guardar medidas';
      editSpecsBtn.dataset.editing = 'true';
    } else {
      // Guardar: leer los inputs, actualizar estado y recalcular
      const nuevoLargo = parseFloat(specLargo.value) || 0;
      const nuevoAncho = parseFloat(specAncho.value) || 0;

      state.specs.largoM = nuevoLargo;
      state.specs.anchoM = nuevoAncho;

      specLargo = convertirInputASpec(specLargo, nuevoLargo.toFixed(2));
      specAncho = convertirInputASpec(specAncho, nuevoAncho.toFixed(2));
      specArea.textContent = (nuevoLargo * nuevoAncho).toFixed(2);

      editSpecsBtn.textContent = 'Corregir medidas';
      editSpecsBtn.dataset.editing = 'false';

      recalcularYRenderizarCotizacion();
    }
  }

  // Reemplaza un <span> de medida por un <input> editable y regresa el nuevo nodo
  function convertirSpecAInput(span, valor) {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.min = '0';
    input.id = span.id;
    input.value = Number(valor).toFixed(2);
    input.className = 'mono spec-edit-input';
    span.replaceWith(input);
    return input;
  }

  // Reemplaza un <input> editable de vuelta por un <span> con el valor final
  function convertirInputASpec(input, valorTexto) {
    const span = document.createElement('span');
    span.id = input.id;
    span.className = 'mono';
    span.textContent = valorTexto;
    input.replaceWith(span);
    return span;
  }

  /* =========================================================
     4. MOTOR DE CÁLCULO — vigueta / bovedilla (determinístico)
     ========================================================= */

  function calcularCantidades(specs) {
    const areaM2 = specs.largoM * specs.anchoM;

    // Viguetas: se colocan a lo largo del "ancho", espaciadas por eje.
    // +1 porque se necesita una vigueta en cada extremo además de las intermedias.
    const numViguetas = Math.max(0, Math.ceil(specs.anchoM / CONFIG.SEPARACION_EJES_VIGUETA_M) + 1);
    const longitudViguetaM = specs.largoM; // cada vigueta corre a lo largo del claro

    // Bovedillas: por densidad de piezas por m² (ajustable en CONFIG)
    const numBovedillas = Math.max(0, Math.ceil(areaM2 * CONFIG.BOVEDILLAS_POR_M2));

    return { areaM2, numViguetas, longitudViguetaM, numBovedillas };
  }

  /* =========================================================
     5. COSTEO
     ========================================================= */

  function calcularCosto(cantidades) {
    const precioVigueta = CONFIG.PRECIOS.precioViguetaPorMetro;
    const precioBovedilla = CONFIG.PRECIOS.precioBovedillaPorPieza;

    const subtotalViguetaCalc = cantidades.numViguetas * cantidades.longitudViguetaM * precioVigueta;
    const subtotalBovedillaCalc = cantidades.numBovedillas * precioBovedilla;

    return {
      precioVigueta,
      precioBovedilla,
      subtotalVigueta: subtotalViguetaCalc,
      subtotalBovedilla: subtotalBovedillaCalc,
      total: subtotalViguetaCalc + subtotalBovedillaCalc,
    };
  }

  /* =========================================================
     6. RENDER DE RESULTADOS
     ========================================================= */

  function recalcularYRenderizarCotizacion() {
    const cantidades = calcularCantidades(state.specs);
    const costo = calcularCosto(cantidades);
    state.quote = { ...cantidades, ...costo };

    qtyVigueta.textContent = `${cantidades.numViguetas} pz (${cantidades.longitudViguetaM.toFixed(2)} m c/u)`;
    priceVigueta.textContent = formatCurrency(costo.precioVigueta) + ' /m';
    subtotalVigueta.textContent = formatCurrency(costo.subtotalVigueta);

    qtyBovedilla.textContent = `${cantidades.numBovedillas} pz`;
    priceBovedilla.textContent = formatCurrency(costo.precioBovedilla) + ' /pz';
    subtotalBovedilla.textContent = formatCurrency(costo.subtotalBovedilla);

    totalCost.textContent = formatCurrency(costo.total);
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: CONFIG.MONEDA,
      maximumFractionDigits: 2,
    }).format(value || 0);
  }

  /* =========================================================
     ACCIONES FINALES
     ========================================================= */

  async function handleRequestQuoteClick() {
    if (!state.specs || !state.quote) return;

    // Si configuraste un webhook para leads, aquí se manda la cotización
    // completa para que la registres/envíes por correo desde n8n.
    if (CONFIG.N8N_LEAD_WEBHOOK_URL) {
      try {
        requestQuoteBtn.disabled = true;
        await fetch(CONFIG.N8N_LEAD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ specs: state.specs, quote: state.quote }),
        });
        alert('¡Listo! Recibimos tu solicitud, un asesor la revisará y te contactará.');
      } catch (err) {
        console.error(err);
        alert('No pudimos enviar tu solicitud en este momento. Intenta de nuevo en unos minutos.');
      } finally {
        requestQuoteBtn.disabled = false;
      }
    } else {
      // Sin webhook de leads configurado: solo confirma en pantalla.
      alert('Cotización preliminar generada. Configura N8N_LEAD_WEBHOOK_URL para enviarla automáticamente a tu equipo.');
    }
  }

  function handleNewQuoteClick() {
    resetFile();
    state.specs = null;
    state.quote = null;
    resultsSection.hidden = true;
    if (titleBlockStatus) titleBlockStatus.textContent = 'En espera de plano';
    document.getElementById('cotizar').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* =========================================================
     UI HELPERS
     ========================================================= */

  function setLoading(isLoading, message) {
    loadingIndicator.hidden = !isLoading;
    if (message) loadingMessage.textContent = message;
  }

  function showError(message) {
    errorText.textContent = message;
    errorMessage.hidden = false;
  }

  function hideError() {
    errorMessage.hidden = true;
  }

})();
