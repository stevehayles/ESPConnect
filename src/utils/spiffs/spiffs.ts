/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Minimal SPIFFS image parser focused on listing files from an exported
 * partition. The implementation mirrors the layout described in the official
 * SPIFFS sources (spiffs_nucleus.h et al.), but only implements the pieces
 * we need for read-only inspection.
 *
 * The parser operates on a provided ArrayBuffer and assumes little-endian
 * encoding, which matches the default ESP32 toolchain behaviour.
 */

export type SpiffsObjectType = 'file' | 'dir' | 'hard_link' | 'soft_link' | 'unknown';

export interface SpiffsConfig {
  pageSize?: number;
  blockSize?: number;
  objNameLength?: number;
  objMetaLength?: number;
  objIdSize?: number;
  spanIxSize?: number;
  pageIndexSize?: number;
  littleEndian?: boolean;
}

export interface SpiffsFileEntry {
  objectId: number;
  name: string;
  size: number | null;
  type: SpiffsObjectType;
  rawType: number;
  headerPageIndex: number;
  headerAddress: number;
  rawFlags: number;
  finalized: boolean;
  valid: boolean;
  markedForDeletion: boolean;
}

interface NormalizedConfig {
  pageSize: number;
  blockSize: number;
  objNameLength: number;
  objMetaLength: number;
  objIdSize: number;
  spanIxSize: number;
  pageIndexSize: number;
  littleEndian: boolean;
}

interface PageHeader {
  objIdRaw: number;
  spanIndex: number;
  flags: number;
}

interface PageInfo {
  objectIdRaw: number;
  objectId: number;
  spanIndex: number;
  flags: number;
  lookupObjId: number;
  blockIndex: number;
  pageWithinBlock: number;
  globalPageIndex: number;
  address: number;
}

interface IndexHeaderInfo {
  objectId: number;
  name: string;
  rawType: number;
  type: SpiffsObjectType;
  size: number | null;
  page: PageInfo;
  flags: number;
  finalized: boolean;
  valid: boolean;
  markedForDeletion: boolean;
}

interface ScanResult {
  indexHeaders: Map<number, IndexHeaderInfo>;
  indexPages: Map<number, Map<number, PageInfo>>;
  dataPages: Map<number, Map<number, PageInfo>>;
}

const DEFAULT_CONFIG: NormalizedConfig = {
  pageSize: 256,
  blockSize: 4096,
  objNameLength: 32,
  objMetaLength: 0,
  objIdSize: 2,
  spanIxSize: 2,
  pageIndexSize: 2,
  littleEndian: true,
};

const OBJECT_TYPE_MAP: Record<number, SpiffsObjectType> = {
  1: 'file',
  2: 'dir',
  3: 'hard_link',
  4: 'soft_link',
};

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/**
 * Read-only view over a SPIFFS partition image.
 */
export class SpiffsImage {
  private readonly data: Uint8Array;
  private readonly view: DataView;
  private readonly cfg: NormalizedConfig;

  private readonly pagesPerBlock: number;
  private readonly lookupPagesPerBlock: number;
  private readonly entriesPerLookupPage: number;
  private readonly dataPagesPerBlock: number;
  private readonly blockCount: number;
  private readonly globalPageCount: number;

  private readonly pageHeaderSize: number;
  private readonly pageHeaderAlign: number;
  private readonly dataPagePayloadSize: number;

  private readonly objectIndexHeaderOffset: number;
  private readonly objectIndexHeaderLength: number;
  private readonly objectIndexEntriesOffset: number;
  private readonly indexPageEntriesOffset: number;
  private readonly headerIndexCapacity: number;
  private readonly indexPageCapacity: number;

  private readonly objIdFree: number;
  private readonly objIdDeleted = 0;
  private readonly objIdIndexFlag: number;
  private readonly undefinedLength = 0xffffffff;

  private cachedScan?: ScanResult;

  constructor(buffer: ArrayBuffer | Uint8Array, config: SpiffsConfig = {}) {
    this.cfg = normalizeConfig(config);
    this.data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);

    if (this.cfg.pageSize <= 0 || this.cfg.blockSize <= 0) {
      throw new Error('pageSize and blockSize must be positive');
    }
    if (this.data.byteLength % this.cfg.pageSize !== 0) {
      throw new Error('Image size is not an exact multiple of the page size');
    }
    if (this.cfg.blockSize % this.cfg.pageSize !== 0) {
      throw new Error('Block size must be an exact multiple of the page size');
    }

