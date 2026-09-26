/**
 * Geriye dönük uyumluluk: Meta webhook'unun kanonik yolu `api/webhooks/meta`.
 * Eski abonelik adresleri bu yola kayıtlı olabileceği için aynı handler'lar
 * (GET doğrulama + POST alım) buradan da sunulur; `[id]` segmenti kullanılmaz.
 */
export { GET, POST } from "../../../webhooks/meta/route";
// Segment yapılandırması statik okunur; yeniden dışa aktarım yerine burada da tanımlanır.
export const maxDuration = 60;
