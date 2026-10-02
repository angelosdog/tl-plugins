import { ReactiveStore } from "@luna/core";
import {
  LunaButtonSetting,
  LunaNumberSetting,
  LunaSelectItem,
  LunaSelectSetting,
  LunaSetting,
  LunaSettings,
  LunaSwitchSetting,
  LunaTextSetting,
} from "@luna/ui";
import type { AudioQuality } from "neptune-types/tidal";

import React from "react";

import { ensureConnected, sendNow } from ".";
import * as hqp from "./index.native";

export type HQPSettings = {
  enabled: boolean;
  host: string;
  streamHost: string;
  upnpDeviceUrl: string;
  quality: AudioQuality;
  muteTidal: boolean;
};

const qualityOptions: AudioQuality[] = [
  "HI_RES_LOSSLESS",
  "HI_RES",
  "LOSSLESS",
  "HIGH",
  "LOW",
];

export const settings = await ReactiveStore.getPluginStorage<HQPSettings>(
  "hqplayer",
  {
    enabled: true,
    host: "localhost",
    streamHost: "",
    upnpDeviceUrl: "http://localhost:8019",
    quality: "HI_RES_LOSSLESS" satisfies AudioQuality,
    muteTidal: false,
  } satisfies HQPSettings,
);

/** Apply a settings patch: persist to storage and mirror native-only hints. */
export const applySettings = (
  patch: Partial<HQPSettings>,
): Partial<HQPSettings> => {
  Object.assign(settings, patch);
  if (patch.streamHost !== undefined)
    void hqp.updateHQPlayerSettings({ streamHost: patch.streamHost });
  if (patch.upnpDeviceUrl !== undefined)
    void hqp.updateHQPlayerSettings({ upnpDeviceUrl: patch.upnpDeviceUrl });
  return patch;
};

export const Settings = () => {
  // Single mutation path so every edit is persisted and mirrored to the native module.
  const set = <K extends keyof HQPSettings>(
    key: K,
    value: HQPSettings[K],
  ): HQPSettings[K] => {
    applySettings({ [key]: value } as Partial<HQPSettings>);
    return value;
  };

  const [enabled, setEnabled] = React.useState(settings.enabled);
  const [host, setHost] = React.useState(settings.host);
  const [streamHost, setStreamHost] = React.useState(settings.streamHost);
  const [upnpDeviceUrl, setUpnpDeviceUrl] = React.useState(
    settings.upnpDeviceUrl,
  );
  const [quality, setQuality] = React.useState(settings.quality);
  const [muteTidal, setMuteTidal] = React.useState(settings.muteTidal);

  return (
    <>
      <LunaSettings title="HQPlayer Settings">
        <LunaSwitchSetting
          title="Enabled"
          desc="Forward TIDAL playback to HQPlayer"
          checked={enabled}
          onChange={(_, checked) => setEnabled(set("enabled", checked))}
        />
        <LunaTextSetting
          title="HQPlayer host"
          desc="IP address or hostname of the HQPlayer machine"
          value={host}
          onChange={(e) => setHost(set("host", e.target.value))}
        />
        <LunaTextSetting
          title="UPnP device URL"
          desc="HQPlayer's UPnP base URL (e.g. http://localhost:8019)"
          value={upnpDeviceUrl}
          onChange={(e) =>
            setUpnpDeviceUrl(set("upnpDeviceUrl", e.target.value))
          }
        />
      </LunaSettings>
      <LunaSettings title="Streaming">
        <LunaSelectSetting
          title="Quality"
          desc="TIDAL audio quality to request for HQPlayer"
          value={quality}
          onChange={(e) =>
            setQuality(set("quality", e.target.value as AudioQuality))
          }
        >
          {qualityOptions.map((q) => (
            <LunaSelectItem key={q} value={q}>
              {q}
            </LunaSelectItem>
          ))}
        </LunaSelectSetting>
        <LunaSwitchSetting
          title="Mute TIDAL output"
          desc="Keep Tidal's own audio muted while it is playing"
          checked={muteTidal}
          onChange={(_, checked) => setMuteTidal(set("muteTidal", checked))}
        />
      </LunaSettings>
      <div
        style={{
          color: "#757575",
          paddingLeft: "16px",
          fontFamily: "monospace",
          fontSize: "0.75rem",
          marginTop: "8px",
        }}
      >
        Requires native permissions for network (net/http/dgram) & system (os).
        First use may prompt.
      </div>
    </>
  );
};
