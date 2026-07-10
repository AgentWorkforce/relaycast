// Canonical HubSpot sync/webhook record shapes.
//
// The HubSpot Nango syncs and the cloud forward-webhook handler both write
// Company/Contact/Deal/Ticket records into Relayfile. Keep the mapping logic
// here so webhook-written records stay byte-identical to sync-written records.
//
// Cross-package mirror: Nango's sandbox cannot resolve `@cloud/core`, so
// `nango-integrations/hubspot-relay/shared/hubspot-record-shapes.ts` mirrors
// the body of this file with zod schemas added for Nango model validation.

export const HUBSPOT_CONTACT_MODEL = "Contact" as const;
export const HUBSPOT_COMPANY_MODEL = "Company" as const;
export const HUBSPOT_DEAL_MODEL = "Deal" as const;
export const HUBSPOT_TICKET_MODEL = "Ticket" as const;

export const CONTACT_OBJECT_TYPE_ID = "0-1" as const;
export const COMPANY_OBJECT_TYPE_ID = "0-2" as const;
export const DEAL_OBJECT_TYPE_ID = "0-3" as const;
export const TICKET_OBJECT_TYPE_ID = "0-5" as const;

export const HUBSPOT_OBJECT_TYPE_ID_TO_MODEL = {
  [CONTACT_OBJECT_TYPE_ID]: HUBSPOT_CONTACT_MODEL,
  [COMPANY_OBJECT_TYPE_ID]: HUBSPOT_COMPANY_MODEL,
  [DEAL_OBJECT_TYPE_ID]: HUBSPOT_DEAL_MODEL,
  [TICKET_OBJECT_TYPE_ID]: HUBSPOT_TICKET_MODEL,
} as const;

export const CONTACT_PROPERTIES =
  "firstname,lastname,email,phone,jobtitle,company,createdate,lastmodifieddate";
export const COMPANY_PROPERTIES =
  "name,domain,industry,city,state,country,phone,website,description,createdate,hs_lastmodifieddate";
export const DEAL_PROPERTIES =
  "dealname,amount,closedate,dealstage,hubspot_owner_id,description,hs_lastmodifieddate";
export const TICKET_PROPERTIES =
  "subject,content,hubspot_owner_id,hs_pipeline,hs_pipeline_stage,hs_category,hs_ticket_priority,createdate,hs_lastmodifieddate";

export const HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS = [
  "object.creation",
  "object.deletion",
  "object.merge",
  "object.restore",
  "object.propertyChange",
] as const;

export const HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS_WITH_ASSOCIATIONS = [
  ...HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS,
  "object.associationChange",
] as const;

export interface HubSpotRawObject {
  id: string;
  properties?: Record<string, string | null | undefined> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  archived?: boolean | null;
  associations?: {
    companies?: { results?: Array<{ id: string }> };
    contacts?: { results?: Array<{ id: string }> };
  } | null;
}

export interface HubSpotAssociationClient {
  get(config: {
    endpoint: string;
    params?: Record<string, string>;
    retries: number;
  }): Promise<{ data: unknown }>;
}

