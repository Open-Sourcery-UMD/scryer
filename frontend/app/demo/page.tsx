import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleHelp,
  FileText,
  GitCommitHorizontal,
  Info,
  LockKeyhole,
} from "lucide-react";
import demo from "@/data/demo-result.json";
import { formatUsdMinor } from "@/lib/format-money.mjs";

const factNames: Record<string, string> = {
  "base-charge": "Original school charge",
  "extra-charge": "New school charge",
  grant: "Revised grant",
  "other-credit": "Other posted aid",
};

const roleNames: Record<string, string> = {
  school_charge: "School charge",
  school_credit: "School credit",
};

export default function DemoPage() {
  const { before, after, comparison, receipt, refundObservation, bankObservation } = demo.result;
  const newCharge = comparison.contributions.find((item) => item.factId === "extra-charge");
  const revisedGrant = comparison.contributions.find((item) => item.factId === "grant");
  if (!newCharge || !revisedGrant) throw new Error("Synthetic comparison is incomplete");

  return (
    <div className="demo-shell">
      <Link href="/" className="back-link"><ArrowLeft size={16} aria-hidden="true" /> Back to Scryer</Link>
      <div className="sample-banner">
        <Info size={17} aria-hidden="true" />
        <span><strong>Synthetic case.</strong> All records and account names below are fictional. No account or upload is involved.</span>
      </div>

      <header className="demo-header">
        <div>
          <span className="eyebrow">FALL 2026 · SAMPLE CASE</span>
          <h1>A changed expectation, fully explained.</h1>
          <p>New reviewed records changed the school-account surplus. Follow the exact difference,
            then inspect the evidence behind it.</p>
        </div>
        <div className="demo-header-tag"><Check size={16} aria-hidden="true" /> Calculated from reviewed evidence</div>
      </header>

      <section className="result-section" aria-labelledby="result-heading">
        <div className="section-title-row">
          <div><span className="eyebrow">THE RESULT</span><h2 id="result-heading">What changed?</h2></div>
          <span className="small-status">Supported by sample records</span>
        </div>
        <div className="result-grid">
          <div className="result-card">
            <span>Earlier school-account surplus</span>
            <strong>{formatUsdMinor(before.amountMinor)}</strong>
            <small>Before the revised grant and new charge</small>
          </div>
          <div className="result-card result-card-current">
            <span>After new records</span>
            <strong>{formatUsdMinor(after.amountMinor)}</strong>
            <small>At the selected reviewed history</small>
          </div>
          <div className="result-card result-card-delta">
            <span>Explained change</span>
            <strong>{formatUsdMinor(comparison.deltaMinor)}</strong>
            <small>Exactly accounted for by two changes</small>
          </div>
        </div>
        <p className="result-caption">This is a calculation from supplied fictional records, not a determination of what anyone is owed.</p>
      </section>

      <section className="explain-section" aria-labelledby="explain-heading">
        <div className="section-title-row">
          <div><span className="eyebrow">CHANGE ATTRIBUTION</span><h2 id="explain-heading">Why did the surplus change?</h2></div>
          <span className="equation-pill">{formatUsdMinor(revisedGrant.deltaMinor)} + {formatUsdMinor(newCharge.deltaMinor)} = {formatUsdMinor(comparison.deltaMinor)}</span>
        </div>
        <div className="explain-grid">
          <article className="explain-card">
            <span className="change-icon"><GitCommitHorizontal size={21} aria-hidden="true" /></span>
            <div>
              <span className="card-kicker">REVIEWED CORRECTION</span>
              <h3>Revised grant</h3>
              <p>The approved grant changed from {formatUsdMinor(revisedGrant.beforeMinor)} to {formatUsdMinor(revisedGrant.afterMinor)}.</p>
              <a href="#fact-grant">Inspect source and approval <ArrowRight size={15} aria-hidden="true" /></a>
            </div>
            <strong>{formatUsdMinor(revisedGrant.deltaMinor)}</strong>
          </article>
          <article className="explain-card">
            <span className="change-icon charge-icon"><FileText size={21} aria-hidden="true" /></span>
            <div>
              <span className="card-kicker">NEW REVIEWED FACT</span>
              <h3>New school charge</h3>
              <p>A reviewed charge lowers the calculated surplus by {formatUsdMinor(newCharge.deltaMinor.slice(1))}.</p>
              <a href="#fact-extra-charge">Inspect source and approval <ArrowRight size={15} aria-hidden="true" /></a>
            </div>
            <strong>{formatUsdMinor(newCharge.deltaMinor)}</strong>
          </article>
        </div>
      </section>

      <section className="trail-section" aria-labelledby="trail-heading">
        <div className="section-title-row">
          <div><span className="eyebrow">EVIDENCE STAGES</span><h2 id="trail-heading">What does the money trail show?</h2></div>
        </div>
        <div className="trail-list">
          <div className="trail-item">
            <span className="trail-dot trail-dot-muted"><CircleHelp size={18} aria-hidden="true" /></span>
            <div><span className="trail-label">Offer and pending aid</span><h3>Not established in this sample</h3>
              <p>The sample starts with reviewed school-account entries. It does not infer an offer or pending disbursement from those entries.</p></div>
            <span className="trail-status unknown">Unknown</span>
          </div>
          <div className="trail-item">
            <span className="trail-dot"><Check size={18} aria-hidden="true" /></span>
            <div><span className="trail-label">School account</span><h3>Credits and charges reviewed</h3>
              <p>The engine calculates a {formatUsdMinor(after.amountMinor)} surplus from approved school-account facts at this history.</p></div>
            <span className="trail-status">Reviewed</span>
          </div>
          <div className="trail-item">
            <span className="trail-dot"><FileText size={18} aria-hidden="true" /></span>
            <div><span className="trail-label">Refund notice</span><h3>Issued refund</h3>
              <p>A fictional refund notice says {formatUsdMinor(refundObservation.currentAmountMinor)} was issued to the student.</p>
              <a className="trail-link" href="#observation-refund">Inspect refund evidence <ArrowRight size={14} aria-hidden="true" /></a></div>
            <span className="trail-status">Source observed</span>
          </div>
          <div className="trail-item">
            <span className="trail-dot"><FileText size={18} aria-hidden="true" /></span>
            <div><span className="trail-label">Bank record</span><h3>Observed bank credit</h3>
              <p>A fictional bank record shows a {formatUsdMinor(bankObservation.currentAmountMinor)} credit. Its relationship to the issued refund is not a confirmed match.</p>
              <a className="trail-link" href="#observation-bank">Inspect bank evidence <ArrowRight size={14} aria-hidden="true" /></a></div>
            <span className="trail-status">Source observed</span>
          </div>
        </div>
      </section>

      <section className="inspector-section" aria-labelledby="inspector-heading">
        <div className="section-title-row">
          <div><span className="eyebrow">AUDIT THE ANSWER</span><h2 id="inspector-heading">Source and calculation inspector</h2></div>
          <span className="receipt-badge"><LockKeyhole size={15} aria-hidden="true" /> Reproducible receipt</span>
        </div>
        <p className="inspector-intro">The school-account calculation uses approved facts below. Open a row to inspect its source and review record. Refund and bank observations have separate evidence because they are not inputs to that calculation.</p>
        <div className="fact-list">
          {receipt.facts.map((fact) => (
            <details className="fact-row" id={"fact-" + fact.factId} key={fact.factId} open={Boolean(fact.correctionEventId)}>
              <summary>
                <span className="fact-main"><span className="fact-symbol">{fact.role === "school_credit" ? "+" : "−"}</span>
                  <span><strong>{factNames[fact.factId] ?? fact.factId}</strong><small>{roleNames[fact.role] ?? fact.role} · approved evidence</small></span></span>
                <span className="fact-amount">{formatUsdMinor(fact.contributionMinor)}</span>
              </summary>
              <div className="fact-details">
                {fact.correctionEventId && <>
                  <div><span>Original source</span><strong>{fact.originalSourceRef.kind === "artifact" ? "Artifact" : fact.originalSourceRef.kind} · {fact.originalSourceRef.artifactId} · {fact.originalSourceRef.location}</strong></div>
                  <div><span>Original approval</span><strong>{fact.approvalReviewId}</strong></div>
                  <div><span>Original reviewed amount</span><strong>{formatUsdMinor(fact.originalAmountMinor)}</strong></div>
                </>}
                <div><span>{fact.correctionEventId ? "Revised source" : "Source location"}</span><strong>{fact.sourceRef.kind === "artifact" ? "Artifact" : fact.sourceRef.kind} · {fact.sourceRef.artifactId} · {fact.sourceRef.location}</strong></div>
                <div><span>{fact.correctionEventId ? "Correction approval" : "Approval record"}</span><strong>{fact.correctionReviewId ?? fact.approvalReviewId}</strong></div>
                <div><span>Current reviewed amount</span><strong>{formatUsdMinor(fact.currentAmountMinor)}</strong></div>
                {fact.correctionEventId && <div><span>Correction event</span><strong>{fact.correctionEventId}</strong></div>}
              </div>
            </details>
          ))}
        </div>
        <div className="observation-grid" aria-label="Separate refund and bank evidence">
          <article className="observation-card" id="observation-refund">
            <span className="card-kicker">REFUND NOTICE · SEPARATE OBSERVATION</span>
            <h3>Issued refund</h3>
            <p>{formatUsdMinor(refundObservation.currentAmountMinor)} appears in the fictional refund notice.</p>
            <div className="fact-details">
              <div><span>Source location</span><strong>{refundObservation.currentSourceRef.kind === "artifact" ? "Artifact" : refundObservation.currentSourceRef.kind} · {refundObservation.currentSourceRef.artifactId} · {refundObservation.currentSourceRef.location}</strong></div>
              <div><span>Approval record</span><strong>{refundObservation.approvalReviewId}</strong></div>
            </div>
          </article>
          <article className="observation-card" id="observation-bank">
            <span className="card-kicker">BANK RECORD · SEPARATE OBSERVATION</span>
            <h3>Observed bank credit</h3>
            <p>{formatUsdMinor(bankObservation.currentAmountMinor)} appears in the fictional bank record. No refund match is established.</p>
            <div className="fact-details">
              <div><span>Source location</span><strong>{bankObservation.currentSourceRef.kind === "artifact" ? "Artifact" : bankObservation.currentSourceRef.kind} · {bankObservation.currentSourceRef.artifactId} · {bankObservation.currentSourceRef.location}</strong></div>
              <div><span>Approval record</span><strong>{bankObservation.approvalReviewId}</strong></div>
            </div>
          </article>
        </div>
        <div className="receipt-note">
          <div><strong>Calculation receipt</strong><p>Engine {receipt.engineVersion} · rule {receipt.ruleVersion}</p></div>
          <code>{receipt.digest}</code>
        </div>
      </section>

      <aside className="limits-panel" aria-label="What this result cannot establish">
        <div><CircleHelp size={20} aria-hidden="true" /><h2>What this result cannot establish</h2></div>
        <ul>
          <li>Not an eligibility or entitlement decision.</li>
          <li>The fictional source files are not authenticated as school or bank originals.</li>
          <li>The supplied records may be incomplete.</li>
          <li>An equal bank credit is not proof that it is the same refund.</li>
        </ul>
      </aside>
      <div className="demo-end">
        <p>Want to see the design and code behind the explanation?</p>
        <a href="https://github.com/Open-Sourcery-UMD/scryer" target="_blank" rel="noreferrer" className="button button-ghost">
          Explore the open-source project <ArrowRight size={17} aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
