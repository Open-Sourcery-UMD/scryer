# M9-7 receipt provenance and archive boundaries

**Task ID, requirements, dependencies, and risk:** M9-7; S-28, S-31, S-44; HIGH. Depends on the native receipt implementation, strict case parser, independent Python receipt checker, and M9-6's measured coverage gap.

**Design:** Add native receipt regressions for an explicitly reviewed, source-linked proposal whose proposed amount differs from the approved exact amount; verify both original/proposed/current fields and successful historical reproduction. Exercise a linked proposal with unknown proposed amount, unsupported producer selection, a nonobject archive, missing archive fields, and an invalid archived head. Each malformed archive must fail typed without returning a partial receipt. Keep the production engine unchanged unless a test exposes a real defect. Compare the linked-proposal expectation with the existing independent Python reference test.

**Verification:** Run the native receipt target, full Python reference suite, native CLI tests, and source coverage gate. Record exact results and retain a nonzero coverage gate if the target remains unmet. Avoid fabricating source authenticity or treating an approved proposal as institution verified.

**Done:** Provenance and archive refusal tests pass, the new coverage result is recorded, and overall status remains `BACKEND_PARTIAL_LOCAL`.