export interface HubSpotContactRecord {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  jobTitle?: string;
  company?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface HubSpotCompanyRecord {
  id: string;
  name?: string;
  domain?: string;
  industry?: string;
  city?: string;
  state?: string;
  country?: string;
  phone?: string;
  website?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface HubSpotDealRecord {
  id: string;
  name?: string;
  amount?: number;
  closeDate?: string;
  stage?: string;
  ownerId?: string;
  description?: string;
  companyIds: string[];
  contactIds: string[];
  updatedAt: string;
}

export interface HubSpotTicketRecord {
  id: string;
  subject?: string;
  content?: string;
  ownerId?: string;
  pipeline?: string;
  stage?: string;
  category?: string;
  priority?: string;
  createdAt?: string;
  updatedAt?: string;
}

type WebhookIdExtractionOptions = {
  includeAssociationChange?: boolean;
};

interface HubSpotWebhookEvent {
  subscriptionType?: string;
  objectTypeId?: string | number;
  objectId?: string | number;
  primaryObjectId?: string | number;
  newObjectId?: string | number;
  mergedObjectIds?: Array<string | number>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function toId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function collectRawEvents(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  const record = asRecord(payload);
  if (!record) {
    return [];
  }

  if (Array.isArray(record["events"])) {
    return record["events"];
  }

  if (Array.isArray(record["body"])) {
    return record["body"];
  }

  const body = asRecord(record["body"]);
  if (body?.["events"] && Array.isArray(body["events"])) {
    return body["events"];
  }

  return [record];
}

function parseWebhookEvent(candidate: unknown): HubSpotWebhookEvent | null {
  const record = asRecord(candidate);
  if (!record) return null;

  const event: HubSpotWebhookEvent = {};
  const subscriptionType = record["subscriptionType"];
  if (typeof subscriptionType === "string") {
    event.subscriptionType = subscriptionType;
  }
  const objectTypeId = toId(record["objectTypeId"]);
  if (objectTypeId) {
    event.objectTypeId = objectTypeId;
  }
  const objectId = toId(record["objectId"]);
  if (objectId) {
    event.objectId = objectId;
  }
  const primaryObjectId = toId(record["primaryObjectId"]);
  if (primaryObjectId) {
    event.primaryObjectId = primaryObjectId;
  }
  const newObjectId = toId(record["newObjectId"]);
  if (newObjectId) {
    event.newObjectId = newObjectId;
  }
  if (Array.isArray(record["mergedObjectIds"])) {
    event.mergedObjectIds = record["mergedObjectIds"]
      .map((id) => toId(id))
      .filter((id): id is string => typeof id === "string");
  }
  return event;
}

function parseEvents(payload: unknown): HubSpotWebhookEvent[] {
  const events: HubSpotWebhookEvent[] = [];

  for (const candidate of collectRawEvents(payload)) {
    const event = parseWebhookEvent(candidate);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

function isMatchingObject(
  event: HubSpotWebhookEvent,
  objectTypeId: string,
): boolean {
  return toId(event.objectTypeId) === objectTypeId;
}

export function extractHubspotWebhookObjectIds(
  payload: unknown,
  objectTypeId: string,
  options: WebhookIdExtractionOptions = {},
): { upsertIds: string[]; deleteIds: string[] } {
  const includeAssociationChange = options.includeAssociationChange === true;
  const upsertIds = new Set<string>();
  const deleteIds = new Set<string>();

  for (const event of parseEvents(payload)) {
    if (!isMatchingObject(event, objectTypeId)) {
      continue;
    }

    const subscriptionType = (event.subscriptionType ?? "").toLowerCase();
    const objectId = toId(event.objectId);

    if (subscriptionType === "object.deletion") {
      if (objectId) {
        deleteIds.add(objectId);
      }
      continue;
    }

    if (subscriptionType === "object.merge") {
      for (const mergedId of event.mergedObjectIds ?? []) {
        const parsedMergedId = toId(mergedId);
        if (parsedMergedId) {
          deleteIds.add(parsedMergedId);
        }
      }

      const winnerId = toId(event.newObjectId) ?? toId(event.primaryObjectId) ?? objectId;
      if (winnerId) {
        upsertIds.add(winnerId);
      }
      continue;
    }

    if (
      subscriptionType === "object.creation" ||
      subscriptionType === "object.propertychange" ||
      subscriptionType === "object.restore" ||
      (includeAssociationChange && subscriptionType === "object.associationchange")
    ) {
      if (objectId) {
        upsertIds.add(objectId);
      }
    }
  }

  for (const deletedId of deleteIds) {
    upsertIds.delete(deletedId);
  }

  return {
    upsertIds: [...upsertIds],
    deleteIds: [...deleteIds],
  };
}

export function buildHubSpotContactRecord(
  contact: HubSpotRawObject,
): HubSpotContactRecord {
  return {
    id: contact.id,
    firstName: contact.properties?.["firstname"] ?? undefined,
    lastName: contact.properties?.["lastname"] ?? undefined,
    email: contact.properties?.["email"] ?? undefined,
    phone: contact.properties?.["phone"] ?? undefined,
    jobTitle: contact.properties?.["jobtitle"] ?? undefined,
    company: contact.properties?.["company"] ?? undefined,
    createdAt: contact.createdAt ?? contact.properties?.["createdate"] ?? undefined,
    updatedAt:
      contact.updatedAt ?? contact.properties?.["lastmodifieddate"] ?? undefined,
  };
}

export function buildHubSpotCompanyRecord(
  company: HubSpotRawObject,
): HubSpotCompanyRecord {
  const props = company.properties || {};

  return {
    id: company.id,
    name: props.name ?? undefined,
    domain: props.domain ?? undefined,
    industry: props.industry ?? undefined,
    city: props.city ?? undefined,
    state: props.state ?? undefined,
    country: props.country ?? undefined,
    phone: props.phone ?? undefined,
    website: props.website ?? undefined,
    description: props.description ?? undefined,
    createdAt: company.createdAt ?? props.createdate ?? undefined,
    updatedAt: company.updatedAt ?? props.hs_lastmodifieddate ?? undefined,
  };
}

function readAssociationIds(deal: HubSpotRawObject, association: "companies" | "contacts"): string[] {
  return (deal.associations?.[association]?.results || []).map((entry) => entry.id);
}

function parseAssociationResults(data: unknown): string[] {
  const record = asRecord(data);
  if (!Array.isArray(record?.["results"])) {
    return [];
  }
  return record["results"]
    .map((entry) => {
      const entryRecord = asRecord(entry);
      return toId(entryRecord?.["id"]);
    })
    .filter((id): id is string => typeof id === "string");
}

async function fetchAssociatedIds(
  client: HubSpotAssociationClient,
  dealId: string,
  association: "companies" | "contacts",
): Promise<string[]> {
  try {
    const response = await client.get({
      endpoint: `/crm/v3/objects/deals/${dealId}/associations/${association}`,
      retries: 3,
    });

    return parseAssociationResults(response.data);
  } catch {
    return [];
  }
}

export async function buildHubSpotDealRecord(
  deal: HubSpotRawObject,
  client?: HubSpotAssociationClient,
): Promise<HubSpotDealRecord> {
  const companyIdsFromPayload = readAssociationIds(deal, "companies");
  const contactIdsFromPayload = readAssociationIds(deal, "contacts");

  const companyIds =
    companyIdsFromPayload.length > 0 || !client
      ? companyIdsFromPayload
      : await fetchAssociatedIds(client, deal.id, "companies");
  const contactIds =
    contactIdsFromPayload.length > 0 || !client
      ? contactIdsFromPayload
      : await fetchAssociatedIds(client, deal.id, "contacts");

  return {
    id: deal.id,
    name: deal.properties?.["dealname"] ?? undefined,
    amount: deal.properties?.["amount"]
      ? parseFloat(deal.properties["amount"] as string)
      : undefined,
    closeDate: deal.properties?.["closedate"] ?? undefined,
    stage: deal.properties?.["dealstage"] ?? undefined,
    ownerId: deal.properties?.["hubspot_owner_id"] ?? undefined,
    description: deal.properties?.["description"] ?? undefined,
    companyIds,
    contactIds,
    updatedAt:
      deal.properties?.["hs_lastmodifieddate"] ??
      deal.updatedAt ??
      new Date().toISOString(),
  };
}

export function buildHubSpotTicketRecord(
  ticket: HubSpotRawObject,
): HubSpotTicketRecord {
  return {
    id: ticket.id,
    subject: ticket.properties?.["subject"] ?? undefined,
    content: ticket.properties?.["content"] ?? undefined,
    ownerId: ticket.properties?.["hubspot_owner_id"] ?? undefined,
    pipeline: ticket.properties?.["hs_pipeline"] ?? undefined,
    stage: ticket.properties?.["hs_pipeline_stage"] ?? undefined,
    category: ticket.properties?.["hs_category"] ?? undefined,
    priority: ticket.properties?.["hs_ticket_priority"] ?? undefined,
    createdAt: ticket.createdAt ?? ticket.properties?.["createdate"] ?? undefined,
    updatedAt:
      ticket.updatedAt ?? ticket.properties?.["hs_lastmodifieddate"] ?? undefined,
  };
}
