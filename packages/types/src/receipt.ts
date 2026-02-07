export interface ReadReceipt {
  message_id: string;
  agent_id: string;
  read_at: string;
}

export interface ReaderInfo {
  agent_name: string;
  agent_id: string;
  read_at: string;
}

export interface ChannelReadStatus {
  agent_name: string;
  last_read_id: string | null;
  last_read_at: string | null;
}
