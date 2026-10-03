import { fetchMediaItemStream } from "@luna/lib.native";
import { createSocket, type RemoteInfo, type Socket as DgramSocket } from "dgram";
import { randomUUID } from "crypto";
import http, { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { createConnection, type Socket } from "net";
import { networkInterfaces } from "os";
import type { Readable } from "stream";

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
	| { type: "stream"; kind: "start" | "end" | "error"; trackId?: string; url?: string; error?: string };

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

export type HQConnectResult = { ok: true; info: HQPInfo } | { ok: false; error: string };
/** Result shape of every `withControl`-wrapped native export: `{ ok: true; value: T }`. */
export type HQOk<T = void> = { ok: true; value: T } | { ok: false; error: string };
export type HQStreamResult = { ok: true; url: string } | { ok: false; error: string };
export type HQDiscoveredHost = {
	address: string;
	name: string;
	version: string;
	port: number;
};
// #endregion

// #region Protocol constants
const CONTROL_PORT = 4321;
const DISCOVERY_MULTICAST = "239.192.0.199";
const DISCOVERY_MULTICAST_V6 = "ff08::c7";
const DISCOVERY_PAYLOAD = '<?xml version="1.0"?><discover>hqplayer</discover>';
const KEEPALIVE = " ";
const KEEPALIVE_INTERVAL = 15000;
const DEFAULT_TIMEOUT = 10000;
const MAX_BUFFER_SIZE = 1_048_576;
// #endregion

// #region UPnP constants
const SSDP_MULTICAST = "239.255.255.250";
const SSDP_PORT = 1900;
const UPNP_DEVICE_TYPE_MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:3";
const UPNP_SERVICE_AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:3";
const UPNP_SERVICE_RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:3";
// #endregion

// #region OpenHome constants
const OPENHOME_DEVICE_TYPE_SOURCE = "urn:linn-co-uk:device:Source:1";
const OPENHOME_SERVICE_PLAYLIST = "urn:av-openhome-org:service:Playlist:1";
const OPENHOME_SERVICE_TRANSPORT = "urn:av-openhome-org:service:Transport:1";
const OPENHOME_SERVICE_VOLUME = "urn:av-openhome-org:service:Volume:1";
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

const formatAttrs = (attrs: Record<string, unknown> | undefined | null): string => {
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
	return !(value === "" || value === "0" || value === "false" || value === "False");
};
// #endregion

// #region UPnP Client
type UPnPDevice = {
	location: string;
	host: string;
	port: number;
	usn: string;
	friendlyName?: string;
	avTransportUrl?: string;
	renderingControlUrl?: string;
};

const parseUpnpLocation = (location: string): { host: string; port: number } => {
	const match = location.match(/^https?:\/\/([^:]+):(\d+)/);
	if (!match) return { host: "", port: 0 };
	return { host: match[1], port: parseInt(match[2], 10) };
};

const ssdpDiscover = async (st: string, timeoutMs = 4000): Promise<UPnPDevice[]> => {
	const devices = new Map<string, UPnPDevice>();
	const sockets: DgramSocket[] = [];

	const payload = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_MULTICAST}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;

	const finish = (): void => {
		for (const socket of sockets) {
			try {
				socket.close();
			} catch {
				// already closed
			}
		}
	};

	const onMessage = (msg: Buffer, rinfo: RemoteInfo): void => {
		const lines = msg.toString("utf8").split("\r\n");
		let location = "";
		let usn = "";
		for (const line of lines) {
			const lower = line.toLowerCase();
			if (lower.startsWith("location:")) {
				location = line.substring(9).trim();
			} else if (lower.startsWith("usn:")) {
				usn = line.substring(4).trim();
			}
		}
		if (location && !devices.has(location)) {
			const { host, port } = parseUpnpLocation(location);
			devices.set(location, { location, host, port, usn });
		}
	};

	const createSocketFn = (family: "udp4" | "udp6"): DgramSocket | undefined => {
		try {
			const sock = createSocket(family);
			sock.on("error", () => {});
			sock.on("message", onMessage);
			sock.bind({ port: 0, exclusive: true });
			sockets.push(sock);
			return sock;
		} catch {
			return undefined;
		}
	};

	const v4 = createSocketFn("udp4");
	const v6 = createSocketFn("udp6");

	if (v4) v4.send(payload, SSDP_PORT, SSDP_MULTICAST);
	if (v6) v6.send(payload, SSDP_PORT, SSDP_MULTICAST);

	await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 5000)));
	finish();

	return [...devices.values()];
};

const fetchXml = async (url: string): Promise<string> => {
	const match = url.match(/^https?:\/\/([^:]+):(\d+)(\/.*)$/);
	if (!match) throw new Error(`Invalid URL: ${url}`);
	const [, host, portStr, path] = match;
	const port = parseInt(portStr, 10);

	return new Promise((resolve, reject) => {
		const req = http.get({ host, port, path, timeout: 10000 }, (res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => resolve(data));
		});
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("Request timeout"));
		});
	});
};

