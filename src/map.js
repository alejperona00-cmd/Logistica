/* ============================================================================
   Mapa real — Google Maps Platform (Maps JavaScript API, Places API (New),
   Geocoding, Directions, Street View).

   Reemplaza el motor anterior (Leaflet + OpenStreetMap) manteniendo EXACTAMENTE
   las mismas funciones exportadas que ya usa app.js (mountMap, mountPickerMap,
   destroyMap, geocodeAddress, mountLogisticsMap, focusLogisticsMap,
   destroyLogisticsMap) para no tener que tocar el resto de la app, más las
   funciones nuevas que pide la evolución a Google Maps: searchPlacesAutocomplete/
   getPlaceById (Places API (New)), calculateRoute (Directions), openStreetView
   (Street View real, nunca una imagen inventada) y googleMapsKeyConfigured
   (para poder avisar con claridad cuando todavía no hay una clave).

   Regla dura de este archivo (igual que el resto del proyecto): nunca inventar
   un dato geográfico. Si algo no se puede geocodificar, no hay cobertura de
   Street View, o todavía no hay una API key configurada, se avisa con un
   mensaje explícito — nunca un mapa en blanco sin explicación ni una posición
   aproximada presentada como real.
   ========================================================================== */
import { clusterPoints } from "./domain/geo.js";

const ARG_CENTER = { lat: -34.6, lng: -64.5 };
const ARG_ZOOM = 5;

/* ============================================================================
   Carga del script de Google Maps — una sola vez por sesión de la app, sin
   importar cuántas veces se llame. La clave viene de una variable de entorno
   (VITE_GOOGLE_MAPS_API_KEY) — nunca hardcodeada en el código.
   ========================================================================== */
let loaderPromise = null;

/** true sólo si hay algo cargado en la variable de entorno. No confirma que la
 * clave sea válida ni que tenga las APIs habilitadas — eso se sabe recién
 * cuando Google responde (ver loadGoogleMaps). */
export function googleMapsKeyConfigured() {
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  return !!(key && key.trim());
}

/** Carga (o reutiliza) el script de Google Maps. Devuelve una promesa que
 * resuelve con `google.maps` una vez que está listo para usarse. Si no hay
 * clave configurada, o Google rechaza la carga (clave inválida, API no
 * habilitada, sin facturación, etc.), la promesa se rechaza — quien llama
 * debe mostrar un aviso claro, nunca un mapa en blanco silencioso. */
export function loadGoogleMaps() {
  if (loaderPromise) return loaderPromise;
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!key || !key.trim()) {
    return Promise.reject(new Error("NO_API_KEY"));
  }
  loaderPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps && window.google.maps.Map) {
      resolve(window.google);
      return;
    }
    const cbName = "__lpGmapsReady_" + Math.random().toString(36).slice(2);
    window[cbName] = () => {
      delete window[cbName];
      if (window.google && window.google.maps) resolve(window.google);
      else reject(new Error("LOAD_FAILED"));
    };
    const script = document.createElement("script");
    script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) +
      "&libraries=places,visualization,geometry&language=es&region=AR&loading=async&callback=" + cbName;
    script.async = true;
    script.onerror = () => { loaderPromise = null; reject(new Error("LOAD_FAILED")); };
    document.head.appendChild(script);
  });
  return loaderPromise;
}

/** Mensaje honesto para mostrar en vez de un mapa, según por qué no se pudo
 * cargar — nunca un mapa en blanco sin explicación. */
function noMapMessageHTML(reason) {
  if (reason === "NO_API_KEY") {
    return `<div class="gmap-unavailable">
      <div class="gmap-unavailable-icon">🗺️</div>
      <b>Falta configurar Google Maps</b>
      <p>Todavía no hay una clave de Google Maps cargada (<code>VITE_GOOGLE_MAPS_API_KEY</code> en <code>.env.local</code>). El resto de la app funciona igual — sólo el mapa visual queda pendiente hasta que se configure la clave.</p>
    </div>`;
  }
  return `<div class="gmap-unavailable">
    <div class="gmap-unavailable-icon">⚠️</div>
    <b>No se pudo cargar Google Maps</b>
    <p>Revisá que la clave tenga habilitadas Maps JavaScript API, Places API (New), Geocoding API y Directions API, y que el proyecto de Google Cloud tenga facturación activa.</p>
  </div>`;
}

