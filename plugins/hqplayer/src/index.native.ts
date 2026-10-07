import { fetchMediaItemStream } from "@luna/lib.native";
import { createCipheriv, createDecipheriv, randomUUID } from "crypto";
import { tmpdir } from "os";
import { createWriteStream, createReadStream, unlink, stat, readdir } from "fs";
import { join } from "path";
import http, {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import https from "https";
import { networkInterfaces } from "os";
import { Transform, PassThrough, type Readable } from "stream";

// Clean up any orphaned temp files from previous sessions
const cleanupOrphanedTempFiles = (): void => {
  const tempDir = tmpdir();
  readdir(tempDir, (err, files) => {
    if (err) return;
    
    const hqPlayerFiles = files.filter(f => f.startsWith("hqplayer-") && f.endsWith(".flac"));
    
    hqPlayerFiles.forEach(file => {
      const filePath = join(tempDir, file);
      unlink(filePath, () => {
        // Silent cleanup - errors are ignored
      });
    });
  });
};

// Run cleanup on module initialization
cleanupOrphanedTempFiles();

// #region OLD_AES Decryption (Tidal FLAC encryption)
// Master key for unwrapping per-track keys (publicly known)
const TIDAL_MASTER_KEY = Buffer.from([
  0x50, 0x89, 0x53, 0x4c, 0x43, 0x26, 0x98, 0xb7, 0xc6, 0xa3, 0x0a, 0x3f, 0x50,
  0x2e, 0xb4, 0xc7, 0x61, 0xf8, 0xe5, 0x6e, 0x8c, 0x74, 0x68, 0x13, 0x45, 0xfa,
  0x3f, 0xba, 0x68, 0x38, 0xef, 0x9e,
]);

/** Unwrap the per-track key and nonce from the base64 security token */
const unwrapTidalKey = (keyId: string): { key: Buffer; nonce: Buffer } => {
  const token = Buffer.from(keyId, "base64");
  const iv = token.subarray(0, 16);
  const wrapped = token.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", TIDAL_MASTER_KEY, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(wrapped), decipher.final()]);
  const key = plain.subarray(0, 16);
  const nonce = plain.subarray(16, 24);
  return { key, nonce };
};

/** Transform stream that decrypts TIDAL OLD_AES encrypted data */
class TidalDecryptStream extends Transform {
  private cipher: ReturnType<typeof createCipheriv>;

  constructor(keyId: string) {
    super();
    const { key, nonce } = unwrapTidalKey(keyId);
    // Build initial counter: nonce (8 bytes) + zero counter (8 bytes)
    const counter = Buffer.alloc(16);
    nonce.copy(counter, 0);
    // Counter starts at 0 (already zero-filled)
    this.cipher = createCipheriv("aes-128-ctr", key, counter);
    this.cipher.setAutoPadding(false);
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const decrypted = this.cipher.update(chunk);
      this.push(decrypted);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  _flush(callback: (error?: Error | null) => void): void {
    try {
      const final = this.cipher.final();
      if (final.length > 0) {
        this.push(final);
      }
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}

/** Fetch and decrypt a TIDAL stream */
const fetchTidalStream = (url: string, keyId: string): Promise<Readable> => {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`TIDAL CDN returned ${res.statusCode}`));
          return;
        }
        const decryptStream = new TidalDecryptStream(keyId);
        res.pipe(decryptStream);
        resolve(decryptStream as Readable);
      })
      .on("error", reject);
  });
};
// #endregion

// #region UPnP AVTransport Control
/** Standard UPnP AVTransport controller using SOAP */
class UPnPAVTransportControl {
  private baseUrl: string;
  private controlUrl: string;

  constructor(deviceUrl: string) {
    // deviceUrl example: http://192.168.20.12:8019
    this.baseUrl = deviceUrl;
    this.controlUrl = `${deviceUrl}/control/av-transport`;
  }

