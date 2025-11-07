import {
  ESP32_DEFAULT_CONFIG,
  SpiffsConfig,
  SpiffsImage,
  SPIFFS_PH_FLAG_DELET,
  SPIFFS_PH_FLAG_INDEX,
} from './spiffs.js';
export { DEFAULT_SPIFFS_PRESETS, SpiffsPreset } from './spiffsPresets.js';

const SPIFFS_TYPE_FILE = 1;

export interface SpiffsEntry {
  name: string;
  size: number;
  type: 'file' | 'dir';
}

export interface SpiffsClient {
  list(): Promise<SpiffsEntry[]>;
  read(name: string): Promise<Uint8Array>;
  write(name: string, data: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  format(): Promise<void>;
  toImage(): Promise<Uint8Array>;
}

type VirtualEntry = {
  type: 'file';
  data: Uint8Array;
};

export class InMemorySpiffsClient implements SpiffsClient {
  private readonly files = new Map<string, VirtualEntry>();
  private readonly config: NormalizedConfig;
  private readonly imageSize: number;

  private constructor(initialFiles: Map<string, VirtualEntry>, config: SpiffsConfig, imageSize: number) {
    this.config = normalizeConfig(config);
    this.imageSize = imageSize;
    initialFiles.forEach((entry, name) => {
      this.files.set(name, { type: entry.type, data: entry.data.slice() });
    });
  }

  public static async fromImage(
    image: Uint8Array,
    config: SpiffsConfig = ESP32_DEFAULT_CONFIG,
  ): Promise<InMemorySpiffsClient> {
    const bufferCopy = new Uint8Array(image);
    const spiffsImage = new SpiffsImage(bufferCopy, config);
    const entries = spiffsImage.listFiles();
    const fileMap = new Map<string, VirtualEntry>();
    for (const entry of entries) {
      if (entry.type !== 'file') {
        continue;
      }
      const data = spiffsImage.readFile(entry.objectId);
      fileMap.set(entry.name, { type: 'file', data });
    }
    return new InMemorySpiffsClient(fileMap, config, bufferCopy.byteLength);
  }

  public async list(): Promise<SpiffsEntry[]> {
    return Array.from(this.files.entries()).map(([name, entry]) => ({
      name,
      size: entry.data.byteLength,
      type: entry.type,
    }));
  }

  public async read(name: string): Promise<Uint8Array> {
    const entry = this.files.get(name);
    if (!entry) {
      throw new Error(`File not found: ${name}`);
    }
    return entry.data.slice();
  }

  public async write(name: string, data: Uint8Array): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('File name cannot be empty');
    }
    if (trimmed.length > this.config.objNameLength - 1) {
      throw new Error(`File name too long (max ${this.config.objNameLength - 1} chars)`);
    }
    this.files.set(trimmed, { type: 'file', data: new Uint8Array(data) });
  }

  public async remove(name: string): Promise<void> {
    if (!this.files.delete(name)) {
      throw new Error(`Cannot remove missing file: ${name}`);
    }
  }

  public async format(): Promise<void> {
    this.files.clear();
  }

  public async toImage(): Promise<Uint8Array> {
    const encoder = new SpiffsImageEncoder(this.config, this.imageSize);
    const files = Array.from(this.files.entries()).map(([name, entry]) => ({
      name,
      data: entry.data,
    }));
    return encoder.encode(files);
  }
}

type NormalizedConfig = Required<SpiffsConfig>;

