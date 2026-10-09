/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the LidarBC CORS proxy (proxy/lidarbc), e.g. https://vanshade-lidarbc.example.workers.dev. Empty: skip LidarBC. */
  readonly VITE_LIDARBC_PROXY?: string;
}