/* ============================================================================
   Memoria de cámara — arregla, de forma correcta, el problema de que la app
   destruye y vuelve a crear el <div> del mapa en cada re-render (cualquier
   click, filtro o tipeo en el buscador dispara un render que reemplaza todo
   #app-main). Antes, el "no reencuadrar en cada interacción" se guardaba en el
   objeto de instancia del mapa — pero ese objeto se recreaba junto con el
   contenedor, así que en la práctica NUNCA sobrevivía a un solo render.
   Ahora la posición de cámara (centro/zoom/tipo de mapa) se guarda acá, en un
   Map a nivel de módulo indexado por containerId, actualizado en vivo con el
   evento 'idle' del mapa — independiente del ciclo de vida del objeto de
   instancia. Así, el próximo montaje (aunque sea un <div> nuevo) arranca
   exactamente donde había quedado la vista, y sólo se hace un encuadre
   automático sobre los marcadores la primera vez que ese contenedor se monta
   (o cuando quien llama lo pide explícitamente).
   ========================================================================== */
const savedViews = new Map(); // containerId -> { center:{lat,lng}, zoom, mapTypeId }

function rememberView(containerId, map) {
  try {
    const c = map.getCenter();
    if (!c) return;
    savedViews.set(containerId, { center: { lat: c.lat(), lng: c.lng() }, zoom: map.getZoom(), mapTypeId: map.getMapTypeId() });
  } catch { /* el mapa puede estar en un estado transitorio justo al destruirse */ }
}

function lastMapType() {
  try { return localStorage.getItem("lp_map_type") || "roadmap"; } catch { return "roadmap"; }
}
function rememberMapType(type) {
  try { localStorage.setItem("lp_map_type", type); } catch { /* almacenamiento no disponible: no es crítico */ }
}

/* ============================================================================
   Íconos de marcador — mismos colores/emojis por tipo que ya existían (no se
   cambian los datos ni la identidad visual por tipo), pero ahora como SVG en
   un data URI en vez de un ícono de Leaflet.
   ========================================================================== */
function colorForKind(kind, colorOverride) {
  const colors = {
    deposito: "#111111", proveedor: "#55524C", pedido: "#111111", cliente: "#111111", incidencia: "#C9142B", ruta: "#171613",
    transportista: "#55524B", zona: "#4B5A6B",
    pedido_pendiente: "#8A6E33", pedido_transito: "#A3691F", pedido_entregado: "#1E7A46", pedido_incidencia: "#C9142B", pedido_sin_estado: "#918D82",
    veh_camion: "#55524B", veh_moto: "#55524B", veh_auto: "#55524B", veh_furgon: "#55524B", veh_utilitario: "#55524B", veh_combi: "#55524B", veh_camioneta: "#55524B",
  };
  return colorOverride || colors[kind] || "#111111";
}
const EMOJI_BY_KIND = {
  deposito: "🏢", proveedor: "🏭", pedido: "📦", cliente: "📍", incidencia: "⚠️", ruta: "🚚",
  transportista: "🚛", zona: "🗺️",
  pedido_pendiente: "📦", pedido_transito: "🚚", pedido_entregado: "✅", pedido_incidencia: "⚠️", pedido_sin_estado: "📦",
  veh_camion: "🚛", veh_moto: "🏍️", veh_auto: "🚗", veh_furgon: "🚐", veh_utilitario: "🚙", veh_combi: "🚐", veh_camioneta: "🛻",
};