interface UPnPServices {
	avTransportUrl: string;
	renderingControlUrl: string;
}

const getUpnpServices = async (device: UPnPDevice): Promise<UPnPServices | undefined> => {
	try {
		const xml = await fetchXml(device.location);
		const controlUrlMatch = xml.match(/<controlURL>([^<]+)<\/controlURL>/g);
		const serviceTypeMatch = xml.match(/<serviceType>([^<]+)<\/serviceType>/g);

		if (!controlUrlMatch || !serviceTypeMatch) return undefined;

		let avTransportUrl = "";
		let renderingControlUrl = "";

		for (let i = 0; i < serviceTypeMatch.length; i++) {
			const serviceType = serviceTypeMatch[i].replace(/<[^>]+>/g, "");
			const controlUrl = controlUrlMatch[i].replace(/<[^>]+>/g, "");
			const baseUrl = device.location.replace(/\/[^/]*$/, "");
			const absoluteUrl = controlUrl.startsWith("http") ? controlUrl : baseUrl + controlUrl;

			if (serviceType.includes("AVTransport")) {
				avTransportUrl = absoluteUrl;
			} else if (serviceType.includes("RenderingControl")) {
				renderingControlUrl = absoluteUrl;
			}
		}

		const friendlyMatch = xml.match(/<friendlyName>([^<]+)<\/friendlyName>/);
		if (friendlyMatch) device.friendlyName = friendlyMatch[1];

		if (!avTransportUrl || !renderingControlUrl) return undefined;

		return { avTransportUrl, renderingControlUrl };
	} catch (err) {
		console.error(`[UPnP] Failed to get services for ${device.location}:`, err);
		return undefined;
	}
};

const soapCall = async (url: string, action: string, body: string): Promise<string> => {
	const match = url.match(/^https?:\/\/([^:]+):(\d+)(\/.*)$/);
	if (!match) throw new Error(`Invalid URL: ${url}`);
	const [, host, portStr, path] = match;
	const port = parseInt(portStr, 10);

	const soapAction = `"urn:schemas-upnp-org:service:AVTransport:3#${action}"`;
	const postData = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>${body}</s:Body>
</s:Envelope>`;

	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host,
				port,
				path,
				method: "POST",
				headers: {
					"Content-Type": 'text/xml; charset="utf-8"',
					SOAPACTION: soapAction,
					"Content-Length": Buffer.byteLength(postData),
				},
				timeout: 15000,
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => (data += chunk));
				res.on("end", () => resolve(data));
			}
		);
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("SOAP request timeout"));
		});
		req.write(postData);
		req.end();
	});
};

class UPnPClient {
	private avTransportUrl = "";
	private renderingControlUrl = "";

	public setServices(avTransport: string, renderingControl: string): void {
		this.avTransportUrl = avTransport;
		this.renderingControlUrl = renderingControl;
	}

	public async setAvTransportUri(uri: string, metadata?: string): Promise<void> {
		const meta = metadata ?? "";
		const body = `<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:3">
      <InstanceID>0</InstanceID>
      <CurrentURI>${escapeAttr(uri)}</CurrentURI>
      <CurrentURIMetaData>${escapeAttr(meta)}</CurrentURIMetaData>
    </u:SetAVTransportURI>`;
		await soapCall(this.avTransportUrl, "SetAVTransportURI", body);
	}

	public async play(): Promise<void> {
		const body = `<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:3">
      <InstanceID>0</InstanceID>
      <Speed>1</Speed>
    </u:Play>`;
		await soapCall(this.avTransportUrl, "Play", body);
	}

	public async pause(): Promise<void> {
		const body = `<u:Pause xmlns:u="urn:schemas-upnp-org:service:AVTransport:3">
      <InstanceID>0</InstanceID>
    </u:Pause>`;
		await soapCall(this.avTransportUrl, "Pause", body);
	}

	public async stop(): Promise<void> {
		const body = `<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:3">
      <InstanceID>0</InstanceID>
    </u:Stop>`;
		await soapCall(this.avTransportUrl, "Stop", body);
	}

	public async seek(seconds: number): Promise<void> {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = Math.floor(seconds % 60);
		const time = `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
		const body = `<u:Seek xmlns:u="urn:schemas-upnp-org:service:AVTransport:3">
      <InstanceID>0</InstanceID>
      <Unit>REL_TIME</Unit>
      <Target>${time}</Target>
    </u:Seek>`;
		await soapCall(this.avTransportUrl, "Seek", body);
	}

	public async setVolume(db: number): Promise<void> {
		const volume = Math.round((db + 60) * 655.35);
		const body = `<u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:3">
      <InstanceID>0</InstanceID>
      <Channel>Master</Channel>
      <DesiredVolume>${volume}</DesiredVolume>
    </u:SetVolume>`;
		await soapCall(this.renderingControlUrl, "SetVolume", body);
	}
}
// #endregion

