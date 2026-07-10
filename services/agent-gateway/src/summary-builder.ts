import { buildSummary as buildGitHubAdapterSummary } from "@relayfile/adapter-github";
import { buildSummary as buildLinearAdapterSummary } from "@relayfile/adapter-linear";
import { buildSummary as buildNotionAdapterSummary } from "@relayfile/adapter-notion";
import { buildSummary as buildSlackAdapterSummary } from "@relayfile/adapter-slack";

export type AgentEventSummary = {
  title?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  actor?: { id: string; displayName?: string };
  fieldsChanged?: string[];
  tags?: string[];
};

export type SummaryBuildInput = {
  provider: string;
  type: string;
  raw?: unknown;
  summary?: Partial<AgentEventSummary>;
  schedule?: string;
  path?: string;
  action?: string;
  revision?: string;
};

export type SummaryBuilder = (input: SummaryBuildInput) => AgentEventSummary;

const MAX_LABELS = 8;
const MAX_TAGS = 8;
const MAX_FIELDS_CHANGED = 16;
const MAX_SUMMARY_BYTES = 1_024;
const MAX_TITLE_LENGTH = 120;
const MAX_STATUS_LENGTH = 96;
const MAX_PRIORITY_LENGTH = 48;
const MAX_TOKEN_LENGTH = 96;

const providerBuilders = new Map<string, SummaryBuilder>();

export function registerSummaryBuilder(
  provider: string,
  builder: SummaryBuilder,
): void {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    throw new Error("provider is required");
  }
  providerBuilders.set(normalized, builder);
}

export function buildSummary(input: SummaryBuildInput): AgentEventSummary {
  const normalizedProvider = input.provider.trim().toLowerCase();
  const builder = providerBuilders.get(normalizedProvider);
  if (builder) {
    return sanitizeSummary(builder({
      ...input,
      provider: normalizedProvider,
    }));
  }

  return sanitizeSummary(buildDefaultSummary({
    ...input,
    provider: normalizedProvider,
  }));
}

export function buildResourceSummary(
  provider: string,
  resource: unknown,
): AgentEventSummary | undefined {
  const record = unwrapResourceRecord(resource);
  if (!record) {
    return undefined;
  }

  const summary = sanitizeSummary({
    ...(readNamedValue(
      record.title,
      record.name,
      record.subject,
      record.summary,
      record.text,
    ) ? {
      title: readNamedValue(
        record.title,
        record.name,
        record.subject,
        record.summary,
        record.text,
      ),
    } : {}),
    ...(readNamedValue(
      record.status,
      record.state,
      record.stage,
      record.phase,
    ) ? {
      status: readNamedValue(
        record.status,
        record.state,
        record.stage,
        record.phase,
      ),
    } : {}),
    ...(readNamedValue(record.priority) ? { priority: readNamedValue(record.priority) } : {}),
    ...(extractActor(record) ? { actor: extractActor(record) } : {}),
    ...(extractStringList(record.labels, record.tags)?.length
      ? { labels: extractStringList(record.labels, record.tags) }
      : {}),
    ...(extractStringList(record.fieldsChanged, record.changedFields)?.length
      ? { fieldsChanged: extractStringList(record.fieldsChanged, record.changedFields) }
      : {}),
  });

  return Object.keys(summary).length > 0
    ? buildSummary({
      provider,
      type: `${provider}.changed`,
      raw: resource,
      summary,
    })
    : undefined;
}

export function registerBuiltinSummaryBuilders(): void {
  registerSummaryBuilder("internal", (input) => {
    if (input.type === "cron.tick") {
      return buildCronSummary(input.schedule);
    }

    return buildDefaultSummary(input);
  });

  registerSummaryBuilder("relayfile", buildDefaultSummary);
  registerSummaryBuilder("linear", (input) => mergeAdapterSummary(input, buildLinearAdapterSummary(readPayloadRecord(input))));
  registerSummaryBuilder("github", (input) => mergeAdapterSummary(input, buildGitHubAdapterSummary(readPayloadRecord(input))));
  registerSummaryBuilder("slack", (input) => mergeAdapterSummary(input, buildSlackAdapterSummary(readPayloadRecord(input))));
  registerSummaryBuilder("notion", (input) => mergeAdapterSummary(input, buildNotionAdapterSummary(readPayloadRecord(input))));
  registerSummaryBuilder("jira", buildJiraSummary);
  registerSummaryBuilder("airtable", buildAirtableSummary);
  registerSummaryBuilder("asana", buildAsanaSummary);
  registerSummaryBuilder("calendly", buildCalendlySummary);
  registerSummaryBuilder("clickup", buildClickUpSummary);
  registerSummaryBuilder("confluence", buildConfluenceSummary);
  registerSummaryBuilder("hubspot", buildHubSpotSummary);
  registerSummaryBuilder("intercom", buildIntercomSummary);
  registerSummaryBuilder("mailgun", buildMailgunSummary);
  registerSummaryBuilder("mixpanel", buildMixpanelSummary);
  registerSummaryBuilder("pipedrive", buildPipedriveSummary);
  registerSummaryBuilder("salesforce", buildSalesforceSummary);
  registerSummaryBuilder("segment", buildSegmentSummary);
  registerSummaryBuilder("sendgrid", buildSendGridSummary);
  registerSummaryBuilder("shopify", buildShopifySummary);
  registerSummaryBuilder("zendesk", buildZendeskSummary);
  registerSummaryBuilder("stripe", buildStripeSummary);
  registerSummaryBuilder("gitlab", buildGitlabSummary);
}

function buildDefaultSummary(input: SummaryBuildInput): AgentEventSummary {
  return {
    title: input.summary?.title ?? input.type,
    status: input.summary?.status,
    priority: input.summary?.priority,
    labels: input.summary?.labels,
    actor: input.summary?.actor,
    fieldsChanged: input.summary?.fieldsChanged,
    tags: input.summary?.tags,
  };
}