  private async soapRequest(
    action: string,
    args: Record<string, string> = {},
  ): Promise<string> {
    const argsXml = Object.entries(args)
      .map(([k, v]) => `<${k}>${this.escapeXml(v)}</${k}>`)
      .join("");

    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
<InstanceID>0</InstanceID>
${argsXml}
</u:${action}>
</s:Body>
</s:Envelope>`;

    return new Promise((resolve, reject) => {
      const req = http.request(
        this.controlUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": 'text/xml; charset="utf-8"',
            SOAPACTION: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode === 200) {
              resolve(data);
            } else {
              console.error(
                `[AVTransport] SOAP ${action} failed. Status: ${res.statusCode}, Response: ${data.substring(0, 500)}`,
              );
              reject(
                new Error(`SOAP request failed: ${res.statusCode} ${data}`),
              );
            }
          });
        },
      );

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  async setAVTransportURI(uri: string, metadata: string): Promise<void> {
    await this.soapRequest("SetAVTransportURI", {
      CurrentURI: uri,
      CurrentURIMetaData: metadata,
    });
    console.log(`[AVTransport] Set URI: ${uri}`);
  }

  async play(): Promise<void> {
    console.log("[AVTransport] Sending Play command...");
    await this.soapRequest("Play", { Speed: "1" });
    console.log("[AVTransport] Play command sent");
  }

  async pause(): Promise<void> {
    await this.soapRequest("Pause");
    console.log("[AVTransport] Pause command sent");
  }

  async stop(): Promise<void> {
    await this.soapRequest("Stop");
    console.log("[AVTransport] Stop command sent");
  }

  async seek(seconds: number): Promise<void> {
    // UPnP AVTransport Seek uses H:MM:SS format
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const target = `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    console.log(`[AVTransport] Seeking to ${target} (${seconds}s)...`);
    try {
      await this.soapRequest("Seek", { Unit: "ABS_TIME", Target: target });
      console.log(`[AVTransport] Seek successful`);
    } catch (err) {
      console.error(`[AVTransport] Seek failed:`, err);
      throw err;
    }
  }

  async transportState(): Promise<string> {
    const response = await this.soapRequest("GetTransportInfo");
    const match = response.match(
      /<CurrentTransportState>(.*?)<\/CurrentTransportState>/,
    );
    return match ? match[1] : "Unknown";
  }
}

// #region OpenHome/UPnP Control
/** Simple OpenHome Playlist controller using SOAP/UPnP */
class OpenHomePlaylistControl {
  private baseUrl: string;
  private controlUrl: string;

  constructor(deviceUrl: string) {
    // deviceUrl example: http://192.168.20.12:50154/dev/5dada143-f634-06a6-ffff-fffff69e6cca
    this.baseUrl = deviceUrl;
    this.controlUrl = `${deviceUrl}/svc/av-openhome-org/Playlist/action`;
  }

