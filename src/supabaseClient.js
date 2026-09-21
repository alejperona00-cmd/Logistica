import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.warn(
    "[Logística Perona] Falta VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. " +
      "Copiá .env.example a .env.local y completá con los datos de tu proyecto de Supabase."
  );
}

export const supabase = createClient(url || "https://placeholder.supabase.co", anonKey || "placeholder", {
  auth: { persistSession: true, autoRefreshToken: true },
});