const svgIconCache = new Map();
function iconFor(kind, colorOverride) {
  const color = colorForKind(kind, colorOverride);
  const emoji = EMOJI_BY_KIND[kind] || "📍";
  const key = kind + "|" + color;
  if (svgIconCache.has(key)) return svgIconCache.get(key);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="40" viewBox="0 0 34 40">
    <path d="M17 0C7.6 0 0 7.6 0 17c0 11 13.6 21.6 16 23.3a1.5 1.5 0 0 0 2 0C20.4 38.6 34 28 34 17 34 7.6 26.4 0 17 0z" fill="${color}" stroke="#fff" stroke-width="2"/>
    <circle cx="17" cy="17" r="11" fill="#fff" opacity="0.001"/>
    <text x="17" y="22" font-size="16" text-anchor="middle">${emoji}</text>
  </svg>`;
  const url = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
  const icon = { url, scaledSize: new window.google.maps.Size(30, 36), anchor: new window.google.maps.Point(15, 34) };
  svgIconCache.set(key, icon);
  return icon;
}
function clusterIcon(count) {
  const size = count > 20 ? 46 : count > 5 ? 38 : 32;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="#111111" stroke="#fff" stroke-width="2"/>
    <text x="50%" y="54%" font-size="${count > 99 ? 12 : 14}" font-weight="800" fill="#fff" text-anchor="middle" font-family="monospace">+${count}</text>
  </svg>`;
  return { url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg), scaledSize: new window.google.maps.Size(size, size), anchor: new window.google.maps.Point(size / 2, size / 2) };
}

/* ============================================================================
   Controles propios — "Mi ubicación" y "Ver todas las operaciones" (Google ya
   trae de fábrica el resto: satélite/calles, zoom, pantalla completa, Street
   View), con la estética de Logística Perona en vez de un botón genérico.
   ========================================================================== */
function makeControlButton(label, title) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "gmap-ctrl-btn";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.textContent = label;
  return btn;
}

function fitMapToPoints(map, points, { padding = 60, maxZoom = 15, singleZoom = 13 } = {}) {
  const google = window.google;
  if (!points.length) { map.setCenter(ARG_CENTER); map.setZoom(ARG_ZOOM); return; }
  if (points.length === 1) { map.setCenter(points[0]); map.setZoom(singleZoom); return; }
  const bounds = new google.maps.LatLngBounds();
  points.forEach((p) => bounds.extend(p));
  map.fitBounds(bounds, padding);
  google.maps.event.addListenerOnce(map, "bounds_changed", () => { if (map.getZoom() > maxZoom) map.setZoom(maxZoom); });
}

function addOverviewControl(map, containerId, getPoints) {
  const btn = makeControlButton("⤢", "Ver todas las operaciones");
  btn.addEventListener("click", () => fitMapToPoints(map, getPoints()));
  map.controls[window.google.maps.ControlPosition.RIGHT_BOTTOM].push(btn);
}
function addMyLocationControl(map) {
  const btn = makeControlButton("📍", "Mi ubicación");
  btn.addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => { map.panTo({ lat: pos.coords.latitude, lng: pos.coords.longitude }); map.setZoom(14); },
      () => { /* permiso denegado o no disponible: no se hace nada, no se inventa una posición */ }
    );
  });
  map.controls[window.google.maps.ControlPosition.RIGHT_BOTTOM].push(btn);
}

/* ============================================================================
   mountMap — mapa simple con marcadores (+ opcionalmente rutas), usado por el
   mini-mapa del dashboard, "Ubicaciones" y el mapa de un transporte. Misma
   firma que la versión anterior con Leaflet.
   markers: [{ id, kind, lat, lng, label, popupHtml, onClick }]
   opts.routes: [{ id, points:[[lat,lng],[lat,lng]], color, popupHtml }]
   ========================================================================== */
const instances = new Map(); // containerId -> { map, markers:[], polylines:[], infoWindow, generation }