// #region OpenHome Client
class OpenHomeClient {
	private devicePath = "";

	public setDevicePath(path: string): void {
		this.devicePath = path.replace(/\/$/, "");
	}

	public get baseUrl(): string {
		return `http://${openHomeHost}:${openHomePort}${this.devicePath}`;
	}

	private async request(service: string, action: string, params?: Record<string, string>): Promise<string> {
		const url = `${this.baseUrl}/svc/av-openhome-org/${service}/action`;
		const soapAction = `urn:av-openhome-org:service:${service}:1#${action}`;
		console.log("[OpenHome] SOAP URL:", url, "Action:", action);

		let body = "";
		if (params && Object.keys(params).length > 0) {
			const paramXml = Object.entries(params)
				.map(([key, value]) => `<${key}>${escapeAttr(value)}</${key}>`)
				.join("");
			body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="urn:av-openhome-org:service:${service}:1">${paramXml}</u:${action}></s:Body></s:Envelope>`;
		} else {
			body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="urn:av-openhome-org:service:${service}:1"></u:${action}></s:Body></s:Envelope>`;
		}

		return new Promise((resolve, reject) => {
			const req = http.request(
				url,
				{
					method: "POST",
					headers: {
						"Content-Type": "text/xml; charset=utf-8",
						"SOAPAction": `"${soapAction}"`,
					},
					timeout: 15000,
				},
				(res) => {
					console.log("[OpenHome] Response status:", res.statusCode);
					let data = "";
					res.on("data", (chunk) => (data += chunk));
					res.on("end", () => {
						console.log("[OpenHome] Response body:", data);
						resolve(data);
					});
				},
			);
			req.on("error", (err) => console.log("[OpenHome] Request error:", err.message));
			req.on("timeout", () => {
				req.destroy();
				reject(new Error("OpenHome request timeout"));
			});
			req.write(body);
			req.end();
		});
	}

	public async insert(uri: string, metadata: string): Promise<number> {
		const params: Record<string, string> = {
			Uri: uri,
			Metadata: metadata,
			AfterId: "0",
		};
		let response = "";
		try {
			response = await this.request("Playlist", "Insert", params);
		} catch (err) {
			throw new Error(`OpenHome Insert failed: ${String(err)}. URL: http://${openHomeHost}:${openHomePort}/svc/av-openhome-org/Playlist/action`);
		}
		const match = response.match(/<NewId>(\d+)<\/NewId>/);
		if (!match) throw new Error(`Failed to get inserted track ID. Response: ${response.substring(0, 1000)}`);
		return parseInt(match[1], 10);
	}

	public async transport(): Promise<string> {
		const response = await this.request("Transport", "TransportState");
		const match = response.match(/<State>([^<]+)<\/State>/);
		return match ? match[1] : "Unknown";
	}

	public async getPlaylist(): Promise<string> {
		const response = await this.request("Playlist", "IdArray");
		console.log("[OpenHome] Playlist IdArray:", response.substring(0, 500));
		return response;
	}

	public async playIndex(id: number): Promise<void> {
		await this.request("Playlist", "PlayIndex", { Id: String(id) });
	}

	public async play(): Promise<void> {
		const state = await this.transport();
		console.log("[OpenHome] Transport state before Play:", state);
		if (state === "Playing") return;
		try {
			await this.request("Transport", "Play");
		} catch (err) {
			console.log("[OpenHome] Transport.Play error:", err);
			throw err;
		}
	}

	public async pause(): Promise<void> {
		await this.request("Transport", "Pause");
	}

	public async stop(): Promise<void> {
		await this.request("Transport", "Stop");
	}

	public async seek(seconds: number): Promise<void> {
		await this.request("Transport", "SeekSecondAbsolute", { StreamId: "0", SecondAbsolute: String(seconds) });
	}

	public async setVolume(db: number): Promise<void> {
		await this.request("Volume", "SetVolume", { Value: String(Math.round((db + 60) * 100)) });
	}

	public async deleteAll(): Promise<void> {
		await this.request("Playlist", "DeleteAll");
	}
}
// #endregion

// #region Tolerant XML tokenizer
type XmlEvent = {
	kind: "start" | "end";
	name: string;
	attrs: Record<string, string>;
	selfClosing: boolean;
};