  private async soapRequest(
    action: string,
    args: Record<string, string> = {},
  ): Promise<string> {
    const argsXml = Object.entries(args)
      .map(([k, v]) => `<${k}>${this.escapeXml(v)}</${k}>`)
      .join("");

    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:${action} xmlns:u="urn:av-openhome-org:service:Playlist:1">
${argsXml}
</u:${action}>
</s:Body>
</s:Envelope>`;

    return new Promise((resolve, reject) => {
      const req = http.request(
        this.controlUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": 'text/xml; charset="utf-8"',
            SOAPACTION: `"urn:av-openhome-org:service:Playlist:1#${action}"`,
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode === 200) {
              resolve(data);
            } else {
              reject(
                new Error(`SOAP request failed: ${res.statusCode} ${data}`),
              );
            }
          });
        },
      );

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  async deleteAll(): Promise<void> {
    await this.soapRequest("DeleteAll");
    console.log("[OpenHome] Playlist cleared");
  }

  async insert(uri: string, metadata: string, afterId = 0): Promise<number> {
    const response = await this.soapRequest("Insert", {
      AfterId: String(afterId),
      Uri: uri,
      Metadata: metadata,
    });

    // Parse NewId from response
    const match = response.match(/<NewId>(\d+)<\/NewId>/);
    const newId = match ? parseInt(match[1], 10) : 0;
    console.log(`[OpenHome] Inserted track ${newId}: ${uri}`);
    return newId;
  }

  async seekId(id: number): Promise<void> {
    await this.soapRequest("SeekId", { Value: String(id) });
    console.log(`[OpenHome] Seek to track ID ${id}`);
  }

  async play(): Promise<void> {
    await this.soapRequest("Play");
    console.log("[OpenHome] Play command sent");
  }

  async pause(): Promise<void> {
    await this.soapRequest("Pause");
    console.log("[OpenHome] Pause command sent");
  }

  async stop(): Promise<void> {
    await this.soapRequest("Stop");
    console.log("[OpenHome] Stop command sent");
  }

  async transportState(): Promise<string> {
    const response = await this.soapRequest("TransportState");
    const match = response.match(/<Value>(.*?)<\/Value>/);
    return match ? match[1] : "Unknown";
  }
}
// #endregion

// #region Shared types (also used by the render side via `import type`)
export const HQPlayerEventChannel = "__Luna.hqplayer.event";

export type HQPInfo = {
  name: string;
  product: string;
  version: string;
  platform: string;
  engine: string;
};

export type HQPMetadata = {
  uri: string;
  mime: string;
  artist: string;
  album: string;
  albumartist: string;
  song: string;
  genre: string;
  date: string;
  track_id: string;
  samplerate: number;
  bits: number;
  channels: number;
  float: boolean;
};

export type HQPStatus = {
  state: number;
  track: number;
  track_id: string;
  tracks_total: number;
  track_serial: number;
  transport_serial: number;
  volume: number;
  clips: number;
  queued: number;
  position: number;
  length: number;
  output_delay: number;
  apod: number;
  input_fill: number;
  output_fill: number;
  process_speed: number;
  active_rate: number;
  active_bits: number;
  active_channels: number;
  filter_junk: number;
  correction: number;
  random: number;
  repeat: number;
  metadata?: HQPMetadata;
};

export type HQPlayerEvent =
  | { type: "connection"; connected: boolean; host?: string; port?: number }
  | { type: "status"; status: HQPStatus }
  | {
      type: "stream";
      kind: "start" | "end" | "error";
      trackId?: string;
      url?: string;
      error?: string;
    };

/**
 * Serializable description of the current TIDAL track, handed over from the
 * render side so the native module can decrypt and re-serve it to HQPlayer.
 */
export type StreamSpec = {
  trackId: string;
  duration: number;
  mime: string;
  manifestMimeType: "application/vnd.tidal.bts" | "application/dash+xml";
  manifest: Record<string, any>;
  directUrl?: string;
};

/** Subset of TIDAL metadata written as the `<metadata>` child of `<PlayNextURI>`. */
export type TrackMeta = {
  song: string;
  artist: string;
  album: string;
  albumartist: string;
  genre: string;
  date: string;
  track_id: string;
  mime: string;
  cover?: string;
  album_gain?: string;
};

export type HQConnectResult =
  | { ok: true; info: HQPInfo }
  | { ok: false; error: string };
/** Result shape of every `withControl`-wrapped native export: `{ ok: true; value: T }`. */
export type HQOk<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };
export type HQStreamResult =
  | { ok: true; url: string }
  | { ok: false; error: string };
// #endregion

// #region Protocol constants
const KEEPALIVE = " ";
const KEEPALIVE_INTERVAL = 15000;
const DEFAULT_TIMEOUT = 10000;
const MAX_BUFFER_SIZE = 1_048_576;
// #endregion

// #region Renderer bridge
// `luna` is provided to native modules by the sandbox (see secureLoad.ts).
declare const luna: {
  sendToRender: (channel: string, data: unknown) => void;
  __hqplayer?: { dispose: () => void };
};

/** Push an event to the render side over the plugin's own IPC channel. */
export const sendToRenderer = (event: HQPlayerEvent): void => {
  try {
    luna.sendToRender(HQPlayerEventChannel, event);
  } catch {
    // renderer not available (yet)
  }
};
// #endregion

// #region Serialization helpers
const escapeAttr = (value: unknown): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const formatAttrs = (
  attrs: Record<string, unknown> | undefined | null,
): string => {
  if (attrs === undefined || attrs === null) return "";
  let out = "";
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === "") continue;
    out += ` ${key}="${escapeAttr(value)}"`;
  }
  return out;
};

const toInt = (value: string | undefined, defaultValue = 0): number => {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
};

const toFloat = (value: string | undefined, defaultValue = 0): number => {
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
};

const toBool = (value: string | undefined, defaultValue = false): boolean => {
  if (value === undefined) return defaultValue;
  return !(
    value === "" ||
    value === "0" ||
    value === "false" ||
    value === "False"
  );
};
// #endregion

// #region Local HTTP stream server

const getLanAddress = (): string => {
  try {
    for (const infos of Object.values(networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family === "IPv4" && !info.internal) return info.address;
      }
    }
  } catch {
    // os module could not be read, fall through
  }
  return "127.0.0.1";
};

type ActiveStream = {
  path: string;
  url: string;
  spec: StreamSpec;
  stream?: Readable;
  tempFilePath?: string;
  tempFileSize?: number;
  isBuffering: boolean;
  isReady: boolean;
};

class StreamServer {
  private server?: Server;
  private port?: number;
  private active?: ActiveStream;

  public ensure(): Promise<number> {
    if (this.server !== undefined) return Promise.resolve(this.port ?? 0);
    return new Promise<number>((resolve, reject) => {
      this.server = createServer((req, res) => void this.handle(req, res));
      this.server.on("error", (err) => {
        console.error(`[HQPlayer.stream] HTTP server error:`, err);
        reject(err);
      });
      this.server.listen(0, "0.0.0.0", () => {
        const address = this.server?.address();
        this.port =
          typeof address === "object" && address !== null ? address.port : 0;
        resolve(this.port);
      });
    });
  }

  /** Stage a new stream and return the URL HQPlayer should fetch. */
  public async play(spec: StreamSpec, streamHost: string): Promise<string> {
    await this.ensure();
    this.clearStream();
    const path = `/s/${encodeURIComponent(spec.trackId)}-${randomUUID()}`;
    this.active = { path, url: "", spec, isBuffering: false, isReady: false };
    this.active.url = `http://${streamHost}:${this.port}${path}`;
    sendToRenderer({
      type: "stream",
      kind: "start",
      trackId: spec.trackId,
      url: this.active.url,
    });

    // Start buffering immediately in background
    void this.bufferTrack(this.active);

    return this.active.url;
  }

