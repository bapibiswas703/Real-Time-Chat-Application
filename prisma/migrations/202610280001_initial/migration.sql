CREATE TYPE "ChatType" AS ENUM ('DIRECT');
CREATE TABLE "users" (
  "id" UUID PRIMARY KEY, "firebase_uid" VARCHAR(128) NOT NULL UNIQUE,
  "display_name" VARCHAR(80) NOT NULL, "phone_number" VARCHAR(32),
  "email" VARCHAR(320), "avatar_url" VARCHAR(2048),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL
);
CREATE TABLE "chats" (
  "id" UUID PRIMARY KEY, "type" "ChatType" NOT NULL DEFAULT 'DIRECT',
  "canonical_direct_pair_key" VARCHAR(73) NOT NULL UNIQUE,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL
);
CREATE TABLE "chat_participants" (
  "chat_id" UUID NOT NULL REFERENCES "chats"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("chat_id", "user_id")
);
CREATE INDEX "chat_participants_user_id_chat_id_idx" ON "chat_participants"("user_id", "chat_id");

-- Membership is immutable in this release. This also serializes attempts to alter
-- it; no concurrent DELETE/INSERT write skew can violate the deferred invariant.
CREATE FUNCTION prevent_participant_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Direct chat membership is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER immutable_members BEFORE UPDATE OR DELETE ON chat_participants
FOR EACH ROW EXECUTE FUNCTION prevent_participant_mutation();

CREATE FUNCTION validate_direct_chat() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID; actual_key TEXT; member_count INT; expected_key TEXT;
BEGIN
  IF TG_TABLE_NAME = 'chats' THEN target := NEW.id; ELSE target := NEW.chat_id; END IF;
  SELECT canonical_direct_pair_key INTO expected_key FROM chats WHERE id = target;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), string_agg(user_id::text, ':' ORDER BY user_id::text COLLATE "C")
    INTO member_count, actual_key FROM chat_participants WHERE chat_id = target;
  IF member_count <> 2 OR actual_key IS DISTINCT FROM expected_key THEN
    RAISE EXCEPTION 'Direct chat requires exactly two canonical participants' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER valid_chat AFTER INSERT OR UPDATE ON chats
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_direct_chat();
CREATE CONSTRAINT TRIGGER valid_members AFTER INSERT ON chat_participants
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_direct_chat();