function normalizeConfig(config: SpiffsConfig): NormalizedConfig {
  return {
    pageSize: config.pageSize ?? ESP32_DEFAULT_CONFIG.pageSize ?? 256,
    blockSize: config.blockSize ?? ESP32_DEFAULT_CONFIG.blockSize ?? 4096,
    objNameLength: config.objNameLength ?? ESP32_DEFAULT_CONFIG.objNameLength ?? 32,
    objMetaLength: config.objMetaLength ?? ESP32_DEFAULT_CONFIG.objMetaLength ?? 0,
    objIdSize: config.objIdSize ?? ESP32_DEFAULT_CONFIG.objIdSize ?? 2,
    spanIxSize: config.spanIxSize ?? ESP32_DEFAULT_CONFIG.spanIxSize ?? 2,
    pageIndexSize: config.pageIndexSize ?? ESP32_DEFAULT_CONFIG.pageIndexSize ?? 2,
    littleEndian: config.littleEndian ?? ESP32_DEFAULT_CONFIG.littleEndian ?? true,
  };
}

interface EncoderFile {
  name: string;
  data: Uint8Array;
}

class SpiffsImageEncoder {
  private readonly layout: SpiffsLayout;
  private readonly image: Uint8Array;
  private readonly view: DataView;
  private readonly lookupEntries: number[];
  private readonly textEncoder = new TextEncoder();
  private readonly emptyIndexEntry: number;

  private nextObjectId = 1;

  constructor(private readonly config: NormalizedConfig, private readonly imageSize: number) {
    this.layout = new SpiffsLayout(config, imageSize);
    this.image = new Uint8Array(this.imageSize);
    this.image.fill(0xff);
    this.view = new DataView(this.image.buffer);
    this.lookupEntries = new Array(this.layout.totalDataPages).fill(this.layout.objIdFree);
    this.emptyIndexEntry = Math.pow(2, this.config.pageIndexSize * 8) - 1;
  }

  encode(files: EncoderFile[]): Uint8Array {
    this.ensureCapacity(files);
    for (const file of files) {
      this.writeFile(file);
    }
    this.flushLookupPages();
    return this.image;
  }

  private ensureCapacity(files: EncoderFile[]): void {
    let requiredPages = 0;
    for (const file of files) {
      const dataPages = this.requiredDataPages(file.data.byteLength);
      const extraEntries = Math.max(0, dataPages - this.layout.headerIndexCapacity);
      const extraIndexPages =
        extraEntries === 0 ? 0 : Math.ceil(extraEntries / this.layout.indexPageCapacity);
      requiredPages += dataPages + 1 + extraIndexPages;
    }
    if (requiredPages > this.layout.totalDataPages) {
      throw new Error(
        `Not enough space: need ${requiredPages} pages, but only ${this.layout.totalDataPages} fit`,
      );
    }
  }

  private writeFile(file: EncoderFile): void {
    const objectId = this.nextObjectId++;
    const dataPages = this.writeDataPages(objectId, file.data);
    const headerEntries = dataPages.slice(0, this.layout.headerIndexCapacity);
    const remainingEntries = dataPages.slice(this.layout.headerIndexCapacity);

    let spanIx = 0;
    const headerPage = this.allocatePage(true, objectId, spanIx);
    this.writeObjectIndexHeader(headerPage, file.name, file.data.byteLength);
    this.writeIndexEntries(
      headerPage,
      headerEntries,
      this.layout.objectIndexEntriesOffset,
      this.layout.headerIndexCapacity,
    );
    spanIx += 1;

    let offset = 0;
    while (offset < remainingEntries.length) {
      const chunk = remainingEntries.slice(offset, offset + this.layout.indexPageCapacity);
      const indexPage = this.allocatePage(true, objectId, spanIx);
      this.writeIndexEntries(
        indexPage,
        chunk,
        this.layout.indexPageEntriesOffset,
        this.layout.indexPageCapacity,
      );
      spanIx += 1;
      offset += chunk.length;
    }
  }

  private writeDataPages(objectId: number, data: Uint8Array): number[] {
    const pageRefs: number[] = [];
    let offset = 0;
    let spanIx = 0;
    if (data.byteLength === 0) {
      const page = this.allocatePage(false, objectId, spanIx);
      pageRefs.push(page.pageIndex);
      spanIx += 1;
    } else {
      while (offset < data.byteLength) {
        const chunk = data.subarray(offset, offset + this.layout.dataPayloadSize);
        const page = this.allocatePage(false, objectId, spanIx, chunk);
        pageRefs.push(page.pageIndex);
        offset += chunk.byteLength;
        spanIx += 1;
      }
    }
    return pageRefs;
  }

