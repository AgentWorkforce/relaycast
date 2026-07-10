-- cloud#1850: persist deployed persona card image URLs so dashboard
-- thumbnails read deployment metadata instead of deriving AgentWorkforce/agents
-- repository paths in UI code.
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "image_url" text;
