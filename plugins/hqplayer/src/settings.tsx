import { ReactiveStore } from "@luna/core";
import { LunaButtonSetting, LunaNumberSetting, LunaSelectItem, LunaSelectSetting, LunaSetting, LunaSettings, LunaSwitchSetting, LunaTextSetting } from "@luna/ui";
import type { AudioQuality } from "neptune-types/tidal";

import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { green, grey, red } from "@mui/material/colors";
import React from "react";

import { ensureConnected, sendNow } from ".";
import type { HQDiscoveredHost } from "./index.native";
import * as hqp from "./index.native";

export type HQPSettings = {
	enabled: boolean;
	host: string;
	port: number;
	streamHost: string;
	quality: AudioQuality;
	syncVolume: boolean;
	muteTidal: boolean;
	maxVolume: number;
};

const qualityOptions: AudioQuality[] = ["HI_RES_LOSSLESS", "HI_RES", "LOSSLESS", "HIGH", "LOW"];
const stateNames: Record<number, string> = {
	0: "Playing",
	1: "Paused",
	2: "Stopped",
	3: "Loading",
	4: "Error",
	5: "Offline",
};

export const settings = await ReactiveStore.getPluginStorage<HQPSettings>("hqplayer", {
	enabled: true,
	host: "192.168.20.12",
	port: 4321,
	streamHost: "",
	quality: "HI_RES_LOSSLESS" satisfies AudioQuality,
	syncVolume: true,
	muteTidal: false,
	maxVolume: 100,
} satisfies HQPSettings);

/** Apply a settings patch: persist to storage and mirror native-only hints. */
export const applySettings = (patch: Partial<HQPSettings>): Partial<HQPSettings> => {
	Object.assign(settings, patch);
	if (patch.streamHost !== undefined) void hqp.updateHQPlayerSettings({ streamHost: patch.streamHost });
	return patch;
};

