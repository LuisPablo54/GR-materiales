/*
  script.js — Cotizador de Losas (Automation Onyx)
  ---------------------------------------------------
  Pendiente: lógica completa. Se documentan aquí los módulos que
  se implementarán en el siguiente paso, referenciando los IDs
  que ya existen en index.html.

  1. Manejo del dropzone (#drop-zone, #file-input)
     - Click / drag&drop → mostrar vista previa (#preview-image, #preview-filename)
     - Habilitar #analyze-btn solo cuando hay archivo cargado
     - #remove-file-btn regresa el dropzone a su estado vacío

  2. Llamada al backend/proxy (n8n) que interpreta el plano
     - Enviar la imagen a un webhook de n8n (NO a la API de IA directamente,
       para no exponer la API key en el navegador)
     - Mostrar #loading-indicator mientras se espera respuesta
     - Manejar error de lectura → #error-message

  3. Render de medidas detectadas (#detected-specs)
     - Pintar #spec-largo, #spec-ancho, #spec-area, #spec-sentido
     - #edit-specs-btn permite corregir manualmente antes de calcular

  4. Motor de cálculo (vigueta / bovedilla)
     - Determinístico, en este archivo — NO depende de la IA
     - A partir de largo/ancho/sentido de armado calcular:
       cantidad de vigueta, cantidad de bovedilla
     - Pintar #qty-vigueta, #qty-bovedilla

  5. Costeo
     - Tabla de precios unitarios (por ahora hardcoded aquí,
       después posiblemente desde una hoja de cálculo/API)
     - Pintar #price-vigueta, #price-bovedilla,
       #subtotal-vigueta, #subtotal-bovedilla, #total-cost

  6. Mostrar sección de resultados (#resultados) y actualizar
     el estado del cajetín (data-title-block-status)

  document.addEventListener('DOMContentLoaded', () => {
    // TODO: inicializar módulos anteriores
  });
*/
```javascript
/* =========================================================
   COTIZADOR DE LOSAS — SCRIPT.JS
   Parte 1: Carga y gestión del plano
   ========================================================= */

document.addEventListener("DOMContentLoaded", () => {

    /* =====================================================
       ELEMENTOS DEL DOM
       ===================================================== */

    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("file-input");

    const previewContainer =
        document.querySelector("[data-dropzone-preview]");

    const emptyContainer =
        document.querySelector("[data-dropzone-empty]");

    const previewImage =
        document.getElementById("preview-image");

    const previewFilename =
        document.getElementById("preview-filename");

    const removeFileBtn =
        document.getElementById("remove-file-btn");

    const analyzeBtn =
        document.getElementById("analyze-btn");

    const loadingIndicator =
        document.getElementById("loading-indicator");

    const errorMessage =
        document.getElementById("error-message");

    const titleBlockStatus =
        document.querySelector("[data-title-block-status]");


    /* =====================================================
       CONFIGURACIÓN
       ===================================================== */

    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

    const ALLOWED_TYPES = [
        "image/jpeg",
        "image/png",
        "application/pdf"
    ];

    let selectedFile = null;


    /* =====================================================
       SELECCIONAR ARCHIVO
       ===================================================== */

    fileInput.addEventListener("change", (event) => {

        const file = event.target.files[0];

        if (!file) {
            return;
        }

        processFile(file);
    });


    /* =====================================================
       DRAG & DROP
       ===================================================== */

    dropZone.addEventListener("dragover", (event) => {

        event.preventDefault();

        dropZone.dataset.state = "dragover";
    });


    dropZone.addEventListener("dragleave", () => {

        dropZone.dataset.state = "empty";
    });


    dropZone.addEventListener("drop", (event) => {

        event.preventDefault();

        dropZone.dataset.state = "empty";

        const file = event.dataTransfer.files[0];

        if (!file) {
            return;
        }

        processFile(file);
    });


    /* =====================================================
       PROCESAR ARCHIVO
       ===================================================== */

    function processFile(file) {

        /* ---------------------------------------------
           Validar tipo
           --------------------------------------------- */

        if (!ALLOWED_TYPES.includes(file.type)) {

            showError(
                "Formato no compatible. Utiliza JPG, PNG o PDF."
            );

            return;
        }


        /* ---------------------------------------------
           Validar tamaño
           --------------------------------------------- */

        if (file.size > MAX_FILE_SIZE) {

            showError(
                "El archivo supera el límite de 10 MB."
            );

            return;
        }


        /* ---------------------------------------------
           Guardar archivo
           --------------------------------------------- */

        selectedFile = file;


        /* ---------------------------------------------
           Actualizar interfaz
           --------------------------------------------- */

        previewFilename.textContent = file.name;

        emptyContainer.hidden = true;
        previewContainer.hidden = false;

        analyzeBtn.disabled = false;

        dropZone.dataset.state = "loaded";


        /* ---------------------------------------------
           Mostrar preview
           --------------------------------------------- */

        if (file.type.startsWith("image/")) {

            const reader = new FileReader();

            reader.onload = (event) => {

                previewImage.src = event.target.result;

                previewImage.hidden = false;
            };

            reader.readAsDataURL(file);

        } else {

            /*
             * Los PDF no se muestran directamente
             * como imagen en este preview.
             */

            previewImage.removeAttribute("src");

            previewImage.hidden = true;
        }


        /* ---------------------------------------------
           Estado del cajetín
           --------------------------------------------- */

        if (titleBlockStatus) {

            titleBlockStatus.textContent =
                "Plano cargado";
        }


        /* ---------------------------------------------
           Limpiar errores anteriores
           --------------------------------------------- */

        hideError();
    }


    /* =====================================================
       QUITAR ARCHIVO
       ===================================================== */

    removeFileBtn.addEventListener("click", () => {

        resetUploader();
    });


    function resetUploader() {

        selectedFile = null;

        fileInput.value = "";

        previewImage.removeAttribute("src");

        previewImage.hidden = false;

        previewFilename.textContent = "";

        previewContainer.hidden = true;
        emptyContainer.hidden = false;

        analyzeBtn.disabled = true;

        dropZone.dataset.state = "empty";


        if (titleBlockStatus) {

            titleBlockStatus.textContent =
                "En espera de plano";
        }

        hideError();
    }


    /* =====================================================
       ERRORES
       ===================================================== */

    function showError(message) {

        const errorText =
            errorMessage.querySelector("[data-error-text]");

        if (errorText) {
            errorText.textContent = message;
        }

        errorMessage.hidden = false;
    }


    function hideError() {

        errorMessage.hidden = true;
    }


    /* =====================================================
       BOTÓN ANALIZAR
       ===================================================== */

    analyzeBtn.addEventListener("click", () => {

        if (!selectedFile) {
            return;
        }

        analyzePlan();
    });


    function analyzePlan() {

        /*
         * Todavía NO conectamos n8n.
         *
         * Aquí posteriormente tendremos:
         *
         * navegador
         *      ↓
         * FormData
         *      ↓
         * Webhook n8n
         *      ↓
         * IA
         *      ↓
         * medidas detectadas
         *      ↓
         * cálculo
         */

        hideError();

        loadingIndicator.hidden = false;

        analyzeBtn.disabled = true;

        if (titleBlockStatus) {

            titleBlockStatus.textContent =
                "Analizando plano";
        }


        /*
         * Simulación temporal.
         * Después será sustituida por fetch()
         * hacia el webhook de n8n.
         */

        setTimeout(() => {

            loadingIndicator.hidden = true;

            analyzeBtn.disabled = false;

            if (titleBlockStatus) {

                titleBlockStatus.textContent =
                    "Análisis pendiente";
            }

            console.log(
                "Archivo listo para enviar a n8n:",
                selectedFile
            );

        }, 1500);
    }


    /* =====================================================
       AÑO DEL FOOTER
       ===================================================== */

    const currentYear =
        document.getElementById("current-year");

    if (currentYear) {

        currentYear.textContent =
            new Date().getFullYear();
    }

});
```