export function mountMap(containerId, markers, opts = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!googleMapsKeyConfigured()) { el.innerHTML = noMapMessageHTML("NO_API_KEY"); return; }
  el.innerHTML = "";

  loadGoogleMaps().then((google) => {
    if (!document.body.contains(el)) return;
    const saved = savedViews.get(containerId);
    const map = new google.maps.Map(el, {
      center: saved ? saved.center : ARG_CENTER,
      zoom: saved ? saved.zoom : ARG_ZOOM,
      mapTypeId: saved ? saved.mapTypeId : lastMapType(),
      mapTypeControl: true, streetViewControl: true, fullscreenControl: true, zoomControl: true,
      mapTypeControlOptions: { position: google.maps.ControlPosition.TOP_RIGHT },
      fullscreenControlOptions: { position: google.maps.ControlPosition.RIGHT_TOP },
    });
    const infoWindow = new google.maps.InfoWindow();
    const gMarkers = [], polylines = [];
    const pts = [];
    (opts.routes || []).forEach((r) => {
      if (!Array.isArray(r.points) || r.points.length < 2) return;
      const path = r.points.map(([lat, lng]) => ({ lat, lng }));
      path.forEach((p) => pts.push(p));
      const line = new google.maps.Polyline({ path, map, strokeColor: r.color || "#171613", strokeOpacity: 0.8, strokeWeight: 3 });
      if (r.popupHtml) line.addListener("click", (e) => { infoWindow.setContent(r.popupHtml); infoWindow.setPosition(e.latLng); infoWindow.open(map); });
      polylines.push(line);
    });
    (markers || []).forEach((m) => {
      if (typeof m.lat !== "number" || typeof m.lng !== "number") return;
      pts.push({ lat: m.lat, lng: m.lng });
      const marker = new google.maps.Marker({ position: { lat: m.lat, lng: m.lng }, map, icon: iconFor(m.kind), title: m.label || "" });
      marker.addListener("click", () => {
        if (m.popupHtml) { infoWindow.setContent(m.popupHtml); infoWindow.open(map, marker); }
        if (m.onClick) m.onClick(m);
      });
      gMarkers.push(marker);
    });
    map.addListener("maptypeid_changed", () => rememberMapType(map.getMapTypeId()));
    map.addListener("idle", () => rememberView(containerId, map));
    addOverviewControl(map, containerId, () => pts);
    addMyLocationControl(map);
    fitMapToPoints(map, pts, { singleZoom: opts.singleZoom || 13 });
    instances.set(containerId, { map, markers: gMarkers, polylines, infoWindow });
  }).catch((err) => {
    if (document.body.contains(el)) el.innerHTML = noMapMessageHTML(err && err.message === "NO_API_KEY" ? "NO_API_KEY" : "LOAD_FAILED");
  });
}

export function destroyMap(containerId) {
  instances.delete(containerId);
}

/* ============================================================================
   mountPickerMap — un único marcador arrastrable para fijar una ubicación
   nueva. Misma firma que antes.
   ========================================================================== */
const pickerInstances = new Map();

export function mountPickerMap(containerId, lat, lng, onMove) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!googleMapsKeyConfigured()) { el.innerHTML = noMapMessageHTML("NO_API_KEY"); return; }
  el.innerHTML = "";
  loadGoogleMaps().then((google) => {
    if (!document.body.contains(el)) return;
    const map = new google.maps.Map(el, { center: { lat, lng }, zoom: 15, mapTypeControl: true, streetViewControl: false, fullscreenControl: false });
    const marker = new google.maps.Marker({ position: { lat, lng }, map, draggable: true, icon: iconFor("cliente") });
    marker.addListener("dragend", () => { const p = marker.getPosition(); onMove(p.lat(), p.lng()); });
    map.addListener("click", (e) => { marker.setPosition(e.latLng); onMove(e.latLng.lat(), e.latLng.lng()); });
    pickerInstances.set(containerId, { map, marker });
  }).catch((err) => {
    if (document.body.contains(el)) el.innerHTML = noMapMessageHTML(err && err.message === "NO_API_KEY" ? "NO_API_KEY" : "LOAD_FAILED");
  });
}

