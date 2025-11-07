import { SpiffsConfig, ESP32_DEFAULT_CONFIG } from './spiffs.js';

export interface SpiffsPreset {
  id: string;
  label: string;
  description: string;
  config: SpiffsConfig;
}

export const DEFAULT_SPIFFS_PRESETS: SpiffsPreset[] = [
  {
    id: 'esp32-default',
    label: 'ESP32 (ESP-IDF default SPIFFS partition)',
    description: '4 KB blocks, 256 B logical pages, 32-byte filenames.',
    config: { ...ESP32_DEFAULT_CONFIG },
  },
  {
    id: 'esp8266',
    label: 'ESP8266 (Arduino "data" partition)',
    description: '4 KB blocks, 256 B pages; common on ESP8266 boards.',
    config: {
      pageSize: 256,
      blockSize: 4096,
      objNameLength: 32,
      objMetaLength: 0,
      objIdSize: 2,
      spanIxSize: 2,
      pageIndexSize: 2,
      littleEndian: true,
    },
  },
  {
    id: 'custom-512',
    label: 'Generic NOR flash (512 B logical page)',
    description: 'For images created with a 512-byte logical page size.',
    config: {
      pageSize: 512,
      blockSize: 4096,
      objNameLength: 32,
      objMetaLength: 0,
      objIdSize: 2,
      spanIxSize: 2,
      pageIndexSize: 2,
      littleEndian: true,
    },
  },
];
