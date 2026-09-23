# satellite-voice-bridge

Low-latency voice control for Home Assistant: a [FutureProofHomes Satellite1](https://futureproofhomes.net/) does on-device wake-word detection and streams command audio over the LAN to this bridge, which streams it to the OpenAI Realtime API with **function calling enabled and no audio output** — there is no speaker and no TTS. The model decides what it heard, a local policy engine authorizes it, and the bridge executes it against Home Assistant. The response to "turn on the kitchen lights" is the kitchen lights turning on.

```
Satellite1 (wake word, mics, XMOS)
      │ PCM16 audio over ESPHome native API
      ▼
voicebridge (this repo, always-on Mac)
      │ audio ──────────────► OpenAI Realtime (text + function-call output only)
      │ ◄─── control_device(…, tone) · dismiss(reason, tone) · delegate(request)
      │                                             │
      │                              delegate ──────► gpt-6-luna (Responses API)
      │                                             │  plans the hard ones
      ▼                                             ▼
policy engine (GREEN/YELLOW/RED, local, deterministic)
      ▼
Home Assistant ──► the actual device
```

The model must pick exactly one of three tools on every utterance, so intent is
decided once, explicitly, by the only participant that heard the audio — and the
bridge never has to infer "was that a command?" from a vocabulary list.

## Status

- ✅ Text path: `voicebridge text "turn on the kitchen lights"` — full loop, real light.
- ✅ Audio path: `voicebridge say command.wav` — real audio through server VAD.
- ✅ Policy engine, HA registry-driven house context, latency telemetry, `doctor`.
- ✅ Satellite1 audio source over the encrypted ESPHome native API, including
  wake lifecycle, streaming 16→24 kHz resampling, reconnects, and clean shutdown.
- ✅ Capability-aware light control: brightness, RGB color, color temperature,
  effects, transitions, and flashing, with duplicate groups removed locally.
- ✅ Explicit intent: `dismiss` for overheard conversation, `delegate` for
  requests that need real thought, `tone` on every call.
- ✅ Local mood composer: the model names a mood, the bridge decides which bulb
  does what.
- ✅ Follow-up window: keep talking for a few seconds with no second wake word.
- ✅ Satellite reconnect: a device reboot or Wi-Fi blip re-claims the audio
  subscription instead of leaving the bridge connected but deaf.

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
node dist/index.js text "hit the lights" --dry-run
node dist/index.js text "set the mood in the office" --dry-run
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

The wake word is chosen on the device, not here — the bridge handles whatever
utterance follows it. `firmware/` builds stock Satellite1 firmware plus an
overlay adding the **"computer"** wake word and a Home Assistant switch per
wake word; see `firmware/README.md`.

## Intent, tone, and taking a hint

The session runs with `tool_choice: required` and three tools, so every utterance
produces one logged decision:

| tool | meaning |
|---|---|
| `control_device(…)` | change something in the house |
| `dismiss(reason, tone)` | not a command — people were talking, or it was a question, or a prohibition |
| `delegate(request, why)` | real request, needs more thought than a sub-second model should spend |

`dismiss` is what makes a wake word firing on ordinary conversation harmless. It
replaced a ~150-word vocabulary the bridge used to check the transcript against,
which was simultaneously too generous (any sentence containing "turn", "make" or
"light" passed) and too narrow (a verb like "hit" was invisible). One transcript
check survives, and it can only ever say no: a prohibition ("don't turn on the
lights") or an informational question is refused even if the model proposed an
action.

`tone` is required on every call and comes from the **audio**, not the words:
`neutral · intimate · playful · urgent · tired · annoyed · excited · hushed`.
It is the only thing in the system that can tell a murmur from a shout, and it
feeds the mood composer below — so the same words, said two ways, land on two
different brightnesses. Every command logs it, so the behavior is tunable from
`var/commands.jsonl` rather than from guesswork.

## Who decides which light does what

The model names a **mood** and an area; the bridge renders it. `light.mood` is a
closed set — `intimate · romantic · cozy · focus · clinical · party · cinema ·
wake · wind_down · normal` — and `src/policy/mood.ts` turns one into concrete
per-light settings locally, in no measurable time and no tokens:

1. flatten HA light groups to leaves and drop unavailable ones
2. classify each light **key** (ceilings, mains), **accent** (colour-capable
   character lighting) or **utility** (closets, cabinets) from its name and
   capabilities
3. apply the mood's recipe per role, scaled and warmed by `tone`
4. drop anything a given bulb cannot do, clamp Kelvin to its real range
5. group lights that end up identical into one service call

Asking a low-latency voice model to invent an RGB triple per bulb meant holding
the room's inventory, each bulb's capabilities and a colour scheme at once — and
when it got that wrong the only recourse was to reject the call and ask the same
model again. Recipes are overridable per-mood under `moods:` in
`voicebridge.yaml`, so taste is config rather than code. Explicit requests
("purple at 60 percent") still use the ordinary `light.*` fields.

## Delegation

When the fast model calls `delegate`, or when policy refuses a command for a
near-miss reason (`no_confident_match`, `ambiguous`, `no_devices_in_scope`,
`unknown_area`), the bridge asks a stronger model — `gpt-6-luna` on the Responses
API with `reasoning.effort: none` — to plan the change, then runs the result
through **the same policy engine**. Delegating buys a better plan, never wider
authority.

Measured at roughly **2.2–3.0 s** for a multi-light plan, against ~0.5 s for the
realtime model alone, so it is deliberately off the common path. The escalation
case *replaces* a round trip rather than adding one: the old behaviour re-asked
the model that had just failed. Records carry `delegated`, and `t4a`/`t4b`
bracket the handoff.

Delegate token counts are logged, but `cost_usd` covers the realtime model only —
there is no verified price for `gpt-6-luna` to put in the table, and a guessed
one would silently corrupt every cost figure.

## Follow-ups

`conversation.follow_up_seconds` (default 6) keeps the microphone open after a
command so the next utterance needs no wake word:

```
"computer, turn on the office lights"  → lights on
"dim it a bit"                         → dimmed      (no wake word)
(silence)                              → mic closes
```

The mechanism is the Satellite's own state machine, and it is unforgiving enough
to be worth stating precisely (`voice_assistant.cpp`, transcribed into
`src/audio/satellite-manager.ts` and modelled in
`test/mocks/fake-satellite-firmware.ts`):

- `STT_VAD_END` moves it to `STOP_MICROPHONE` → `AWAITING_RESPONSE`. With no
  speaker there is no TTS event to move it on again.
- `RUN_END` acts only from `STREAMING_MICROPHONE` (stop the mic, go idle) or
  `AWAITING_RESPONSE` (go idle). From `STOP_MICROPHONE`/`STOPPING_MICROPHONE` it
  matches nothing at all.
- `STT_VAD_START`, `STT_END`, `INTENT_START`, `INTENT_END` are triggers only —
  safe to send mid-chain, which is what lets the device show progress per turn.

So a chain withholds `STT_VAD_END` (that is the event that would close the mic)
and ends on `RUN_END` while the device is still streaming. Because a fast command
can put `STT_VAD_END` and `RUN_END` in the same breath — where `RUN_END` would do
nothing and strand the device mid-"thinking" — every run also sends a second
`RUN_END` 300 ms later. It is free when the first worked.

The chain shares one Realtime conversation, which is what lets "dim it a bit"
resolve against what just happened; that history is pruned once the chain ends so
it cannot colour the next person who says the wake word. A follow-up the model
`dismiss`es closes the window immediately — continuing to listen is exactly the
wrong answer to "that wasn't for me" — and `max_follow_ups` (default 3) caps a
chain so a loud room cannot hold the microphone open.

This holds a live microphone open in the room for the window. Set
`follow_up_seconds: 0` to turn it off. It needs `session.mode: warm` to be worth
having; `doctor` warns if you have one without the other.

## Flourishes (the one thing the model never sees)

Everything spoken is model-interpreted except phrases listed under `flourishes:`
in `voicebridge.yaml`. Those are matched locally against the transcript and get
a fixed short-lived look — hold one appearance, or walk a palette around the
room — after which the lights are restored to exactly what they were.

The point is reliability, not shortcutting: the model refuses or moralizes at
some perfectly harmless wording, and a refusal emits no function call to
intercept. Matching the transcript sidesteps that, and costs no model round trip
at all. Targeting still goes through the policy engine below, so a flourish can
only touch lights an ordinary spoken command could have touched.

State is captured before the flourish lands and restored after; a later command
on the same lights cancels the pending restore rather than undoing itself.

## How commands are authorized

The model can only ever propose `control_device(action, domain, target, area, value, light, tone)`.
The bridge — not the model — decides what runs. This is true of a delegated plan
and a rendered mood exactly as it is of a spoken command:

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
| T4a/T4b | delegation to the strong model started / returned (when used) |
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
