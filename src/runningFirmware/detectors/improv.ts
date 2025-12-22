import type { Detector, DetectorContext } from '../types';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const IMPROV_HEADER = new Uint8Array([
  0x49, 0x4d, 0x50, 0x52, 0x4f, 0x56, // "IMPROV"
]);
const IMPROV_VERSION = 0x01;
const IMPROV_DEVICE_PACKET_TYPES = new Set<number>([0x01, 0x02, 0x04]);

async function waitForAscii(
  ctx: DetectorContext,
  re: RegExp,
  ms: number,
): Promise<RegExpMatchArray | null> {
  const deadline = ctx.now() + ms;
  while (ctx.now() < deadline) {
    const m = ctx.buffer.matchRegex(re, 4096);
    if (m) return m;
    await sleep(20);
  }
  return null;
}

type ImprovPacket = {
  type: number;
  length: number;
  data: Uint8Array;
  hasLfTerminator: boolean;
};

function asciiMatches(buf: Uint8Array, offset: number, ascii: Uint8Array): boolean {
  if (offset < 0 || offset + ascii.length > buf.length) return false;
  for (let i = 0; i < ascii.length; i += 1) {
    if (buf[offset + i] !== ascii[i]) return false;
  }
  return true;
}

function checksum8(data: Uint8Array, start: number, endExclusive: number): number {
  let sum = 0;
  for (let i = start; i < endExclusive; i += 1) sum = (sum + data[i]!) & 0xff;
  return sum;
}

function findImprovPacket(snapshot: Uint8Array): { packet?: ImprovPacket; maybe?: true } | null {
  let sawHeaderButIncomplete = false;

  for (let i = 0; i + IMPROV_HEADER.length <= snapshot.length; i += 1) {
    if (!asciiMatches(snapshot, i, IMPROV_HEADER)) continue;
    if (i + 9 > snapshot.length) continue;

    const version = snapshot[i + 6]!;
    const type = snapshot[i + 7]!;
    const length = snapshot[i + 8]!;

    if (version !== IMPROV_VERSION) continue;
    if (!IMPROV_DEVICE_PACKET_TYPES.has(type)) continue;

    const packetLen = 9 + length + 1;
    if (i + packetLen > snapshot.length) {
      sawHeaderButIncomplete = true;
      continue;
    }

    const expected = checksum8(snapshot, i, i + packetLen - 1);
    const actual = snapshot[i + packetLen - 1]!;
    if (expected !== actual) continue;

    const hasLfTerminator = i + packetLen < snapshot.length && snapshot[i + packetLen] === 0x0a;
    return {
      packet: {
        type,
        length,
        data: snapshot.slice(i + 9, i + 9 + length),
        hasLfTerminator,
      },
    };
  }

  // Heuristic: we saw a plausible header/version/type but not enough bytes to validate checksum yet.
  if (sawHeaderButIncomplete) return { maybe: true };
  return null;
}

function buildImprovPacket(packetType: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + 1 + 1 + 1 + payload.length + 1 + 1);
  out.set(IMPROV_HEADER, 0);
  out[6] = IMPROV_VERSION;
  out[7] = packetType & 0xff;
  out[8] = payload.length & 0xff;
  out.set(payload, 9);

  // checksum: sum of all bytes excluding checksum and LF terminator
  out[out.length - 2] = checksum8(out, 0, out.length - 2);
  out[out.length - 1] = 0x0a; // LF terminator used by official JS SDK
  return out;
}

async function waitForImprovPacket(ctx: DetectorContext, ms: number): Promise<ImprovPacket | null> {
  const deadline = ctx.now() + ms;
  while (ctx.now() < deadline) {
    const hit = findImprovPacket(ctx.buffer.snapshot(4096));
    if (hit?.packet) return hit.packet;
    await sleep(20);
  }
  return null;
}

function packetDetails(p: ImprovPacket): Record<string, string> | undefined {
  if (p.type === 0x01 && p.length === 1) {
    const state = p.data[0]!;
    const name = state === 0x02
      ? 'Ready (Authorized)'
      : state === 0x03
        ? 'Provisioning'
        : state === 0x04
          ? 'Provisioned'
          : 'Unknown';
    return { packet: 'Current State', state: `0x${state.toString(16).padStart(2, '0')}`, stateName: name };
  }
  if (p.type === 0x02 && p.length === 1) {
    const code = p.data[0]!;
    const name = code === 0x00
      ? 'No error'
      : code === 0x01
        ? 'Invalid RPC packet'
        : code === 0x02
          ? 'Unknown RPC command'
          : code === 0x03
            ? 'Unable to connect'
            : code === 0x05
              ? 'Bad Hostname'
              : code === 0xff
                ? 'Unknown Error'
                : 'Unknown';
    return { packet: 'Error State', error: `0x${code.toString(16).padStart(2, '0')}`, errorName: name };
  }
  return undefined;
}

export const improvSerialDetector: Detector = {
  id: 'improv-serial',
  name: 'Improv Serial',
  priority: 850,
  passive: ctx => {
    const hit = findImprovPacket(ctx.buffer.snapshot(4096));
    if (hit?.packet) {
      return {
        id: 'improv-serial',
        name: 'Improv Serial',
        confidence: hit.packet.hasLfTerminator ? 'high' : 'med',
        details: packetDetails(hit.packet),
      };
    }

    // Fallback: some firmwares may print "IMPROV" in a human-readable banner.
    if (hit?.maybe || ctx.buffer.includesAscii('IMPROV')) {
      return { id: 'improv-serial', name: 'Improv Serial', confidence: 'low' };
    }
    return null;
  },
  active: async ctx => {
    ctx.buffer.clear();

    // Official probe per https://www.improv-wifi.com/serial/:
    // Send "RPC Command: Request current state" and expect a valid Improv packet back.
    const requestCurrentState = buildImprovPacket(0x03, new Uint8Array([0x02, 0x00]));
    await ctx.io.write(requestCurrentState);

    const packet = await waitForImprovPacket(ctx, 250);
    if (packet) {
      return {
        id: 'improv-serial',
        name: 'Improv Serial',
        confidence: 'high',
        details: packetDetails(packet),
      };
    }

    // Best-effort fallback: some Improv-enabled firmwares print an "IMPROV" banner on demand.
    // Clear any echoed bytes from the probe to avoid banner false-positives.
    ctx.buffer.clear();
    await ctx.io.write(new Uint8Array([0x0d, 0x0a]));
    const banner = await waitForAscii(ctx, /IMPROV/i, 150);
    if (!banner) return null;

    return { id: 'improv-serial', name: 'Improv Serial', confidence: 'med' };
  },
};
