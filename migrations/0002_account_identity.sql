-- Forward-only integrity constraint: one account per trusted provider identity.
-- A duplicate from an older database aborts migration for operator review.
SET ROLE scryer_owner;
ALTER TABLE scryer.accounts
  ADD CONSTRAINT accounts_provider_identity_unique
  UNIQUE (identity_issuer, identity_subject);
RESET ROLE;
