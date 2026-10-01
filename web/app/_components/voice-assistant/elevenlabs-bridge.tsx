"use client";
import { useEffect } from "react";
import { ConversationProvider } from "@elevenlabs/react";
import type { ElevenLabsAdapter } from "../../_lib/assistant/adapter";
import { useElevenLabsAdapter } from "../../_lib/assistant/elevenlabs-adapter";

/**
 * ElevenLabs SDK köprüsü. `next/dynamic` ile yalnızca gerçek (deneme olmayan) bir oturum başlarken yüklenir; böylece
 * SDK her sayfanın paketine girmez. Bağdaştırıcı hazır olunca (`bind` yapıldıktan sonra) `onReady` çağrılır.
 */
function Bridge({ onReady }: { onReady: (adapter: ElevenLabsAdapter) => void }) {
  const adapter = useElevenLabsAdapter();
  // `useElevenLabsAdapter` içindeki `bind` etkisi bu etkiden önce çalışır (aynı bileşen ağacında önce tanımlı).
  useEffect(() => {
    onReady(adapter);
  }, [adapter, onReady]);
  return null;
}

export default function ElevenLabsBridge({ onReady }: { onReady: (adapter: ElevenLabsAdapter) => void }) {
  return (
    <ConversationProvider>
      <Bridge onReady={onReady} />
    </ConversationProvider>
  );
}
