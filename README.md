# Logística Perona

Torre de control logística: Pedidos, Compras, Transporte, Ubicaciones,
Inventario, Producción, Incidencias, Tareas, Reportes y el Dashboard
Gerencial. SPA en JavaScript vanilla (sin framework de UI), servida con
**Vite**, con **Supabase** (Postgres + Auth + Realtime) como base de datos y
**Leaflet + OpenStreetMap** para el mapa.

Este README cubre instalación, desarrollo local y publicación en
**Netlify**, usando siempre tu misma base de datos de Supabase — publicar en
Netlify **no** crea ni reemplaza ninguna base de datos, es sólo la app
sirviéndose desde otra URL.

## 1. Instalación

```bash
npm install
```

## 2. Variables de entorno

La app necesita dos variables para conectarse a tu proyecto de Supabase (las
lee `src/supabaseClient.js` vía `import.meta.env`):

```
VITE_SUPABASE_URL=https://tuproyecto.supabase.co
VITE_SUPABASE_ANON_KEY=tu-anon-key-publica
VITE_GOOGLE_MAPS_API_KEY=tu-clave-de-google-maps
```

La clave de Google Maps es la que usa el módulo **Mapa** (y las miniaturas
de mapa en Pedidos, Transporte y Ubicaciones) — sin ella esas pantallas
muestran un aviso de error en vez de un mapa. Ver `.env.example` para el
paso a paso de cómo conseguirla en Google Cloud Console.

Para desarrollo local:

```bash
cp .env.example .env.local
```

y completá `.env.local` con los valores de tu proyecto (Supabase →
**Settings → API**). `.env.local` está en `.gitignore`: nunca se sube al
repositorio ni se publica en ningún lado — es sólo para tu máquina.

La `anon key` es una clave pública pensada para exponerse en el cliente (así
es como funciona Supabase); el acceso real a los datos lo controlan las
políticas de Row Level Security ya definidas en `schema.sql`, que este
despliegue no modifica.

## 3. Desarrollo local

```bash
npm run dev
```

Abre la URL que muestre la terminal (normalmente `http://localhost:5173`).

## 4. Build de producción

```bash
npm run build
```

Esto genera la carpeta **`dist/`** con la app compilada y lista para
publicar (HTML/JS/CSS con nombres con hash, assets optimizados). Podés
previsualizar ese build localmente antes de publicarlo con:

```bash
npm run preview
```

## 5. Publicar en Netlify

**Opción A — con Git (recomendada, para el flujo PC local → GitHub → Netlify):**

1. Subí este proyecto a un repositorio de GitHub (si todavía no lo hiciste):
   ```bash
   git init
   git add .
   git commit -m "Logística Perona"
   git branch -M main
   git remote add origin <url-de-tu-repo>
   git push -u origin main
   ```
   `node_modules`, `dist` y los `.env*` ya están excluidos por `.gitignore`
   — no se suben credenciales ni archivos generados.
2. En Netlify: **Add new site → Import an existing project**, elegí GitHub y
   seleccioná el repositorio.
3. Netlify va a detectar la configuración automáticamente desde
   `netlify.toml` (incluido en este proyecto):
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
4. Antes de desplegar (o en **Site configuration → Environment variables**
   después), cargá las dos variables de entorno — ver punto 6.
5. **Deploy site.** Cada `git push` a la rama configurada vuelve a
   desplegar automáticamente.

**Opción B — con la CLI de Netlify, sin Git:**

```bash
npm install -g netlify-cli
netlify deploy --build --prod
```

La primera vez te va a pedir loguearte y elegir/crear el sitio. Las
variables de entorno se configuran igual desde el dashboard de Netlify
(**Site configuration → Environment variables**) antes del deploy.

## 6. Variables de entorno en Netlify

En **Site configuration → Environment variables**, agregá exactamente estas
dos (los mismos valores que usás en tu `.env.local`):

| Variable | Valor |
|---|---|
| `VITE_SUPABASE_URL` | La misma Project URL de tu Supabase actual |
| `VITE_SUPABASE_ANON_KEY` | La misma anon public key de tu Supabase actual |
| `VITE_GOOGLE_MAPS_API_KEY` | La misma clave de Google Maps que usás en desarrollo |

Una vez que sepas la URL final de Netlify, conviene volver a la clave de
Google Maps en Google Cloud Console (**Credenciales**) y restringirla por
"Referrers HTTP" a esa URL (+ `http://localhost:5173/*` para seguir
probando en tu máquina) — así nadie más puede usarla aunque la vea en el
código fuente publicado.

Con esto, la app publicada en Netlify se conecta **a la misma base de datos
de Supabase** que ya usás en desarrollo — mismos productos, inventario,
pedidos, producción, simulaciones, distribución, proveedores y
transportistas. No hay ninguna base de datos nueva ni separada.

## 7. Rutas y navegación

La app usa ruteo **por hash** (`#/pedidos`, `#/produccion`, `#/gerencia`,
etc. — ver `parseHash()` en `src/app.js`), no ruteo de historial de
navegador. Esto significa que, salvo por el archivo `index.html`, el
servidor nunca necesita saber nada sobre las rutas internas: entrar por la
página principal, navegar entre módulos, refrescar el navegador en
cualquier pantalla o entrar directamente a una URL con `#/...` funcionan
todos igual, sirviendo siempre el mismo `index.html`. El `netlify.toml`
incluido agrega igualmente una redirección `/* → /index.html` como red de
seguridad.

## 8. Qué NO modificar (para no perder datos ni funcionalidad)

- **No** cambies ni borres `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` en
  ningún entorno salvo que realmente quieras apuntar a otro proyecto de
  Supabase.
- **No** ejecutes de nuevo `schema.sql` sobre una base que ya tiene datos —
  ese script es sólo para crear las tablas la primera vez (usa
  `create table if not exists`, así que volver a correrlo no destruye datos
  existentes, pero no hace falta volver a correrlo).
- **No** borres ni edites las políticas de Row Level Security del final de
  `schema.sql` salvo que sepas exactamente qué estás cambiando — son las que
  protegen que sólo usuarios logueados puedan leer/escribir.
- **No** publiques la `service_role key` de Supabase en ningún lado (ni en
  variables de entorno de Netlify ni en el código) — esta app sólo necesita
  la `anon key`, que es pública por diseño.
- Publicar en Netlify es sólo servir el mismo build de la app desde otra
  URL: no migra, no duplica ni modifica ningún dato de Supabase.

## Notas

- El mapa usa Google Maps (Maps JavaScript API, Places, Geocoding y Directions) — necesita `VITE_GOOGLE_MAPS_API_KEY`, ver punto 2 y 6.
- Los datos de ejemplo ("Cargar datos de ejemplo" en Configuración, si
  existe en tu versión) son opcionales y aditivos: no borran nada si ya
  cargaste datos reales.
- Para más detalle sobre cómo crear el proyecto de Supabase desde cero (si
  alguna vez necesitás uno nuevo), ver `DEPLOY.md`.
