// Contica 웹과 동일 구조 — 백엔드 공유.
export interface Contact {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  phone: string;
  phone2?: string;
  email?: string;
  email2?: string;
  company?: string;
  position?: string;
  address?: string;
  memo?: string;
  profile_image?: string;
  favorite: boolean;
  version: number;
  phone_contact_id?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
  groups?: Group[];
}

export interface Group {
  id: string;
  user_id: string;
  name: string;
  color: string;
  contact_count?: number;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export const WEB_API_BASE = 'https://contica.vercel.app';