export const Settings = () => {
	// Single mutation path so every edit is persisted and mirrored to the native module.
	const set = <K extends keyof HQPSettings>(key: K, value: HQPSettings[K]): HQPSettings[K] => {
		applySettings({ [key]: value } as Partial<HQPSettings>);
		return value;
	};

	const [enabled, setEnabled] = React.useState(settings.enabled);
	const [host, setHost] = React.useState(settings.host);
	const [port, setPort] = React.useState(settings.port);
	const [streamHost, setStreamHost] = React.useState(settings.streamHost);
	const [quality, setQuality] = React.useState(settings.quality);
	const [syncVolume, setSyncVolume] = React.useState(settings.syncVolume);
	const [muteTidal, setMuteTidal] = React.useState(settings.muteTidal);
	const [maxVolume, setMaxVolume] = React.useState(settings.maxVolume);

	const [isConnected, setIsConnected] = React.useState<boolean | undefined>(undefined);
	const [hqInfo, setHqInfo] = React.useState<string>("");
	const [hqState, setHqState] = React.useState<string>("");
	const [hqError, setHqError] = React.useState<string>("");
	const [hosts, setHosts] = React.useState<HQDiscoveredHost[]>([]);

	const infoLoaded = React.useRef(false);

	React.useEffect(() => {
		// Connection & status poll (drives the badge in this card).
		const poll = async (): Promise<void> => {
			const connected = await hqp.isHQPlayerConnected();
			setIsConnected(connected);
			setHqError("");
			if (!connected) {
				setHqState("");
				return;
			}
			// Device info is static for a connection, so only fetch it once.
			if (!infoLoaded.current) {
				const infoResult = await hqp.getHQPlayerInfo();
				if (infoResult.ok) {
					const info = infoResult.value.info;
					setHqInfo(`${info.name} ${info.version} (${info.platform})`);
					infoLoaded.current = true;
				} else {
					setHqError(infoResult.error);
				}
			}
			const statusResult = await hqp.getHQPlayerStatus();
			if (!statusResult.ok) {
				setHqError(statusResult.error);
				return;
			}
			const status = statusResult.value.status;
			setHqState(
				`${stateNames[status.state] ?? status.state} ${status.metadata?.song ? `- ${status.metadata.song}` : ""} ${status.position}:${status.length} @ ${status.active_rate}kHz/${status.active_bits}bit`,
			);
		};
		void poll();
		const timer = setInterval(() => void poll(), 2500);
		return () => clearInterval(timer);
	}, []);

	return (
		<>
			<LunaSettings title="TIDAL > HQPlayer">
				<LunaSetting title="Connection" desc="HQPlayer control interface (TCP)" />
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
				<LunaNumberSetting
					title="Control port"
					desc="HQPlayer control protocol port"
					value={port}
					onNumber={(value) => setPort(set("port", value))}
				/>
				<LunaTextSetting
					title="Stream host (optional)"
					desc="LAN address HQPlayer can reach TIDAL on. Leave empty to auto-detect"
					value={streamHost}
					onChange={(e) => setStreamHost(set("streamHost", e.target.value))}
				/>
				<LunaSetting title="Control: Native TCP (port 4321)" desc="Uses HQPlayer's native TCP control API" />
				<LunaButtonSetting
					title="Reconnect"
					desc="Force a reconnect to the control interface"
					onClick={() => void ensureConnected()}
				>
					Reconnect
				</LunaButtonSetting>
			</LunaSettings>
			<Stack direction="row" spacing={1} sx={{ alignItems: "center", paddingLeft: 2, marginTop: 0.5 }}>
				<Typography variant="caption" sx={{ color: green[300], fontFamily: "monospace" }}>
					{hqState || hqInfo || (isConnected === false ? "Disconnected" : "Connecting...")}
				</Typography>
				<Typography variant="caption" sx={{ color: red[300], fontFamily: "monospace" }}>
					{hqError}
				</Typography>
			</Stack>
			<LunaSettings title="Discovery" desc="Find HQPlayer instances on the local network">
				<LunaButtonSetting
					title="Discover (native)"
					desc="Send HQPlayer's custom multicast discovery"
					onClick={() => void hqp.discoverHQPlayers(4000).then(setHosts)}
				>
					Native
				</LunaButtonSetting>
				{hosts.length > 0 && (
					<List dense disablePadding>
						{hosts.map((h) => (
							<ListItemButton
								key={h.address}
								sx={{ paddingLeft: 2, gap: 1 }}
								onClick={() => {
									applySettings({ host: h.address, port: h.port });
									setHost(h.address);
									setPort(h.port);
								}}
							>
								<Typography variant="body2" sx={{ color: grey[300] }}>
									{h.name} ({h.version})
								</Typography>
								<Typography variant="caption" sx={{ color: grey[500], marginLeft: "auto", paddingRight: 2 }}>
									{h.address}:{h.port}
								</Typography>
							</ListItemButton>
						))}
					</List>
				)}
			</LunaSettings>
			<LunaSettings title="Streaming">
				<LunaSelectSetting
					title="Quality"
					desc="TIDAL audio quality to request for HQPlayer"
					value={quality}
					onChange={(e) => setQuality(set("quality", e.target.value as AudioQuality))}
				>
					{qualityOptions.map((q) => (
						<LunaSelectItem key={q} value={q}>
							{q}
						</LunaSelectItem>
					))}
				</LunaSelectSetting>
				<LunaSwitchSetting
					title="Sync volume"
					desc="Mirror the TIDAL volume slider to HQPlayer"
					checked={syncVolume}
					onChange={(_, checked) => setSyncVolume(set("syncVolume", checked))}
				/>
				<LunaSwitchSetting
					title="Mute TIDAL output"
					desc="Keep Tidal's own audio muted while it is playing"
					checked={muteTidal}
					onChange={(_, checked) => setMuteTidal(set("muteTidal", checked))}
				/>
				<LunaNumberSetting
					title="Max volume"
					desc="Maximum TIDAL volume (0-100) mapped to 0dB output"
					value={maxVolume}
					onNumber={(value) => setMaxVolume(set("maxVolume", value))}
				/>
				<LunaButtonSetting
					title="Send current track"
					desc="Push the currently loaded track to HQPlayer"
					onClick={() => { console.log("[HQPlayer] Send now clicked"); void sendNow(); }}
				>
					Send now
				</LunaButtonSetting>
			</LunaSettings>
			<Typography variant="caption" sx={{ color: grey[600], paddingLeft: 2, fontFamily: "monospace" }}>
				Requires native permissions for network (net/http/dgram) & system (os). First use may prompt.
			</Typography>
		</>
	);
};