import { defineConfig } from "vite";

// Este proyecto vive en una carpeta sincronizada con OneDrive. En Windows,
// OneDrive puede interferir con la detección de cambios de archivos que usa
// Vite por defecto, así que los cambios guardados no se recargaban solos.
// "usePolling" hace que Vite revise los archivos por polling en vez de
// depender de esos eventos del sistema operativo, evitando ese problema.
export default defineConfig({
  server: {
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
});