function mergeAdapterSummary(
  input: SummaryBuildInput,
  adapterSummary: AgentEventSummary,
): AgentEventSummary {
  const base = buildDefaultSummary(input);
  return {
    title: adapterSummary.title ?? base.title,
    status: adapterSummary.status ?? base.status,
    priority: adapterSummary.priority ?? base.priority,
    labels: mergeStringLists(adapterSummary.labels, base.labels, MAX_LABELS),
    actor: adapterSummary.actor ?? base.actor,
    fieldsChanged: mergeStringLists(
      adapterSummary.fieldsChanged,
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(adapterSummary.tags, base.tags, MAX_TAGS),
  };
}

export function buildCronSummary(schedule: string | undefined): AgentEventSummary {
  return sanitizeSummary({
    title: "cron tick",
    status: schedule,
    tags: schedule ? ["schedule"] : undefined,
  });
}

function buildLinearSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const previousData =
    readRecord(payload.previousData)
    ?? readRecord(readRecord(payload._webhook)?.previousData);
  return {
    ...base,
    title: readString(payload.title) ?? readString(payload.name) ?? base.title,
    status:
      readString(readRecord(payload.state)?.name)
      ?? readString(payload.state_name)
      ?? base.status,
    priority: resolveLinearPriority(payload) ?? base.priority,
    labels: mergeStringLists(readLabelNames(payload.labels), base.labels, MAX_LABELS),
    actor:
      buildObjectActor(
        readRecord(payload.actionBy)
        ?? readRecord(readRecord(payload._webhook)?.actor),
      )
      ?? base.actor,
    fieldsChanged: mergeStringLists(
      diffRecordKeys(previousData, payload, MAX_FIELDS_CHANGED, { skipPrivate: true }),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      "linear",
      ...(readString(readRecord(payload.state)?.name) ? [`state:${readString(readRecord(payload.state)?.name)}`] : []),
      ...(resolveLinearPriority(payload) ? [`priority:${resolveLinearPriority(payload)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildGitHubSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const pullRequest = readRecord(payload.pull_request);
  const issue = readRecord(payload.issue);
  const subject = pullRequest ?? issue ?? payload;
  const repoName = readString(readRecord(payload.repository)?.full_name);

  return {
    ...base,
    title: readString(subject.title) ?? base.title,
    status:
      (pullRequest && subject.draft === true ? "draft" : undefined)
      ?? readString(subject.state)
      ?? base.status,
    labels: mergeStringLists(readLabelNames(subject.labels), base.labels, MAX_LABELS),
    actor: buildGitHubActor(
      readRecord(payload.sender)
      ?? readRecord(subject.user),
    ) ?? base.actor,
    fieldsChanged: mergeStringLists(
      limitStrings(Object.keys(readRecord(payload.changes) ?? {}), MAX_FIELDS_CHANGED),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...(pullRequest ? ["kind:pull_request"] : issue ? ["kind:issue"] : []),
      ...(repoName ? [`repo:${repoName}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildSlackSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const channel = readRecord(payload.channel);
  const channelId = readString(payload.channel) ?? readString(channel?.id);
  const channelName = readString(channel?.name);
  const channelType = readString(payload.channel_type);
  return {
    ...base,
    title:
      readString(payload.text)
      ?? readString(readRecord(payload.previous_message)?.text)
      ?? readString(readRecord(payload.message)?.text)
      ?? base.title,
    actor: buildSlackActor(payload) ?? base.actor,
    tags: mergeStringLists(limitStrings([
      ...(channelId ? [`channel:${channelId}`] : []),
      ...(channelName ? [`channel_name:${channelName}`] : []),
      ...(channelType ? [`channel_type:${channelType}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildNotionSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const properties = readRecord(payload.properties);
  const previousProperties =
    readRecord(payload.previousProperties)
    ?? readRecord(payload.previous_properties)
    ?? readRecord(readRecord(payload.before)?.properties)
    ?? readRecord(readRecord(payload._webhook)?.previousProperties);

  return {
    ...base,
    title: resolveNotionTitle(payload, properties) ?? base.title,
    status: resolveNotionStatus(properties) ?? base.status,
    labels: mergeStringLists(resolveNotionLabels(properties), base.labels, MAX_LABELS),
    actor:
      buildObjectActor(
        readRecord(payload.last_edited_by)
        ?? readRecord(payload.lastEditedBy)
        ?? readRecord(payload.created_by)
        ?? readRecord(payload.createdBy),
      )
      ?? base.actor,
    fieldsChanged: mergeStringLists(
      resolveNotionChangedFields(payload, previousProperties, properties),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...(readString(payload.object) ? [`object:${readString(payload.object)}`] : []),
      ...resolveNotionParentTags(readRecord(payload.parent)),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildJiraSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const issue = readRecord(payload.issue) ?? payload;
  const fields = readRecord(issue.fields);
  return {
    ...base,
    title:
      readString(fields?.summary)
      ?? readString(issue.summary)
      ?? readString(issue.title)
      ?? base.title,
    status:
      readString(readRecord(fields?.status)?.name)
      ?? readString(issue.status)
      ?? base.status,
    priority:
      readString(readRecord(fields?.priority)?.name)
      ?? readString(issue.priority)
      ?? base.priority,
    labels: mergeStringLists(readStringArray(fields?.labels), base.labels, MAX_LABELS),
    actor:
      buildObjectActor(
        readRecord(payload.user)
        ?? readRecord(payload.actor)
        ?? readRecord(payload.currentUser),
      )
      ?? base.actor,
    fieldsChanged: mergeStringLists(
      extractJiraChangedFields(readRecord(payload.changelog))
      ?? limitStrings(Object.keys(readRecord(payload.changes) ?? {}), MAX_FIELDS_CHANGED),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...extractJiraProjectTags(issue, fields),
      ...(readString(readRecord(fields?.issuetype)?.name) ? [`type:${readString(readRecord(fields?.issuetype)?.name)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildAirtableSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const baseId =
    readString(payload.baseId)
    ?? readString(payload.base_id)
    ?? readString(readRecord(payload.base)?.id);
  const webhookId =
    readString(payload.webhookId)
    ?? readString(payload.webhook_id)
    ?? readString(readRecord(payload.webhook)?.id)
    ?? readString(payload.id);
  const changes = extractAirtableChanges(payload);
  const changedFieldIds = limitStrings([
    ...readStringArray(payload.changedFieldIds),
    ...changes
      .map((change) => readString(readRecord(change)?.fieldId))
      .filter((value): value is string => Boolean(value)),
  ], MAX_FIELDS_CHANGED);
  const tableIds = limitStrings(
    changes
      .map((change) => readString(readRecord(change)?.tableId))
      .filter((value): value is string => Boolean(value)),
    6,
  );

  return {
    ...base,
    title:
      resolveAirtableNotificationTitle(payload)
      ?? base.title
      ?? (baseId ? `Airtable base ${baseId} change notification` : "Airtable change notification"),
    actor:
      buildObjectActor(
        readRecord(readRecord(readRecord(payload.actionMetadata)?.sourceMetadata)?.user)
        ?? readRecord(payload.actor),
      )
      ?? base.actor,
    fieldsChanged: mergeStringLists(changedFieldIds, base.fieldsChanged, MAX_FIELDS_CHANGED),
    tags: mergeStringLists(limitStrings([
      "airtable",
      "notification",
      ...(webhookId ? [`webhook:${webhookId}`] : []),
      ...(tableIds ?? []).map((tableId) => `table:${tableId}`),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildConfluenceSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const page = readRecord(payload.page) ?? readRecord(payload.content) ?? payload;
  const labelResults = readArray(readRecord(readRecord(page.metadata)?.labels)?.results);
  return {
    ...base,
    title: readString(page.title) ?? base.title,
    status:
      readString(page.status)
      ?? readString(readRecord(page.version)?.status)
      ?? readString(readRecord(page.history)?.status)
      ?? base.status,
    labels: mergeStringLists(limitStrings(
      labelResults
        .map((entry) => readString(readRecord(entry)?.name))
        .filter((value): value is string => Boolean(value)),
      MAX_LABELS,
    ), base.labels, MAX_LABELS),
    actor:
      buildObjectActor(
        readRecord(readRecord(page.version)?.by)
        ?? readRecord(readRecord(page.history)?.createdBy)
        ?? readRecord(payload.user),
      )
      ?? base.actor,
    fieldsChanged: mergeStringLists(
      limitStrings(Object.keys(readRecord(payload.changes) ?? {}), MAX_FIELDS_CHANGED),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...(readString(readRecord(page.space)?.key) ? [`space:${readString(readRecord(page.space)?.key)}`] : []),
      ...(readString(page.type) ? [`type:${readString(page.type)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildHubSpotSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const properties = readRecord(payload.properties) ?? payload;
  const propertyName = readString(payload.propertyName) ?? readString(readRecord(payload.change)?.propertyName);
  return {
    ...base,
    title:
      readString(properties.dealname)
      ?? readString(properties.firstname)
      ?? readString(properties.subject)
      ?? base.title,
    status:
      readString(properties.dealstage)
      ?? readString(properties.hs_pipeline_stage)
      ?? base.status,
    priority:
      readString(properties.priority)
      ?? readString(properties.hs_priority)
      ?? base.priority,
    actor:
      buildObjectActor(readRecord(payload.owner))
      ?? (readString(properties.hubspot_owner_id) ? { id: readString(properties.hubspot_owner_id)! } : base.actor),
    fieldsChanged: mergeStringLists(
      propertyName ? [propertyName] : undefined,
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...(readString(payload.subscriptionType) ? [`subscription:${readString(payload.subscriptionType)}`] : []),
      ...(readString(payload.objectType) ? [`object:${readString(payload.objectType)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildStripeSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const data = readRecord(payload.data);
  const object = readRecord(data?.object) ?? payload;
  return {
    ...base,
    title: readString(object.description) ?? readString(object.name) ?? base.title,
    status: readString(object.status) ?? readString(payload.type) ?? base.status,
    fieldsChanged: mergeStringLists(
      limitStrings(Object.keys(readRecord(data?.previous_attributes) ?? {}), MAX_FIELDS_CHANGED),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...(readString(object.object) ? [`object:${readString(object.object)}`] : []),
      ...(readString(payload.type) ? [`event:${readString(payload.type)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildAsanaSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const firstEvent = readRecord(readArray(payload.events)[0]);
  const resource = readRecord(firstEvent?.resource);
  const task = readRecord(payload.data) ?? readRecord(payload.task) ?? resource ?? payload;
  const completed = task.completed;
  return {
    ...base,
    title: readString(task.name) ?? readString(resource?.name) ?? base.title,
    status:
      typeof completed === "boolean"
        ? completed ? "done" : "open"
        : readString(task.status) ?? base.status,
    labels: mergeStringLists(readLabelNames(task.tags), base.labels, MAX_LABELS),
    actor: buildObjectActor(readRecord(firstEvent?.user)) ?? base.actor,
    fieldsChanged: mergeStringLists(
      extractAsanaChangedFields(readArray(payload.events)),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...(readString(resource?.resource_type) ? [`resource:${readString(resource?.resource_type)}`] : []),
      ...(readString(firstEvent?.action) ? [`action:${readString(firstEvent?.action)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildShopifySummary(input: SummaryBuildInput): AgentEventSummary {
  const root = readRecord(input.raw) ?? {};
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const data = readRecord(payload.data) ?? readRecord(payload.payload) ?? payload;
  const title =
    readString(data.name)
    ?? readString(data.title)
    ?? readString(readRecord(readArray(data.line_items)[0])?.title)
    ?? readString(readRecord(readArray(data.line_items)[0])?.name);
  return {
    ...base,
    title: title ?? base.title,
    status:
      readString(data.fulfillment_status)
      ?? readString(data.status)
      ?? base.status,
    labels: mergeStringLists(parseDelimitedTags(readString(data.tags)), base.labels, MAX_LABELS),
    fieldsChanged: mergeStringLists(
      limitStrings(
        [
          readString(root.topic) ?? readString(payload.topic),
          readString(root.type) ?? readString(payload.type),
        ].filter((value): value is string => Boolean(value)),
        MAX_FIELDS_CHANGED,
      ),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...(readString(payload.objectType) ? [`object:${readString(payload.objectType)}`] : []),
      ...(readString(root.shop_domain) ? [`shop:${readString(root.shop_domain)}`] : []),
      ...(readString(root.shopDomain) ? [`shop:${readString(root.shopDomain)}`] : []),
      ...(readString(payload.shop_domain) ? [`shop:${readString(payload.shop_domain)}`] : []),
      ...(readString(payload.shopDomain) ? [`shop:${readString(payload.shopDomain)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildMailgunSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const eventData =
    readRecord(payload.eventData)
    ?? readRecord(payload["event-data"])
    ?? readRecord(payload.data)
    ?? payload;
  const eventType = readString(eventData.event) ?? readString(payload.event);
  return {
    ...base,
    title: eventType ?? base.title,
    status:
      readString(eventData.severity)
      ?? readString(readRecord(eventData.delivery_status)?.description)
      ?? eventType
      ?? base.status,
    labels: mergeStringLists(readStringArray(eventData.tags), base.labels, MAX_LABELS),
    tags: mergeStringLists(limitStrings([
      ...(readString(eventData.domain) ? [`domain:${readString(eventData.domain)}`] : []),
      ...(eventType ? [`event:${eventType}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildSalesforceSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const attributes = readRecord(payload.attributes);
  return {
    ...base,
    title:
      readString(payload.Subject)
      ?? readString(payload.Name)
      ?? readString(payload.Title)
      ?? base.title,
    status: readString(payload.Status) ?? readString(payload.State) ?? base.status,
    priority: readString(payload.Priority) ?? base.priority,
    actor: buildSalesforceActor(payload) ?? base.actor,
    fieldsChanged: mergeStringLists(
      resolveSalesforceChangedFields(payload),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...(readString(attributes?.type) ? [`object:${readString(attributes?.type)}`] : []),
      ...(readString(payload.RecordTypeId) ? [`record_type:${readString(payload.RecordTypeId)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildClickUpSummary(input: SummaryBuildInput): AgentEventSummary {
  const root = readRecord(input.raw) ?? {};
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const data = readRecord(payload.data) ?? payload;
  return {
    ...base,
    title: readString(data.name) ?? base.title,
    status:
      readString(readRecord(data.status)?.status)
      ?? readString(data.status)
      ?? base.status,
    priority:
      readString(readRecord(data.priority)?.priority)
      ?? readString(data.priority)
      ?? base.priority,
    labels: mergeStringLists(readLabelNames(data.tags), base.labels, MAX_LABELS),
    actor:
      buildObjectActor(readRecord(data.creator))
      ?? buildObjectActor(readRecord(readRecord(readArray(payload.history_items)[0])?.user))
      ?? base.actor,
    fieldsChanged: mergeStringLists(
      extractClickUpChangedFields(
        readArray(root.history_items).length > 0
          ? readArray(root.history_items)
          : readArray(payload.history_items),
      ),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...(readString(root.event) ? [`event:${readString(root.event)}`] : []),
      ...(readString(payload.event) ? [`event:${readString(payload.event)}`] : []),
      ...(readString(readRecord(data.list)?.id) ? [`list:${readString(readRecord(data.list)?.id)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildCalendlySummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const data = readRecord(payload.payload) ?? payload;
  return {
    ...base,
    title: readString(data.name) ?? base.title,
    status:
      readString(data.status)
      ?? (data.canceled === true ? "canceled" : undefined)
      ?? base.status,
    actor:
      buildObjectActor(readRecord(readArray(data.event_memberships)[0]))
      ?? buildObjectActor(readRecord(data.created_by))
      ?? base.actor,
    tags: mergeStringLists(limitStrings([
      ...(readString(payload.event) ? [`event:${readString(payload.event)}`] : []),
      ...(readString(readRecord(data.location)?.type) ? [`location:${readString(readRecord(data.location)?.type)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildPipedriveSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const data =
    readRecord(payload.current)
    ?? readRecord(payload.data)
    ?? readRecord(payload.deal)
    ?? payload;
  const pipeline =
    readNamedValue(data.pipeline, readRecord(data.pipeline)?.name)
    ?? readNamedValue(data.pipeline_name, data.pipelineName);
  return {
    ...base,
    title:
      readString(data.title)
      ?? readString(data.name)
      ?? readString(data.subject)
      ?? base.title,
    status:
      readString(data.status)
      ?? readString(data.stage_name)
      ?? readString(data.stageName)
      ?? base.status,
    actor:
      buildObjectActor(readRecord(payload.user))
      ?? buildObjectActor(readRecord(data.owner))
      ?? base.actor,
    tags: mergeStringLists(limitStrings([
      ...(pipeline ? [`pipeline:${pipeline}`] : []),
      ...(readString(payload.event) ? [`event:${readString(payload.event)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildIntercomSummary(input: SummaryBuildInput): AgentEventSummary {
  const root = readRecord(input.raw) ?? {};
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const data =
    readRecord(readRecord(payload.data)?.item)
    ?? readRecord(payload.item)
    ?? readRecord(payload.conversation)
    ?? readRecord(payload.data)
    ?? payload;
  const source =
    readRecord(readRecord(data.source)?.body)
    ?? readRecord(readRecord(data.conversation_message)?.body)
    ?? readRecord(data.source);
  const title =
    readString(readRecord(source)?.plain_text)
    ?? readString(readRecord(source)?.text)
    ?? readString(data.title);
  return {
    ...base,
    title: title ?? base.title,
    status:
      readString(data.state)
      ?? readString(data.status)
      ?? base.status,
    actor:
      buildObjectActor(readRecord(data.author))
      ?? buildObjectActor(readRecord(payload.author))
      ?? base.actor,
    tags: mergeStringLists(limitStrings([
      ...(readString(root.topic) ? [`topic:${readString(root.topic)}`] : []),
      ...(readString(payload.topic) ? [`topic:${readString(payload.topic)}`] : []),
      ...(readString(data.conversation_message_type) ? [`message:${readString(data.conversation_message_type)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildSendGridSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const eventRecord = readRecord(readArray(payload.events)[0]) ?? readRecord(readArray(payload.data)[0]) ?? payload;
  const eventType = readString(eventRecord.event) ?? readString(payload.event);
  const subject =
    readString(readRecord(eventRecord.smtp)?.subject)
    ?? readString(eventRecord.subject);
  const sgEventId =
    readString(eventRecord.sg_event_id)
    ?? readString(eventRecord.sgEventId);
  return {
    ...base,
    title: eventType ?? base.title,
    status:
      readString(eventRecord.type)
      ?? eventType
      ?? base.status,
    fieldsChanged: mergeStringLists(
      limitStrings([sgEventId].filter((value): value is string => Boolean(value)), MAX_FIELDS_CHANGED),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...(subject ? [subject] : []),
      ...(readString(eventRecord.category) ? [`category:${readString(eventRecord.category)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildSegmentSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const event = readRecord(payload.event) ?? readRecord(payload.data) ?? payload;
  const context = readRecord(event.context);
  return {
    ...base,
    title:
      readString(event.event)
      ?? readString(event.name)
      ?? base.title,
    status:
      readString(event.type)
      ?? readString(payload.type)
      ?? base.status,
    tags: mergeStringLists(limitStrings([
      ...(readNamedValue(context?.library) ? [`library:${readNamedValue(context?.library)}`] : []),
      ...(readNamedValue(context?.source, context?.channel) ? [`source:${readNamedValue(context?.source, context?.channel)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildMixpanelSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const event = readRecord(payload.data) ?? payload;
  return {
    ...base,
    title:
      readString(event.event)
      ?? readString(event.name)
      ?? base.title,
    status:
      readString(event.type)
      ?? readString(payload.type)
      ?? base.status,
    tags: mergeStringLists(limitStrings([
      ...(readString(readRecord(event.properties)?.source) ? [`source:${readString(readRecord(event.properties)?.source)}`] : []),
      ...(readString(readRecord(event.properties)?.["$browser"]) ? [`browser:${readString(readRecord(event.properties)?.["$browser"])}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildZendeskSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const ticket = readRecord(payload.ticket) ?? payload;
  return {
    ...base,
    title:
      readString(ticket.subject)
      ?? readString(ticket.title)
      ?? base.title,
    status: readString(ticket.status) ?? base.status,
    priority: readString(ticket.priority) ?? base.priority,
    labels: mergeStringLists(limitStrings(readStringArray(ticket.tags), MAX_LABELS), base.labels, MAX_LABELS),
    actor:
      buildObjectActor(
        readRecord(payload.current_user)
        ?? readRecord(payload.requester)
        ?? readRecord(ticket.requester)
        ?? readRecord(ticket.submitter)
        ?? readRecord(ticket.assignee),
      )
      ?? base.actor,
    fieldsChanged: mergeStringLists(
      resolveZendeskChangedFields(payload, ticket),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...(readString(ticket.type) ? [`type:${readString(ticket.type)}`] : []),
      ...(readString(ticket.group_id) ? [`group:${readString(ticket.group_id)}`] : []),
      ...(readString(ticket.brand_id) ? [`brand:${readString(ticket.brand_id)}`] : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function buildGitlabSummary(input: SummaryBuildInput): AgentEventSummary {
  const payload = readPayloadRecord(input);
  const base = buildDefaultSummary(input);
  const subject =
    readRecord(payload.object_attributes)
    ?? readRecord(payload.merge_request)
    ?? readRecord(payload.issue)
    ?? payload;
  return {
    ...base,
    title: readString(subject.title) ?? base.title,
    status:
      readString(subject.state)
      ?? (subject.work_in_progress === true ? "draft" : undefined)
      ?? base.status,
    labels: mergeStringLists(limitStrings(
      readArray(subject.labels)
        .map((entry) => readString(entry) ?? readString(readRecord(entry)?.title) ?? readString(readRecord(entry)?.name))
        .filter((value): value is string => Boolean(value)),
      MAX_LABELS,
    ), base.labels, MAX_LABELS),
    actor:
      buildObjectActor(readRecord(payload.user) ?? readRecord(subject.author))
      ?? base.actor,
    fieldsChanged: mergeStringLists(
      limitStrings(Object.keys(readRecord(payload.changes) ?? {}), MAX_FIELDS_CHANGED),
      base.fieldsChanged,
      MAX_FIELDS_CHANGED,
    ),
    tags: mergeStringLists(limitStrings([
      ...(readString(payload.object_kind) ? [`kind:${readString(payload.object_kind)}`] : []),
      ...(readString(readRecord(payload.project)?.path_with_namespace)
        ? [`project:${readString(readRecord(payload.project)?.path_with_namespace)}`]
        : []),
    ], MAX_TAGS), base.tags, MAX_TAGS),
  };
}

function sanitizeSummary(summary: AgentEventSummary): AgentEventSummary {
  const actorId = sanitizeActorId(summary.actor?.id);
  const actorDisplayName = sanitizeText(summary.actor?.displayName, MAX_TOKEN_LENGTH, {
    dropIfEmailLike: true,
  });
  const sanitized: AgentEventSummary = {
    ...(sanitizeText(summary.title, MAX_TITLE_LENGTH) ? { title: sanitizeText(summary.title, MAX_TITLE_LENGTH) } : {}),
    ...(sanitizeText(summary.status, MAX_STATUS_LENGTH) ? { status: sanitizeText(summary.status, MAX_STATUS_LENGTH) } : {}),
    ...(sanitizeText(summary.priority, MAX_PRIORITY_LENGTH) ? { priority: sanitizeText(summary.priority, MAX_PRIORITY_LENGTH) } : {}),
    ...(sanitizeTokenList(summary.labels, MAX_LABELS) ? { labels: sanitizeTokenList(summary.labels, MAX_LABELS) } : {}),
    ...(actorId
      ? {
        actor: {
          id: actorId,
          ...(actorDisplayName ? { displayName: actorDisplayName } : {}),
        },
      }
      : {}),
    ...(sanitizeTokenList(summary.fieldsChanged, MAX_FIELDS_CHANGED) ? { fieldsChanged: sanitizeTokenList(summary.fieldsChanged, MAX_FIELDS_CHANGED) } : {}),
    ...(sanitizeTokenList(summary.tags, MAX_TAGS) ? { tags: sanitizeTokenList(summary.tags, MAX_TAGS) } : {}),
  };

  return pruneSummaryToMaxBytes(sanitized);
}

function pruneSummaryToMaxBytes(summary: AgentEventSummary): AgentEventSummary {
  const pruned: AgentEventSummary = { ...summary };
  if (serializedLength(pruned) <= MAX_SUMMARY_BYTES) {
    return pruned;
  }

  if (pruned.tags?.length) {
    delete pruned.tags;
  }
  if (serializedLength(pruned) <= MAX_SUMMARY_BYTES) {
    return pruned;
  }

  if (pruned.fieldsChanged?.length) {
    delete pruned.fieldsChanged;
  }
  if (serializedLength(pruned) <= MAX_SUMMARY_BYTES) {
    return pruned;
  }

  if (pruned.labels?.length) {
    delete pruned.labels;
  }
  if (serializedLength(pruned) <= MAX_SUMMARY_BYTES) {
    return pruned;
  }

  if (pruned.actor?.displayName) {
    pruned.actor = { id: pruned.actor.id };
  }
  if (serializedLength(pruned) <= MAX_SUMMARY_BYTES) {
    return pruned;
  }

  if (pruned.priority) {
    delete pruned.priority;
  }
  if (serializedLength(pruned) <= MAX_SUMMARY_BYTES) {
    return pruned;
  }

  if (pruned.status) {
    delete pruned.status;
  }
  if (serializedLength(pruned) <= MAX_SUMMARY_BYTES) {
    return pruned;
  }

  if (pruned.title && pruned.title.length > 72) {
    pruned.title = `${pruned.title.slice(0, 69).trimEnd()}...`;
  }

  return pruned;
}

function serializedLength(summary: AgentEventSummary): number {
  return new TextEncoder().encode(JSON.stringify(summary)).length;
}

function sanitizeActorId(value: string | undefined): string | undefined {
  const normalized = sanitizeToken(value, 128);
  if (!normalized || looksLikeEmail(normalized) || looksLikePhoneOrLongNumber(normalized)) {
    return undefined;
  }
  return normalized;
}

function sanitizeTokenList(values: string[] | undefined, max: number): string[] | undefined {
  if (!values?.length) {
    return undefined;
  }

  const sanitized = limitStrings(
    values
      .map((value) => sanitizeToken(value, MAX_TOKEN_LENGTH))
      .filter((value): value is string => Boolean(value)),
    max,
  );
  return sanitized?.length ? sanitized : undefined;
}

function sanitizeToken(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || looksLikeEmail(trimmed)) {
    return undefined;
  }

  const normalized = trimmed.replace(/\s+/g, " ");
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function sanitizeText(
  value: string | undefined,
  maxLength: number,
  options: { dropIfEmailLike?: boolean } = {},
): string | undefined {
  if (!value) {
    return undefined;
  }

  const redacted = redactFreeText(value).replace(/\s+/g, " ").trim();
  if (!redacted || (options.dropIfEmailLike && looksLikeEmail(redacted))) {
    return undefined;
  }

  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function redactFreeText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-number]")
    .replace(/\b\d{9,}\b/g, "[redacted-number]");
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function looksLikePhoneOrLongNumber(value: string): boolean {
  return /\+?\d[\d\s().-]{7,}\d/.test(value) || /\b\d{9,}\b/.test(value);
}

function readPayloadRecord(input: SummaryBuildInput): Record<string, unknown> {
  return unwrapResourceRecord(input.raw) ?? {};
}

function unwrapResourceRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const direct = value as Record<string, unknown>;
  if ("data" in direct && direct.data && typeof direct.data === "object" && !Array.isArray(direct.data)) {
    return direct.data as Record<string, unknown>;
  }
  if ("resource" in direct && direct.resource && typeof direct.resource === "object" && !Array.isArray(direct.resource)) {
    return direct.resource as Record<string, unknown>;
  }
  return direct;
}

function readNamedValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const nested = readNamedValue(
        record.name,
        record.displayName,
        record.title,
        record.label,
        record.text,
      );
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry))
    : [];
}

function extractActor(
  record: Record<string, unknown>,
): AgentEventSummary["actor"] | undefined {
  const candidate = [
    record.actionBy,
    record.actor,
    record.user,
    record.author,
    record.updatedBy,
    record.lastEditedBy,
  ].find((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown> | undefined;
  return buildObjectActor(candidate);
}

function buildObjectActor(
  record: Record<string, unknown> | undefined,
): AgentEventSummary["actor"] | undefined {
  if (!record) {
    return undefined;
  }

  const id = readNamedValue(record.id, record.userId, record.actorId, record.accountId, record.account_id, record.login, record.username, record.name);
  if (!id) {
    return undefined;
  }

  return {
    id,
    ...(readNamedValue(
      record.displayName,
      record.display_name,
      record.real_name,
      record.name,
      record.fullName,
      record.username,
      record.login,
      record.publicName,
    ) ? {
      displayName: readNamedValue(
        record.displayName,
        record.display_name,
        record.real_name,
        record.name,
        record.fullName,
        record.username,
        record.login,
        record.publicName,
      ),
    } : {}),
  };
}

function buildGitHubActor(
  record: Record<string, unknown> | undefined,
): AgentEventSummary["actor"] | undefined {
  if (!record) {
    return undefined;
  }

  const numericId = readNumber(record.id);
  const login = readString(record.login);
  const actorId = numericId !== undefined ? String(numericId) : login;
  if (!actorId) {
    return undefined;
  }

  return login ? { id: actorId, displayName: login } : { id: actorId };
}

function buildSlackActor(payload: Record<string, unknown>): AgentEventSummary["actor"] | undefined {
  const user = payload.user;
  if (typeof user === "string" && user.trim().length > 0) {
    const displayName = readString(payload.user_name) ?? readString(payload.userName);
    return displayName ? { id: user.trim(), displayName } : { id: user.trim() };
  }

  return buildObjectActor(readRecord(user));
}

function buildSalesforceActor(payload: Record<string, unknown>): AgentEventSummary["actor"] | undefined {
  const id = readString(payload.LastModifiedById) ?? readString(payload.CreatedById) ?? readString(payload.OwnerId);
  return id ? { id } : undefined;
}

function readLabelNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const names = value
    .map((entry) => readString(readRecord(entry)?.name))
    .filter((entry): entry is string => Boolean(entry));
  return names.length > 0 ? limitStrings(names, MAX_LABELS) : undefined;
}

function extractStringList(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    const items = value
      .map((entry) => readNamedValue(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (items.length > 0) {
      return items;
    }
  }
  return undefined;
}

function limitStrings(values: string[], max: number): string[] | undefined {
  const results: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || results.includes(normalized)) {
      continue;
    }
    results.push(normalized);
    if (results.length >= max) {
      break;
    }
  }
  return results.length > 0 ? results : undefined;
}

function mergeStringLists(
  primary: string[] | undefined,
  secondary: string[] | undefined,
  max: number,
): string[] | undefined {
  return limitStrings([...(primary ?? []), ...(secondary ?? [])], max);
}

function diffRecordKeys(
  previousData: Record<string, unknown> | undefined,
  currentData: Record<string, unknown>,
  max: number,
  options: { skipPrivate?: boolean } = {},
): string[] | undefined {
  if (!previousData) {
    return undefined;
  }

  const changed: string[] = [];
  for (const key of Object.keys(previousData)) {
    if (options.skipPrivate && key.startsWith("_")) {
      continue;
    }

    if (!isSameValue(previousData[key], currentData[key])) {
      changed.push(key);
    }

    if (changed.length >= max) {
      break;
    }
  }

  return changed.length > 0 ? changed : undefined;
}

function isSameValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveLinearPriority(payload: Record<string, unknown>): string | undefined {
  const explicit = readString(payload.priority_label);
  if (explicit) {
    return explicit;
  }

  const priority = readNumber(payload.priority);
  switch (priority) {
    case 0:
      return "none";
    case 1:
      return "urgent";
    case 2:
      return "high";
    case 3:
      return "normal";
    case 4:
      return "low";
    default:
      return undefined;
  }
}

function resolveNotionChangedFields(
  payload: Record<string, unknown>,
  previousProperties: Record<string, unknown> | undefined,
  properties: Record<string, unknown> | undefined,
): string[] | undefined {
  const explicitCandidates = [
    payload.changedProperties,
    payload.changed_properties,
    payload.propertiesChanged,
    readRecord(payload._webhook)?.changedProperties,
  ];
  for (const candidate of explicitCandidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const explicitFields = limitStrings(
      candidate
        .map((value) => readString(value))
        .filter((value): value is string => Boolean(value)),
      MAX_FIELDS_CHANGED,
    );
    if (explicitFields) {
      return explicitFields;
    }
  }

  if (!previousProperties || !properties) {
    return undefined;
  }

  return diffRecordKeys(previousProperties, properties, MAX_FIELDS_CHANGED);
}

function resolveNotionLabels(
  properties: Record<string, unknown> | undefined,
): string[] | undefined {
  if (!properties) {
    return undefined;
  }

  const labels: string[] = [];
  for (const property of Object.values(properties)) {
    const record = readRecord(property);
    if (!record) {
      continue;
    }

    if (readString(record.type) === "multi_select") {
      for (const entry of readArray(record.multi_select)) {
        const name = readString(readRecord(entry)?.name);
        if (name) {
          labels.push(name);
        }
      }
      continue;
    }

    if (readString(record.type) === "select") {
      const name = readString(readRecord(record.select)?.name);
      if (name && /tag|label|area|team/i.test(readString(record.name) ?? "")) {
        labels.push(name);
      }
    }
  }

  return limitStrings(labels, MAX_LABELS);
}

function resolveNotionParentTags(parent: Record<string, unknown> | undefined): string[] {
  if (!parent) {
    return [];
  }

  const tags: string[] = [];
  const type = readString(parent.type);
  if (type) {
    tags.push(`parent_type:${type}`);
  }
  const databaseId = readString(parent.database_id);
  if (databaseId) {
    tags.push(`parent:${databaseId}`);
  }
  const pageId = readString(parent.page_id);
  if (pageId) {
    tags.push(`parent:${pageId}`);
  }
  return tags;
}

function resolveNotionTitle(
  payload: Record<string, unknown>,
  properties: Record<string, unknown> | undefined,
): string | undefined {
  const normalizedTitle = readString(payload.title);
  if (normalizedTitle) {
    return normalizedTitle;
  }

  if (!properties) {
    return undefined;
  }

  for (const property of Object.values(properties)) {
    const record = readRecord(property);
    if (!record) {
      continue;
    }
    const type = readString(record.type);
    if (type !== "title") {
      continue;
    }
    const richText = readArray(record.title).length > 0 ? readArray(record.title) : readArray(record.value);
    const text = richText
      .map((entry) => readString(readRecord(entry)?.plain_text) ?? readString(readRecord(readRecord(entry)?.text)?.content))
      .filter((value): value is string => Boolean(value))
      .join("");
    if (text.trim()) {
      return text.trim();
    }
  }

  return undefined;
}

function resolveNotionStatus(properties: Record<string, unknown> | undefined): string | undefined {
  if (!properties) {
    return undefined;
  }

  const statusProperty = readRecord(properties.Status);
  if (statusProperty) {
    return readString(readRecord(statusProperty.status)?.name) ?? readString(readRecord(statusProperty.value)?.name) ?? readString(statusProperty.value);
  }

  for (const property of Object.values(properties)) {
    const record = readRecord(property);
    if (!record || readString(record.type) !== "status") {
      continue;
    }
    return readString(readRecord(record.status)?.name) ?? readString(readRecord(record.value)?.name) ?? readString(record.value);
  }

  return undefined;
}

function extractAsanaChangedFields(events: unknown[]): string[] | undefined {
  const changed: string[] = [];
  for (const event of events) {
    const record = readRecord(event);
    const change = readRecord(record?.change);
    const field = readString(change?.field);
    const action = readString(change?.action) ?? readString(record?.action);
    if (field) {
      changed.push(field);
    } else if (action) {
      changed.push(action);
    }
  }
  return limitStrings(changed, MAX_FIELDS_CHANGED);
}

function extractClickUpChangedFields(historyItems: unknown[]): string[] | undefined {
  const changed: string[] = [];
  for (const item of historyItems) {
    const record = readRecord(item);
    const field =
      readString(record?.field)
      ?? readString(record?.field_name)
      ?? readString(record?.type)
      ?? readString(record?.status);
    if (field) {
      changed.push(field);
    }
  }
  return limitStrings(changed, MAX_FIELDS_CHANGED);
}

function parseDelimitedTags(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  return limitStrings(
    value.split(",").map((entry) => entry.trim()).filter(Boolean),
    MAX_LABELS,
  );
}

function resolveSalesforceChangedFields(
  payload: Record<string, unknown>,
): string[] | undefined {
  const explicit = limitStrings([
    ...Object.keys(readRecord(payload.changes) ?? {}),
    ...readStringArray(payload.changedFields),
    ...readStringArray(readRecord(payload.ChangeEventHeader)?.changedFields),
  ], MAX_FIELDS_CHANGED);
  if (explicit) {
    return explicit;
  }

  const previous =
    readRecord(payload.previous)
    ?? readRecord(payload.previousData)
    ?? readRecord(readRecord(payload.before)?.data);
  const current = readRecord(payload.data) ?? payload;
  return diffRecordKeys(previous, current, MAX_FIELDS_CHANGED);
}

function resolveZendeskChangedFields(
  payload: Record<string, unknown>,
  ticket: Record<string, unknown>,
): string[] | undefined {
  const commentFields: string[] = [];
  for (const comment of readArray(ticket.comments)) {
    const record = readRecord(comment);
    const field =
      readString(record?.field)
      ?? readString(record?.type)
      ?? (record ? "comments" : undefined);
    if (field) {
      commentFields.push(field);
    }
  }

  return limitStrings([
    ...commentFields,
    ...Object.keys(readRecord(payload.changes) ?? {}),
    ...Object.keys(readRecord(payload.previous) ?? {}),
  ], MAX_FIELDS_CHANGED);
}

function extractJiraChangedFields(changelog: Record<string, unknown> | undefined): string[] | undefined {
  if (!changelog) {
    return undefined;
  }

  const changed: string[] = [];
  collectJiraChangeItems(readArray(changelog.items), changed);
  for (const history of readArray(changelog.histories)) {
    collectJiraChangeItems(readArray(readRecord(history)?.items), changed);
    if (changed.length >= MAX_FIELDS_CHANGED) {
      break;
    }
  }
  return changed.length > 0 ? changed : undefined;
}

function collectJiraChangeItems(items: unknown[], changed: string[]): void {
  for (const item of items) {
    const field = readString(readRecord(item)?.field) ?? readString(readRecord(item)?.fieldId);
    if (!field || changed.includes(field)) {
      continue;
    }
    changed.push(field);
    if (changed.length >= MAX_FIELDS_CHANGED) {
      break;
    }
  }
}

function extractJiraProjectTags(
  issue: Record<string, unknown>,
  fields: Record<string, unknown> | undefined,
): string[] {
  const explicitProject = readString(readRecord(fields?.project)?.key);
  if (explicitProject) {
    return [`project:${explicitProject}`];
  }

  const issueKey = readString(issue.key);
  if (!issueKey || !issueKey.includes("-")) {
    return [];
  }

  return [`project:${issueKey.split("-", 1)[0]}`];
}

function extractAirtableChanges(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(payload.changes)) {
    return payload.changes.map((entry) => readRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry));
  }

  const changedTablesById = readRecord(payload.changedTablesById);
  if (!changedTablesById) {
    return [];
  }

  const changes: Record<string, unknown>[] = [];
  for (const [tableId, tableChangeValue] of Object.entries(changedTablesById)) {
    const tableChange = readRecord(tableChangeValue);
    const changedRecordsById = readRecord(tableChange?.changedRecordsById);
    if (!changedRecordsById) {
      continue;
    }

    for (const [recordId, changeValue] of Object.entries(changedRecordsById)) {
      const changeRecord = readRecord(changeValue);
      const changedFieldsById = readRecord(changeRecord?.changedFieldsById);
      for (const fieldId of Object.keys(changedFieldsById ?? {})) {
        changes.push({ tableId, recordId, fieldId });
      }
    }
  }

  return changes;
}

function resolveAirtableNotificationTitle(payload: Record<string, unknown>): string | undefined {
  const changedTablesById = readRecord(payload.changedTablesById);
  if (!changedTablesById) {
    return undefined;
  }

  for (const tableChange of Object.values(changedTablesById)) {
    const changedRecordsById = readRecord(readRecord(tableChange)?.changedRecordsById);
    if (!changedRecordsById) {
      continue;
    }

    for (const changeRecord of Object.values(changedRecordsById)) {
      const currentFields = readRecord(readRecord(readRecord(changeRecord)?.current)?.cellValuesByFieldId);
      const previousFields = readRecord(readRecord(readRecord(changeRecord)?.previous)?.cellValuesByFieldId);
      const title = firstNonEmptyString(...Object.values(currentFields ?? {}))
        ?? firstNonEmptyString(...Object.values(previousFields ?? {}));
      if (title) {
        return title;
      }
    }
  }

  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const string = readString(value);
    if (string) {
      return string;
    }
  }
  return undefined;
}

registerBuiltinSummaryBuilders();
