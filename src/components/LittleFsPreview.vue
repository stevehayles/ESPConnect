<template>
  <v-card class="littlefs-card" variant="tonal">
    <v-card-title class="d-flex align-center gap-2">
      <v-icon size="18">mdi-alpha-l-circle-outline</v-icon>
      LittleFS Preview
      <v-chip v-if="state.ready" size="x-small" color="success" variant="tonal">Ready</v-chip>
    </v-card-title>
    <v-card-subtitle>
      Quickly load the LittleFS WASM module and try basic file operations before wiring it into SPIFFS.
    </v-card-subtitle>
    <v-card-text class="littlefs-card__body">
      <div class="littlefs-card__actions">
        <v-btn color="primary" :loading="state.loading && !state.ready" :disabled="state.loading"
          @click="initializeLittleFs">
          <v-icon start>mdi-power</v-icon>
          {{ state.ready ? 'Reinitialize' : 'Initialize' }}
        </v-btn>
        <v-btn color="secondary" variant="tonal" :disabled="!state.ready || state.loading"
          @click="formatLittleFs">
          <v-icon start>mdi-broom</v-icon>
          Format FS
        </v-btn>
        <v-btn color="secondary" variant="text" :disabled="!state.ready || state.loading"
          @click="refreshListing">
          <v-icon start>mdi-refresh</v-icon>
          Refresh List
        </v-btn>
      </div>

      <v-alert v-if="state.error" type="error" variant="tonal" density="comfortable" border="start" class="mb-2">
        {{ state.error }}
      </v-alert>
      <v-alert v-else-if="state.status" type="info" variant="tonal" density="comfortable" border="start" class="mb-2">
        {{ state.status }}
      </v-alert>

      <div class="littlefs-form">
        <v-text-field v-model="form.path" label="File path" density="comfortable" variant="outlined"
          :disabled="!state.ready || state.loading" placeholder="logs/demo.txt" />
        <v-textarea v-model="form.content" label="Content" rows="2" auto-grow variant="outlined"
          :disabled="!state.ready || state.loading" placeholder="Hello LittleFS from ESPConnect!" />
        <div class="littlefs-form__actions">
          <v-btn color="primary" variant="tonal" :disabled="!state.ready || state.loading || !canAddFile"
            @click="addFile">
            <v-icon start>mdi-file-plus</v-icon>
            Add / Replace File
          </v-btn>
          <v-btn color="error" variant="text"
            :disabled="!state.ready || state.loading || !form.path.trim()" @click="deleteFile">
            <v-icon start>mdi-delete</v-icon>
            Delete File
          </v-btn>
        </div>
      </div>

      <v-progress-linear v-if="state.loading" indeterminate color="primary" class="my-2" />

      <div class="littlefs-list">
        <div class="littlefs-list__header">
          <strong>Files ({{ state.files.length }})</strong>
          <span v-if="!state.ready" class="text-medium-emphasis">Initialize to view contents</span>
        </div>
        <v-table density="compact" class="littlefs-table" v-if="state.files.length">
          <thead>
            <tr>
              <th class="text-start">Path</th>
              <th class="text-start">Size</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="file in state.files" :key="file.path">
              <td><code>{{ file.path }}</code></td>
              <td>{{ formatSize(file.size) }}</td>
            </tr>
          </tbody>
        </v-table>
        <div v-else class="text-medium-emphasis text-caption">
          {{ state.ready ? 'No files found. Add one above to test writes.' : 'Module not initialized yet.' }}
        </div>
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';

const LITTLEFS_MODULE_PATH = '/wasm/littlefs/index.js';

const state = reactive({
  status: '',
  error: '',
  loading: false,
  ready: false,
  files: [],
  fs: null,
});

const form = reactive({
  path: 'demo.txt',
  content: 'Hello from ESPConnect + LittleFS!',
});

const canAddFile = computed(() => Boolean(form.path.trim()) && form.content.length > 0);

async function loadFactory() {
  const resolvedUrl = new URL(LITTLEFS_MODULE_PATH, window.location.origin).toString();
  const module = (await import(
    /* @vite-ignore */ resolvedUrl
  )) as typeof import('/wasm/littlefs/index.js');
  return module.createLittleFS || module.default;
}

async function initializeLittleFs() {
  if (state.loading) return;
  state.loading = true;
  state.error = '';
  state.status = 'Loading WASM module...';
  console.time('littlefs-init');
  try {
    const factory = await loadFactory();
    state.status = 'Mounting filesystem...';
    state.fs = await factory({ formatOnInit: true });
    console.timeEnd('littlefs-init');
    state.ready = true;
    state.status = 'LittleFS is ready.';
    await refreshListing();
  } catch (error) {
    console.error('LittleFS init failed', error);
    state.error =
      error?.message || 'Failed to load the LittleFS module. Confirm the WASM files exist under /public/wasm.';
    state.ready = false;
    state.fs = null;
  } finally {
    state.loading = false;
  }
}

async function formatLittleFs() {
  if (!state.fs || state.loading) return;
  try {
    state.loading = true;
    state.fs.format();
    state.status = 'Filesystem formatted.';
    await refreshListing();
  } catch (error) {
    state.error = error?.message || 'Format failed.';
  } finally {
    state.loading = false;
  }
}

async function refreshListing() {
  if (!state.fs || state.loading) return;
  try {
    const entries = state.fs.list();
    state.files = Array.isArray(entries) ? entries : [];
  } catch (error) {
    state.error = error?.message || 'Failed to list files.';
  }
}

async function addFile() {
  if (!state.fs || state.loading || !form.path.trim()) return;
  try {
    state.loading = true;
    state.fs.addFile(form.path.trim(), form.content);
    state.status = `Stored "${form.path.trim()}" into LittleFS.`;
    await refreshListing();
  } catch (error) {
    state.error = error?.message || 'Add file failed.';
  } finally {
    state.loading = false;
  }
}

async function deleteFile() {
  if (!state.fs || state.loading || !form.path.trim()) return;
  try {
    state.loading = true;
    state.fs.deleteFile(form.path.trim());
    state.status = `Deleted "${form.path.trim()}" from LittleFS.`;
    await refreshListing();
  } catch (error) {
    state.error = error?.message || 'Delete file failed.';
  } finally {
    state.loading = false;
  }
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) {
    return '-';
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
</script>

<style scoped>
.littlefs-card {
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--v-theme-primary) 18%, transparent);
  background: color-mix(in srgb, var(--v-theme-surface) 96%, transparent);
}

.littlefs-card__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.littlefs-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.littlefs-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.littlefs-form__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.littlefs-list__header {
  display: flex;
  justify-content: space-between;
  font-size: 0.9rem;
}

.littlefs-table code {
  font-size: 0.85rem;
}
</style>
