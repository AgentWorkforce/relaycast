import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from '../schema.js';

describe('Database Schema', () => {
  // ============================================
  // All 12 tables exported
  // ============================================
  it('exports all 12 tables', () => {
    expect(schema.workspaces).toBeDefined();
    expect(schema.agents).toBeDefined();
    expect(schema.channels).toBeDefined();
    expect(schema.channelMembers).toBeDefined();
    expect(schema.messages).toBeDefined();
    expect(schema.reactions).toBeDefined();
    expect(schema.dmConversations).toBeDefined();
    expect(schema.dmParticipants).toBeDefined();
    expect(schema.files).toBeDefined();
    expect(schema.messageAttachments).toBeDefined();
    expect(schema.readReceipts).toBeDefined();
    expect(schema.usageRecords).toBeDefined();
  });

  // ============================================
  // Table names
  // ============================================
  it('has correct table names', () => {
    expect(getTableName(schema.workspaces)).toBe('workspaces');
    expect(getTableName(schema.agents)).toBe('agents');
    expect(getTableName(schema.channels)).toBe('channels');
    expect(getTableName(schema.channelMembers)).toBe('channel_members');
    expect(getTableName(schema.messages)).toBe('messages');
    expect(getTableName(schema.reactions)).toBe('reactions');
    expect(getTableName(schema.dmConversations)).toBe('dm_conversations');
    expect(getTableName(schema.dmParticipants)).toBe('dm_participants');
    expect(getTableName(schema.files)).toBe('files');
    expect(getTableName(schema.messageAttachments)).toBe('message_attachments');
    expect(getTableName(schema.readReceipts)).toBe('read_receipts');
    expect(getTableName(schema.usageRecords)).toBe('usage_records');
  });

  // ============================================
  // Workspaces columns
  // ============================================
  it('workspaces table has correct columns', () => {
    const cols = getTableColumns(schema.workspaces);
    expect(cols.id).toBeDefined();
    expect(cols.name).toBeDefined();
    expect(cols.apiKeyHash).toBeDefined();
    expect(cols.systemPrompt).toBeDefined();
    expect(cols.plan).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.metadata).toBeDefined();
  });

  // ============================================
  // Agents columns
  // ============================================
  it('agents table has correct columns', () => {
    const cols = getTableColumns(schema.agents);
    expect(cols.id).toBeDefined();
    expect(cols.workspaceId).toBeDefined();
    expect(cols.name).toBeDefined();
    expect(cols.type).toBeDefined();
    expect(cols.tokenHash).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.persona).toBeDefined();
    expect(cols.metadata).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.lastSeen).toBeDefined();
  });

  // ============================================
  // Channels columns
  // ============================================
  it('channels table has correct columns', () => {
    const cols = getTableColumns(schema.channels);
    expect(cols.id).toBeDefined();
    expect(cols.workspaceId).toBeDefined();
    expect(cols.name).toBeDefined();
    expect(cols.channelType).toBeDefined();
    expect(cols.topic).toBeDefined();
    expect(cols.createdBy).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.isArchived).toBeDefined();
  });

  // ============================================
  // Channel Members columns
  // ============================================
  it('channel_members table has correct columns', () => {
    const cols = getTableColumns(schema.channelMembers);
    expect(cols.channelId).toBeDefined();
    expect(cols.agentId).toBeDefined();
    expect(cols.role).toBeDefined();
    expect(cols.joinedAt).toBeDefined();
    expect(cols.lastReadId).toBeDefined();
  });

  // ============================================
  // Messages columns
  // ============================================
  it('messages table has correct columns', () => {
    const cols = getTableColumns(schema.messages);
    expect(cols.id).toBeDefined();
    expect(cols.workspaceId).toBeDefined();
    expect(cols.channelId).toBeDefined();
    expect(cols.agentId).toBeDefined();
    expect(cols.threadId).toBeDefined();
    expect(cols.body).toBeDefined();
    expect(cols.blocks).toBeDefined();
    expect(cols.hasAttachments).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });

  // ============================================
  // Reactions columns
  // ============================================
  it('reactions table has correct columns', () => {
    const cols = getTableColumns(schema.reactions);
    expect(cols.id).toBeDefined();
    expect(cols.messageId).toBeDefined();
    expect(cols.agentId).toBeDefined();
    expect(cols.emoji).toBeDefined();
    expect(cols.createdAt).toBeDefined();
  });

  // ============================================
  // DM Conversations columns
  // ============================================
  it('dm_conversations table has correct columns', () => {
    const cols = getTableColumns(schema.dmConversations);
    expect(cols.id).toBeDefined();
    expect(cols.workspaceId).toBeDefined();
    expect(cols.channelId).toBeDefined();
    expect(cols.dmType).toBeDefined();
    expect(cols.name).toBeDefined();
    expect(cols.createdAt).toBeDefined();
  });

  // ============================================
  // DM Participants columns
  // ============================================
  it('dm_participants table has correct columns', () => {
    const cols = getTableColumns(schema.dmParticipants);
    expect(cols.conversationId).toBeDefined();
    expect(cols.agentId).toBeDefined();
    expect(cols.joinedAt).toBeDefined();
    expect(cols.leftAt).toBeDefined();
  });

  // ============================================
  // Files columns
  // ============================================
  it('files table has correct columns', () => {
    const cols = getTableColumns(schema.files);
    expect(cols.id).toBeDefined();
    expect(cols.workspaceId).toBeDefined();
    expect(cols.uploadedBy).toBeDefined();
    expect(cols.filename).toBeDefined();
    expect(cols.contentType).toBeDefined();
    expect(cols.sizeBytes).toBeDefined();
    expect(cols.storageKey).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.createdAt).toBeDefined();
  });

  // ============================================
  // Message Attachments columns
  // ============================================
  it('message_attachments table has correct columns', () => {
    const cols = getTableColumns(schema.messageAttachments);
    expect(cols.messageId).toBeDefined();
    expect(cols.fileId).toBeDefined();
    expect(cols.position).toBeDefined();
  });

  // ============================================
  // Read Receipts columns
  // ============================================
  it('read_receipts table has correct columns', () => {
    const cols = getTableColumns(schema.readReceipts);
    expect(cols.messageId).toBeDefined();
    expect(cols.agentId).toBeDefined();
    expect(cols.readAt).toBeDefined();
  });

  // ============================================
  // Usage Records columns
  // ============================================
  it('usage_records table has correct columns', () => {
    const cols = getTableColumns(schema.usageRecords);
    expect(cols.id).toBeDefined();
    expect(cols.workspaceId).toBeDefined();
    expect(cols.periodStart).toBeDefined();
    expect(cols.periodEnd).toBeDefined();
    expect(cols.messagesSent).toBeDefined();
    expect(cols.apiCalls).toBeDefined();
    expect(cols.filesUploaded).toBeDefined();
    expect(cols.fileBytes).toBeDefined();
    expect(cols.wsMinutes).toBeDefined();
    expect(cols.createdAt).toBeDefined();
  });

  // ============================================
  // Not-null constraints
  // ============================================
  it('workspaces.name is not null', () => {
    const cols = getTableColumns(schema.workspaces);
    expect(cols.name.notNull).toBe(true);
  });

  it('agents.workspaceId is not null', () => {
    const cols = getTableColumns(schema.agents);
    expect(cols.workspaceId.notNull).toBe(true);
  });

  it('messages.body is not null', () => {
    const cols = getTableColumns(schema.messages);
    expect(cols.body.notNull).toBe(true);
  });

  // ============================================
  // Default values
  // ============================================
  it('workspaces.plan defaults to free', () => {
    const cols = getTableColumns(schema.workspaces);
    expect(cols.plan.hasDefault).toBe(true);
  });

  it('agents.type defaults to agent', () => {
    const cols = getTableColumns(schema.agents);
    expect(cols.type.hasDefault).toBe(true);
  });

  it('agents.status defaults to online', () => {
    const cols = getTableColumns(schema.agents);
    expect(cols.status.hasDefault).toBe(true);
  });

  it('channels.channelType defaults to 0', () => {
    const cols = getTableColumns(schema.channels);
    expect(cols.channelType.hasDefault).toBe(true);
  });

  it('channels.isArchived defaults to false', () => {
    const cols = getTableColumns(schema.channels);
    expect(cols.isArchived.hasDefault).toBe(true);
  });

  it('messages.hasAttachments defaults to false', () => {
    const cols = getTableColumns(schema.messages);
    expect(cols.hasAttachments.hasDefault).toBe(true);
  });

  it('files.status defaults to pending', () => {
    const cols = getTableColumns(schema.files);
    expect(cols.status.hasDefault).toBe(true);
  });
});