/* ============================================================================
   Geocodificación — Google Geocoding API. Si no hay clave configurada o falla
   la carga, devuelve [] (nunca inventa una coordenada): quien llama ya sabe
   mostrar "no se encontró esa dirección" en ese caso.
   ========================================================================== */
export async function geocodeAddress(query) {
  if (!query || !query.trim()) return [];
  try {
    const google = await loadGoogleMaps();
    const geocoder = new google.maps.Geocoder();
    const res = await geocoder.geocode({ address: query, region: "ar" });
    return (res.results || []).map((r) => ({ lat: r.geometry.location.lat(), lng: r.geometry.location.lng(), label: r.formatted_address }));
  } catch {
    return [];
  }
}

/* ============================================================================
   Places API (New) — autocompletado de direcciones/lugares para el buscador
   general y para "Planificar recorrido". No reemplaza la búsqueda interna de
   pedidos/clientes/transportistas — se muestra como un grupo aparte.
   ========================================================================== */
export async function searchPlacesAutocomplete(query, sessionToken) {
  if (!query || !query.trim()) return [];
  try {
    const google = await loadGoogleMaps();
    const { suggestions } = await google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input: query,
      sessionToken,
      includedRegionCodes: ["ar"],
      language: "es",
    });
    return (suggestions || [])
      .filter((s) => s.placePrediction)
      .map((s) => ({ placeId: s.placePrediction.placeId, label: s.placePrediction.text.text, place: s.placePrediction }));
  } catch {
    return [];
  }
}

/** Resuelve un placeId de Places (New) a coordenadas reales + dirección
 * formateada. Nunca inventa una coordenada: si Google no puede resolverlo,
 * devuelve null. */
export async function getPlaceById(placeId, placePrediction) {
  try {
    const google = await loadGoogleMaps();
    const place = placePrediction ? placePrediction.toPlace() : new google.maps.places.Place({ id: placeId });
    await place.fetchFields({ fields: ["location", "formattedAddress", "displayName"] });
    if (!place.location) return null;
    return { lat: place.location.lat(), lng: place.location.lng(), label: place.formattedAddress || place.displayName || "" };
  } catch {
    return null;
  }
}

/** Crea un token de sesión de Places (New) — agrupa las consultas de
 * autocompletado de una misma búsqueda para la facturación de Google. */
export async function createPlacesSessionToken() {
  try {
    const google = await loadGoogleMaps();
    return new google.maps.places.AutocompleteSessionToken();
  } catch {
    return undefined;
  }
}

/* ============================================================================
   Directions — ruta real sobre calles reales entre dos puntos (coordenadas
   {lat,lng}, ya sea de una ubicación guardada o de un resultado de Places).
   Si Directions no puede resolver una ruta (sin cobertura, puntos
   inalcanzables por calle, sin clave configurada), devuelve null — quien
   llama debe mostrar el motivo, nunca inventar una distancia/tiempo.
   ========================================================================== */
export async function calculateRoute(origin, destination) {
  try {
    const google = await loadGoogleMaps();
    const svc = new google.maps.DirectionsService();
    const res = await svc.route({
      origin, destination,
      travelMode: google.maps.TravelMode.DRIVING,
      region: "ar",
    });
    const route = res.routes && res.routes[0];
    if (!route || !route.legs || !route.legs[0]) return null;
    const leg = route.legs[0];
    const path = route.overview_path.map((p) => ({ lat: p.lat(), lng: p.lng() }));
    return {
      distanceKm: Math.round((leg.distance?.value || 0) / 100) / 10,
      distanceText: leg.distance?.text || "",
      durationMin: Math.round((leg.duration?.value || 0) / 60),
      durationText: leg.duration?.text || "",
      path,
    };
  } catch {
    return null;
  }
}

