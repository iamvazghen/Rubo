/**
 * Future channel extension points:
 *
 * 1. Implement a channel plugin that satisfies `ChannelPlugin<TConfig, TAccount>`.
 * 2. Normalize inbound messages into the channel's own inbound message type.
 * 3. Reuse `resolveRoute()` + `runAgentForMessage()` without changing gateway orchestration.
 * 4. Register the plugin in gateway bootstrap next to Telegram.
 *
 * This keeps Layer 1 channel transport isolated from Rubo agent execution.
 */
export const GATEWAY_EXTENSION_POINTS = [
  'ChannelPlugin lifecycle (start/stop/status)',
  'inbound message normalization',
  'Outbound delivery adapter',
  'Route/session metadata integration',
] as const;

