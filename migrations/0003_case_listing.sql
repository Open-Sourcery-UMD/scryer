-- Keyset pagination for live opaque cases. Earlier migration checksums stay immutable.
CREATE INDEX cases_live_updated_keyset
ON scryer.cases (account_id, updated_at DESC, case_id DESC)
WHERE deleted_at IS NULL;