    this.pagesPerBlock = this.cfg.blockSize / this.cfg.pageSize;
    this.lookupPagesPerBlock = Math.max(
      1,
      Math.floor((this.pagesPerBlock * this.cfg.objIdSize) / this.cfg.pageSize),
    );
    this.entriesPerLookupPage = this.cfg.pageSize / this.cfg.objIdSize;
    this.dataPagesPerBlock = this.pagesPerBlock - this.lookupPagesPerBlock;
    if (this.dataPagesPerBlock <= 0) {
      throw new Error('Configuration leaves no room for data pages inside a block');
    }

    this.blockCount = Math.floor(this.data.byteLength / this.cfg.blockSize);
    this.globalPageCount = Math.floor(this.data.byteLength / this.cfg.pageSize);

    this.pageHeaderSize = this.cfg.objIdSize + this.cfg.spanIxSize + 1; // obj_id + span_ix + flags
    this.pageHeaderAlign = alignmentPadding(this.pageHeaderSize, 4);
    this.dataPagePayloadSize = this.cfg.pageSize - this.pageHeaderSize;

    this.objectIndexHeaderOffset = this.pageHeaderSize + this.pageHeaderAlign;
    this.objectIndexHeaderLength =
      this.objectIndexHeaderOffset + 4 + 1 + this.cfg.objNameLength + this.cfg.objMetaLength;
    this.objectIndexEntriesOffset = this.objectIndexHeaderLength;
    this.indexPageEntriesOffset = this.pageHeaderSize + this.pageHeaderAlign;

    const headerAvailable =
      this.cfg.pageSize - this.objectIndexHeaderLength - this.cfg.pageIndexSize >= 0;
    if (!headerAvailable) {
      throw new Error('Object index header structure exceeds the configured page size');
    }

    this.headerIndexCapacity = Math.floor(
      (this.cfg.pageSize - this.objectIndexHeaderLength) / this.cfg.pageIndexSize,
    );
    this.indexPageCapacity = Math.floor(
      (this.cfg.pageSize - this.indexPageEntriesOffset) / this.cfg.pageIndexSize,
    );

    if (this.headerIndexCapacity <= 0 || this.indexPageCapacity <= 0) {
      throw new Error('Configuration yields zero entries per index page');
    }