const TOKEN_RE = /<(?<close>\/?)(?<name>[A-Za-z_][\w.\-]*)(?<attrs>(?:\s+[\w:.\-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(?<empty>\/)?>/g;
const ATTR_RE = /([\w:.\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const DECL_RE = /<\?xml[^>]*\?>/g;

const decodeEntities = (value: string): string =>
	value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"');

const parseAttrs = (source: string): Record<string, string> => {
	const attrs: Record<string, string> = {};
	ATTR_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ATTR_RE.exec(source)) !== null) {
		const [, key, double, single] = match;
		attrs[key] = decodeEntities(double ?? single ?? "");
	}
	return attrs;
};

class HQPParser {
	private buffer = "";
	private readonly maxSize = MAX_BUFFER_SIZE;

	/** Feed a received chunk and return every event that is now complete. */
	feed(chunk: string): XmlEvent[] {
		this.buffer += chunk.replace(DECL_RE, "");
		const events: XmlEvent[] = [];
		let consumed = 0;
		TOKEN_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = TOKEN_RE.exec(this.buffer)) !== null) {
			const groups = match.groups!;
			events.push({
				kind: groups.close ? "end" : "start",
				name: groups.name,
				attrs: groups.close ? {} : parseAttrs(groups.attrs ?? ""),
				selfClosing: !groups.close && Boolean(groups.empty),
			});
			consumed = match.index + match[0].length;
		}
		if (consumed > 0) this.buffer = this.buffer.slice(consumed);
		// A fragment without a single tag means we lost sync, don't grow forever.
		if (this.buffer.length > this.maxSize) this.buffer = "";
		return events;
	}
}
// #endregion

// #region Command correlation
type Waiter = { resolve: (events: XmlEvent[]) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };
// #endregion

class HQPlayerControl {
	public host = "";
	public port = CONTROL_PORT;
	private socket?: Socket;
	private readonly parser = new HQPParser();
	private readonly waiters = new Map<string, Waiter[]>();
	private docTag?: string;
	private doc: XmlEvent[] = [];
	private docDepth = 0;
	private keepAlive?: ReturnType<typeof setInterval>;
	private statusQueue: HQPStatus[] = [];
	private connected = false;

	public onStatus: ((status: HQPStatus) => void) | undefined;
	public onDisconnected: (() => void) | undefined;

	public get isConnected(): boolean {
		return this.connected && this.socket !== undefined && !this.socket.destroyed;
	}

	public connect(host: string, port: number, timeoutMs = 8000): Promise<void> {
		if (this.isConnected) return Promise.resolve();
		host = host.trim();
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const socket = createConnection({ host, port });
			const connectTimer = setTimeout(() => {
				if (settled) return;
				settled = true;
				socket.destroy();
				reject(new Error(`Timed out connecting to HQPlayer at ${host}:${port}`));
			}, timeoutMs);

			socket.once("connect", () => {
				if (settled) return;
				settled = true;
				clearTimeout(connectTimer);
				this.socket = socket;
				this.host = host;
				this.port = port;
				this.connected = true;
				this.startKeepAlive();
				// Subscribe to pushed Status documents (best effort - HQPlayer answers with an ack).
				try {
					this.commandEvent("Status", { subscribe: "1" }, 5000).catch(() => {});
				} catch {
					// subscription ack not required for operation
				}
				socket.on("data", (data) => {
					for (const event of this.parser.feed(data.toString("utf8"))) this.dispatch(event);
				});
				socket.on("close", () => this.handleDrop(new Error("HQPlayer closed the connection")));
				socket.on("error", (err) => this.handleDrop(err));
				sendToRenderer({ type: "connection", connected: true, host: this.host, port: this.port });
				resolve();
			});

			socket.on("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(connectTimer);
				reject(err);
			});
		});
	}

	private handleDrop(err: Error): void {
		const wasConnected = this.connected;
		this.connected = false;
		this.stopKeepAlive();
		if (this.socket !== undefined) {
			try {
				this.socket.destroy();
			} catch {
				// already destroyed
			}
			this.socket = undefined;
		}
		this.failWaiters(err);
		this.statusQueue.length = 0;
		if (wasConnected) this.onDisconnected?.();
		sendToRenderer({ type: "connection", connected: false });
	}

	public close(): void {
		this.onDisconnected = undefined;
		this.onStatus = undefined;
		this.handleDrop(new Error("Control connection closed by client"));
	}

	private startKeepAlive(): void {
		this.stopKeepAlive();
		this.keepAlive = setInterval(() => {
			this.socket?.write(KEEPALIVE);
		}, KEEPALIVE_INTERVAL);
	}

	private stopKeepAlive(): void {
		if (this.keepAlive !== undefined) {
			clearInterval(this.keepAlive);
			this.keepAlive = undefined;
		}
	}

	private requireConnection(): void {
		if (!this.isConnected || this.socket === undefined) {
			throw new Error(`Not connected to HQPlayer at ${this.host}:${this.port}`);
		}
	}

	public send(tag: string, attrs?: Record<string, unknown>): void {
		this.requireConnection();
		const payload = `<?xml version="1.0"?><${tag}${formatAttrs(attrs)}/>`;
		this.socket!.write(payload);
	}

	/** Send a full request document (used to add a `<metadata>` child). */
	public sendRaw(payload: string): void {
		this.requireConnection();
		this.socket!.write(payload);
	}

	public command(tag: string, attrs?: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT): Promise<XmlEvent[]> {
		return new Promise<XmlEvent[]>((resolve, reject) => {
			try {
				const waiter: Waiter = {
					resolve,
					reject,
					timer: setTimeout(() => {
						this.removeWaiter(tag, waiter);
						reject(new Error(`Timeout waiting for <${tag}> from HQPlayer`));
					}, timeoutMs),
				};
				const queue = this.waiters.get(tag) ?? [];
				queue.push(waiter);
				this.waiters.set(tag, queue);
				this.send(tag, attrs);
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/** Send a raw request document and resolve with its response document. */
	public commandRaw(tag: string, payload: string, timeoutMs = DEFAULT_TIMEOUT): Promise<XmlEvent[]> {
		return new Promise<XmlEvent[]>((resolve, reject) => {
			try {
				const waiter: Waiter = {
					resolve,
					reject,
					timer: setTimeout(() => {
						this.removeWaiter(tag, waiter);
						reject(new Error(`Timeout waiting for <${tag}> from HQPlayer`));
					}, timeoutMs),
				};
				const queue = this.waiters.get(tag) ?? [];
				queue.push(waiter);
				this.waiters.set(tag, queue);
				this.sendRaw(payload);
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	public async commandEvent(tag: string, attrs?: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT): Promise<XmlEvent> {
		const events = await this.command(tag, attrs, timeoutMs);
		const root = events[0];
		if (root !== undefined && root.attrs.result === "Error") {
			throw new Error(`<${tag}> was rejected by HQPlayer`);
		}
		return root;
	}

	private removeWaiter(tag: string, waiter: Waiter): void {
		const queue = this.waiters.get(tag);
		if (queue === undefined) return;
		const index = queue.indexOf(waiter);
		if (index >= 0) queue.splice(index, 1);
		if (queue.length === 0) this.waiters.delete(tag);
	}

	private failWaiters(err: Error): void {
		for (const queue of this.waiters.values()) {
			for (const waiter of queue.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.reject(err);
			}
		}
		this.waiters.clear();
	}

	private dispatch(event: XmlEvent): void {
		if (this.docTag === undefined) {
			if (event.kind !== "start") return;
			this.docTag = event.name;
			this.doc = [event];
			if (event.selfClosing) this.completeDocument();
			else this.docDepth = 1;
			return;
		}
		this.doc.push(event);
		if (event.kind === "start" && !event.selfClosing) {
			this.docDepth += 1;
		} else if (event.kind === "end") {
			this.docDepth -= 1;
			if (this.docDepth <= 0) this.completeDocument();
		}
	}

	private completeDocument(): void {
		const events = this.doc;
		const tag = this.docTag;
		this.doc = [];
		this.docTag = undefined;
		this.docDepth = 0;
		if (events.length === 0 || tag === undefined) return;

		// Status documents without a `result` attribute are pushes from HQPlayer.
		if (tag === "Status" && events[0].attrs.result === undefined) {
			this.completeStatus(events);
			return;
		}

		const queue = this.waiters.get(tag);
		if (queue !== undefined) {
			for (const waiter of queue.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.resolve(events);
				break;
			}
			if (queue.length === 0) this.waiters.delete(tag);
		}
	}

	private completeStatus(events: XmlEvent[]): void {
		const root = events[0];
		const status: HQPStatus = {
			state: toInt(root.attrs.state),
			track: toInt(root.attrs.track),
			track_id: root.attrs.track_id ?? "",
			tracks_total: toInt(root.attrs.tracks_total),
			track_serial: toInt(root.attrs.track_serial),
			transport_serial: toInt(root.attrs.transport_serial),
			volume: toFloat(root.attrs.volume),
			clips: toInt(root.attrs.clips),
			queued: toInt(root.attrs.queued),
			position: toFloat(root.attrs.position),
			length: toFloat(root.attrs.length),
			output_delay: toInt(root.attrs.output_delay),
			apod: toInt(root.attrs.apod),
			input_fill: toFloat(root.attrs.input_fill),
			output_fill: toFloat(root.attrs.output_fill),
			process_speed: toFloat(root.attrs.process_speed),
			active_rate: toInt(root.attrs.active_rate),
			active_bits: toInt(root.attrs.active_bits),
			active_channels: toInt(root.attrs.active_channels),
			filter_junk: toInt(root.attrs.filter_junk),
			correction: toInt(root.attrs.correction),
			random: toInt(root.attrs.random),
			repeat: toInt(root.attrs.repeat),
		};
		for (const event of events) {
			if (event.kind === "start" && event.name === "metadata") {
				status.metadata = {
					uri: event.attrs.uri ?? "",
					mime: event.attrs.mime ?? "",
					artist: event.attrs.artist ?? "",
					album: event.attrs.album ?? "",
					albumartist: event.attrs.albumartist ?? "",
					song: event.attrs.song ?? "",
					genre: event.attrs.genre ?? "",
					date: event.attrs.date ?? "",
					track_id: event.attrs.track_id ?? "",
					samplerate: toInt(event.attrs.samplerate),
					bits: toInt(event.attrs.bits),
					channels: toInt(event.attrs.channels),
					float: toBool(event.attrs.float),
				};
			}
		}
		this.statusQueue.push(status);
		if (this.statusQueue.length > 5) this.statusQueue.shift();
		const callback = this.onStatus;
		if (callback !== undefined) {
			try {
				callback(status);
			} catch (err) {
				console.error(`[HQPlayer.control] status callback error:`, err);
			}
		}
		sendToRenderer({ type: "status", status });
	}

	// #region Typed commands
	public async getInfo(): Promise<HQPInfo> {
		const event = await this.commandEvent("GetInfo");
		return {
			name: event.attrs.name ?? "",
			product: event.attrs.product ?? "",
			version: event.attrs.version ?? "",
			platform: event.attrs.platform ?? "",
			engine: event.attrs.engine ?? "",
		};
	}

	public async getVolumeRange(): Promise<{ min: number; max: number }> {
		const event = await this.commandEvent("VolumeRange");
		return {
			min: Math.min(toFloat(event.attrs.min, -60), 0),
			max: Math.max(toFloat(event.attrs.max, 0), 1),
		};
	}

	public async getStatus(): Promise<HQPStatus> {
		if (!this.isConnected) await this.connect(this.host || "192.168.20.12", this.port || 4321);
		this.send("Status");
		const deadline = Date.now() + DEFAULT_TIMEOUT;
		while (Date.now() < deadline) {
			const pending = this.statusQueue.shift();
			if (pending !== undefined) return pending;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`Timeout waiting for <Status> from HQPlayer`);
	}

	public async play(): Promise<void> {
		if (!this.isConnected) await this.connect(this.host || "192.168.20.12", this.port || 4321);
		await this.commandEvent("Play", { last: "0" });
	}
	public async pause(): Promise<void> {
		if (!this.isConnected) await this.connect(this.host || "192.168.20.12", this.port || 4321);
		await this.commandEvent("Pause");
	}
	public async stop(): Promise<void> {
		if (!this.isConnected) await this.connect(this.host || "192.168.20.12", this.port || 4321);
		await this.commandEvent("Stop");
	}
	public async seek(position: number): Promise<void> {
		if (!this.isConnected) await this.connect(this.host || "192.168.20.12", this.port || 4321);
		await this.commandEvent("Seek", { position: String(Math.floor(position)) });
	}
	public async volume(valueDb: number): Promise<void> {
		if (!this.isConnected) await this.connect(this.host || "192.168.20.12", this.port || 4321);
		const value = Math.round(valueDb * 100) / 100;
		await this.commandEvent("Volume", { value: String(value) });
	}

	public async playlistClear(): Promise<void> {
		if (!this.isConnected) await this.connect(this.host || "192.168.20.12", this.port || 4321);
		await this.commandEvent("PlaylistClear");
	}

public async playlistAdd(uri: string, metadata: string, freewheel = 1): Promise<void> {
		if (!this.isConnected) await this.connect(this.host || "192.168.20.12", this.port || 4321);
		const metaChild = metadata ? `<metadata ${metadata}/>` : "";
		const payload = `<?xml version="1.0"?><PlaylistAdd uri="${escapeAttr(uri)}" queued="0" clear="0" start="0" freewheel="${freewheel}">${metaChild}</PlaylistAdd>`;
		await this.commandRaw("PlaylistAdd", payload);
	}

	// #endregion
}

// #region Local HTTP stream server
const isLoopbackHost = (host: string): boolean =>
	host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0" || host === "::" || host === "";

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
	claimed: boolean;
};

class StreamServer {
	private server?: Server;
	private port?: number;
	private active?: ActiveStream;
	private readonly control: HQPlayerControl;

	constructor(control: HQPlayerControl) {
		this.control = control;
	}

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
				this.port = typeof address === "object" && address !== null ? address.port : 0;
				resolve(this.port);
			});
		});
	}

	/** Stage a new stream and return the URL HQPlayer should fetch. */
	public async play(spec: StreamSpec, streamHost: string): Promise<string> {
		await this.ensure();
		this.clearStream();
		const path = `/s/${encodeURIComponent(spec.trackId)}-${randomUUID()}`;
		this.active = { path, url: "", spec, claimed: false };
		this.active.url = `http://${streamHost}:${this.port}${path}`;
		sendToRenderer({ type: "stream", kind: "start", trackId: spec.trackId, url: this.active.url });
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

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = (req.url ?? "").split("?")[0];
		const active = this.active;
		if (active === undefined || path !== active.path) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not Found");
			return;
		}
		if (req.method === "HEAD") {
			res.writeHead(200, this.headers(active.spec));
			res.end();
			return;
		}
		if (active.claimed) {
			res.writeHead(409, { "Content-Type": "text/plain" });
			res.end("Stream already claimed");
			return;
		}
		if (active.spec.manifestMimeType !== "application/vnd.tidal.bts") {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("Only TIDAL FLAC (application/vnd.tidal.bts) streams can be forwarded");
			sendToRenderer({ type: "stream", kind: "error", trackId: active.spec.trackId, error: "Unsupported manifest type" });
			return;
		}

		active.claimed = true;
		res.writeHead(200, this.headers(active.spec));
		try {
			const stream = await fetchMediaItemStream(active.spec as never);
			active.stream = stream;
			stream.on("error", (err) => {
				console.error(`[HQPlayer.stream] stream error:`, err);
				sendToRenderer({ type: "stream", kind: "error", trackId: active.spec.trackId, error: String((err as Error)?.message ?? err) });
				try {
					res.destroy(err);
				} catch {
					// response already closed
				}
			});
			res.on("close", () => {
				if (!res.writableEnded) {
					try {
						stream.destroy();
					} catch {
						// already destroyed
					}
				}
			});
			stream.on("end", () => sendToRenderer({ type: "stream", kind: "end", trackId: active.spec.trackId }));
			stream.pipe(res);
		} catch (err) {
			console.error(`[HQPlayer.stream] failed to start stream:`, err);
			sendToRenderer({ type: "stream", kind: "error", trackId: active.spec.trackId, error: String((err as Error)?.message ?? err) });
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "text/plain" });
			}
			res.end("Failed to fetch TIDAL stream");
		}
	}

	private headers(spec: StreamSpec): Record<string, string> {
		return {
			"Content-Type": spec.mime || "audio/flac",
			"Cache-Control": "no-store, no-cache, must-revalidate",
			Pragma: "no-cache",
			"Accept-Ranges": "none",
			"Connection": "close",
			"X-Accel-Buffering": "no",
		};
	}
}
// #endregion