  private allocatePage(
    isIndex: boolean,
    objectId: number,
    spanIx: number,
    payload?: Uint8Array,
  ): AllocatedPage {
    const slot = this.layout.nextDataSlot();
    const pageIndex = this.layout.dataPageIndexToPageNumber(slot);
    const address = pageIndex * this.config.pageSize;
    const objIdRaw = isIndex ? objectId | this.layout.objIdIndexFlag : objectId;
    this.writeUnsigned(address, objIdRaw, this.config.objIdSize);
    this.writeUnsigned(address + this.config.objIdSize, spanIx, this.config.spanIxSize);
    const flags =
      SPIFFS_PH_FLAG_DELET |
      (isIndex ? SPIFFS_PH_FLAG_INDEX : 0);
    this.image[address + this.config.objIdSize + this.config.spanIxSize] = flags;
    this.lookupEntries[slot] = objIdRaw;

    if (payload && payload.byteLength > 0) {
      const start = address + this.layout.pageHeaderSize;
      this.image.set(payload, start);
    }

    return { pageIndex, dataSlot: slot, address };
  }

  private writeObjectIndexHeader(page: AllocatedPage, name: string, size: number): void {
    const headerBase = page.address + this.layout.objectIndexHeaderOffset;
    this.view.setUint32(headerBase, size, this.config.littleEndian);
    this.view.setUint8(headerBase + 4, SPIFFS_TYPE_FILE);
    const encodedName = this.textEncoder.encode(name);
    const nameBytes = new Uint8Array(this.layout.config.objNameLength);
    const limit = Math.min(Math.max(0, nameBytes.length - 1), encodedName.length);
    nameBytes.set(encodedName.subarray(0, limit));
    if (nameBytes.length > 0) {
      const terminatorIndex = Math.min(limit, nameBytes.length - 1);
      nameBytes[terminatorIndex] = 0;
    }
    this.image.set(nameBytes, headerBase + 5);
    const metaStart = headerBase + 5 + this.layout.config.objNameLength;
    if (this.layout.config.objMetaLength > 0) {
      this.image.fill(0, metaStart, metaStart + this.layout.config.objMetaLength);
    }
  }

  private writeIndexEntries(
    page: AllocatedPage,
    refs: number[],
    offset: number,
    capacity: number,
  ): void {
    for (let i = 0; i < capacity; i += 1) {
      const refValue = refs[i] ?? this.emptyIndexEntry;
      const refAddress = page.address + offset + i * this.config.pageIndexSize;
      this.writeUnsigned(refAddress, refValue, this.config.pageIndexSize);
    }
  }

  private requiredDataPages(size: number): number {
    if (size === 0) {
      return 1;
    }
    return Math.ceil(size / this.layout.dataPayloadSize);
  }

  private flushLookupPages(): void {
    for (let block = 0; block < this.layout.blockCount; block += 1) {
      for (let entry = 0; entry < this.layout.dataPagesPerBlock; entry += 1) {
        const globalSlot = block * this.layout.dataPagesPerBlock + entry;
        const objId = this.lookupEntries[globalSlot] ?? this.layout.objIdFree;
        const lookupPage = Math.floor(entry / this.layout.entriesPerLookupPage);
        const offsetInPage = entry % this.layout.entriesPerLookupPage;
        const address =
          block * this.config.blockSize +
          lookupPage * this.config.pageSize +
          offsetInPage * this.config.objIdSize;
        this.writeUnsigned(address, objId, this.config.objIdSize);
      }
    }
  }

