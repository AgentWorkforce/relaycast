export type FileStatus = 'pending' | 'complete' | 'deleted';

export interface FileRecord {
  id: string;
  workspace_id: string;
  uploaded_by: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  storage_key: string;
  status: FileStatus;
  created_at: string;
}

export interface UploadRequest {
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface UploadResponse {
  file_id: string;
  upload_url: string;
  expires_at: string;
}

export interface FileAttachment {
  file_id: string;
  filename: string;
  url: string;
  size: number;
}

export interface FileInfo {
  file_id: string;
  filename: string;
  content_type: string;
  size: number;
  url: string;
  uploaded_by: string;
  created_at: string;
}
