<template>
  <div class="spiffs-manager">
    <v-alert
      v-if="error"
      type="error"
      variant="tonal"
      density="comfortable"
      border="start"
      class="mb-3"
    >
      {{ error }}
    </v-alert>
    <v-alert
      v-else-if="readOnly"
      type="warning"
      variant="tonal"
      density="comfortable"
      border="start"
      class="mb-3"
    >
      SPIFFS is in read-only mode. {{ readOnlyReason || 'Changes cannot be saved.' }}
    </v-alert>

    <v-card class="mb-4" variant="tonal">
      <v-card-title class="text-subtitle-1">
        <v-icon start size="18">mdi-folder-wrench</v-icon>
        SPIFFS Partition
      </v-card-title>
      <v-card-text class="d-flex flex-column gap-4">
        <v-select
          :items="partitions"
          item-title="label"
          item-value="id"
          density="comfortable"
          label="Partition"
          :model-value="selectedPartitionId"
          :disabled="loading || busy || saving || !partitions.length"
          @update:model-value="value => emit('select-partition', value)"
        />
        <div class="spiffs-manager__controls">
          <v-btn
            color="primary"
            variant="tonal"
            :disabled="!hasPartition || loading || busy || saving"
            @click="emit('refresh')"
          >
            <v-icon start>mdi-refresh</v-icon>
            Read
          </v-btn>
          <v-btn
            color="secondary"
            variant="outlined"
            :disabled="!hasPartition || loading || busy || saving"
            @click="emit('backup')"
          >
            <v-icon start>mdi-content-save</v-icon>
            Backup
          </v-btn>
          <v-btn
            color="secondary"
            variant="text"
            :disabled="!hasPartition || loading || busy || saving"
            @click="triggerRestore"
          >
            <v-icon start>mdi-upload</v-icon>
            Restore Image
          </v-btn>
          <v-btn
            color="error"
            variant="text"
            :disabled="readOnly || !hasClient || loading || busy || saving"
            @click="emit('format')"
          >
            <v-icon start>mdi-delete-sweep</v-icon>
            Format
          </v-btn>
          <v-spacer />
          <v-btn
            color="primary"
            variant="elevated"
            :disabled="readOnly || !dirty || !backupDone || saving || loading || busy || !hasClient"
            @click="emit('save')"
          >
            <v-icon start>mdi-content-save-outline</v-icon>
            Save to Flash
          </v-btn>
        </div>
        <p class="text-caption text-medium-emphasis mb-0">
          Always download a backup before saving. Changes are staged in the browser until you click
          “Save to Flash”.
        </p>
      </v-card-text>
      <v-progress-linear v-if="loading || saving" indeterminate color="primary" />
    </v-card>

    <v-card variant="tonal">
      <v-card-title class="d-flex align-center justify-space-between">
        <span class="text-subtitle-1">Files</span>
        <v-chip v-if="dirty" color="warning" size="small" variant="elevated">
          Unsaved changes
        </v-chip>
      </v-card-title>
      <v-card-text>
        <div class="upload-row">
          <v-file-input
            v-model="uploadFile"
            density="comfortable"
            accept="*/*"
            label="Select file"
            prepend-icon="mdi-file-upload"
            :disabled="readOnly || !hasClient || loading || busy || saving"
          />
          <v-text-field
            v-model="uploadName"
            density="comfortable"
            label="Store as"
            placeholder="path/to/file.txt"
            :disabled="readOnly || !hasClient || loading || busy || saving"
          />
          <v-btn
            color="primary"
            variant="tonal"
            class="upload-row__cta"
            :disabled="readOnly || !uploadFile || !hasClient || loading || busy || saving"
            @click="submitUpload"
          >
            <v-icon start>mdi-upload</v-icon>
            Upload
          </v-btn>
        </div>

        <v-alert
          v-if="!files.length"
          type="info"
          variant="tonal"
          density="comfortable"
          border="start"
          class="mt-4"
        >
          No files detected. Upload or restore a SPIFFS image to begin.
        </v-alert>
        <v-table
          v-else
          density="comfortable"
          class="spiffs-table mt-4"
        >
          <thead>
            <tr>
              <th class="text-start">Name</th>
              <th class="text-start">Size</th>
              <th class="text-start">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="file in files" :key="file.name">
              <td><code>{{ file.name }}</code></td>
              <td>{{ formatSize(file.size) }}</td>
              <td>
                <v-btn
                  size="small"
                  variant="text"
                  color="primary"
                  :disabled="loading || busy || saving || readOnly"
                  @click="emit('download-file', file.name)"
                >
                  <v-icon start size="16">mdi-download</v-icon>
                  Download
                </v-btn>
                <v-btn
                  size="small"
                  variant="text"
                  color="error"
                  :disabled="readOnly || loading || busy || saving"
                  @click="emit('delete-file', file.name)"
                >
                  <v-icon start size="16">mdi-delete</v-icon>
                  Delete
                </v-btn>
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <v-alert
      type="info"
      variant="tonal"
      density="comfortable"
      border="start"
      class="mt-4"
    >
      {{ status }}
    </v-alert>

    <input ref="restoreInput" type="file" class="d-none" @change="handleRestoreFile" />
  </div>
</template>

<script setup>
import { ref } from 'vue';

const props = defineProps({
  partitions: {
    type: Array,
    default: () => [],
  },
  selectedPartitionId: {
    type: [Number, String, null],
    default: null,
  },
  files: {
    type: Array,
    default: () => [],
  },
  status: {
    type: String,
    default: '',
  },
  loading: Boolean,
  busy: Boolean,
  saving: Boolean,
  readOnly: Boolean,
  readOnlyReason: {
    type: String,
    default: '',
  },
  dirty: Boolean,
  backupDone: Boolean,
  error: {
    type: String,
    default: null,
  },
  hasPartition: Boolean,
  hasClient: Boolean,
});

const emit = defineEmits([
  'select-partition',
  'refresh',
  'backup',
  'restore',
  'download-file',
  'upload-file',
  'delete-file',
  'format',
  'save',
]);

const uploadFile = ref(null);
const uploadName = ref('');
const restoreInput = ref(null);

function submitUpload() {
  if (!uploadFile.value) return;
  emit('upload-file', { file: uploadFile.value, name: uploadName.value });
  uploadName.value = '';
  uploadFile.value = null;
}

function triggerRestore() {
  restoreInput.value?.click();
}

function handleRestoreFile(event) {
  const [file] = event.target.files || [];
  if (file) {
    emit('restore', file);
  }
  event.target.value = '';
}

function formatSize(size) {
  if (!Number.isFinite(size)) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}
</script>

<style scoped>
.spiffs-manager {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.spiffs-manager__controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.upload-row {
  display: grid;
  gap: 12px;
}

@media (min-width: 960px) {
  .upload-row {
    grid-template-columns: 1fr 1fr auto;
    align-items: end;
  }
  .upload-row__cta {
    align-self: center;
  }
}

.spiffs-table code {
  font-size: 0.85rem;
}
</style>
