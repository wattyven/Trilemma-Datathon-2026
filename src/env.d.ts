/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the LidarBC CORS proxy (proxy/lidarbc), e.g. https://vanshade-lidarbc.example.workers.dev. Empty: skip LidarBC. */
  readonly VITE_LIDARBC_PROXY?: string;
  /** Base URL of the Analysis proxy (proxy/gemini), e.g. https://vanshade-gemini.example.workers.dev. Empty: no Analysis chat. */
  readonly VITE_GEMINI_PROXY?: string;
}
