// Hand-typed subset of the GA Realtime wire protocol (verified 2026-08).
// We deliberately type only the ~15 events the bridge uses.
import type { Usage } from '../telemetry.js';

// ---------- client → server ----------

export interface TurnDetection {
  type: 'server_vad';
  threshold: number;
  prefix_padding_ms: number;
  silence_duration_ms: number;
  create_response: boolean;
  interrupt_response: boolean;
}

export interface AudioInputConfig {
  format: { type: 'audio/pcm'; rate: number };
  transcription?: { model: string; language?: string } | null;
  turn_detection: TurnDetection | null;
}

export interface SessionConfig {
  type: 'realtime';
  model?: string;
  output_modalities: ['text'];
  instructions: string;
  tools: unknown[];
  tool_choice: 'auto' | 'none' | 'required';
  max_output_tokens?: number;
  audio?: { input: AudioInputConfig };
}

export type ConversationItem =
  | { type: 'message'; role: 'user' | 'system'; content: Array<{ type: 'input_text'; text: string }> }
  | { type: 'function_call_output'; call_id: string; output: string };

export type ClientEvent =
  | { type: 'session.update'; session: SessionConfig }
  | { type: 'input_audio_buffer.append'; audio: string }
  | { type: 'input_audio_buffer.commit' }
  | { type: 'conversation.item.create'; item: ConversationItem }
  | { type: 'response.create'; response?: Record<string, unknown> };

// ---------- server → client ----------

export interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

export interface FunctionCallArgumentsDone extends ServerEvent {
  type: 'response.function_call_arguments.done';
  call_id: string;
  name: string;
  arguments: string;
}

export interface OutputTextDelta extends ServerEvent {
  type: 'response.output_text.delta';
  delta: string;
}

export interface TranscriptionCompleted extends ServerEvent {
  type: 'conversation.item.input_audio_transcription.completed';
  transcript: string;
}

export interface ResponseDone extends ServerEvent {
  type: 'response.done';
  response: {
    status?: string;
    output?: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>;
    usage?: RawUsage;
  };
}

export interface RealtimeErrorEvent extends ServerEvent {
  type: 'error';
  error: { type?: string; code?: string; message?: string };
}

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

export function usageFromRaw(raw: RawUsage | undefined): Partial<Usage> {
  if (!raw) return {};
  const inDetails = raw.input_token_details;
  const cachedDetails = inDetails?.cached_tokens_details;
  const cachedText = cachedDetails?.text_tokens ?? inDetails?.cached_tokens ?? 0;
  return {
    inputTextTokens: inDetails?.text_tokens ?? raw.input_tokens ?? 0,
    inputAudioTokens: inDetails?.audio_tokens ?? 0,
    cachedTextTokens: cachedText,
    cachedAudioTokens: cachedDetails?.audio_tokens ?? 0,
    outputTextTokens: raw.output_token_details?.text_tokens ?? raw.output_tokens ?? 0,
  };
}
