import Link from "next/link";
import { ArrowRight, FileCheck2, Fingerprint, GitBranch, ShieldCheck } from "lucide-react";
import demo from "@/data/demo-result.json";
import { formatUsdMinor } from "@/lib/format-money.mjs";

const stages = [
  { number: "01", name: "Promised", detail: "What an offer says" },
  { number: "02", name: "Posted", detail: "What reached the school account" },
  { number: "03", name: "Issued", detail: "What the school says it refunded" },
  { number: "04", name: "Observed", detail: "What appears in a bank record" },
];

export default function Home() {
  const { before, after, comparison } = demo.result;
  const newCharge = comparison.contributions.find((item) => item.factId === "extra-charge");
  const revisedGrant = comparison.contributions.find((item) => item.factId === "grant");
  if (!newCharge || !revisedGrant) throw new Error("Synthetic comparison is incomplete");

  return (
    <>
      <section className="home-hero">
        <div className="hero-copy">
          <span className="eyebrow"><span className="signal-dot" /> Financial aid, made traceable</span>
          <h1>Trace financial aid from promise to deposit<span className="hero-period">.</span></h1>
          <p className="hero-lead">
            When an amount changes, Scryer shows which reviewed records changed it.
            Follow school charges, aid postings, refund notices, and bank observations
            without turning a guess into a fact.
          </p>
          <div className="hero-actions">
            <Link href="/demo" className="button button-primary">
              Try the synthetic case <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <a href="#how-it-works" className="button button-ghost">See how it works</a>
          </div>
          <p className="hero-footnote">No account, upload, or personal data needed for the sample.</p>
        </div>
        <div className="hero-preview" aria-label="Preview of the fictional case explanation">
          <div className="preview-topline">
            <span className="preview-symbol">✦</span>
            <span>CASE SNAPSHOT · SYNTHETIC</span>
            <span className="preview-live">REVIEWED</span>
          </div>
          <div className="preview-question">Why did the school-account surplus change?</div>
          <div className="preview-values">
            <div><span>Earlier view</span><strong>{formatUsdMinor(before.amountMinor)}</strong></div>
            <div className="preview-arrow" aria-hidden="true">→</div>
            <div><span>After new records</span><strong>{formatUsdMinor(after.amountMinor)}</strong></div>
          </div>
          <div className="preview-divider" />
          <div className="preview-row"><span><span className="mini-line" />Revised grant</span><strong>{formatUsdMinor(revisedGrant.deltaMinor)}</strong></div>
          <div className="preview-row"><span><span className="mini-line" />New school charge</span><strong>{formatUsdMinor(newCharge.deltaMinor)}</strong></div>
          <div className="preview-total"><span>Explained change</span><strong>{formatUsdMinor(comparison.deltaMinor)}</strong></div>
          <p className="preview-note">Inspect the approved facts behind every amount in the sample case.</p>
        </div>
      </section>

      <section className="proof-strip" aria-label="Scryer principles">
        <div><FileCheck2 size={19} aria-hidden="true" /><span>Review before calculation</span></div>
        <div><Fingerprint size={19} aria-hidden="true" /><span>Source-linked explanations</span></div>
        <div><GitBranch size={19} aria-hidden="true" /><span>History you can revisit</span></div>
        <div><ShieldCheck size={19} aria-hidden="true" /><span>Unknown stays unknown</span></div>
      </section>

      <section className="section-shell" id="how-it-works">
        <div className="section-heading">
          <span className="eyebrow">THE MONEY TRAIL</span>
          <h2>Four different claims. One clear trail.</h2>
          <p>An offer, a school posting, an issued refund, and a bank credit do not prove
            the same thing. Scryer keeps their evidence separate.</p>
        </div>
        <div className="stage-grid">
          {stages.map((stage) => (
            <div className="stage-card" key={stage.number}>
              <span className="stage-number">{stage.number}</span>
              <h3>{stage.name}</h3>
              <p>{stage.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section-shell trust-section">
        <div>
          <span className="eyebrow">BUILT FOR TRUST</span>
          <h2>Answers that show their work.</h2>
        </div>
        <div className="trust-copy">
          <p>Imported text starts as a proposal. Only reviewed evidence affects a
            calculation. When a record is missing or a match is ambiguous, the answer says so.</p>
          <p>The open-source engine uses exact cents and keeps a reproducible receipt for
            each result. The sample shows how that works with fictional records.</p>
          <Link href="/demo" className="text-link">Explore the reviewed evidence <ArrowRight size={18} aria-hidden="true" /></Link>
        </div>
      </section>

      <section className="closing-cta">
        <div><span className="eyebrow">SEE THE EXPLANATION</span><h2>Start with a case you can inspect.</h2></div>
        <Link href="/demo" className="button button-primary">Open the synthetic case <ArrowRight size={18} aria-hidden="true" /></Link>
      </section>
    </>
  );
}