// #region Discovery
const parseDiscoveryResponse = (data: Buffer, sender: string): HQDiscoveredHost | undefined => {
	for (const event of new HQPParser().feed(data.toString("utf8"))) {
		if (event.kind !== "start" || event.name !== "discover") continue;
		if (event.attrs.result !== "OK") return undefined;
		return {
			address: sender,
			name: event.attrs.name ?? "",
			version: event.attrs.version ?? "",
			port: CONTROL_PORT,
		};
	}
	return undefined;
};

const discoverySocket = (family: "udp4" | "udp6", onMessage: (msg: Buffer, rinfo: RemoteInfo) => void): DgramSocket | undefined => {
	const socket = createSocket(family);
	try {
		socket.on("error", (err) => console.warn(`[HQPlayer.discover] ${family} socket error:`, err.message));
		socket.on("message", onMessage);
		socket.bind({ port: 0, exclusive: true });
		return socket;
	} catch {
		return undefined;
	}
};

const discoverOnce = async (timeoutMs: number): Promise<HQDiscoveredHost[]> => {
	const hosts = new Map<string, HQDiscoveredHost>();
	const sockets: DgramSocket[] = [];
	let finished = false;

	const finish = (): void => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		for (const socket of sockets) {
			try {
				socket.close();
			} catch {
				// already closed
			}
		}
	};

	const timer = setTimeout(finish, Math.min(timeoutMs, 5000));

	const onMessage = (msg: Buffer, rinfo: RemoteInfo): void => {
		const host = parseDiscoveryResponse(msg, rinfo.address);
		if (host !== undefined) hosts.set(host.address, host);
	};

	const sendToGroup = (family: "udp4" | "udp6", group: string): void => {
		const socket = discoverySocket(family, onMessage);
		if (socket === undefined) return;
		sockets.push(socket);
		try {
			socket.send(DISCOVERY_PAYLOAD, CONTROL_PORT, group);
		} catch {
			// send failed, ignore
		}
	};

	sendToGroup("udp4", DISCOVERY_MULTICAST);
	sendToGroup("udp6", DISCOVERY_MULTICAST_V6);
	return [...hosts.values()];
};