/* ============================================================================
   Street View — 360° real. Nunca se muestra una imagen falsa: si Google no
   tiene cobertura cerca del punto (StreetViewService la busca en un radio
   razonable), se avisa explícitamente en vez de mostrar cualquier otra cosa.
   ========================================================================== */
const streetViewInstances = new Map();

export async function openStreetView(containerId, lat, lng) {
  const el = document.getElementById(containerId);
  if (!el) return { available: false };
  el.innerHTML = `<div class="gmap-sv-loading">Buscando cobertura de Street View…</div>`;
  try {
    const google = await loadGoogleMaps();
    const svc = new google.maps.StreetViewService();
    const result = await new Promise((resolve) => {
      svc.getPanorama({ location: { lat, lng }, radius: 100, source: google.maps.StreetViewSource.OUTDOOR }, (data, status) => {
        resolve(status === google.maps.StreetViewStatus.OK ? data : null);
      });
    });
    if (!document.body.contains(el)) return { available: false };
    if (!result) {
      el.innerHTML = `<div class="gmap-sv-unavailable">📷 Street View no disponible para esta ubicación.</div>`;
      return { available: false };
    }
    el.innerHTML = "";
    const pano = new google.maps.StreetViewPanorama(el, {
      position: result.location.latLng,
      pov: { heading: 0, pitch: 0 },
      addressControl: true, fullscreenControl: true, motionTracking: false,
    });
    streetViewInstances.set(containerId, pano);
    return { available: true };
  } catch {
    if (document.body.contains(el)) el.innerHTML = `<div class="gmap-sv-unavailable">📷 Street View no disponible para esta ubicación.</div>`;
    return { available: false };
  }
}
export function destroyStreetView(containerId) {
  streetViewInstances.delete(containerId);
}

/* ============================================================================
   CENTRO GEOESPACIAL — capas activables, clustering (reutiliza la misma
   función pura clusterPoints ya usada con Leaflet, agnóstica del motor de
   mapa) y mapa de calor con el HeatmapLayer nativo de Google.
   ========================================================================== */
const logisticInstances = new Map(); // containerId -> { map, layerObjs, currentConfig, lastPoints, activeInfoWindow }

