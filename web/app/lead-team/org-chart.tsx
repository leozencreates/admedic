/**
 * Lead takımının hiyerarşi şeması (ADR-0029, görünüm ADR-0030): direktör üstte, yedi takım lideri ortak çizgiden iner,
 * her liderin altında uzmanları durur. Direktörün yanında kararın bir insanın onayına bağlı olduğu yazar.
 * Ajan durumu renkli noktayla birlikte ekran okuyucu metniyle de verilir.
 */
export interface OrgTeam {
  key: string;
  title: string;
  specialists: { key: string; title: string }[];
}

type AgentState = "done" | "failed" | "idle";

const STATE_TEXT: Record<AgentState, string> = {
  done: "rapor verdi",
  failed: "rapor üretemedi",
  idle: "rapor bekleniyor",
};

export function OrgChart({
  teams,
  statusOf,
  hasRun,
  pendingProposals,
}: {
  teams: OrgTeam[];
  /** Ajan anahtarı ("director", "lead:<takım>", "<takım>:<uzman>") → son çalıştırmadaki rapor durumu. */
  statusOf: (agentKey: string) => string | undefined;
  /** Hiç çalıştırma yoksa durum noktaları gösterilmez. */
  hasRun: boolean;
  pendingProposals: number;
}) {
  const state = (key: string): AgentState => {
    const status = statusOf(key);
    return status === "COMPLETED" ? "done" : status === "FAILED" ? "failed" : "idle";
  };
  const dot = (key: string) =>
    hasRun ? (
      <>
        <span aria-hidden="true" className="kc-dot" data-tone={state(key)} />
        <span className="sr-only">({STATE_TEXT[state(key)]})</span>
      </>
    ) : null;

  return (
    <div className="kc-org">
      <div className="kc-org__top">
        <div className="kc-org__director">
          <strong>Direktör</strong>
          <span>Takım liderlerinin raporlarını tartar, nihai kararı verir</span>
        </div>
        <p className="kc-org__human">
          <strong className="block">Sizin onayınız</strong>
          {pendingProposals > 0
            ? `${pendingProposals} öneri kararınızı bekliyor.`
            : "Direktörün önerileri onayınız olmadan uygulanmaz."}
        </p>
      </div>
      <div className="kc-org__stem" aria-hidden="true" />
      <ul className="kc-org__teams" aria-label="Takımlar">
        {teams.map((team) => (
          <li key={team.key} className="kc-org__team">
            <div className="kc-org__lead">
              <strong>{team.title}</strong>
              <span className="inline-flex items-center gap-1.5">
                {dot(`lead:${team.key}`)}
                Takım lideri
              </span>
            </div>
            <ul className="kc-org__specialists" aria-label={`${team.title} takımının uzmanları`}>
              {team.specialists.map((s) => (
                <li key={s.key}>
                  {dot(s.key)}
                  <span className="min-w-0 break-words">{s.title}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
