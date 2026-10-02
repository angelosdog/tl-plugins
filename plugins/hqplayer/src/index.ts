import { Tracer, type LunaUnload } from "@luna/core";
import { ipcRenderer, MediaItem, observe, PlayState, redux, safeInterval } from "@luna/lib";
import type { AudioQuality } from "neptune-types/tidal";

import { HQPlayerEventChannel, type HQPlayerEvent, type StreamSpec, type TrackMeta } from "./index.native";
import * as hqp from "./index.native";
import { applySettings, settings } from "./settings";

export { applySettings, Settings, settings } from "./settings";

export const { trace } = Tracer("[HQPlayer]");
export const unloads = new Set<LunaUnload>();

let connected = false;
let connecting = false;
let sendingTrack = false;
// Normalized by the native side (min <= 0, max >= 1) before it reaches us.
let hqVolumeRange = { min: -60, max: 0 };
let lastVolume: number | undefined;

// Volume mapping: TIDAL `volume` (0..maxVolume) -> HQPlayer dB.
const volumeToDb = (volume: number): number => {
	const { min, max } = hqVolumeRange;
	const ratio = Math.min(Math.max(volume, 0), settings.maxVolume) / Math.max(settings.maxVolume, 1);
	return Math.round((min + (max - min) * ratio) * 100) / 100;
};

const setSyncVolume = (volume: number): void => {
	if (volume === lastVolume) return;
	lastVolume = volume;
	void hqp.setHQVolume(volumeToDb(volume));
};

export const ensureConnected = async (): Promise<boolean> => {
	if (connected) return true;
	if (connecting) return connected;
	connecting = true;
	try {
		const result = await hqp.connectHQPlayer(settings.host, settings.port, settings.streamHost);
		if (!result.ok) throw new Error(result.error);
		connected = true;
		const range = await hqp.getHQVolumeRange();
		if (range.ok) hqVolumeRange = range.value;
		else trace.msg.err(range.error);
		trace.log(`Connected to ${settings.host}:${settings.port}`);
		return true;
	} catch (err) {
		trace.warn(`Connection failed: ${String((err as Error)?.message ?? err)}`);
		connected = false;
		return false;
	} finally {
		connecting = false;
	}
};

// Keep the connection alive while the plugin is enabled.
const reconnectLoop = safeInterval(unloads, () => {
	if (settings.enabled && !connected && !connecting) void ensureConnected();
}, 10_000);

// Mirror what the native module pushes back to us.
ipcRenderer.on(unloads, HQPlayerEventChannel, (_event: unknown, data: HQPlayerEvent) => {
	switch (data.type) {
		case "connection":
			connected = data.connected;
			if (data.connected) trace.log("Connection established");
			else trace.warn("Connection lost");
			break;
		case "stream":
			if (data.kind === "error") trace.warn(`Stream ${String(data.error)}`);
			break;
	}
});

// Best-effort <metadata> child for PlayNextURI (guarded accessors).
const toTrackMeta = async (item: MediaItem): Promise<TrackMeta> => {
	const tidalItem = item.tidalItem;
	trace.log("tidalItem keys:", Object.keys(tidalItem).join(", "));
	trace.log("album keys:", tidalItem.album ? Object.keys(tidalItem.album).join(", ") : "no album");
	const coverUrl = (tidalItem as unknown as { coverUrl?: string })?.coverUrl 
		?? (tidalItem.album as unknown as { coverUrl?: string })?.coverUrl
		?? (tidalItem.album as unknown as { cover?: string })?.cover
		?? (tidalItem as unknown as { cover?: string })?.cover
		?? "";
	trace.log("Cover URL:", coverUrl);
	return {
		song: await item.title().catch(() => tidalItem.title ?? ""),
		artist: tidalItem.artists?.map((a) => a.name).join(", ") ?? "",
		album: tidalItem.album?.title ?? "",
		albumartist: "",
		genre: "",
		date: tidalItem.releaseDate ?? "",
		track_id: String(item.id),
		mime: "audio/flac",
		cover: coverUrl,
	};
};