/** Discover HQPlayer instances on the local network via the discovery multicast. */
export const discoverHQPlayers = (timeoutMs = 4000): Promise<HQDiscoveredHost[]> => discoverOnce(timeoutMs);



// #endregion

// #region Module state
const control = new HQPlayerControl();
const streamServer = new StreamServer(control);

let connectedInfo: HQPInfo | undefined;
let streamHostOverride: string | undefined;

control.onDisconnected = () => {
	streamServer.clearStream();
};

const withControl = async <T>(fn: () => Promise<T>): Promise<HQOk<T>> => {
	try {
		const value = await fn();
		return { ok: true, value };
	} catch (err) {
		console.error(`[HQPlayer.control]`, err);
		return { ok: false, error: String((err as Error)?.message ?? err) };
	}
};
// #endregion

// #region Native IPC API
export const connectHQPlayer = async (
	host: string | undefined,
	port: number | undefined,
	streamHost: string | undefined
): Promise<HQConnectResult> => {
	host = (host ?? "").trim();
	port = port ?? CONTROL_PORT;
	streamHostOverride = streamHost?.trim() ? streamHost.trim() : undefined;

	try {
		await control.connect(host, port);
		connectedInfo = await control.getInfo();
		return { ok: true, info: connectedInfo };
	} catch (err) {
		return { ok: false, error: String((err as Error)?.message ?? err) };
	}
};