    const objIdBits = this.cfg.objIdSize * 8;
    this.objIdIndexFlag = Math.pow(2, objIdBits - 1);
    this.objIdFree = Math.pow(2, objIdBits) - 1;
  }

  /**
   * Returns all files that currently have a finalized object index header.
   * The result excludes headers marked for deletion or still under modification.
   */
  public listFiles(): SpiffsFileEntry[] {
    const scan = this.scan();
    const entries: SpiffsFileEntry[] = [];

    scan.indexHeaders.forEach((info) => {
      if (!info.valid || !info.finalized || info.markedForDeletion) {
        return;
      }

      entries.push({
        objectId: info.objectId,
        name: info.name,
        size: info.size,
        type: info.type,
        rawType: info.rawType,
        headerPageIndex: info.page.globalPageIndex,
        headerAddress: info.page.address,
        rawFlags: info.flags,
        finalized: info.finalized,
        valid: info.valid,
        markedForDeletion: info.markedForDeletion,
      });
    });

    entries.sort((a, b) => {
      if (a.name === b.name) {
        return a.objectId - b.objectId;
      }
      return a.name.localeCompare(b.name);
    });

    return entries;
  }

  /**
   * Returns the raw contents of the file identified by objectId.
   * Throws if the file cannot be found in the current image.
   */
  public readFile(objectId: number): Uint8Array {
    const scan = this.scan();
    const headerInfo = scan.indexHeaders.get(objectId);
    const dataSpans = scan.dataPages.get(objectId);
    if (!dataSpans || dataSpans.size === 0) {
      return new Uint8Array(0);
    }

    const sortedSpans = [...dataSpans.entries()].sort((a, b) => a[0] - b[0]);
    const declaredSize =
      headerInfo?.size ?? sortedSpans.length * this.dataPagePayloadSize;
    const output = new Uint8Array(declaredSize);

    let written = 0;
    for (const [, page] of sortedSpans) {
      const chunk = this.readDataPage(page);
      const remaining = declaredSize - written;
      if (remaining <= 0) {
        break;
      }
      const slice = chunk.subarray(0, Math.min(chunk.length, remaining));
      output.set(slice, written);
      written += slice.length;
    }

    return output;
  }

  private scan(): ScanResult {
    if (this.cachedScan) {
      return this.cachedScan;
    }

    const indexHeaders = new Map<number, IndexHeaderInfo>();
    const indexPages = new Map<number, Map<number, PageInfo>>();
    const dataPages = new Map<number, Map<number, PageInfo>>();

    for (let block = 0; block < this.blockCount; block += 1) {
      const blockBase = block * this.cfg.blockSize;

      for (let dataEntry = 0; dataEntry < this.dataPagesPerBlock; dataEntry += 1) {
        const lookupValue = this.readLookupEntry(block, dataEntry);
        if (this.isLookupFree(lookupValue) || this.isLookupDeleted(lookupValue)) {
          continue;
        }

        const pageWithinBlock = this.lookupPagesPerBlock + dataEntry;
        const pageAddress = blockBase + pageWithinBlock * this.cfg.pageSize;
        if (pageAddress + this.cfg.pageSize > this.data.byteLength) {
          continue;
        }

        const header = this.readPageHeader(pageAddress);

        if (header.objIdRaw !== lookupValue) {
          // Inconsistent entry, likely belongs to an outdated lookup slot.
          continue;
        }

        if (header.objIdRaw === this.objIdFree || header.objIdRaw === this.objIdDeleted) {
          continue;
        }

        const objectId = header.objIdRaw & ~this.objIdIndexFlag;
        const globalPageIndex = block * this.pagesPerBlock + pageWithinBlock;

        const pageInfo: PageInfo = {
          objectIdRaw: header.objIdRaw,
          objectId,
          spanIndex: header.spanIndex,
          flags: header.flags,
          lookupObjId: lookupValue,
          blockIndex: block,
          pageWithinBlock,
          globalPageIndex,
          address: pageAddress,
        };

        const isValid = (header.flags & SPIFFS_PH_FLAG_DELET) !== 0;
        if (!isValid) {
          continue;
        }

        const isIndexPage = (header.objIdRaw & this.objIdIndexFlag) !== 0;

        if (isIndexPage) {
          let spans = indexPages.get(objectId);
          if (!spans) {
            spans = new Map();
            indexPages.set(objectId, spans);
          }
          const existing = spans.get(header.spanIndex);
          if (!existing || existing.globalPageIndex <= globalPageIndex) {
            spans.set(header.spanIndex, pageInfo);
          }

          if (header.spanIndex === 0) {
            const headerInfo = this.readObjectIndexHeader(pageInfo);
            if (!headerInfo) {
              continue;
            }

            const existingHeader = indexHeaders.get(objectId);
            if (!existingHeader || existingHeader.page.globalPageIndex <= globalPageIndex) {
              indexHeaders.set(objectId, {
                objectId,
                name: headerInfo.name,
                size: headerInfo.size,
                rawType: headerInfo.rawType,
                type: headerInfo.type,
                page: pageInfo,
                flags: header.flags,
                finalized: (header.flags & SPIFFS_PH_FLAG_FINAL) === 0,
                valid: true,
                markedForDeletion: (header.flags & SPIFFS_PH_FLAG_IXDELE) === 0,
              });
            }
          }
        } else {
          let spans = dataPages.get(objectId);
          if (!spans) {
            spans = new Map();
            dataPages.set(objectId, spans);
          }
          const existing = spans.get(header.spanIndex);
          if (!existing || existing.globalPageIndex <= globalPageIndex) {
            spans.set(header.spanIndex, pageInfo);
          }
        }
      }
    }

    const result: ScanResult = { indexHeaders, indexPages, dataPages };
    this.cachedScan = result;
    return result;
  }

  private readLookupEntry(blockIndex: number, entryIndex: number): number {
    if (entryIndex < 0 || entryIndex >= this.dataPagesPerBlock) {
      throw new RangeError('Lookup entry index out of bounds for block');
    }
    const lookupPage = Math.floor(entryIndex / this.entriesPerLookupPage);
    const entryInsidePage = entryIndex % this.entriesPerLookupPage;
    const byteOffset =
      blockIndex * this.cfg.blockSize +
      lookupPage * this.cfg.pageSize +
      entryInsidePage * this.cfg.objIdSize;
    return this.readUnsigned(byteOffset, this.cfg.objIdSize);
  }

  private readPageHeader(pageAddress: number): PageHeader {
    const objIdRaw = this.readUnsigned(pageAddress, this.cfg.objIdSize);
    const spanIndex = this.readUnsigned(pageAddress + this.cfg.objIdSize, this.cfg.spanIxSize);
    const flags = this.view.getUint8(pageAddress + this.cfg.objIdSize + this.cfg.spanIxSize);
    return { objIdRaw, spanIndex, flags };
  }

  private readObjectIndexHeader(page: PageInfo): {
    name: string;
    size: number | null;
    rawType: number;
    type: SpiffsObjectType;
  } | null {
    if (page.spanIndex !== 0) {
      return null;
    }

    const base = page.address + this.objectIndexHeaderOffset;
    const sizeRaw = this.view.getUint32(base, this.cfg.littleEndian);
    const rawType = this.view.getUint8(base + 4);
    const nameStart = base + 5;
    const nameEnd = nameStart + this.cfg.objNameLength;
    if (nameEnd > this.data.byteLength) {
      return null;
    }

    const nameBytes = this.data.subarray(nameStart, nameEnd);
    const name = decodeNullTerminated(nameBytes);

    const size = sizeRaw === this.undefinedLength ? null : sizeRaw;
    const type = OBJECT_TYPE_MAP[rawType] ?? 'unknown';

    return { name, size, rawType, type };
  }

  private readDataPage(page: PageInfo): Uint8Array {
    const start = page.address + this.pageHeaderSize;
    const end = start + this.dataPagePayloadSize;
    return this.data.slice(start, end);
  }

  private readUnsigned(offset: number, byteLength: number): number {
    switch (byteLength) {
      case 1:
        return this.view.getUint8(offset);
      case 2:
        return this.view.getUint16(offset, this.cfg.littleEndian);
      case 4:
        return this.view.getUint32(offset, this.cfg.littleEndian);
      default:
        throw new Error(`Unsupported integer byte length ${byteLength}`);
    }
  }

  private isLookupFree(value: number): boolean {
    return value === this.objIdFree;
  }

  private isLookupDeleted(value: number): boolean {
    return value === this.objIdDeleted;
  }
}

