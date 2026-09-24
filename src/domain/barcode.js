/* ============================================================================
   domain/barcode.js — Escáner universal de códigos de barra (EAN-13, etc.)
   Capa de dispositivo-agnóstica: los lectores USB/Bluetooth y los colectores
   Android que emulan teclado (el caso más común) no necesitan código
   especial — escriben el código y "presionan Enter" como un teclado real,
   así que un <input> normal dentro de un <form> ya los captura sin lógica
   adicional (ver <form data-form="of-consumo"> en viewOfScanPanel, app.js).
   Este módulo agrega sólo lo que un <input> no puede dar solo: lectura por
   cámara del celular (Barcode Detection API, con manejo explícito de que no
   todos los navegadores la soportan) y una etiqueta simple de qué tipo de
   dispositivo está escaneando (para trazabilidad).
   ========================================================================== */

/** True si el navegador soporta la Barcode Detection API nativa (Chrome/
 * Android mayormente; Safari/Firefox no la tienen todavía — hay que avisar
 * en vez de fallar en silencio). */
export function cameraScanSupported() {
  return typeof window !== "undefined" && "BarcodeDetector" in window &&
    typeof navigator !== "undefined" && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/** Etiqueta simple del tipo de dispositivo, sólo para trazabilidad
 * (production_consumptions.dispositivo) — no cambia ningún comportamiento. */
export function detectDeviceLabel() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Mobi/i.test(ua)) return "Móvil";
  return "PC/Notebook";
}

/**
 * Abre un overlay de escaneo por cámara, fuera del sistema de modales
 * genérico de la app (que se reconstruye en cada renderApp(), lo que
 * cortaría el stream de video a mitad de camino) para poder manejar el
 * ciclo de vida de la cámara de forma segura y autocontenida. Llama a
 * onResult(code) apenas detecta un código y cierra el overlay solo;
 * onClose(reason) se llama si el operador cancela, si no hay permiso de
 * cámara, o si el navegador no soporta esta API ("unsupported"). Devuelve
 * una función close() por si hay que cerrarla desde afuera.
 */
export function openCameraScan({ onResult, onClose } = {}) {
  if (!cameraScanSupported()) {
    if (onClose) onClose("unsupported");
    return () => {};
  }
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:#000;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;";
  const video = document.createElement("video");
  video.setAttribute("playsinline", "true");
  video.setAttribute("muted", "true");
  video.style.cssText = "max-width:100%;max-height:75vh;border-radius:8px;";
  const hint = document.createElement("div");
  hint.textContent = "Apuntá la cámara al código de barras…";
  hint.style.cssText = "color:#fff;font-size:13px;";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "✕ Cerrar cámara";
  closeBtn.style.cssText = "padding:10px 18px;border-radius:8px;border:none;background:#fff;font-weight:700;cursor:pointer;";
  overlay.appendChild(video);
  overlay.appendChild(hint);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);

  let stream = null, stopped = false, rafId = null;
  let detector;
  try {
    detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128", "upc_a", "upc_e"] });
  } catch {
    overlay.remove();
    if (onClose) onClose("unsupported");
    return () => {};
  }

  function cleanup() {
    if (stopped) return;
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    overlay.remove();
  }
  closeBtn.addEventListener("click", () => { cleanup(); if (onClose) onClose("cancelled"); });

  async function loop() {
    if (stopped) return;
    try {
      const codes = await detector.detect(video);
      if (codes && codes.length) {
        const value = codes[0].rawValue;
        cleanup();
        if (onResult) onResult(value);
        return;
      }
    } catch { /* frame no legible todavía, se reintenta en el próximo */ }
    rafId = requestAnimationFrame(loop);
  }

  navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
    .then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      video.srcObject = s;
      video.play();
      rafId = requestAnimationFrame(loop);
    })
    .catch(() => {
      cleanup();
      if (onClose) onClose("permission_denied");
    });

  return cleanup;
}