export const disconnectHQPlayer = async (): Promise<HQOk> => {
	control.close();
	streamServer.clearStream();
	connectedInfo = undefined;
	return { ok: true, value: undefined };
};

export const isHQPlayerConnected = (): boolean => control.isConnected;

export const getHQPlayerInfo = async (): Promise<HQOk<{ info: HQPInfo }>> =>
	withControl(async () => ({ info: connectedInfo ?? (connectedInfo = await control.getInfo()) }));

export const getHQPlayerStatus = async (): Promise<HQOk<{ status: HQPStatus }>> =>
	withControl(async () => ({ status: await control.getStatus() }));

export const getHQVolumeRange = async (): Promise<HQOk<{ min: number; max: number }>> =>
	withControl(async () => ({ ...(await control.getVolumeRange()) }));

/** Send the current TIDAL track (decrypted + re-served locally) to HQPlayer. */
export const sendCurrentTrack = async (spec: StreamSpec | undefined, meta: TrackMeta | undefined): Promise<HQStreamResult> => {
	if (spec === undefined) return { ok: false, error: "No stream spec provided" };
	streamServer.clearStream();
	const useDirect = false; // Force proxy to compare
	try {
		const host =
			streamHostOverride !== undefined
				? streamHostOverride
				: isLoopbackHost(control.host)
					? "127.0.0.1"
					: getLanAddress();
		const url = useDirect ? spec.directUrl! : await streamServer.play(spec, host);
		console.log(`[HQPlayer] Mode: ${useDirect ? "DIRECT" : "PROXY"}, URL: ${url.substring(0, 100)}...`);

		const metaAttrs = formatAttrs({
			song: meta?.song,
			artist: meta?.artist,
			album: meta?.album,
			albumartist: meta?.albumartist,
			genre: meta?.genre,
			date: meta?.date,
			track_id: meta?.track_id ?? spec.trackId,
			mime: meta?.mime ?? spec.mime ?? "audio/flac",
			length: String(spec.duration),
		});
		try {
			await control.stop(); // Stop first - same as LMS
			await control.playlistClear();
			await control.playlistAdd(url, metaAttrs, 0);
		} catch (err) {
			console.error(`[HQPlayer] PlaylistAdd failed:`, err);
			throw err;
		}
		// Direct URL: HQPlayer fetches from TIDAL, minimal wait
		// Proxy: needs buffer time (4s)
		await new Promise((r) => setTimeout(r, useDirect ? 1000 : 4000));
		console.log(`[HQPlayer] About to send Play command...`);
		await control.play();
		console.log(`[HQPlayer] Play command sent successfully`);

		// Check status after a few seconds to see what's happening
		setTimeout(async () => {
			try {
				const status = await control.getStatus();
				console.log(`[HQPlayer] Status check: state=${status.state}, track=${status.track}, input_fill=${status.input_fill}, uri=${status.metadata?.uri?.substring(0, 60)}...`);
			} catch (e) {
				console.log(`[HQPlayer] Status check failed:`, e);
			}
		}, 5000);

		return { ok: true, url };
	} catch (err) {
		const message = String((err as Error)?.message ?? err);
		console.error(`[HQPlayer.sendCurrentTrack]`, err);
		return { ok: false, error: message };
	}
};

export const playHQPlayer = async (): Promise<HQOk> => {
	return withControl(() => control.play());
};

export const pauseHQPlayer = async (): Promise<HQOk> => {
	return withControl(() => control.pause());
};

export const stopHQPlayer = async (): Promise<HQOk> => {
	streamServer.clearStream();
	return withControl(() => control.stop());
};

export const seekHQPlayerTo = async (position: number): Promise<HQOk> => {
	return withControl(() => control.seek(position));
};

export const setHQVolume = async (valueDb: number): Promise<HQOk> => {
	return withControl(() => control.volume(valueDb));
};

/** Update native-only connection hints (pushed by applySettings / Settings UI). */
export const updateHQPlayerSettings = async (partial: { streamHost?: string } | undefined): Promise<HQOk> => {
	if (partial?.streamHost !== undefined) {
		streamHostOverride = partial.streamHost.trim() ? partial.streamHost.trim() : undefined;
	}
	return { ok: true, value: undefined };
};

/** Idempotent teardown of every native resource. */
export const dispose = async (): Promise<HQOk> => {
	control.close();
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