  /** Abort the currently staged stream (used on track transition / stop). */
  public clearStream(): void {
    if (this.active !== undefined) {
      try {
        this.active.stream?.destroy();
      } catch {
        // already destroyed
      }
      // Clean up temp file
      if (this.active.tempFilePath) {
        unlink(this.active.tempFilePath, (err) => {
          if (err)
            console.error(
              `[HQPlayer.stream] Failed to delete temp file: ${err.message}`,
            );
        });
      }
    }
    this.active = undefined;
  }

  public get activeUrl(): string | undefined {
    return this.active?.url;
  }

  public close(): void {
    this.clearStream();
    if (this.server !== undefined) {
      try {
        this.server.close();
      } catch {
        // already closed
      }
      this.server = undefined;
      this.port = undefined;
    }
  }

  /** Buffer entire track to temp file (BubbleUPnP style) */
  private async bufferTrack(active: ActiveStream): Promise<void> {
    if (active.isBuffering) return;
    active.isBuffering = true;

    // Yield to event loop immediately so UPnP commands can proceed
    await new Promise((resolve) => setImmediate(resolve));

    try {
      // Create temp file
      const tempFileName = `hqplayer-${randomUUID()}.flac`;
      const tempFilePath = join(tmpdir(), tempFileName);
      active.tempFilePath = tempFilePath;

      // Get source stream
      let sourceStream: Readable;
      const manifest = active.spec.manifest;
      const isOldAes = manifest.encryptionType === "OLD_AES";
      const hasUrl = manifest.urls && manifest.urls.length > 0;
      const hasKeyId = manifest.keyId;

      if (isOldAes && hasUrl && hasKeyId) {
        sourceStream = await fetchTidalStream(manifest.urls[0], manifest.keyId);
      } else {
        sourceStream = await fetchMediaItemStream(active.spec as never);
      }

      // Write to temp file
      const fileStream = createWriteStream(tempFilePath);
      let bytesWritten = 0;

      sourceStream.on("data", (chunk: Buffer) => {
        bytesWritten += chunk.length;
      });

      await new Promise<void>((resolve, reject) => {
        sourceStream.pipe(fileStream);
        fileStream.on("finish", () => {
          console.log(
            `[HQPlayer.stream] Buffering complete: ${bytesWritten} bytes written to ${tempFilePath}`,
          );
          active.tempFileSize = bytesWritten;
          active.isReady = true;
          active.isBuffering = false;
          resolve();
        });
        fileStream.on("error", reject);
        sourceStream.on("error", reject);
      });
    } catch (err) {
      console.error(`[HQPlayer.stream] Buffering failed:`, err);
      active.isBuffering = false;
      sendToRenderer({
        type: "stream",
        kind: "error",
        trackId: active.spec.trackId,
        error: String((err as Error)?.message ?? err),
      });
    }
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = (req.url ?? "").split("?")[0];
    const active = this.active;
    if (active === undefined || path !== active.path) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    if (req.method === "HEAD") {
      // For HEAD requests, wait for buffering if needed to get file size
      if (!active.isReady) {
        const startTime = Date.now();
        const timeout = 60000;
        while (!active.isReady && Date.now() - startTime < timeout) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      res.writeHead(200, this.headers(active.spec, active.tempFileSize));
      res.end();
      return;
    }

    if (active.spec.manifestMimeType !== "application/vnd.tidal.bts") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(
        "Only TIDAL FLAC (application/vnd.tidal.bts) streams can be forwarded",
      );
      sendToRenderer({
        type: "stream",
        kind: "error",
        trackId: active.spec.trackId,
        error: "Unsupported manifest type",
      });
      return;
    }

    try {
      // Wait for buffering to complete
      if (!active.isReady) {
        console.log(`[HQPlayer.stream] Waiting for buffering to complete...`);
        // Poll until ready (with timeout)
        const startTime = Date.now();
        const timeout = 60000; // 60 seconds
        while (!active.isReady && Date.now() - startTime < timeout) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!active.isReady) {
          throw new Error("Buffering timeout");
        }
      }

      console.log(
        `[HQPlayer.stream] Serving from temp file: ${active.tempFilePath}`,
      );

      if (!active.tempFilePath) {
        throw new Error("Temp file path not set");
      }

      // Handle Range requests for seeking
      const rangeHeader = req.headers.range;
      const fileSize = active.tempFileSize || 0;
      let fileStream;

      if (rangeHeader && fileSize > 0) {
        // Parse range header: "bytes=start-end"
        const parts = rangeHeader.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        console.log(
          `[HQPlayer.stream] Range request: ${start}-${end}/${fileSize}`,
        );

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunkSize),
          "Content-Type": active.spec.mime || "audio/flac",
          Connection: "close",
        });

        fileStream = createReadStream(active.tempFilePath, { start, end });
      } else {
        // Serve entire file
        res.writeHead(200, this.headers(active.spec, active.tempFileSize));
        fileStream = createReadStream(active.tempFilePath);
      }

      fileStream.pipe(res);

      fileStream.on("error", (err) => {
        console.error(`[HQPlayer.stream] file read error:`, err);
        sendToRenderer({
          type: "stream",
          kind: "error",
          trackId: active.spec.trackId,
          error: String((err as Error)?.message ?? err),
        });
        try {
          res.destroy(err);
        } catch {}
      });

      fileStream.on("end", () => {
        console.log(`[HQPlayer.stream] file stream ended`);
        sendToRenderer({
          type: "stream",
          kind: "end",
          trackId: active.spec.trackId,
        });
      });

      res.on("close", () => {
        if (!res.writableEnded) {
          console.log(
            `[HQPlayer.stream] response closed, destroying file stream`,
          );
          try {
            fileStream.destroy();
          } catch {}
        }
      });
    } catch (err) {
      console.error(`[HQPlayer.stream] failed to serve stream:`, err);
      sendToRenderer({
        type: "stream",
        kind: "error",
        trackId: active.spec.trackId,
        error: String((err as Error)?.message ?? err),
      });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.end("Failed to serve stream");
    }
  }

  private headers(spec: StreamSpec, fileSize?: number): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": spec.mime || "audio/flac",
      Connection: "close",
      "Accept-Ranges": "bytes",
    };
    if (fileSize !== undefined) {
      headers["Content-Length"] = String(fileSize);
    }
    return headers;
  }
}
// #endregion