function normalizeConfig(config: SpiffsConfig): NormalizedConfig {
  return {
    pageSize: config.pageSize ?? DEFAULT_CONFIG.pageSize,
    blockSize: config.blockSize ?? DEFAULT_CONFIG.blockSize,
    objNameLength: config.objNameLength ?? DEFAULT_CONFIG.objNameLength,
    objMetaLength: config.objMetaLength ?? DEFAULT_CONFIG.objMetaLength,
    objIdSize: config.objIdSize ?? DEFAULT_CONFIG.objIdSize,
    spanIxSize: config.spanIxSize ?? DEFAULT_CONFIG.spanIxSize,
    pageIndexSize: config.pageIndexSize ?? DEFAULT_CONFIG.pageIndexSize,
    littleEndian: config.littleEndian ?? DEFAULT_CONFIG.littleEndian,
  };
}

function alignmentPadding(size: number, alignment: number): number {
  const remainder = size % alignment;
  if (remainder === 0) {
    return 0;
  }
  return alignment - remainder;
}

function decodeNullTerminated(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end === -1) {
    end = bytes.length;
  }
  if (end === 0) {
    return '';
  }
  return TEXT_DECODER.decode(bytes.subarray(0, end));
}

export const SPIFFS_PH_FLAG_USED = 1 << 0;
export const SPIFFS_PH_FLAG_FINAL = 1 << 1;
export const SPIFFS_PH_FLAG_INDEX = 1 << 2;
export const SPIFFS_PH_FLAG_IXDELE = 1 << 6;
export const SPIFFS_PH_FLAG_DELET = 1 << 7;

export const ESP32_DEFAULT_CONFIG: SpiffsConfig = {
  pageSize: 256,
  blockSize: 4096,
  objNameLength: 32,
  objMetaLength: 0,
  objIdSize: 2,
  spanIxSize: 2,
  pageIndexSize: 2,
  littleEndian: true,
};
