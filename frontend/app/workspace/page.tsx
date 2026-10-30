"use client";

import Link from "next/link";
import { ArrowLeft, FileSearch, Info, LockKeyhole, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatUsdMinor } from "@/lib/format-money.mjs";

type Candidate = {
  sourceLocation: string;
  effectiveDate: string | null;
  direction: "credit" | "debit" | "unresolved";
  amountMinor: string | null;
  warningCodes: readonly string[];
  rawFields: readonly string[];
};
type PreviewCandidate = Candidate & { rawTruncated: boolean };
type Detection = { outcome: "SUPPORTED_CSV" | "MANUAL_REQUIRED" | "UNSUPPORTED_INPUT"; reasonCode: string };
type Batch = { sourceBytes: Uint8Array; artifact: { sha256: string }; candidates: readonly Candidate[] };
type BrowserImport = {
  detectFile: (file: File, options: { signal: AbortSignal }) => Promise<Detection>;
  extractBankFile: (file: File, metadata: { accountRefId: string; observedAt: string },
    mapping: { kind: "signed"; dateColumn: string; amountColumn: string; mappingVersion: string } |
      { kind: "split"; dateColumn: string; creditColumn: string; debitColumn: string; mappingVersion: string },
    options: { signal: AbortSignal }) => Promise<Batch>;
};
type Preview = { fileName: string; sha256: string; candidates: readonly PreviewCandidate[] };

const warningText: Record<string, string> = {
  DEBIT_NOT_SUPPORTED: "Debit is outside current bank-credit support.",
  INVALID_DATE: "Date is not a valid YYYY-MM-DD value.",
  INVALID_AMOUNT: "Amount could not be read as exact US dollars and cents.",
  MISSING_AMOUNT: "Amount is missing.",
  ZERO_AMOUNT: "Zero is not a bank credit.",
};
const errorText: Record<string, string> = {
  INPUT_TOO_LARGE: "The file exceeds the 20 MiB preview limit.",
  INVALID_CSV: "This file is not a supported bank CSV.",
  MISSING_HEADER: "The named date or amount column was not found. Check the CSV header.",
  INVALID_MAPPING: "Enter two different column names from the CSV header.",
  WORKER_FAILURE: "The local parser could not start. No entries were saved.",
  TIMED_OUT: "The local parser timed out. No entries were saved.",
};

async function browserImport(): Promise<BrowserImport> {
  const asset = "/headless/import/browser.js";
  return await import(/* webpackIgnore: true */ asset) as BrowserImport;
}

function messageFor(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : "";
  return errorText[code] ?? "The file could not be previewed. No entries were saved.";
}