function redrawLogisticsMap(inst, containerId) {
  const google = window.google;
  const { map } = inst;
  const config = inst.currentConfig || {};
  const zoom = map.getZoom();
  const pts = [];

  // Se descarta todo lo dibujado antes y se vuelve a construir — más simple y
  // suficientemente rápido para la cantidad de marcadores reales de la app.
  Object.values(inst.layerObjs).forEach((arr) => (arr || []).forEach((o) => o.setMap && o.setMap(null)));
  inst.layerObjs = {};
  if (inst.heatLayer) { inst.heatLayer.setMap(null); inst.heatLayer = null; }

  let markerToReopen = null;

  Object.entries(config.layers || {}).forEach(([key, layer]) => {
    const objs = [];
    if (layer.visible === false) { inst.layerObjs[key] = objs; return; }
    const markers = layer.markers || [];
    const drawOne = (m, icon) => {
      const marker = new google.maps.Marker({ position: { lat: m.lat, lng: m.lng }, map, icon, title: m.label || "" });
      marker.__lpId = m.id;
      if (m.popupHtml || m.onClick) {
        marker.addListener("click", () => {
          if (m.popupHtml) {
            if (inst.activeInfoWindow) inst.activeInfoWindow.close();
            const iw = new google.maps.InfoWindow({ content: m.popupHtml });
            iw.open(map, marker);
            inst.activeInfoWindow = iw;
          }
          if (m.onClick) m.onClick(m);
        });
      }
      if (config.selectedId && m.id === config.selectedId && m.popupHtml) markerToReopen = { marker, popupHtml: m.popupHtml };
      objs.push(marker);
    };
    if (layer.cluster && markers.length > 1) {
      clusterPoints(markers, zoom).forEach((c) => {
        if (c.count === 1) { const m = c.items[0]; pts.push({ lat: m.lat, lng: m.lng }); drawOne(m, iconFor(m.kind, m.color)); }
        else {
          const marker = new google.maps.Marker({ position: { lat: c.lat, lng: c.lng }, map, icon: clusterIcon(c.count) });
          marker.addListener("click", () => { map.panTo({ lat: c.lat, lng: c.lng }); map.setZoom(Math.min(zoom + 2, 17)); });
          pts.push({ lat: c.lat, lng: c.lng });
          objs.push(marker);
        }
      });
    } else {
      markers.forEach((m) => { pts.push({ lat: m.lat, lng: m.lng }); drawOne(m, iconFor(m.kind, m.color)); });
    }
    inst.layerObjs[key] = objs;
  });

  // Rutas reales (recorridos de transporte, o el resultado de Directions de
  // "Planificar recorrido") — lo que venga en config.routes ya trae los puntos.
  const routeObjs = [];
  if (config.routesVisible !== false) {
    (config.routes || []).forEach((r) => {
      if (!Array.isArray(r.points) || r.points.length < 2) return;
      const path = r.points.map(([lat, lng]) => ({ lat, lng }));
      path.forEach((p) => pts.push(p));
      const line = new google.maps.Polyline({ path, map, strokeColor: r.color || "#171613", strokeOpacity: 0.85, strokeWeight: 4 });
      if (r.popupHtml) line.addListener("click", (e) => {
        if (inst.activeInfoWindow) inst.activeInfoWindow.close();
        const iw = new google.maps.InfoWindow({ content: r.popupHtml, position: e.latLng });
        iw.open(map);
        inst.activeInfoWindow = iw;
      });
      routeObjs.push(line);
    });
  }
  inst.layerObjs.__routes = routeObjs;

  // Radios de cobertura geográfica (nunca tiempo de entrega).
  const circleObjs = [];
  (config.circles || []).forEach((c) => {
    circleObjs.push(new google.maps.Circle({ center: { lat: c.lat, lng: c.lng }, radius: c.radiusMeters, map, strokeColor: c.color || "#171613", strokeWeight: 1.5, fillOpacity: 0.04, strokeOpacity: 0.6 }));
  });
  inst.layerObjs.__circles = circleObjs;

  // Mapa de calor real (google.maps.visualization.HeatmapLayer).
  if (config.heat && config.heat.visible && (config.heat.points || []).length && google.maps.visualization) {
    const weighted = config.heat.points.map((p) => ({ location: new google.maps.LatLng(p.lat, p.lng), weight: p.weight || 1 }));
    inst.heatLayer = new google.maps.visualization.HeatmapLayer({ data: weighted, map, radius: 32, opacity: 0.65 });
    config.heat.points.forEach((p) => pts.push({ lat: p.lat, lng: p.lng }));
  }

  inst.lastPoints = pts;

  // El auto-encuadre sólo pasa la primera vez que ESTE containerId se monta en
  // toda la sesión (savedViews no tiene nada todavía), o cuando quien llama lo
  // fuerza explícitamente (config.fitBounds === true, p.ej. al cambiar de
  // nivel Operativo/Táctico/Estratégico). Esto es lo que antes se intentaba
  // lograr con una bandera en el objeto de instancia — que se perdía en cada
  // render porque el contenedor se recrea siempre; ahora se apoya en
  // savedViews, que sobrevive a la recreación del <div>.
  const hasSavedView = savedViews.has(containerId);
  const shouldFit = config.fitBounds === true || (!hasSavedView && config.fitBounds !== false);
  if (shouldFit) fitMapToPoints(map, pts, { singleZoom: config.singleZoom || 6, maxZoom: 13 });

  if (markerToReopen) {
    const iw = new google.maps.InfoWindow({ content: markerToReopen.popupHtml });
    iw.open(map, markerToReopen.marker);
    inst.activeInfoWindow = iw;
  }
}

