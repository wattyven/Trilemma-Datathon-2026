/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the LidarBC CORS proxy (proxy/lidarbc), e.g. https://vanshade-lidarbc.example.workers.dev. Empty: skip LidarBC. */
  readonly VITE_LIDARBC_PROXY?: string;
  /** Gemini key baked into the public site at build time. Empty: the chat uses the local dev server. */
  readonly VITE_GEMINI_API_KEY?: string;
}
