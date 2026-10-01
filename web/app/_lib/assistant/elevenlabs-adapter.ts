/**
 * `ElevenLabsAdapter`'ı `@elevenlabs/react` `useConversation` kancasına bağlar (ADR-0028 §1). Yalnızca istemci
 * bileşenlerinden çağrılır ve bir `<ConversationProvider>` içinde olmalıdır (SDK kuralı). Deneme oturumunda
 * (`mock: true`) bunun yerine `MockAdapter` kullanılır.
 */
import { useEffect, useState } from "react";
import { useConversation, type HookOptions } from "@elevenlabs/react";
import { ElevenLabsAdapter, type ElevenLabsSessionOptions } from "./adapter";

// Derleme anı denetimi: bizim seçenek tipimiz SDK'nın `startSession` seçeneklerine atanabilir olmalı.
type AssertAssignable<T extends HookOptions> = T;
export type CheckedSessionOptions = AssertAssignable<ElevenLabsSessionOptions>;

export function useElevenLabsAdapter(): ElevenLabsAdapter {
  const [adapter] = useState(() => new ElevenLabsAdapter());
  const conversation = useConversation({
    onConnect: ({ conversationId }) => adapter.handleConnect(conversationId),
    onDisconnect: () => adapter.handleStatus("disconnected"),
    onStatusChange: ({ status }) => adapter.handleStatus(status),
    onModeChange: ({ mode }) => adapter.handleMode(mode),
    onMessage: ({ role, message }) => adapter.handleMessage(role, message),
    onError: (message) => adapter.handleError(message),
  });
  const { startSession, endSession, sendUserMessage, sendContextualUpdate, getInputVolume, getOutputVolume } = conversation;
  useEffect(() => {
    adapter.bind({ startSession, endSession, sendUserMessage, sendContextualUpdate, getInputVolume, getOutputVolume });
  }, [adapter, startSession, endSession, sendUserMessage, sendContextualUpdate, getInputVolume, getOutputVolume]);
  return adapter;
}
