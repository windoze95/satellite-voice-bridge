# satellite-voice-bridge

Low-latency voice control for Home Assistant: a [FutureProofHomes Satellite1](https://futureproofhomes.net/) does on-device wake-word detection and streams command audio over the LAN to this bridge, which streams it to the OpenAI Realtime API with **function calling enabled and no audio output** — there is no speaker and no TTS. The model proposes a single `control_device` call, a local policy engine authorizes it, and the bridge executes it against Home Assistant. The response to "turn on the kitchen lights" is the kitchen lights turning on.

```
Satellite1 (wake word, mics, XMOS)
      │ PCM16 audio over ESPHome native API
      ▼
voicebridge (this repo, always-on Mac)
      │ audio ──────────────► OpenAI Realtime (text + function-call output only)
      │ ◄────────── control_device(action, domain, target, area, value, light)
      ▼
policy engine (GREEN/YELLOW/RED, local, deterministic)
      ▼
Home Assistant ──► the actual device
```

## Status

- ✅ Text path: `voicebridge text "turn on the kitchen lights"` — full loop, real light.
- ✅ Audio path: `voicebridge say command.wav` — real audio through server VAD.
- ✅ Policy engine, HA registry-driven house context, latency telemetry, `doctor`.
- ✅ Satellite1 audio source over the encrypted ESPHome native API, including
  wake lifecycle, streaming 16→24 kHz resampling, reconnects, and clean shutdown.
- ✅ Capability-aware light control: brightness, RGB color, color temperature,
  effects, transitions, and flashing, with duplicate groups removed locally.

## Quickstart

Requires Node ≥ 22 and (for the audio path) `ffmpeg` on PATH.

```
git clone https://github.com/windoze95/satellite-voice-bridge.git
cd satellite-voice-bridge
npm ci
cp .env.example .env               # fill in OPENAI_API_KEY, HA_URL, HA_TOKEN
cp voicebridge.example.yaml voicebridge.yaml
npm run build

node dist/index.js doctor          # every dependency checked, ✓/✗
node dist/index.js text "turn on the kitchen lights" --dry-run
node dist/index.js text "party time in the office" --dry-run
node dist/index.js text "make the office purple at 60 percent" --dry-run
node dist/index.js text "set the office to warm white over five seconds" --dry-run
node dist/index.js text "turn on the kitchen lights"
node dist/index.js say command.wav
node dist/index.js run             # 24/7 service mode
```

Secrets live only in `.env` (gitignored). Your house layout (`voicebridge.yaml`,
runtime caches under `var/`) is gitignored too.

- **HA token**: mint a long-lived access token from an **admin** HA user
  (registry-change subscriptions require admin).
- **OpenAI key**: use a dedicated project with a monthly budget cap. With no
  audio output, a spoken command costs well under $0.001.

## Satellite1 connection and ownership

Adopt the Satellite1 normally through Home Assistant's ESPHome integration and
leave that config entry enabled. Configure its host and HA config-entry id in
`voicebridge.yaml`; the bridge asks HA for the ESPHome Noise key at runtime, so
the key is never copied into YAML:

```yaml
satellites:
  satellite1-aabbcc:
    host: 192.168.20.135
    port: 6053
    ha_entry_id: 01EXAMPLECONFIGENTRYID
    area: Kitchen # optional; used as the command's default area
```

ESPHome permits only one Voice Assistant audio subscriber. At cutover, disable
only the Satellite's `assist_satellite.*` entity in Home Assistant, then reload
that ESPHome config entry before starting `voicebridge run`. Do not disable or
delete the ESPHome device: its sensors, controls, firmware updates, and ordinary
HA connection remain available. Re-enable the Assist Satellite entity whenever
you want Home Assistant to own the microphone again.

## How commands are authorized

The model can only ever propose `control_device(action, domain, target, area, value, light)`.
The bridge — not the model — decides what runs:

- **GREEN** (lights, fans, switches, media, scenes, scripts): resolved against
  the HA registry and executed immediately.
- **YELLOW** (locks, covers, climate): executed only for entities you listed in
  `yellow_allow`. Collective commands ("all locks") are never allowed here.
- **RED** (alarm panel, anything unknown): always refused, always logged.

Target resolution is deterministic: the spoken target/area are matched against
HA's area, device, and entity registries (names + aliases). Low-confidence or
ambiguous matches are refused rather than guessed, and the action → HA-service
mapping is a fixed allowlist, so arbitrary service calls are impossible by
construction.

Light options are a closed, typed object: absolute or relative brightness percentage, RGB color,
Kelvin temperature, effect, transition time, and short/long flash. The bridge
checks those options against the selected lights' live Home Assistant
capabilities, removes duplicate group/member targets, skips unavailable or
incompatible bulbs, and validates named effects before making the fixed
`light.turn_on` or `light.turn_off` call. Open-ended mood requests such as
`party time` are interpreted by the model using the area's advertised effects
and color controls; the bridge validates the chosen appearance rather than
hard-coding a phrase-specific preset or guessing an unrelated scene.

## Latency methodology

Every command logs one JSONL record (`var/commands.jsonl`) with timestamps:

| T | Meaning |
|---|---------|
| T0 | wake / command start |
| T1 | Realtime session usable |
| T2 | first audio chunk sent |
| T3 | end of speech (server VAD) |
| T4 | function-call arguments complete |
| T5 | policy decision |
| T6 | HA service call sent |
| T7 | HA acknowledged |
| T8 | device state change confirmed (causally, via HA context id) |

Headline metric: **speech→action = T8 − T3**. Console per command:

```
✔ "turn on the kitchen lights" → light.kitchen_ceiling on | speech→action 742 ms (model 418 · policy 1 · ha 89 · confirm 234) | $0.0007
```

`session_setup = T1 − T0` quantifies the cost of fresh-per-utterance sessions;
`session.mode: warm` in `voicebridge.yaml` keeps a session open instead
(auto-recycled before OpenAI's 60-minute session cap). Benchmark both from the
JSONL and pick.

## Deployment (launchd on an always-on Mac)

See [deploy/](deploy/): a LaunchDaemon plist (`com.lothal.voicebridge`),
`install.sh` (build + `launchctl bootstrap`), `deploy.sh` (rsync from a dev
machine, excluding secrets), and a `newsyslog` rotation config. The `.env` is
copied to the target by hand — never through git. On first deployment, create
the target directory and place `.env` plus `voicebridge.yaml` there before
running `deploy.sh`; the installer locks both files to mode `600`.

## Development

```
npm run typecheck
npm test          # unit + integration against local mock OpenAI/HA servers;
                  # no network, no secrets — same as CI
```

Live end-to-end runs (real model, real house) are deliberately not automated.

## A note on scope

This bridge coexists with a conventional Home Assistant Assist pipeline; it
adds no HA entities and defines no HA actions. If its commands later become
part of an action ontology elsewhere (e.g. Lothal's `config/actions.yaml`),
those entries must be added there deliberately — nothing here does it for you.

## License

MIT