  private writeUnsigned(address: number, value: number, byteLength: number): void {
    switch (byteLength) {
      case 1:
        this.view.setUint8(address, value);
        break;
      case 2:
        this.view.setUint16(address, value, this.config.littleEndian);
        break;
      case 4:
        this.view.setUint32(address, value, this.config.littleEndian);
        break;
      default:
        throw new Error(`Unsupported integer width ${byteLength}`);
    }
  }
}

interface AllocatedPage {
  pageIndex: number;
  dataSlot: number;
  address: number;
}

class SpiffsLayout {
  public readonly pagesPerBlock: number;
  public readonly lookupPagesPerBlock: number;
  public readonly dataPagesPerBlock: number;
  public readonly entriesPerLookupPage: number;
  public readonly blockCount: number;
  public readonly totalDataPages: number;

  public readonly pageHeaderSize: number;
  public readonly objectIndexHeaderOffset: number;
  public readonly objectIndexEntriesOffset: number;
  public readonly indexPageEntriesOffset: number;
  public readonly headerIndexCapacity: number;
  public readonly indexPageCapacity: number;
  public readonly dataPayloadSize: number;
  public readonly objIdIndexFlag: number;
  public readonly objIdFree: number;

  private dataSlotCursor = 0;

  constructor(public readonly config: NormalizedConfig, private readonly imageSize: number) {
    if (imageSize % config.blockSize !== 0) {
      throw new Error('Image size must be a multiple of block size');
    }

    this.pagesPerBlock = config.blockSize / config.pageSize;
    this.lookupPagesPerBlock = Math.max(
      1,
      Math.floor((this.pagesPerBlock * config.objIdSize) / config.pageSize),
    );
    this.dataPagesPerBlock = this.pagesPerBlock - this.lookupPagesPerBlock;
    if (this.dataPagesPerBlock <= 0) {
      throw new Error('Configuration yields zero data pages per block');
    }

    this.entriesPerLookupPage = config.pageSize / config.objIdSize;
    this.blockCount = imageSize / config.blockSize;
    this.totalDataPages = this.blockCount * this.dataPagesPerBlock;

    this.pageHeaderSize = config.objIdSize + config.spanIxSize + 1;
    const pageHeaderAlign = alignmentPadding(this.pageHeaderSize, 4);
    this.dataPayloadSize = config.pageSize - this.pageHeaderSize;
    this.objectIndexHeaderOffset = this.pageHeaderSize + pageHeaderAlign;
    this.objectIndexEntriesOffset =
      this.objectIndexHeaderOffset + 4 + 1 + config.objNameLength + config.objMetaLength;
    this.indexPageEntriesOffset = this.pageHeaderSize + pageHeaderAlign;
    this.headerIndexCapacity = Math.floor(
      (config.pageSize - this.objectIndexEntriesOffset) / config.pageIndexSize,
    );
    this.indexPageCapacity = Math.floor(
      (config.pageSize - this.indexPageEntriesOffset) / config.pageIndexSize,
    );
    if (this.headerIndexCapacity <= 0 || this.indexPageCapacity <= 0) {
      throw new Error('Configuration yields zero index capacity');
    }

    this.objIdIndexFlag = 1 << (config.objIdSize * 8 - 1);
    this.objIdFree = (1 << (config.objIdSize * 8)) - 1;
  }

  public nextDataSlot(): number {
    if (this.dataSlotCursor >= this.totalDataPages) {
      throw new Error('Out of SPIFFS pages');
    }
    return this.dataSlotCursor++;
  }

  public dataPageIndexToPageNumber(dataSlot: number): number {
    const block = Math.floor(dataSlot / this.dataPagesPerBlock);
    const offsetInBlock = dataSlot % this.dataPagesPerBlock;
    return block * this.pagesPerBlock + this.lookupPagesPerBlock + offsetInBlock;
  }
}

function alignmentPadding(size: number, alignment: number): number {
  const remainder = size % alignment;
  return remainder === 0 ? 0 : alignment - remainder;
}