export default function WorkspacePage() {
  const [file, setFile] = useState<File | null>(null);
  const [dateColumn, setDateColumn] = useState("Date");
  const [amountColumn, setAmountColumn] = useState("Amount");
  const [amountLayout, setAmountLayout] = useState<"signed" | "split">("signed");
  const [creditColumn, setCreditColumn] = useState("Credit");
  const [debitColumn, setDebitColumn] = useState("Debit");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => () => request.current?.abort(), []);

  function clearPreview(nextFile: File | null) {
    request.current?.abort();
    generation.current++;
    setBusy(false);
    setPreview(null);
    setPageIndex(0);
    setNotice("");
    setFile(nextFile);
  }

  async function runPreview() {
    if (!file || busy) return;
    const current = ++generation.current;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setPreview(null);
    setNotice("");
    try {
      const importer = await browserImport();
      if (controller.signal.aborted) return;
      const detection = await importer.detectFile(file, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (detection.outcome === "MANUAL_REQUIRED") {
        setNotice("PDF layout is unverified. This file was not parsed or saved.");
        return;
      }
      if (detection.outcome !== "SUPPORTED_CSV") {
        setNotice(errorText[detection.reasonCode] ?? "This format is not supported for preview. Nothing was saved.");
        return;
      }
      const observedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const mapping = amountLayout === "signed" ?
        { kind: "signed" as const, dateColumn, amountColumn, mappingVersion: "workspace-1" } :
        { kind: "split" as const, dateColumn, creditColumn, debitColumn, mappingVersion: "workspace-1" };
      const batch = await importer.extractBankFile(file,
        { accountRefId: "bank-local-preview", observedAt },
        mapping,
        { signal: controller.signal });
      if (controller.signal.aborted || generation.current !== current) {
        batch.sourceBytes.fill(0);
        return;
      }
      const next = { fileName: file.name, sha256: batch.artifact.sha256,
        candidates: batch.candidates.map((candidate) => ({ ...candidate, warningCodes: [...candidate.warningCodes],
          rawTruncated: candidate.rawFields.length > 8 || candidate.rawFields.some((field) => field.length > 200),
          rawFields: candidate.rawFields.slice(0, 8).map((field) => field.slice(0, 200)),
        })) };
      batch.sourceBytes.fill(0);
      setPageIndex(0);
      setPreview(next);
    } catch (error) {
      if (!controller.signal.aborted && generation.current === current) setNotice(messageFor(error));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  return (
    <div className="workspace-shell">
      <Link href="/" className="back-link"><ArrowLeft size={16} aria-hidden="true" /> Back to Scryer</Link>
      <div className="workspace-privacy"><LockKeyhole size={18} aria-hidden="true" /> Local preview · no account or upload</div>
      <p className="workspace-development">Development build: use synthetic test files only.</p>
      <header className="workspace-header">
        <span className="eyebrow">PRIVATE WORKSPACE</span>
        <h1>Preview your records on this device.</h1>
        <p>Inspect proposed bank entries and source positions. This preview is unreviewed: no entry affects a calculation or case.</p>
        <span className="workspace-status">Unreviewed preview</span>
      </header>

      <section className="workspace-panel" aria-labelledby="preview-form-heading">
        <div className="workspace-panel-title"><FileSearch size={22} aria-hidden="true" /><div>
          <span className="eyebrow">STEP 01 · SOURCE</span><h2 id="preview-form-heading">Choose a bank CSV</h2>
        </div></div>
        <p>Generic CSV only, up to 20 MiB. Dates must use YYYY-MM-DD. Enter the exact header names and amount layout from your file.</p>
        <form onSubmit={(event) => { event.preventDefault(); void runPreview(); }}>
          <fieldset className="workspace-layout"><legend>Amount layout</legend>
            <label><input type="radio" name="amount-layout" checked={amountLayout === "signed"} onChange={() => { setAmountLayout("signed"); clearPreview(file); }} /> Signed amount column</label>
            <label><input type="radio" name="amount-layout" checked={amountLayout === "split"} onChange={() => { setAmountLayout("split"); clearPreview(file); }} /> Separate credit and debit columns</label>
          </fieldset>
          <div className="workspace-fields">
            <label>Bank CSV file
              <input type="file" accept=".csv,text/csv,application/pdf" onChange={(event) => clearPreview(event.target.files?.[0] ?? null)} />
            </label>
            <label>Date column
              <input type="text" value={dateColumn} maxLength={128} onChange={(event) => { setDateColumn(event.target.value); clearPreview(file); }} />
            </label>
            {amountLayout === "signed" ? <label>Amount column
              <input type="text" value={amountColumn} maxLength={128} onChange={(event) => { setAmountColumn(event.target.value); clearPreview(file); }} />
            </label> : <>
              <label>Credit column<input type="text" value={creditColumn} maxLength={128} onChange={(event) => { setCreditColumn(event.target.value); clearPreview(file); }} /></label>
              <label>Debit column<input type="text" value={debitColumn} maxLength={128} onChange={(event) => { setDebitColumn(event.target.value); clearPreview(file); }} /></label>
            </>}
          </div>
          <button className="button button-primary workspace-submit" type="submit" disabled={!file || busy}>
            {busy ? "Reading on this device…" : "Preview entries"}
          </button>
        </form>
        <p className="sr-only" role="status" aria-label="Preview progress" aria-live="polite">{busy ?
          "Parsing local file." : preview ?
          `Preview ready: ${preview.candidates.length} proposed ${preview.candidates.length === 1 ? "entry" : "entries"}. No entry has been approved or saved.` : notice}</p>
        <p className="workspace-note"><Info size={16} aria-hidden="true" /> Your file is parsed by a browser worker. It is not sent to Scryer or saved in browser storage.</p>
        {notice && <p className="workspace-alert"><ShieldAlert size={17} aria-hidden="true" />{notice}</p>}
      </section>

      {preview && <section className="workspace-panel workspace-results" aria-labelledby="proposed-entries-heading">
        <div className="workspace-panel-title"><FileSearch size={22} aria-hidden="true" /><div>
          <span className="eyebrow">STEP 02 · INSPECT</span><h2 id="proposed-entries-heading">Proposed entries</h2>
        </div></div>
        <p className="workspace-file">{preview.fileName} · {preview.candidates.length} rows · SHA-256 <code>{preview.sha256}</code></p>
        <p className="workspace-alert"><ShieldAlert size={17} aria-hidden="true" />No entry has been approved or saved.</p>
        {preview.candidates.length === 0 ? <p>No transaction rows were found in this CSV.</p> : <div className="workspace-table-wrap"><table className="workspace-table">
          <thead><tr><th scope="col">Source</th><th scope="col">Date</th><th scope="col">Interpretation</th><th scope="col">Candidate amount</th><th scope="col">Review note</th></tr></thead>
          <tbody>{preview.candidates.slice(pageIndex * 50, pageIndex * 50 + 50).map((candidate) => <tr key={candidate.sourceLocation}>
            <td data-label="Source"><code>{candidate.sourceLocation}</code></td>
            <td data-label="Date">{candidate.effectiveDate ?? "Unresolved"}</td>
            <td data-label="Interpretation">{candidate.direction === "credit" ? "Possible bank credit" : candidate.direction === "debit" ? "Debit" : "Unresolved"}</td>
            <td data-label="Candidate amount">{candidate.amountMinor === null ? "—" : formatUsdMinor(candidate.amountMinor)}</td>
            <td data-label="Review note">
              {candidate.warningCodes.length ? candidate.warningCodes.map((code) => <span key={code} className="workspace-warning">{warningText[code] ?? code}</span>) : "Check against your original record."}
              <details className="workspace-raw"><summary>Inspect original CSV row</summary><p>Original fields: {candidate.rawFields.join(" · ")}</p>
                {candidate.rawTruncated && <p>Long source field shortened for preview; original file unchanged.</p>}
              </details>
            </td>
          </tr>)}</tbody>
        </table></div>}
        {preview.candidates.length > 50 && <div className="workspace-pagination" aria-label="Preview pages">
          <button type="button" onClick={() => setPageIndex((index) => index - 1)} disabled={pageIndex === 0}>Previous 50 entries</button>
          <span>Page {pageIndex + 1} of {Math.ceil(preview.candidates.length / 50)}</span>
          <button type="button" onClick={() => setPageIndex((index) => index + 1)} disabled={(pageIndex + 1) * 50 >= preview.candidates.length}>Next 50 entries</button>
        </div>}
        <p className="workspace-note">A bank credit alone does not prove it came from a school refund. Keep the original CSV for later source review.</p>
      </section>}
    </div>
  );
}
