-- Record the provider connection that owns each node invocation so one
-- provider's inventory cannot complete or reschedule another provider's work.

ALTER TABLE action_invocations ADD COLUMN dispatched_provider TEXT DEFAULT NULL;

-- Infer ownership from the strongest historical evidence available. Rows on a
-- multi-provider node that remain ambiguous stay NULL so no provider inventory
-- can claim them; the normal timeout sweep will redispatch and stamp ownership.
WITH spawn_targets AS (
  SELECT
    id AS invocation_id,
    workspace_id,
    dispatched_node_id,
    CASE
      WHEN json_type(input, '$.capability') = 'text'
        AND NULLIF(trim(json_extract(input, '$.capability')), '') IS NOT NULL
        THEN CASE
          WHEN trim(json_extract(input, '$.capability')) LIKE 'spawn:%'
            THEN trim(json_extract(input, '$.capability'))
          ELSE 'spawn:' || trim(json_extract(input, '$.capability'))
        END
      WHEN json_type(input, '$.cli') = 'text'
        AND NULLIF(trim(json_extract(input, '$.cli')), '') IS NOT NULL
        THEN CASE
          WHEN trim(json_extract(input, '$.cli')) LIKE 'spawn:%'
            THEN trim(json_extract(input, '$.cli'))
          ELSE 'spawn:' || trim(json_extract(input, '$.cli'))
        END
      ELSE action_name
    END AS capability_name
  FROM action_invocations
  WHERE dispatched_node_id IS NOT NULL
    AND action_name LIKE 'spawn%'
),
spawn_candidates AS (
  SELECT spawn_targets.invocation_id, actions.handler_provider AS provider_name
  FROM spawn_targets
  JOIN actions
    ON actions.workspace_id = spawn_targets.workspace_id
    AND actions.handler_node_id = spawn_targets.dispatched_node_id
    AND actions.name = spawn_targets.capability_name
  WHERE actions.handler_provider IS NOT NULL

  UNION ALL

  SELECT spawn_targets.invocation_id, node_providers.name AS provider_name
  FROM spawn_targets
  JOIN node_providers
    ON node_providers.workspace_id = spawn_targets.workspace_id
    AND node_providers.node_id = spawn_targets.dispatched_node_id
  JOIN json_each(node_providers.capabilities) AS capability
  WHERE CASE
    WHEN capability.type = 'text' THEN capability.value
    ELSE json_extract(capability.value, '$.name')
  END = spawn_targets.capability_name
    AND CASE
      WHEN capability.type = 'text' THEN 'capacity'
      ELSE COALESCE(json_extract(capability.value, '$.kind'), 'capacity')
    END = 'capacity'
),
spawn_owners AS (
  SELECT
    invocation_id,
    CASE WHEN COUNT(DISTINCT provider_name) = 1 THEN MIN(provider_name) END AS provider_name
  FROM spawn_candidates
  GROUP BY invocation_id
)
UPDATE action_invocations
SET dispatched_provider = COALESCE(
  (SELECT actions.handler_provider FROM actions WHERE actions.id = action_invocations.action_id),
  (
    SELECT agents.provider_name
    FROM actions
    JOIN agents ON agents.id = actions.handler_agent_id
    WHERE actions.id = action_invocations.action_id
  ),
  (
    SELECT agents.provider_name
    FROM agents
    WHERE action_invocations.action_name = 'release'
      AND agents.workspace_id = action_invocations.workspace_id
      AND agents.name = json_extract(action_invocations.input, '$.name')
    LIMIT 1
  ),
  (
    SELECT spawn_owners.provider_name
    FROM spawn_owners
    WHERE spawn_owners.invocation_id = action_invocations.id
  ),
  (
    SELECT CASE WHEN COUNT(*) = 1 THEN MIN(node_providers.name) END
    FROM node_providers
    WHERE node_providers.workspace_id = action_invocations.workspace_id
      AND node_providers.node_id = action_invocations.dispatched_node_id
      AND NOT EXISTS (
        SELECT 1
        FROM spawn_candidates
        WHERE spawn_candidates.invocation_id = action_invocations.id
      )
  )
)
WHERE dispatched_node_id IS NOT NULL;