/**
 * Monta (o actualiza) el Centro Geoespacial dentro de #containerId.
 * config = {
 *   layers: { [key]: { markers:[{id,lat,lng,kind,color,popupHtml,onClick}], cluster:bool, visible:bool } },
 *   routes: [{ points:[[lat,lng],[lat,lng]], popupHtml, color }],
 *   routesVisible: bool,
 *   circles: [{ lat, lng, radiusMeters, color }],
 *   heat: { visible: bool, points: [{lat,lng,weight}] },
 *   fitBounds: bool (default: sólo la primera vez que se ve este contenedor en la sesión),
 *   selectedId: string — si un marcador con ese id tiene popupHtml, se reabre su InfoWindow automáticamente.
 *   singleZoom: number,
 * }
 */
export function mountLogisticsMap(containerId, config = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!googleMapsKeyConfigured()) {
    if (!el.dataset.gmapMsgShown) { el.innerHTML = noMapMessageHTML("NO_API_KEY"); el.dataset.gmapMsgShown = "1"; }
    return;
  }

  const existing = logisticInstances.get(containerId);
  if (existing && existing.el === el) {
    existing.currentConfig = config;
    redrawLogisticsMap(existing, containerId);
    return;
  }
  // El contenedor es nuevo (re-render de la app) o todavía no existe ninguna
  // instancia: hay que crear el mapa de Google desde cero en este <div>. La
  // vista de cámara se recupera de savedViews si ya existía.
  el.innerHTML = "";
  el.removeAttribute("data-gmap-msg-shown");
  loadGoogleMaps().then((google) => {
    if (!document.body.contains(el)) return;
    const saved = savedViews.get(containerId);
    const map = new google.maps.Map(el, {
      center: saved ? saved.center : ARG_CENTER,
      zoom: saved ? saved.zoom : ARG_ZOOM,
      mapTypeId: saved ? saved.mapTypeId : lastMapType(),
      mapTypeControl: true, streetViewControl: true, fullscreenControl: true, zoomControl: true,
      mapTypeControlOptions: { position: google.maps.ControlPosition.TOP_RIGHT, style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR },
      fullscreenControlOptions: { position: google.maps.ControlPosition.RIGHT_TOP },
    });
    const inst = { el, map, layerObjs: {}, heatLayer: null, currentConfig: config, activeInfoWindow: null, lastPoints: [] };
    map.addListener("maptypeid_changed", () => rememberMapType(map.getMapTypeId()));
    map.addListener("idle", () => rememberView(containerId, map));
    map.addListener("zoom_changed", () => redrawLogisticsMap(inst, containerId));
    addOverviewControl(map, containerId, () => inst.lastPoints);
    addMyLocationControl(map);
    logisticInstances.set(containerId, inst);
    redrawLogisticsMap(inst, containerId);
  }).catch((err) => {
    if (document.body.contains(el)) el.innerHTML = noMapMessageHTML(err && err.message === "NO_API_KEY" ? "NO_API_KEY" : "LOAD_FAILED");
  });
}

/** Centra el Centro Geoespacial en un punto (usado por el buscador). Actualiza
 * también la memoria de cámara, para que un re-render inmediatamente después
 * (habitual: seleccionar un resultado dispara renderMainOnly) no la pierda. */
export function focusLogisticsMap(containerId, lat, lng, zoom = 13) {
  savedViews.set(containerId, { center: { lat, lng }, zoom, mapTypeId: savedViews.get(containerId)?.mapTypeId || lastMapType() });
  const inst = logisticInstances.get(containerId);
  if (inst) { inst.map.panTo({ lat, lng }); inst.map.setZoom(zoom); }
}

export function destroyLogisticsMap(containerId) {
  logisticInstances.delete(containerId);
  // Deliberadamente NO se borra savedViews: la vista se recuerda "cuando sea
  // razonable" — incluso si el usuario navega a otra sección y vuelve.
}