// #region Module state
const streamServer = new StreamServer();
let upnpControl: UPnPAVTransportControl | undefined;

let connectedInfo: HQPInfo | undefined;
let streamHostOverride: string | undefined;
let upnpDeviceUrlOverride: string | undefined;
// #endregion

// #region Native IPC API
export const connectHQPlayer = async (
  host: string | undefined,
  upnpDeviceUrl: string | undefined,
): Promise<HQConnectResult> => {
  host = (host ?? "").trim();
  upnpDeviceUrlOverride = upnpDeviceUrl?.trim()
    ? upnpDeviceUrl.trim()
    : undefined;

  try {
    // Use UPnP AVTransport
    console.log(
      `[HQPlayer] Connecting via UPnP AVTransport to ${upnpDeviceUrlOverride}`,
    );
    upnpControl = new UPnPAVTransportControl(upnpDeviceUrlOverride || "");

    // Test connection by getting transport state
    const state = await upnpControl.transportState();
    console.log(`[UPnP] Connected successfully, state: ${state}`);

    connectedInfo = {
      name: "HQPlayer (UPnP)",
      product: "SignalystHQPlayer6",
      version: "6.0",
      platform: "UPnP",
      engine: "AVTransport",
    };

    return { ok: true, info: connectedInfo };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
};

export const disconnectHQPlayer = async (): Promise<HQOk> => {
  streamServer.clearStream();
  connectedInfo = undefined;
  return { ok: true, value: undefined };
};

/** Send the current TIDAL track (decrypted + re-served locally) to HQPlayer. */
export const sendCurrentTrack = async (
  spec: StreamSpec | undefined,
  meta: TrackMeta | undefined,
): Promise<HQStreamResult> => {
  if (spec === undefined)
    return { ok: false, error: "No stream spec provided" };
  streamServer.clearStream();

  try {
    const host =
      streamHostOverride !== undefined ? streamHostOverride : getLanAddress();
    const url = await streamServer.play(spec, host);

    const lengthInt = Math.floor(spec.duration);
    const lengthStr = String(lengthInt);

    // Use UPnP AVTransport protocol

    // Convert duration to H:MM:SS format required by DIDL-Lite
    const hours = Math.floor(lengthInt / 3600);
    const minutes = Math.floor((lengthInt % 3600) / 60);
    const seconds = lengthInt % 60;
    const durationStr = `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

    // Helper to escape XML special characters
    const escapeXml = (str: string) =>
      str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    // Create DIDL-Lite metadata with properly escaped values
    const metadata = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
<item id="1" parentID="0" restricted="1">
<dc:title>${escapeXml(meta?.song || "Unknown")}</dc:title>
<dc:creator>${escapeXml(meta?.artist || "Unknown")}</dc:creator>
<upnp:class>object.item.audioItem.musicTrack</upnp:class>
<upnp:album>${escapeXml(meta?.album || "Unknown")}</upnp:album>
<upnp:artist>${escapeXml(meta?.artist || "Unknown")}</upnp:artist>
<upnp:albumArtist>${escapeXml(meta?.albumartist || meta?.artist || "Unknown")}</upnp:albumArtist>
<upnp:genre>${escapeXml(meta?.genre || "Unknown")}</upnp:genre>
<res protocolInfo="http-get:*:${spec.mime || "audio/flac"}:*" duration="${durationStr}" size="0">${escapeXml(url)}</res>
</item>
</DIDL-Lite>`;

    await upnpControl!.stop();
    await upnpControl!.setAVTransportURI(url, metadata);
    await upnpControl!.play();

    // Check status
    setTimeout(async () => {
      try {
        const state = await upnpControl!.transportState();
        console.log(`[UPnP] Status check: state=${state}`);
      } catch (e) {
        console.log(`[UPnP] Status check failed:`, e);
      }
    }, 2000);

    return { ok: true, url };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    console.error(`[HQPlayer.sendCurrentTrack]`, err);
    return { ok: false, error: message };
  }
};

export const playHQPlayer = async (): Promise<HQOk> => {
  try {
    await upnpControl!.play();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
};

export const pauseHQPlayer = async (): Promise<HQOk> => {
  try {
    await upnpControl!.pause();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
};

export const stopHQPlayer = async (): Promise<HQOk> => {
  streamServer.clearStream();
  try {
    await upnpControl!.stop();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
};

export const seekHQPlayerTo = async (position: number): Promise<HQOk> => {
  console.log(`[HQPlayer] seekHQPlayerTo called with position: ${position}`);
  try {
    await upnpControl!.seek(position);
    console.log(`[HQPlayer] seekHQPlayerTo successful`);
    return { ok: true };
  } catch (err) {
    console.error(`[HQPlayer] seekHQPlayerTo failed:`, err);
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
};

/** Update native-only connection hints (pushed by applySettings / Settings UI). */
export const updateHQPlayerSettings = async (
  partial: { streamHost?: string; upnpDeviceUrl?: string } | undefined,
): Promise<HQOk> => {
  if (partial?.streamHost !== undefined) {
    streamHostOverride = partial.streamHost.trim()
      ? partial.streamHost.trim()
      : undefined;
  }
  if (partial?.upnpDeviceUrl !== undefined) {
    upnpDeviceUrlOverride = partial.upnpDeviceUrl.trim()
      ? partial.upnpDeviceUrl.trim()
      : undefined;
  }
  return { ok: true, value: undefined };
};

/** Idempotent teardown of every native resource. */
export const dispose = async (): Promise<HQOk> => {
  streamServer.close();
  connectedInfo = undefined;
  return { ok: true, value: undefined };
};

// Clean up a previous instance when the plugin is reloaded (the vm context is
// replaced but these singletons live on the shared `luna` object).
try {
  luna.__hqplayer?.dispose();
} catch {
  // first load
}
luna.__hqplayer = { dispose: () => void dispose() };
// #endregion
