/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_ROOM_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
