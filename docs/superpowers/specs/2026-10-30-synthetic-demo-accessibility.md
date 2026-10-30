# Synthetic demo accessibility design

## Intent

Make the public synthetic journey understandable and operable with keyboard navigation and assistive semantics. The existing demo is read-only and contains no personal case controls. S-55's full-product accessibility gate remains open until the personal-case workflow exists and is tested with actual screen readers.

## Scope

- Preserve the static, synthetic, local-only demo.
- Give distinct accessible names to the two source-inspection links.
- Verify visible skip navigation, keyboard-operable evidence disclosures, named landmarks, one page title per route, and no horizontal clipping at a 320 CSS-pixel viewport.
- Verify that the corrected grant's source details and the distinct refund/bank observation cards appear in Chrome's accessibility tree.
- Use only the already installed local Chrome and `playwright-core`; the browser check must state when Chrome is unavailable.
- Record that a Chrome accessibility-tree check does not substitute for a human screen-reader test.

## Acceptance

The production static build passes a browser test that opens `/` and `/demo` from its generated HTML/CSS, performs the keyboard checks, and inspects the accessibility tree. The existing frontend build/lint, Python reference, and headless client tests remain green. A human screen-reader test remains a release requirement.
