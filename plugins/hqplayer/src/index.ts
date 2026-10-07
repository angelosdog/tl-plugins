import { Tracer, type LunaUnload } from "@luna/core";
import {
  ipcRenderer,
  MediaItem,
  observe,
  PlayState,
  redux,
  safeInterval,
} from "@luna/lib";
import type { AudioQuality } from "neptune-types/tidal";

import {
  HQPlayerEventChannel,
  type HQPlayerEvent,
  type StreamSpec,
  type TrackMeta,
} from "./index.native";
import * as hqp from "./index.native";
import { applySettings, settings } from "./settings";

export { applySettings, Settings, settings } from "./settings";

export const { trace } = Tracer("[HQPlayer]");
export const unloads = new Set<LunaUnload>();

let connected = false;
let connecting = false;
let sendingTrack = false;

export const ensureConnected = async (): Promise<boolean> => {
  if (connected) return true;
  if (connecting) return connected;
  connecting = true;
  try {
    const result = await hqp.connectHQPlayer(
      settings.host,
      settings.upnpDeviceUrl,
    );
    if (!result.ok) throw new Error(result.error);
    connected = true;
    trace.log(`Connected to ${settings.host}`);
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
const reconnectLoop = safeInterval(
  unloads,
  () => {
    if (settings.enabled && !connected && !connecting) void ensureConnected();
  },
  10_000,
);

// Mirror what the native module pushes back to us.
ipcRenderer.on(
  unloads,
  HQPlayerEventChannel,
  (_event: unknown, data: HQPlayerEvent) => {
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
  },
);

// Best-effort <metadata> child for PlayNextURI (guarded accessors).
const toTrackMeta = async (item: MediaItem): Promise<TrackMeta> => {
  const tidalItem = item.tidalItem;
  return {
    song: await item.title().catch(() => tidalItem.title ?? ""),
    artist: tidalItem.artists?.map((a) => a.name).join(", ") ?? "",
    album: tidalItem.album?.title ?? "",
    albumartist: "",
    genre: "",
    date: tidalItem.releaseDate ?? "",
    track_id: String(item.id),
    mime: "audio/flac",
  };
};

export const sendCurrentTrack = async (item: MediaItem): Promise<boolean> => {
  if (!settings.enabled) {
    trace.warn("Plugin not enabled, skipping");
    return false;
  }
  const connected = await ensureConnected();
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
  };

  const result = await hqp.sendCurrentTrack(spec, await toTrackMeta(item));
  if (!result.ok) {
    trace.msg.err(`Failed to send track: ${result.error}`);
    sendingTrack = false;
    return false;
  }
  sendingTrack = false;
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

// Track the currently playing track to avoid re-sending on seeks
let currentTrackId: string | undefined;

// Send the new track whenever TIDAL transitions to another track.
// Note: MediaTransition also fires on seeks, so we check if it's actually a new track.
MediaItem.onMediaTransition(unloads, (item) => {
	const itemId = item?.id?.toString();
	if (itemId && itemId === currentTrackId) {
		trace.log(`MediaTransition fired but same track (${itemId}) - ignoring (likely a seek)`);
		return;
	}
	currentTrackId = itemId;
	void sendCurrentTrack(item);
});

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
    case "PAUSED":
    case "NOT_PLAYING": {
      void hqp.pauseHQPlayer();
      break;
    }
    case "STALLED": {
      // Ignore STALLED - it's just TIDAL's internal buffering state.
      break;
    }
    case "IDLE":
    default: {
      void hqp.stopHQPlayer();
      break;
    }
  }
});


// Keep TIDAL muted while the option is enabled (re-mute any unmute).
redux.intercept("playbackControls/SET_MUTE", unloads, (muted) => {
  if (settings.enabled && settings.muteTidal && !muted)
    redux.actions["playbackControls/SET_MUTE"](true);
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