export const sendCurrentTrack = async (item: MediaItem): Promise<boolean> => {
	trace.log("sendCurrentTrack called, enabled:", settings.enabled);
	if (!settings.enabled) {
		trace.warn("Plugin not enabled, skipping");
		return false;
	}
	const connected = await ensureConnected();
	trace.log("ensureConnected result:", connected);
	if (!connected) return false;

	sendingTrack = true;
	setTimeout(() => (sendingTrack = false), 5000);

	const quality = settings.quality as AudioQuality;
	const playback = await item.playbackInfo(quality);
	if (playback === undefined) {
		trace.warn("No playback info for this track, skipping.");
		sendingTrack = false;
		return false;
	}
	const manifestKeys = playback.manifest ? Object.keys(playback.manifest) : [];
	trace.log("TIDAL manifest keys:", manifestKeys.join(", "));
	const directUrl = playback.manifest.urls && playback.manifest.urls.length > 0
		? String(playback.manifest.urls[0])
		: undefined;
	trace.log("Direct URL available:", !!directUrl);
	if (playback.manifestMimeType !== "application/vnd.tidal.bts") {
		trace.warn("DASH stream not supported, skipping (spatial audio?).");
		sendingTrack = false;
		return false;
	}

	const spec: StreamSpec = {
		trackId: String(playback.trackId),
		duration: item.duration ?? 0,
		mime: playback.manifest.mimeType || "audio/flac",
		manifestMimeType: "application/vnd.tidal.bts",
		manifest: playback.manifest,
		directUrl: directUrl,
	};

	const result = await hqp.sendCurrentTrack(spec, await toTrackMeta(item));
	if (!result.ok) {
		trace.msg.err(`Failed to send track: ${result.error}`);
		sendingTrack = false;
		return false;
	}
	sendingTrack = false;
	if (settings.syncVolume) setSyncVolume(redux.store.getState().playbackControls.volume);
	trace.log(`Sent track ${spec.trackId} -> ${result.url}`);
	return true;
};

export const sendNow = async (): Promise<void> => {
	trace.log("sendNow called");
	const item = await MediaItem.fromPlaybackContext();
	trace.log("MediaItem from context:", item ? "found" : "undefined");
	if (item) {
		trace.log("Calling sendCurrentTrack");
		await sendCurrentTrack(item);
	} else {
		trace.log("No item from playback context");
	}
};

// Send the new track whenever TIDAL transitions to another track.
MediaItem.onMediaTransition(unloads, (item) => void sendCurrentTrack(item));

// Mirror TIDAL transport to HQPlayer while the plugin is enabled.
PlayState.onState(unloads, (state) => {
	if (!settings.enabled) return;
	// Skip if we're currently sending a track (we handle play ourselves)
	if (sendingTrack) return;
	switch (state) {
		case "PLAYING": {
			void hqp.playHQPlayer();
			break;
		}
		case "PAUSED": {
			if (!settings.muteTidal) void hqp.pauseHQPlayer();
			break;
		}
		case "IDLE":
		default: {
			void hqp.stopHQPlayer();
			break;
		}
	}
});

// Volume sync through the reducer.
redux.intercept("playbackControls/SET_VOLUME", unloads, ({ volume }) => {
	if (settings.enabled && settings.syncVolume) setSyncVolume(volume);
});
// Keep TIDAL muted while the option is enabled (re-mute any unmute).
redux.intercept("playbackControls/SET_MUTE", unloads, (muted) => {
	if (settings.enabled && settings.muteTidal && !muted) redux.actions["playbackControls/SET_MUTE"](true);
});
// Extra guard: silence the media element directly when minding mute.
observe<HTMLVideoElement>(unloads, "video", (video) => {
	if (settings.muteTidal && !video.muted) video.muted = true;
});

// Tear down native resources when the plugin is disabled/reloaded.
unloads.add(() => {
	applySettings({ enabled: false });
	void hqp.disconnectHQPlayer();
});